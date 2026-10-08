const assert = require('assert');

const isolatedFixture = require('./helpers/isolatedSocialDatabase')('f1-bot-shield-reconciliation');
require('../src/Global');
isolatedFixture.assertConfigured(options.default);

const fixtureDatabase = invoke('Database');
const fixtureDatabaseMethods = { ...fixtureDatabase };

(async () => {
    try {
        // Lifecycle count/save readers use native queues outside Database.execute.
        // Initialize the complete disposable schema before installing unit facades.
        invoke('GameServer/DataCache').init();
        await new Promise(resolve => fixtureDatabase.init(resolve));

        const declaredCharacters = [
            [101, "shield_test", "BrokenShieldRepair", 40, 7],
            [102, "shield_test", "HealthyShieldRepair", 40, 7],
            [103, "shield_test", "UnequippedRingProbe", 20, 0],
        ];
        for (const [id, account, name, level, classId] of declaredCharacters) {
            await fixtureDatabase.execute(['INSERT OR IGNORE INTO accounts(username,password) VALUES(?,?)',
                [account, 'fixture']]);
            await fixtureDatabase.execute([`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,
                sex,face,hair,hairColor,locX,locY,locZ) VALUES(?,?,?,?,0,?,100,100,0,0,0,0,0,0,0)`,
                [id, account, name, classId, level]]);
        }

        // The native lifecycle saver bypasses the old execute-only failure facade.
        // Refuse the same row in SQLite so the failed repair remains a real rollback.
        await fixtureDatabase.execute([`CREATE TRIGGER fixture_shield_failure
            BEFORE INSERT ON bot_life_state WHEN NEW.characterId=101
            BEGIN SELECT RAISE(ABORT, 'synthetic row failure'); END;`, []]);

        const Database = invoke('Database');
        const originalReconcileClanGoals = Database.reconcileBotClanGoals;
        const DataCache = invoke('GameServer/DataCache');
        const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');

        DataCache.init();

        const originalExecute = Database.execute;
        const originalSyncInventorySummary = Database.syncInventorySummary;
        const originalFetchItems = Database.fetchItems;
        const originalRecoverStartupLeases = ColdSimulationOwner.recoverStartupLeases;
        const originalReconcileClanMembership = Database.reconcileBotClanMembership;

        function persistedShieldRow(characterId, name) {
            return {
                characterId,
                accountName: 'shield_test',
                characterName: name,
                level: 40,
                exp: 0,
                sp: 0,
                adena: 0,
                phase: 'cold',
                activity: 'hunting',
                homeRegion: null,
                currentRegion: null,
                spotId: null,
                locX: 0,
                locY: 0,
                locZ: 0,
                hp: 100,
                maxHp: 100,
                mp: 50,
                maxMp: 50,
                targetLevelBand: 40,
                deathCount: 0,
                partyId: null,
                inventorySummary: JSON.stringify({
                    625: {
                        selfId: 625,
                        name: 'Bone Shield',
                        amount: 1,
                        equipped: true,
                        equippedCount: 1,
                        equippedSlots: [8],
                        slot: 8
                    }
                }),
                statsJson: JSON.stringify({ classId: 7, role: 'dagger' }),
                updatedAt: 1
            };
        }

        Database.execute = ([sql, params]) => {
            const statement = String(sql);
            if (/^SELECT states\.\*/i.test(statement) && statement.includes('FROM bot_life_state states')) {
                return Promise.resolve([
                    persistedShieldRow(101, 'BrokenShieldRepair'),
                    persistedShieldRow(102, 'HealthyShieldRepair')
                ]);
            }
            if (statement.includes('INSERT INTO bot_life_state') && Number(params?.[0]) === 101) {
                return Promise.reject(new Error('synthetic row failure'));
            }
            if (statement.includes('UPDATE bot_life_state')) return Promise.resolve({ affectedRows: 0 });
            return Promise.resolve([]);
        };
        Database.syncInventorySummary = () => Promise.resolve();
        ColdSimulationOwner.recoverStartupLeases = () => Promise.resolve({ affectedRows: 0 });
        Database.reconcileBotClanMembership = () => Promise.resolve({ repairedMembers: 0, repairedParties: 0 });
        Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });

        const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

        await (async () => {
            try {
                const ready = await BotLifeState.init();
                assert.strictEqual(ready, true,
                    'one failed shield repair must not make the entire lifecycle unavailable');
                assert.strictEqual(BotLifeState.cachedState(101).inventory['625'].equipped, true,
                    'a failed row must remain unchanged in cache for a later retry');
                assert.strictEqual(BotLifeState.cachedState(102).inventory['625'].equipped, false,
                    'subsequent shield repairs must continue after an earlier row fails');

                Database.fetchItems = () => Promise.resolve([
                    { selfId: 878, name: 'Ring of Knowledge', amount: 1, equipped: false, slot: 5 }
                ]);
                const refreshed = await BotLifeState.refreshInventory({
                    characterId: 103,
                    name: 'UnequippedRingProbe',
                    level: 20,
                    stats: { classId: 0, role: 'dps' },
                    inventory: {
                        878: {
                            selfId: 878,
                            name: 'Ring of Knowledge',
                            amount: 2,
                            equipped: true,
                            equippedCount: 2,
                            equippedSlots: [4, 5],
                            slot: 4
                        }
                    }
                });
                assert.strictEqual(refreshed.inventory['878'].equipped, false,
                    'a present physical row must be authoritative when paired gear is unequipped');
                assert.deepStrictEqual(refreshed.inventory['878'].equippedSlots, [],
                    'stale persisted paired slots must be allowed to shrink after physical refresh');

                console.log('Bot shield reconciliation checks passed');
            } finally {
                Database.execute = originalExecute;
                Database.syncInventorySummary = originalSyncInventorySummary;
                Database.fetchItems = originalFetchItems;
                ColdSimulationOwner.recoverStartupLeases = originalRecoverStartupLeases;
                Database.reconcileBotClanMembership = originalReconcileClanMembership;
                Database.reconcileBotClanGoals = originalReconcileClanGoals;
            }
        })().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    } finally {
        Object.assign(fixtureDatabase, fixtureDatabaseMethods);
        await fixtureDatabase.close();
        require('node:fs').rmSync(isolatedFixture.directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

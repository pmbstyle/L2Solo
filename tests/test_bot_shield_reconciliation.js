const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const originalExecute = Database.execute;
const originalSyncInventorySummary = Database.syncInventorySummary;
const originalFetchItems = Database.fetchItems;

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
    if (statement.startsWith('SELECT * FROM bot_life_state')) {
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

const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

(async () => {
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
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

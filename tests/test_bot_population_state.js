const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const originalExecute = Database.execute;
const statements = [];

try {
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        if (String(sql).startsWith('SELECT id, classId, level, exp, sp FROM characters')) {
            return Promise.resolve([{ id: 42, classId: 31, level: 42, exp: 0, sp: 0 }]);
        }
        if (String(sql).startsWith('UPDATE bot_life_state')) {
            return Promise.resolve({ affectedRows: 2 });
        }
        if (String(sql).startsWith('SELECT * FROM bot_life_state')) {
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    };

    const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

    BotLifeState.init().then((ready) => {
        assert.strictEqual(ready, true);
        const recovery = statements.find((entry) => entry.sql.includes("WHERE phase = 'hot'"));
        assert(recovery, 'bot life init should recover stale hot records on startup');
        assert(recovery.sql.includes("activity <> 'merchant' OR statsJson LIKE '%\"marketStore\"%'"), 'only dynamic market merchants should be recovered; configured static merchants remain hot');
        assert(!recovery.sql.includes('activity <> \'crafting\''), 'craft services must recover as cold because they have no static startup owner');
        assert(recovery.sql.includes("WHEN activity IN ('following', 'shopping', 'getting_buffed', 'fleeing', 'pk_fleeing') THEN 'hunting'"));
        assert.strictEqual(recovery.params.length, 2, 'recovery query should set next resolve and updated timestamps');
        const craftRecovery = statements.find((entry) => entry.sql.includes("startup_craft_wait_recovery"));
        assert(craftRecovery, 'bot life init must release stale craft waits after a restart');
        assert(craftRecovery.sql.includes("AND activity = 'crafting'"), 'only stale station waits should be recovered as hunters');
        assert.strictEqual(craftRecovery.params[1], craftRecovery.params[0], 'recovered craft waits must be due immediately for their replan');
        const partyWaitMigration = statements.find((entry) => entry.sql.includes("migrated %d acquisition party waits") || entry.sql.includes("activity = 'party_wait'"));
        assert(partyWaitMigration, 'startup must move legacy acquisition waits out of the rest scheduler');
        return BotLifeState.upsertState({
            characterId: 42, name: 'PersistenceProbe', level: 42, phase: 'cold', activity: 'hunting',
            timing: { activityStartedAt: 1, nextResolveAt: 2, lastResolvedAt: 1 },
            vitals: {}, stats: { classId: 31 }, inventory: {}
        }, 'persistence_probe').then(() => {
            const save = statements.find((entry) => entry.sql.includes('ON DUPLICATE KEY UPDATE'));
            assert(save.sql.includes('nextResolveAt = VALUES(nextResolveAt)'), 'persisted cold resolve timing must advance after every tick');
            assert(save.sql.includes('lastResolvedAt = VALUES(lastResolvedAt)'), 'persisted cold resolve history must survive an upsert');
            assert(save.sql.includes('inventorySummary = VALUES(inventorySummary)'), 'background drop rewards must persist after an upsert');
            return BotLifeState.migrateLegacyClassProgression(1).then((migrated) => {
                assert.strictEqual(migrated.length, 1, 'legacy cold bots without progression markers must be migrated');
                const classUpdate = statements.filter((entry) => entry.sql.includes('classId')).at(-1);
                assert(classUpdate, 'migration must persist the profession on the physical character');
                assert.ok([36, 37].includes(classUpdate.params[0]), 'migration must use the physical character class as its source of truth');
                return BotLifeState.dueCold(5, 1000);
            });
        }).then(() => {
            const due = statements.find((entry) => entry.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 0"));
            assert(due.sql.includes('rateModelVersion'), 'due cold states must prioritize persisted plans from an older drop-rate model');
            assert(due.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 0"), 'due cold states must promptly finish travel and crafting transitions');
            assert(due.sql.includes("startup_craft_wait_recovery"), 'startup craft recovery must immediately replan before the ordinary hunting backlog');
            assert(due.sql.includes('COALESCE(nextResolveAt, 0) ASC'), 'due cold states must remain fair by schedule within each lifecycle bucket');
            return BotLifeState.assignParty({
                characterId: 43,
                name: 'PartyWaitAssignmentProbe',
                phase: 'cold',
                activity: 'party_wait',
                timing: { nextResolveAt: 9000 },
                vitals: {},
                stats: { lastReason: 'acquisition_party_wait', partyWaitUntil: 9000 },
                inventory: {}
            }, 'bgp_probe', 'healer', 42).then((assigned) => {
                assert.strictEqual(assigned.activity, 'grouped', 'a formed party must release its waiting member into the group lifecycle');
                assert.strictEqual(assigned.stats.partyWaitUntil, null, 'assigned members must not retain an obsolete wait deadline');
                return BotLifeState.coldPartyCandidates(5);
            }).then(() => {
                const candidates = statements.find((entry) => entry.sql.includes("activity IN ('hunting', 'resting', 'party_wait')"));
                assert(candidates, 'party formation must see event-scheduled party waits without making them combat-due');
                return BotLifeState.coldPartyCandidates(5, true);
            }).then(() => {
                const requiredCandidates = statements.find((entry) => entry.sql.includes("states.activity = 'party_wait'"));
                assert(requiredCandidates, 'a real party-wait backlog must reserve formation capacity ahead of elective hunting parties');
                const member = {
                    characterId: 44,
                    name: 'PartyTelemetryProbe',
                    level: 20,
                    phase: 'cold',
                    activity: 'grouped',
                    party: { partyId: 'bgp_probe' },
                    timing: { nextResolveAt: 9000 },
                    vitals: { hp: 400, maxHp: 400, mp: 200, maxMp: 200 },
                    stats: {
                        lastResolveDebug: { targetNpcId: null },
                        targetCombat: { targets: {}, populationTargets: {} }
                    },
                    inventory: {}
                };
                return BotLifeState.applyResolve(member, {
                    patch: {
                        activity: 'grouped',
                        vitals: member.vitals,
                        // This mirrors the projected snapshot that a party
                        // resolver returns after a fight.
                        stats: { ...member.stats, coldCombat: { cooldowns: {} } }
                    },
                    materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: 10000,
                    debug: {
                        partyId: 'bgp_probe',
                        aggregate: true,
                        populationTelemetryOwner: true,
                        targetNpcId: 93,
                        defeatedNpcIds: [93]
                    }
                });
            }).then(() => {
                const partySave = statements.filter((entry) => entry.sql.includes('ON DUPLICATE KEY UPDATE')).at(-1);
                const persistedStats = JSON.parse(partySave.params[27]);
                assert.strictEqual(persistedStats.lastResolveDebug.partyId, 'bgp_probe', 'a party result must not be replaced by its previous solo debug snapshot');
                assert.strictEqual(persistedStats.targetCombat.populationTargets['93'].targetKills, 1, 'a party result must retain its shared target telemetry');
            });
        }).then(() => {
            console.log('Bot population state checks passed');
        });
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    }).finally(() => {
        Database.execute = originalExecute;
    });
} catch (err) {
    Database.execute = originalExecute;
    throw err;
}

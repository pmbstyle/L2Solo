const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

DataCache.init();

const originalExecute = Database.execute;
const originalSyncInventorySummary = Database.syncInventorySummary;
const originalUpdateCharacterLocation = Database.updateCharacterLocation;
const originalUpdateCharacterExperience = Database.updateCharacterExperience;
const originalUpdateCharacterVitals = Database.updateCharacterVitals;
const originalFetchSkills = Database.fetchSkills;
const originalFetchSkill = Database.fetchSkill;
const originalSetSkill = Database.setSkill;
const originalUpdateSkillLevel = Database.updateSkillLevel;
const originalUpdateCharacterClassId = Database.updateCharacterClassId;
const statements = [];
const classUpdates = [];

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
    Database.syncInventorySummary = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterExperience = () => Promise.resolve();
    Database.updateCharacterVitals = () => Promise.resolve();
    Database.fetchSkills = () => Promise.resolve([]);
    Database.fetchSkill = () => Promise.resolve([]);
    Database.setSkill = () => Promise.resolve();
    Database.updateSkillLevel = () => Promise.resolve();
    Database.updateCharacterClassId = (characterId, classId) => {
        classUpdates.push({ characterId, classId });
        return Promise.resolve();
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
        const dissolvedPartyRecovery = statements.find((entry) => entry.sql.includes('orphaned_dissolved_party'));
        assert(dissolvedPartyRecovery, 'startup must release members left behind by a dissolved background party');
        assert(dissolvedPartyRecovery.sql.includes('SET partyId = NULL'), 'orphan recovery must clear the persisted party id');
        assert(dissolvedPartyRecovery.sql.includes("WHEN activity = 'grouped' THEN 'hunting'"), 'orphan recovery must return grouped members to an actionable solo state');
        assert(dissolvedPartyRecovery.sql.includes("status <> 'active'"), 'active background parties must survive startup recovery');
        const craftRecovery = statements.find((entry) => entry.sql.includes("startup_craft_wait_recovery"));
        assert(craftRecovery, 'bot life init must release stale craft waits after a restart');
        assert(craftRecovery.sql.includes("AND activity = 'crafting'"), 'only stale station waits should be recovered as hunters');
        assert.strictEqual(craftRecovery.params[1], craftRecovery.params[0], 'recovered craft waits must be due immediately for their replan');
        const partyWaitMigration = statements.find((entry) => entry.sql.includes("migrated %d acquisition party waits") || entry.sql.includes("activity = 'party_wait'"));
        assert(partyWaitMigration, 'startup must move legacy acquisition waits out of the rest scheduler');
        const invalidPlanMigration = statements.find((entry) => entry.sql.includes("json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan')"));
        assert(invalidPlanMigration, 'startup must discard malformed persisted equipment plans that passive bots would not otherwise replan');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.target.selfId'"), 'the invalid-plan migration must validate the persisted target identity');
        return BotLifeState.upsertState({
            characterId: 42, name: 'PersistenceProbe', level: 42, phase: 'cold', activity: 'hunting',
            timing: { activityStartedAt: 1, nextResolveAt: 2, lastResolvedAt: 1 },
            vitals: {}, stats: { classId: 31 }, inventory: {}
        }, 'persistence_probe').then(() => {
            const save = statements.find((entry) => entry.sql.includes('ON CONFLICT(characterId) DO UPDATE'));
            assert(save.sql.includes('nextResolveAt = excluded.nextResolveAt'), 'persisted cold resolve timing must advance after every tick');
            assert(save.sql.includes('lastResolvedAt = excluded.lastResolvedAt'), 'persisted cold resolve history must survive an upsert');
            assert(save.sql.includes('inventorySummary = excluded.inventorySummary'), 'background drop rewards must persist after an upsert');
            return BotLifeState.migrateLegacyClassProgression(1).then((migrated) => {
                assert.strictEqual(migrated.length, 1, 'legacy cold bots without progression markers must be migrated');
                const classUpdate = classUpdates.at(-1);
                assert(classUpdate, 'migration must persist the profession on the physical character');
                assert.ok([36, 37].includes(classUpdate.classId), 'migration must use the physical character class as its source of truth');
                return BotLifeState.dueCold(5, 1000);
            });
        }).then(() => {
            const due = statements.find((entry) => entry.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 1"));
            assert(due.sql.includes('rateModelVersion'), 'due cold states must prioritize persisted plans from an older drop-rate model');
            assert(due.sql.includes(`< ${GearPlanner.RATE_MODEL_VERSION}`), 'due cold states must prioritize plans from the current model rollout rather than a stale hard-coded version');
            assert(due.sql.includes("OR (activity = 'hunting' AND (json_extract(statsJson, '$.equipmentPlan.expectedKills') IS NOT NULL"), 'a stale active combat plan must bypass its old next-resolve deadline for an immediate safety replan');
            assert(due.sql.indexOf("WHEN json_extract(statsJson, '$.equipmentPlan.expectedKills') IS NOT NULL") < due.sql.indexOf("WHEN activity IN ('traveling', 'crafting') THEN 1"), 'a stale active plan must outrank ordinary travel and crafting transitions');
            assert(due.sql.includes("WHEN activity IN ('traveling', 'crafting') THEN 1"), 'due cold states must promptly finish travel and crafting transitions after an urgent combat-safety replan');
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
                const partySave = statements.filter((entry) => entry.sql.includes('ON CONFLICT(characterId) DO UPDATE')).at(-1);
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
        Database.syncInventorySummary = originalSyncInventorySummary;
        Database.updateCharacterLocation = originalUpdateCharacterLocation;
        Database.updateCharacterExperience = originalUpdateCharacterExperience;
        Database.updateCharacterVitals = originalUpdateCharacterVitals;
        Database.fetchSkills = originalFetchSkills;
        Database.fetchSkill = originalFetchSkill;
        Database.setSkill = originalSetSkill;
        Database.updateSkillLevel = originalUpdateSkillLevel;
        Database.updateCharacterClassId = originalUpdateCharacterClassId;
    });
} catch (err) {
    Database.execute = originalExecute;
    Database.syncInventorySummary = originalSyncInventorySummary;
    Database.updateCharacterLocation = originalUpdateCharacterLocation;
    Database.updateCharacterExperience = originalUpdateCharacterExperience;
    Database.updateCharacterVitals = originalUpdateCharacterVitals;
    Database.fetchSkills = originalFetchSkills;
    Database.fetchSkill = originalFetchSkill;
    Database.setSkill = originalSetSkill;
    Database.updateSkillLevel = originalUpdateSkillLevel;
    Database.updateCharacterClassId = originalUpdateCharacterClassId;
    throw err;
}

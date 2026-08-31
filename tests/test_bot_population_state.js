const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');

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
const originalRecoverStartupLeases = ColdSimulationOwner.recoverStartupLeases;
const statements = [];
const classUpdates = [];
let stalePartyRows = [];
let marketCandidateRows = [];

try {
    ColdSimulationOwner.recoverStartupLeases = () => Promise.resolve({ affectedRows: 0 });
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        if (String(sql).startsWith('SELECT id, classId, level, exp, sp FROM characters')) {
            return Promise.resolve([{ id: 42, classId: 31, level: 42, exp: 0, sp: 0 }]);
        }
        if (String(sql).startsWith('SELECT characterId, statsJson FROM bot_life_state')) {
            return Promise.resolve(stalePartyRows);
        }
        if (String(sql).startsWith('UPDATE bot_life_state')) {
            if (String(sql).includes("'$.partyRequest.lastReason'")) return Promise.resolve({ affectedRows: 1 });
            return Promise.resolve({ affectedRows: 2 });
        }
        if (String(sql).includes('marketSellRetryAfter') && String(sql).includes('FROM bot_life_state states')) {
            return Promise.resolve(marketCandidateRows);
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
        const partyWaitMigration = statements.find((entry) => entry.sql.includes("SET activity = 'hunting'")
            && entry.sql.includes("lastReason') = 'acquisition_party_wait'"));
        assert(partyWaitMigration, 'startup must move legacy acquisition requests back to actionable hunting');
        assert(partyWaitMigration.sql.includes("'$.partyWaitUntil', NULL"), 'startup must clear the obsolete blocking wait deadline');
        const passivePartyRequestCleanup = statements.find((entry) => entry.sql.includes("json_remove(COALESCE(statsJson, '{}'), '$.partyRequest')")
            && entry.sql.includes("activity IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead')"));
        assert(passivePartyRequestCleanup, 'startup must clear party requests from passive activities that cannot join formation');
        assert(passivePartyRequestCleanup.sql.includes("partyRequestStatus = 'open'"), 'passive cleanup must use the generated request projection');
        const stalePartyRequestCleanup = statements.find((entry) => entry.sql.includes("'$.partyRequest.deferredUntil'")
            && entry.sql.includes('partyRequestedAt <=')
            && entry.sql.includes("'$.partyRequest.status', 'deferred'"));
        assert(stalePartyRequestCleanup, 'startup must defer party requests that already exceeded their priority-specific TTL');
        assert(stalePartyRequestCleanup.sql.includes('partyRequestPriority'), 'TTL cleanup must use the generated priority projection');
        const invalidPlanMigration = statements.find((entry) => entry.sql.includes("json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan'"));
        assert(invalidPlanMigration, 'startup must discard malformed persisted equipment plans that passive bots would not otherwise replan');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.target.selfId'"), 'the invalid-plan migration must validate the persisted target identity');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.rateModelVersion'"),
            'startup must immediately discard routes from a superseded source model');
        assert(invalidPlanMigration.sql.includes("activity = 'hunting'"),
            'startup model invalidation must not reset passive market, craft, or blocked workflows');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.clanGoal.clanId'"),
            'startup model invalidation must also reset stale clan routes whose assignee is temporarily passive');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.status') = 'active'"),
            'startup model invalidation must preserve inactive acquisition plans');
        assert(invalidPlanMigration.sql.includes("'$.equipmentPlan.expectedKills') IS NOT NULL"),
            'startup model invalidation must only reset combat-rate routes');
        assert.strictEqual(invalidPlanMigration.params[1], GearPlanner.RATE_MODEL_VERSION,
            'startup invalidation must track the current planner model instead of a stale literal');
        const migrationProbe = new DatabaseSync(':memory:');
        try {
            migrationProbe.exec(`CREATE TABLE bot_life_state (
                characterId INTEGER PRIMARY KEY,
                activity TEXT NOT NULL,
                statsJson TEXT NOT NULL,
                updatedAt INTEGER NOT NULL
            )`);
            const insertProbe = migrationProbe.prepare(`INSERT INTO bot_life_state
                (characterId, activity, statsJson, updatedAt) VALUES (?, ?, ?, 0)`);
            const staleVersion = GearPlanner.RATE_MODEL_VERSION - 1;
            const validTarget = { selfId: 100, name: 'Valid Target' };
            [
                [1, 'hunting', { status: 'active', strategy: 'direct_drop', expectedKills: 10, rateModelVersion: staleVersion, target: validTarget }],
                [2, 'hunting', { status: 'blocked', strategy: 'blocked', rateModelVersion: staleVersion, target: validTarget }],
                [3, 'shopping', { status: 'active', strategy: 'market', rateModelVersion: staleVersion, target: validTarget }],
                [4, 'crafting', { status: 'ready_to_craft', strategy: 'craft', rateModelVersion: staleVersion, target: validTarget }],
                [5, 'crafting', { status: 'component_ready', strategy: 'craft', rateModelVersion: staleVersion, target: validTarget }],
                [6, 'merchant', { status: 'blocked', strategy: 'blocked', rateModelVersion: GearPlanner.RATE_MODEL_VERSION, target: { selfId: 0, name: '' } }],
                [7, 'resting', { status: 'active', strategy: 'direct_drop', expectedKills: 5000, rateModelVersion: staleVersion, target: validTarget, clanGoal: { clanId: 10 } }],
                [8, 'grouped', { status: 'active', strategy: 'direct_drop', expectedKills: 5000, rateModelVersion: GearPlanner.RATE_MODEL_VERSION, target: validTarget, clanGoal: { clanId: 10 } }]
            ].forEach(([characterId, activity, equipmentPlan]) => insertProbe.run(
                characterId,
                activity,
                JSON.stringify({ equipmentPlan, partyRequest: { status: 'open' }, clanPartyObjective: { clanId: 1 } })
            ));
            migrationProbe.prepare(invalidPlanMigration.sql).run(...invalidPlanMigration.params);
            const retainedPlanIds = migrationProbe.prepare(`SELECT characterId FROM bot_life_state
                WHERE json_extract(statsJson, '$.equipmentPlan.target') IS NOT NULL ORDER BY characterId`).all()
                .map((row) => Number(row.characterId));
            assert.deepStrictEqual(retainedPlanIds, [2, 3, 4, 5, 8],
                'startup model invalidation must remove stale hunting and clan combat routes without resetting unrelated passive workflows');
        } finally {
            migrationProbe.close();
        }
        const fulfilledPlanMigration = statements.find((entry) => entry.sql.includes('fulfilled_equipment_plans'));
        assert(fulfilledPlanMigration, 'startup must discard equipment plans whose exact target slot is already equipped');
        assert(fulfilledPlanMigration.sql.includes('json_each'), 'fulfilled paired-slot plans must inspect their persisted equipped slots');
        assert(fulfilledPlanMigration.sql.includes('targets.targetSlot IN (7, 14)'),
            'persisted weapon plans must treat one- and two-handed paperdoll slots as one fulfillment group');
        assert(fulfilledPlanMigration.sql.includes('combineResultId'),
            'startup must not discard a dual-sword objective merely because its purchased component is equipped');
        assert(fulfilledPlanMigration.sql.includes("'$.partyRequest'"), 'finishing a persisted gear target must clear its obsolete party request');
        const reconciledPlan = BotLifeState.reconcileFulfilledEquipmentPlan({
            stats: {
                equipmentPlan: { target: { selfId: 878, slot: 5 } },
                partyRequest: { status: 'open' }
            },
            inventory: {
                878: { selfId: 878, amount: 2, equipped: true, equippedSlots: [4, 5], slot: 4 }
            }
        });
        assert.strictEqual(reconciledPlan.stats.equipmentPlan, undefined,
            'every runtime persistence path must discard a plan already fulfilled by a paired paperdoll slot');
        assert.strictEqual(reconciledPlan.stats.partyRequest, undefined,
            'runtime plan reconciliation must clear the obsolete party request too');
        const reconciledWeaponPlan = BotLifeState.reconcileFulfilledEquipmentPlan({
            stats: {
                equipmentPlan: { target: { selfId: 93, slot: 7 } },
                partyRequest: { status: 'open' }
            },
            inventory: {
                93: { selfId: 93, amount: 1, equipped: true, equippedSlots: [14], slot: 14 }
            }
        });
        assert.strictEqual(reconciledWeaponPlan.stats.equipmentPlan, undefined,
            'a two-handed item must fulfill a weapon plan recorded with the canonical weapon slot');
        const retainedDualComponentPlan = BotLifeState.reconcileFulfilledEquipmentPlan({
            stats: {
                equipmentPlan: {
                    target: { selfId: 129, slot: 7 },
                    combine: { resultId: 2523, requirements: [{ selfId: 123, amount: 1 }, { selfId: 129, amount: 1 }] }
                }
            },
            inventory: {
                129: { selfId: 129, amount: 1, equipped: true, equippedSlots: [7], slot: 7 }
            }
        });
        assert(retainedDualComponentPlan.stats.equipmentPlan,
            'equipping a newly purchased component sword must retain the final dual-sword objective');
        const reconciledDagger = BotLifeState.reconcileEquipmentInventory({
            level: 20,
            stats: { classId: 7, role: 'dagger' },
            inventory: {
                625: { selfId: 625, name: 'Bone Shield', amount: 1, equipped: true, equippedSlots: [8], slot: 8 }
            }
        });
        assert.strictEqual(reconciledDagger.inventory['625'].equipped, false,
            'class-aware lifecycle reconciliation must remove a shield after a class transition');
        const reconciledPoleShield = BotLifeState.reconcileIncompatibleShieldState({
            level: 40,
            stats: {
                classId: 55,
                role: 'dps',
                equipmentPlan: { strategy: 'market', target: { selfId: 626, name: 'Bronze Shield', slot: 8 } },
                partyRequest: { status: 'open' }
            },
            inventory: {
                93: { selfId: 93, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [14], slot: 14, kind: 'Weapon.Pole', rank: 'd' },
                626: { selfId: 626, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [8], slot: 8, kind: 'Armor.Shield', rank: 'd' }
            }
        });
        assert.strictEqual(reconciledPoleShield.inventory['626'].equipped, false,
            'startup reconciliation must remove a shield from a profile that permits shields but currently uses a polearm');
        assert.strictEqual(reconciledPoleShield.stats.equipmentPlan, undefined,
            'startup reconciliation must discard the incompatible persisted shield plan');
        assert.strictEqual(reconciledPoleShield.stats.partyRequest, undefined,
            'discarding an incompatible shield plan must clear its obsolete party request');
        return BotLifeState.upsertState({
            characterId: 42, name: 'PersistenceProbe', level: 42, phase: 'cold', activity: 'hunting',
            timing: { activityStartedAt: 1, nextResolveAt: 2, lastResolvedAt: 1 },
            vitals: {}, stats: {
                classId: 31,
                partyRequest: {
                    status: 'open',
                    priority: 'required',
                    requestedAt: Date.now() - 60 * 60 * 1000,
                    objectiveKey: 'farm:probe:99'
                }
            }, inventory: {}
        }, 'persistence_probe').then(() => {
            const save = statements.find((entry) => entry.sql.includes('ON CONFLICT(characterId) DO UPDATE'));
            assert(save.sql.includes('nextResolveAt = excluded.nextResolveAt'), 'persisted cold resolve timing must advance after every tick');
            assert(save.sql.includes('lastResolvedAt = excluded.lastResolvedAt'), 'persisted cold resolve history must survive an upsert');
            assert(save.sql.includes('inventorySummary = excluded.inventorySummary'), 'background drop rewards must persist after an upsert');
            assert(save.sql.includes("WHERE bot_life_state.simulationOwner = 'legacy_main'"), 'legacy saves must not overwrite a cold owner lease');
            stalePartyRows = [{
                characterId: 42,
                statsJson: JSON.stringify({
                    partyRequest: {
                        status: 'open',
                        priority: 'required',
                        requestedAt: Date.now() - 60 * 60 * 1000,
                        objectiveKey: 'farm:probe:99'
                    }
                })
            }];
            const cleanupStart = statements.length;
            return BotLifeState.expireStalePartyRequests(100).then((expired) => {
                assert.strictEqual(expired, 2, 'TTL cleanup should report the affected rows');
                const cleanupUpdate = statements.slice(cleanupStart).find((entry) => entry.sql.startsWith('UPDATE bot_life_state'));
                assert(cleanupUpdate, 'periodic TTL cleanup must execute its update');
                assert.strictEqual(cleanupUpdate.params.length, 6, 'bounded TTL cleanup must bind only the predicates present in its subquery');
                assert.strictEqual(BotLifeState.cachedState(42).stats.partyRequest.status, 'deferred', 'TTL cleanup must refresh the lifecycle cache');
                assert.strictEqual(BotLifeState.partyRequestSummary().total, 0, 'TTL cleanup must remove expired requests from telemetry');
            });
        }).then(() => BotLifeState.migrateLegacyClassProgression(1).then((migrated) => {
                assert.strictEqual(migrated.length, 1, 'legacy cold bots without progression markers must be migrated');
                const classUpdate = classUpdates.at(-1);
                assert(classUpdate, 'migration must persist the profession on the physical character');
                assert.ok([36, 37].includes(classUpdate.classId), 'migration must use the physical character class as its source of truth');
                marketCandidateRows = [
                    { characterId: 71, characterName: 'MarketCursorA', phase: 'cold', activity: 'hunting', updatedAt: 10 },
                    { characterId: 72, characterName: 'MarketCursorB', phase: 'cold', activity: 'hunting', updatedAt: 10 }
                ];
                return BotLifeState.dueCold(5, 1000)
                    .then(() => BotLifeState.marketGoalCandidates(5, 123456))
                    .then(() => BotLifeState.marketGoalCandidates(5, 123457));
            }))
        .then(() => {
            const due = statements.find((entry) => entry.sql.includes("WHEN activity IN ('traveling', 'shopping', 'crafting') THEN 1"));
            assert(due.sql.includes('rateModelVersion'), 'due cold states must prioritize persisted plans from an older drop-rate model');
            assert(due.sql.includes(`< ${GearPlanner.RATE_MODEL_VERSION}`), 'due cold states must prioritize plans from the current model rollout rather than a stale hard-coded version');
            assert(due.sql.includes("OR (activity = 'hunting' AND (json_extract(statsJson, '$.equipmentPlan.status') = 'active'"), 'only active stale combat plans must bypass their old next-resolve deadline for an immediate safety replan');
            const stalePlanOrder = due.sql.indexOf("WHEN json_extract(statsJson, '$.equipmentPlan.status') = 'active'");
            assert(stalePlanOrder >= 0 && stalePlanOrder < due.sql.indexOf("WHEN activity IN ('traveling', 'shopping', 'crafting') THEN 1"), 'a stale active plan must outrank ordinary market, travel, and crafting transitions');
            assert(due.sql.includes("WHEN activity IN ('traveling', 'shopping', 'crafting') THEN 1"), 'due cold states must promptly finish market, travel, and crafting transitions after an urgent combat-safety replan');
            assert(due.sql.includes("json_extract(statsJson, '$.equipmentPlan.next.spotId')"), 'due cold states must prioritize active gear plans whose source spot differs from the saved spot');
            assert(due.sql.includes("startup_craft_wait_recovery"), 'startup craft recovery must immediately replan before the ordinary hunting backlog');
            assert(due.sql.includes('COALESCE(nextResolveAt, 0) ASC'), 'due cold states must remain fair by schedule within each lifecycle bucket');
            const marketCandidateQueries = statements.filter((entry) => entry.sql.includes("FROM bot_life_state states")
                && entry.sql.includes("marketSellRetryAfter"));
            const marketCandidates = marketCandidateQueries[0];
            assert(marketCandidates, 'market reconciliation must query current lifecycle market state');
            assert(!marketCandidates.sql.includes('goalJson LIKE'), 'market reconciliation must not trust stale goal metadata');
            assert(marketCandidates.sql.includes("'$.marketSellRetryAfter'"), 'market reconciliation must exclude sellers whose retry cooldown is still active');
            assert(marketCandidates.sql.includes('INDEXED BY bot_life_state_market_reconcile'),
                'market reconciliation must use its keyset-compatible lifecycle index');
            assert(!marketCandidates.sql.includes('COALESCE(states.updatedAt'),
                'a redundant updatedAt expression must not force a temporary sort');
            assert(marketCandidates.sql.includes('states.characterId > ?'), 'market reconciliation must advance with a stable keyset cursor');
            assert.deepStrictEqual(marketCandidates.params, [123456, 0, 0, 0], 'the first market pass must start at the beginning of the rotation');
            assert.deepStrictEqual(marketCandidateQueries[1].params, [123457, 10, 10, 72],
                'the next market pass must continue after the last projected lifecycle row');
            return BotLifeState.staleGoalCandidates(5, 123456).then(() => {
                const staleGoals = statements.at(-1);
                assert(staleGoals.sql.includes('INNER JOIN bot_goal_state goals'), 'goal metadata review must read persisted goal rows');
                assert(staleGoals.sql.includes("'$.nextReviewAt'"), 'goal metadata review must select rows whose review deadline is due');
                assert.deepStrictEqual(staleGoals.params, [123456], 'goal metadata review must bind the current review cutoff');
                return BotLifeState.deferUnformablePartyRequests([42], 'no_compatible_level_match').then((deferred) => {
                    const deferUpdate = statements.at(-1);
                    assert.strictEqual(deferred, 1, 'an unformable required group must close its active requests as a batch');
                    assert(deferUpdate.sql.includes("'$.partyRequest.lastReason'"), 'unformable party cleanup must persist its reason');
                    assert.strictEqual(deferUpdate.params[3], 'no_compatible_level_match', 'unformable party cleanup must persist the classification');
                });
            }).then(() => BotLifeState.assignParty({
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
                assert.strictEqual(assigned.stats.partyRequest, null, 'assigned members must clear the outstanding party request');
                return BotLifeState.assignParty({
                    characterId: 46,
                    name: 'RestingPartyProbe',
                    phase: 'cold',
                    activity: 'resting',
                    timing: { nextResolveAt: 9000 },
                    stats: {
                        restUntil: Date.now() + 60000,
                        partyRequest: { status: 'open', priority: 'required' }
                    },
                    vitals: {},
                    inventory: {}
                }, 'bgp_probe', 'dps', 42).then((restingAssigned) => {
                    assert.strictEqual(restingAssigned.activity, 'resting', 'assigning a resting requester must not wake it into combat');
                    assert(restingAssigned.stats.restUntil > Date.now(), 'assigning a resting requester must preserve its recovery deadline');
                    const candidateQueryStart = statements.length;
                    return BotLifeState.coldPartyCandidates(5).then(() => {
                        const candidates = statements.slice(candidateQueryStart)
                            .find((entry) => entry.sql.includes('party_spots.candidateCount'));
                        assert(candidates, 'party formation must see event-scheduled party waits without making them combat-due');
                        const requiredRank = candidates.sql.indexOf("eligible.partyRequestPriority = 'required' THEN 0");
                        const preferredRank = candidates.sql.indexOf("eligible.partyRequestStatus = 'open' THEN 1");
                        const generalRank = candidates.sql.indexOf('ELSE 2');
                        const populationRank = candidates.sql.indexOf('party_spots.candidateCount DESC');
                        assert(requiredRank >= 0 && requiredRank < preferredRank, 'required requests must rank ahead of preferred requests');
                        assert(preferredRank < generalRank && generalRank < populationRank, 'all open requests must rank ahead of crowded general candidate grounds');
                        assert(candidates.sql.includes("simulationOwner = 'legacy_main'"), 'party spot counts must exclude cold-worker-owned rows');
                        assert(candidates.sql.includes('partyObjectiveSpot AS candidateSpot'), 'party formation must use the indexed objective projection');
                        assert(!candidates.sql.includes('json_extract'), 'party formation must not parse full JSON state while ranking candidates');
                        assert(candidates.sql.indexOf('LIMIT 5') < candidates.sql.indexOf('SELECT states.*'), 'party formation must rank lightweight ids before loading full state blobs');
                        assert(candidates.sql.includes('ORDER BY'), 'party candidate query must retain deterministic bounded ordering');
                    });
                });
            }).then(() => BotLifeState.coldPartyCandidates(5, true)).then(() => {
                const requiredCandidates = statements.find((entry) => entry.sql.includes('partyRequestPriority') && entry.sql.includes("'required'"));
                assert(requiredCandidates, 'required party requests must reserve formation capacity ahead of elective hunting parties');
                return BotLifeState.coldPartyCandidateCount(true).then(() => {
                    const count = statements.find((entry) => entry.sql.includes('COUNT(*) AS candidateCount'));
                    assert(count, 'party capacity planning must be able to measure the full wait backlog');
                    assert(count.sql.includes("simulationOwner = 'legacy_main'"), 'party capacity counts must exclude cold-worker-owned rows');
                    return BotLifeState.coldPartyCandidatesForSpots(['cruma', 'dion'], 3, true);
                }).then(() => {
                    const fairCandidates = statements.find((entry) => entry.sql.includes('ROW_NUMBER() OVER') && entry.sql.includes('PARTITION BY'));
                    assert(fairCandidates, 'party recruitment must load a bounded fair sample per active spot');
                    assert(fairCandidates.sql.includes("simulationOwner = 'legacy_main'"), 'party recruitment must exclude cold-worker-owned rows');
                    assert(fairCandidates.sql.includes('PARTITION BY partyObjectiveSpot'), 'party recruitment must rank the indexed objective projection');
                    assert(!fairCandidates.sql.includes('json_extract'), 'party recruitment must not parse JSON while ranking candidates');
                    const clearPartyStart = statements.length;
                    return BotLifeState.clearParty('bgp_cleanup_probe', 'ownership_aware_cleanup').then(() => {
                        const clearPartyQuery = statements.slice(clearPartyStart)
                            .find((entry) => entry.sql.includes('AND partyId = ?') && entry.sql.includes('simulationOwner = ?'));
                        assert(clearPartyQuery, 'party cleanup must query only rows owned by the main lifecycle');
                        assert.deepStrictEqual(clearPartyQuery.params, ['bgp_cleanup_probe', 'legacy_main']);
                    });
                }).then(() => {
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
                            classId: 0,
                            classProgressionLevel: 20,
                            classProgressionClassId: 0,
                            fightsWon: 4,
                            fightsResolved: 6,
                            deaths: 2,
                            expEarned: 1000,
                            spEarned: 100,
                            adenaEarned: 500,
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
                        materialize: { exp: 120, sp: 13, adena: 80, items: [] },
                        nextResolveAt: 10000,
                        debug: {
                            partyId: 'bgp_probe',
                            fights: 3,
                            wins: 2,
                            aggregate: true,
                            populationTelemetryOwner: true,
                            targetNpcId: 93,
                            defeatedNpcIds: [93]
                        }
                    }).then((resolvedMember) => {
                        assert.strictEqual(resolvedMember.stats.fightsWon, 6, 'a projected party stats snapshot must not erase newly won fights');
                        assert.strictEqual(resolvedMember.stats.fightsResolved, 9, 'a projected party stats snapshot must not erase newly resolved fights');
                        assert.strictEqual(resolvedMember.stats.deaths, 2, 'a non-lethal party resolve must preserve the cumulative death count');
                        assert.strictEqual(resolvedMember.stats.expEarned, 1120, 'a projected party stats snapshot must not erase earned EXP telemetry');
                        assert.strictEqual(resolvedMember.stats.spEarned, 113, 'a projected party stats snapshot must not erase earned SP telemetry');
                        assert.strictEqual(resolvedMember.stats.adenaEarned, 580, 'a projected party stats snapshot must not erase earned Adena telemetry');
                        assert.deepStrictEqual(resolvedMember.stats.coldCombat, { cooldowns: {} }, 'resolver-specific patch stats must still survive the authoritative counter merge');
                        return resolvedMember;
                    });
                });
                }).then(() => {
                    const partySave = statements.filter((entry) => entry.sql.includes('ON CONFLICT(characterId) DO UPDATE')).at(-1);
                    const persistedStats = JSON.parse(partySave.params[27]);
                    assert.strictEqual(persistedStats.lastResolveDebug.partyId, 'bgp_probe', 'a party result must not be replaced by its previous solo debug snapshot');
                    assert.strictEqual(persistedStats.targetCombat.populationTargets['93'].targetKills, 1, 'a party result must retain its shared target telemetry');
                    assert.strictEqual(persistedStats.targetCombat.targets, undefined, 'obsolete per-bot target maps must not be persisted');
                    const deadProbe = {
                        characterId: 45,
                        name: 'DeadPartyRequestProbe',
                        level: 20,
                        phase: 'cold',
                        activity: 'hunting',
                        exp: 500,
                        sp: 50,
                        adena: 100,
                        stats: {
                            classId: 0,
                            classProgressionLevel: 20,
                            classProgressionClassId: 0,
                            fightsWon: 10,
                            fightsResolved: 12,
                            deaths: 2,
                            expEarned: 100,
                            spEarned: 20,
                            adenaEarned: 50,
                            partyRequest: { status: 'open', priority: 'required' }
                        },
                        timing: {},
                        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
                        inventory: {}
                    };
                    return BotLifeState.applyResolve(deadProbe, {
                        patch: {
                            activity: 'dead',
                            deathCount: 3,
                            vitals: { hp: 0, maxHp: 100, mp: 0, maxMp: 50 },
                            stats: { ...deadProbe.stats, coldCombat: { cooldowns: { 3: 9000 } } }
                        },
                        materialize: { exp: 40, sp: 5, adena: 30, items: [] },
                        nextResolveAt: 10000,
                        debug: { fights: 2, wins: 1, deaths: 1 }
                    }).then((deadState) => {
                        assert.strictEqual(deadState.stats.partyRequest, null, 'dead bots must not retain open party requests');
                        assert.strictEqual(deadState.stats.fightsWon, 11, 'a lethal resolve must retain wins completed before death');
                        assert.strictEqual(deadState.stats.fightsResolved, 14, 'a lethal resolve must retain all attempted fights');
                        assert.strictEqual(deadState.stats.deaths, 3, 'a stale patch stats snapshot must not reset the new death count');
                        assert.strictEqual(deadState.stats.expEarned, 140, 'a lethal resolve must retain earned EXP telemetry');
                        assert.strictEqual(deadState.stats.spEarned, 25, 'a lethal resolve must retain earned SP telemetry');
                        assert.strictEqual(deadState.stats.adenaEarned, 80, 'a lethal resolve must retain earned Adena telemetry');
                        const respawnAt = Date.now() + 1000;
                        const recovery = BackgroundResolver.resolveSolo({ state: deadState, timestamp: respawnAt });
                        return BotLifeState.applyResolve(deadState, recovery).then((recoveredState) => {
                            assert.strictEqual(recoveredState.stats.deaths, 3, 'death recovery must preserve the cumulative death count');
                            assert.strictEqual(recoveredState.stats.fightsWon, 11, 'death recovery must preserve cumulative wins');
                            assert.strictEqual(recoveredState.stats.fightsResolved, 14, 'death recovery must preserve cumulative fights');
                            assert.strictEqual(recoveredState.stats.lastRespawnAt, respawnAt, 'resolver-specific respawn telemetry must survive the counter merge');
                        });
                    });
                }));
        }).then(() => BotLifeState.upsertState({
            characterId: 99,
            name: 'StaleSummaryProbe',
            level: 20,
            phase: 'cold',
            activity: 'hunting',
            timing: { nextResolveAt: 999999 },
            stats: {
                equipmentPlan: {
                    status: 'active',
                    expectedKills: 5,
                    rateModelVersion: GearPlanner.RATE_MODEL_VERSION - 1
                }
            },
            vitals: {},
            inventory: {}
        }, 'summary_probe').then(() => {
            const summary = BotLifeState.coldDueSummary(1000);
            assert(summary.due >= 1, 'cold due telemetry must include stale hunting plans before their persisted deadline');
        })).then(() => {
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
        ColdSimulationOwner.recoverStartupLeases = originalRecoverStartupLeases;
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
    ColdSimulationOwner.recoverStartupLeases = originalRecoverStartupLeases;
    throw err;
}

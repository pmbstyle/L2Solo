const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-population-state-'));
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);

require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;

const Database = invoke('Database');
Database.init();
const originalReconcileClanGoals = Database.reconcileBotClanGoals;
const originalFetchMarketCounts = Database.fetchBotMarketCounts;
const DataCache = invoke('GameServer/DataCache');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

DataCache.init();

const originalExecute = Database.execute;
const originalSaveLifeState = Database.saveBotLifeState;
const fixtureReady = originalExecute(["INSERT INTO accounts(username,password) VALUES('bot_population_fixture','pw')"])
    .then(() => Promise.all([42, 43, 44, 45, 46, 71, 72, 99].map(id => originalExecute([
        'INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, 'bot_population_fixture', `PopulationFixture${id}`, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0]
    ]))));
const originalSyncInventorySummary = Database.syncInventorySummary;
const originalUpdateCharacterLocation = Database.updateCharacterLocation;
const originalUpdateCharacterProgress = Database.updateCharacterProgress;
const originalApplyCharacterDeathExperience = Database.applyCharacterDeathExperience;
const originalRestoreCharacterDeathExperience = Database.restoreCharacterDeathExperience;
const originalClearCharacterDeathExperience = Database.clearCharacterDeathExperience;
const originalUpdateCharacterVitals = Database.updateCharacterVitals;
const originalFetchSkills = Database.fetchSkills;
const originalFetchSkill = Database.fetchSkill;
const originalSetSkill = Database.setSkill;
const originalUpdateSkillLevel = Database.updateSkillLevel;
const originalCreateColdTrainingGuard = Database.createColdTrainingGuard;
const originalUpdateCharacterClassId = Database.updateCharacterClassId;
const originalReconcileClanMembership = Database.reconcileBotClanMembership;
const statements = [];
const classUpdates = [];

try {
    Database.reconcileBotClanMembership = () => Promise.resolve({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.fetchBotMarketCounts = async () => [];
    Database.saveBotLifeState = (statement, queryOptions) => {
        statements.push({ sql: String(statement[0]), params: statement[1], queryOptions });
        return originalSaveLifeState(statement, queryOptions);
    };
    Database.execute = ([sql, params, queryOptions]) => {
        statements.push({ sql: String(sql), params, queryOptions });
        if (String(sql).startsWith('SELECT id, classId, level, exp, sp FROM characters')) {
            return Promise.resolve([{ id: 42, classId: 31, level: 42, exp: 0, sp: 0 }]);
        }
        if (String(sql).startsWith('SELECT characterId FROM bot_life_state') || /\bRETURNING\b/i.test(sql)) {
            return originalExecute([sql, params, queryOptions]);
        }
        if (String(sql).startsWith('UPDATE bot_life_state')) {
            if (String(sql).includes("'$.partyRequest.lastReason'")) return Promise.resolve({ affectedRows: 1 });
            return Promise.resolve({ affectedRows: 2 });
        }
        if (String(sql).startsWith('SELECT * FROM bot_life_state')) {
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    };
    Database.syncInventorySummary = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterProgress = () => Promise.resolve();
    Database.applyCharacterDeathExperience = () => Promise.resolve({ applied: true });
    Database.restoreCharacterDeathExperience = () => Promise.resolve({ restored: 0 });
    Database.clearCharacterDeathExperience = () => Promise.resolve({ cleared: true });
    Database.updateCharacterVitals = () => Promise.resolve();
    Database.fetchSkills = () => Promise.resolve([]);
    Database.fetchSkill = () => Promise.resolve([]);
    Database.setSkill = () => Promise.resolve();
    Database.updateSkillLevel = () => Promise.resolve();
    // Skill writes are stubbed above; their row fence would read probes that are not in the table.
    Database.createColdTrainingGuard = () => () => {};
    Database.updateCharacterClassId = (characterId, classId) => {
        classUpdates.push({ characterId, classId });
        return Promise.resolve();
    };

    const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

    fixtureReady.then(() => BotLifeState.init()).then((ready) => {
        assert.strictEqual(ready, true);
        const retiredStaticMerchants = statements.find((entry) => entry.sql.includes('retired_static_merchant'));
        assert(retiredStaticMerchants, 'bot life init should remove hot lifecycle rows for retired static merchants');
        assert(retiredStaticMerchants.sql.includes("json_extract(statsJson, '$.marketStore') IS NULL"),
            'dynamic market stores must survive static-service retirement cleanup');
        assert(retiredStaticMerchants.sql.includes('characterName NOT IN'),
            'configured static merchants must remain available for startup spawning');
        assert.deepStrictEqual(retiredStaticMerchants.params, Object.keys(MerchantStoreConfigs),
            'retirement cleanup must use the current static merchant configuration as its allowlist');
        const retirementProbe = new DatabaseSync(':memory:');
        try {
            retirementProbe.exec(`CREATE TABLE bot_life_state (
                characterId INTEGER PRIMARY KEY,
                characterName TEXT NOT NULL,
                phase TEXT NOT NULL,
                activity TEXT NOT NULL,
                statsJson TEXT NOT NULL
            )`);
            const configuredName = Object.keys(MerchantStoreConfigs)[0];
            const insertRetirementProbe = retirementProbe.prepare(`INSERT INTO bot_life_state
                (characterId, characterName, phase, activity, statsJson) VALUES (?, ?, ?, ?, ?)`);
            insertRetirementProbe.run(1, configuredName, 'hot', 'merchant', '{}');
            insertRetirementProbe.run(2, 'RetiredStaticMerchant', 'hot', 'merchant', '{}');
            insertRetirementProbe.run(3, 'DynamicMarketStore', 'hot', 'merchant', JSON.stringify({ marketStore: { storeType: 1 } }));
            insertRetirementProbe.run(4, 'ColdMerchant', 'cold', 'merchant', '{}');
            retirementProbe.prepare(retiredStaticMerchants.sql).run(...retiredStaticMerchants.params);
            assert.deepStrictEqual(retirementProbe.prepare('SELECT characterId FROM bot_life_state ORDER BY characterId').all()
                .map((row) => Number(row.characterId)), [1, 3, 4],
            'startup cleanup must remove only retired hot static merchants');
        } finally {
            retirementProbe.close();
        }
        const dissolvedPartyRecovery = statements.find((entry) => entry.sql.includes('orphaned_dissolved_party'));
        assert(dissolvedPartyRecovery, 'startup must release members left behind by a dissolved background party');
        assert(dissolvedPartyRecovery.sql.includes('SET partyId = NULL'), 'orphan recovery must clear the persisted party id');
        assert(dissolvedPartyRecovery.sql.includes("WHEN activity = 'grouped' THEN 'hunting'"), 'orphan recovery must return grouped members to an actionable solo state');
        assert(dissolvedPartyRecovery.sql.includes("status NOT IN ('active', 'hot')"), 'active and reserved hot background parties must survive startup recovery');
        const craftRecovery = statements.find((entry) => entry.sql.includes("startup_craft_wait_recovery"));
        assert(craftRecovery, 'bot life init must release stale craft waits after a restart');
        assert(craftRecovery.sql.includes("AND activity = 'crafting'"), 'only stale station waits should be recovered as hunters');
        assert.strictEqual(craftRecovery.params[1], craftRecovery.params[0], 'recovered craft waits must be due immediately for their replan');
        const partyWaitMigration = statements.find((entry) => entry.sql.includes("SET activity = 'hunting'")
            && entry.sql.includes("lastReason') = 'acquisition_party_wait'"));
        assert(partyWaitMigration, 'startup must move legacy acquisition requests back to actionable hunting');
        assert(partyWaitMigration.sql.includes("'$.partyWaitUntil', NULL"), 'startup must clear the obsolete blocking wait deadline');
        const passivePartyRequestCleanup = statements.find((entry) => entry.sql.includes("json_remove(COALESCE(statsJson, '{}'), '$.partyRequest')")
            && entry.sql.includes("activity IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'clan_hall')"));
        assert(passivePartyRequestCleanup, 'startup must clear party requests from passive activities that cannot join formation');
        assert(passivePartyRequestCleanup.sql.includes("partyRequestStatus = 'open'"), 'passive cleanup must use the generated request projection');
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
                [8, 'grouped', { status: 'active', strategy: 'direct_drop', expectedKills: 5000, rateModelVersion: GearPlanner.RATE_MODEL_VERSION, target: validTarget, clanGoal: { clanId: 10 } }],
                [9, 'shopping', { status: 'deferred', strategy: 'none', reason: 'wish_focus', target: { selfId: 76, slot: 7 },
                    exchange: { kind: 'luxury_exchange' }, materials: [{ selfId: 1458, amount: 5375 }] }],
                [10, 'shopping', { status: 'active', strategy: 'market', target: { selfId: 99999999, name: 'Looks real' } }],
                [11, 'hunting', { status: 'active', strategy: 'direct_drop', expectedKills: 10, rateModelVersion: staleVersion,
                    target: { selfId: 76, slot: 7 } }],
                [12, 'resting', { status: 'active', strategy: 'luxury_exchange', target: { selfId: 76, slot: 7, name: '0' } }]
            ].forEach(([characterId, activity, equipmentPlan]) => insertProbe.run(
                characterId,
                activity,
                JSON.stringify({ equipmentPlan, partyRequest: { status: 'open' }, clanPartyObjective: { clanId: 1 } })
            ));
            migrationProbe.prepare(invalidPlanMigration.sql).run(...invalidPlanMigration.params);
            const retainedPlanIds = migrationProbe.prepare(`SELECT characterId FROM bot_life_state
                WHERE json_extract(statsJson, '$.equipmentPlan.target') IS NOT NULL ORDER BY characterId`).all()
                .map((row) => Number(row.characterId));
            assert.deepStrictEqual(retainedPlanIds, [2, 3, 4, 5, 8, 9, 12],
                'startup uses the canonical catalog ID, preserves nameless exchange reserves and removes unknown or stale combat routes');
            assert.equal(JSON.parse(migrationProbe.prepare('SELECT statsJson FROM bot_life_state WHERE characterId=9').get().statsJson)
                .equipmentPlan.materials[0].amount, 5375, 'the paused exchange inputs survive startup unchanged');
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
        }, 'persistence_probe').then(() => originalExecute([
            'SELECT nextResolveAt, lastResolvedAt, inventorySummary FROM bot_life_state WHERE characterId = 42', []
        ])).then(([saved]) => {
            assert.strictEqual(Number(saved.nextResolveAt), 2, 'persisted cold resolve timing must advance after every tick');
            assert.strictEqual(Number(saved.lastResolvedAt), 1, 'persisted cold resolve history must survive an upsert');
            assert.strictEqual(saved.inventorySummary, '{}', 'background drop rewards must persist after an upsert');
        }).then(() => BotLifeState.migrateLegacyClassProgression(1).then((migrated) => {
                assert.strictEqual(migrated.length, 1, 'legacy cold bots without progression markers must be migrated');
                const classUpdate = classUpdates.at(-1);
                assert(classUpdate, 'migration must persist the profession on the physical character');
                assert.ok([36, 37].includes(classUpdate.classId), 'migration must use the physical character class as its source of truth');
            }))
        .then(() => {
            const current = BotLifeState.cachedState(42);
            return BotLifeState.upsertState({ ...current,
                stats: { ...current.stats, partyRequest: { ...current.stats.partyRequest, status: 'open' } }
            }, 'reopened_party_request').then(() =>
                BotLifeState.deferUnformablePartyRequests([42], 'no_compatible_level_match')
            ).then((deferred) => {
                const deferUpdate = statements.at(-1);
                assert.strictEqual(deferred, 1, 'an unformable required group must close its active requests as a batch');
                assert(deferUpdate.sql.includes("'$.partyRequest.lastReason'"), 'unformable party cleanup must persist its reason');
                assert.strictEqual(deferUpdate.params[0], 'no_compatible_level_match', 'unformable party cleanup must persist the classification');
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
                    return BotLifeState.coldPartyCandidatesForSpots(['cruma', 'dion'], 3, true);
                }).then(() => {
                    const fairCandidates = statements.find((entry) => entry.sql.includes('ROW_NUMBER() OVER') && entry.sql.includes('PARTITION BY'));
                    assert(fairCandidates, 'party recruitment must load a bounded fair sample per active spot');
                    assert(fairCandidates.sql.includes('PARTITION BY partyObjectiveSpot'), 'party recruitment must rank the indexed objective projection');
                    assert(!fairCandidates.sql.includes('json_extract'), 'party recruitment must not parse JSON while ranking candidates');
                    const clearPartyStart = statements.length;
                    return BotLifeState.clearParty('bgp_cleanup_probe', 'ownership_aware_cleanup').then(() => {
                        const clearPartyQuery = statements.slice(clearPartyStart)
                            .find((entry) => entry.sql.includes('AND partyId = ?'));
                        assert(clearPartyQuery, 'party cleanup must query the far members of the party');
                        assert.deepStrictEqual(clearPartyQuery.params, ['bgp_cleanup_probe']);
                    });
                }).then(() => {
                    const member = {
                        characterId: 44,
                        name: 'PartyTelemetryProbe',
                        level: 20,
                        phase: 'cold',
                        simulation: { revision: 0 },
                        updatedAt: 1000,
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
                            targetOnSpot: 1,
                            defeatedNpcIds: [93]
                        }
                    }).then((resolvedMember) => {
                        assert.strictEqual(resolvedMember.stats.fightsWon, 6, 'a projected party stats snapshot must not erase newly won fights');
                        assert.strictEqual(resolvedMember.stats.fightsResolved, 9, 'a projected party stats snapshot must not erase newly resolved fights');
                        assert.strictEqual(resolvedMember.stats.deaths, 2, 'a non-lethal party resolve must preserve the cumulative death count');
                        assert.strictEqual(resolvedMember.stats.expEarned, 1120, 'a projected party stats snapshot must not erase earned EXP telemetry');
                        assert.strictEqual(resolvedMember.stats.spEarned, 113, 'a projected party stats snapshot must not erase earned SP telemetry');
                        assert.strictEqual(resolvedMember.stats.adenaEarned, 580, 'a projected party stats snapshot must not erase earned Adena telemetry');
                        assert.deepStrictEqual(resolvedMember.stats.coldCombat.cooldowns, {}, 'resolver-specific cooldown patch must still survive profile normalization and the authoritative counter merge');
                        return resolvedMember;
                    });
                });
                }).then(() => {
                    const partySave = statements.filter((entry) => entry.sql.includes('ON CONFLICT(characterId) DO UPDATE')).at(-1);
                    const persistedStats = JSON.parse(partySave.params[27]);
                    assert.strictEqual(persistedStats.lastResolveDebug, undefined, 'the last round\'s debug copy is not persisted');
                    assert.strictEqual(persistedStats.targetCombat.populationTargets['93'].targetKills, 1, 'a party result must retain its shared target telemetry');
                    assert.strictEqual(persistedStats.targetCombat.targets, undefined, 'obsolete per-bot target maps must not be persisted');
                    const deadProbe = {
                        characterId: 45,
                        name: 'DeadPartyRequestProbe',
                        level: 20,
                        phase: 'cold',
                        simulation: { revision: 0 },
                        updatedAt: 1000,
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
            // A row held for the near-player activation waits for it: not a queued bot.
            const probe = BotLifeState.cachedState(summary.oldest?.characterId);
            assert.strictEqual(BotLifeState.coldDueSummary(1000, new Set([probe.characterId])).due, summary.due - 1,
                'a row held for its activation is not due in the cold queue');
        })).then(() => BotLifeState.upsertState({
            characterId: 72,
            name: 'LevelLessHistogramProbe',
            phase: 'cold',
            activity: 'hunting',
            timing: { nextResolveAt: 999999 },
            stats: {},
            vitals: {},
            inventory: {}
        }, 'histogram_probe')).then(() => Promise.all([
            BotLifeState.levelHistogram(),
            // The query the histogram replaced; its NULL level and phase merge
            // into level 1 and the cold phase.
            originalExecute(['SELECT phase, level, COUNT(*) AS count FROM bot_life_state GROUP BY phase, level', []])
        ])).then(([histogram, rows]) => {
            const expected = new Map();
            for (const row of rows) {
                const key = `${row.phase || 'cold'}:${Number(row.level || 1)}`;
                expected.set(key, (expected.get(key) || 0) + Number(row.count));
            }
            const counted = new Map(histogram.levels.map((row) => [`${row.phase}:${row.level}`, row.count]));
            assert.deepStrictEqual([...counted].sort(), [...expected].sort(), 'the cache histogram must count what the table groups');
            assert.strictEqual(histogram.total, [...expected.values()].reduce((sum, count) => sum + count, 0));
            assert(counted.get('cold:1') >= 1, 'a state without a level must count as level 1');
            assert.deepStrictEqual(histogram.levels.map((row) => row.level), histogram.levels.map((row) => row.level).sort((x, y) => x - y),
                'levels must come ascending');
        }).then(() => {
            console.log('Bot population state checks passed');
        });
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    }).finally(async () => {
        Database.execute = originalExecute;
        Database.saveBotLifeState = originalSaveLifeState;
        Database.syncInventorySummary = originalSyncInventorySummary;
        Database.updateCharacterLocation = originalUpdateCharacterLocation;
        Database.updateCharacterProgress = originalUpdateCharacterProgress;
        Database.applyCharacterDeathExperience = originalApplyCharacterDeathExperience;
        Database.restoreCharacterDeathExperience = originalRestoreCharacterDeathExperience;
        Database.clearCharacterDeathExperience = originalClearCharacterDeathExperience;
        Database.updateCharacterVitals = originalUpdateCharacterVitals;
        Database.fetchSkills = originalFetchSkills;
        Database.fetchSkill = originalFetchSkill;
        Database.setSkill = originalSetSkill;
        Database.updateSkillLevel = originalUpdateSkillLevel;
        Database.createColdTrainingGuard = originalCreateColdTrainingGuard;
        Database.updateCharacterClassId = originalUpdateCharacterClassId;
        Database.reconcileBotClanMembership = originalReconcileClanMembership;
        Database.reconcileBotClanGoals = originalReconcileClanGoals;
        Database.fetchBotMarketCounts = originalFetchMarketCounts;
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
} catch (err) {
    Database.execute = originalExecute;
    Database.saveBotLifeState = originalSaveLifeState;
    Database.syncInventorySummary = originalSyncInventorySummary;
    Database.updateCharacterLocation = originalUpdateCharacterLocation;
    Database.updateCharacterProgress = originalUpdateCharacterProgress;
    Database.applyCharacterDeathExperience = originalApplyCharacterDeathExperience;
    Database.restoreCharacterDeathExperience = originalRestoreCharacterDeathExperience;
    Database.clearCharacterDeathExperience = originalClearCharacterDeathExperience;
    Database.updateCharacterVitals = originalUpdateCharacterVitals;
    Database.fetchSkills = originalFetchSkills;
    Database.fetchSkill = originalFetchSkill;
    Database.setSkill = originalSetSkill;
    Database.updateSkillLevel = originalUpdateSkillLevel;
    Database.createColdTrainingGuard = originalCreateColdTrainingGuard;
    Database.updateCharacterClassId = originalUpdateCharacterClassId;
    Database.reconcileBotClanMembership = originalReconcileClanMembership;
    Database.reconcileBotClanGoals = originalReconcileClanGoals;
    Database.fetchBotMarketCounts = originalFetchMarketCounts;
    Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw err;
}

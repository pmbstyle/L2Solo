const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const isolated = require('./helpers/isolatedSocialDatabase')('clan-equipment-goal');
require('../src/Global');
isolated.assertConfigured(options.default);

const rootDir = path.resolve(__dirname, '..');
const databasePath = isolated.world;
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_clan_equipment', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_clan_equipment', ?, ?, 0, 35, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_clan_equipment', ?, 35, 100000, 'hunting', 'cold', ?, ?, ?)`);
    [4, 15, 21, 43, 11].forEach((classId, index) => {
        const id = 4700001 + index;
        insertCharacter.run(id, `ClanGear${index + 1}`, classId);
        insertState.run(
            id,
            `ClanGear${index + 1}`,
            JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 100000 } }),
            JSON.stringify({ generatedCold: true, classId }),
            index + 1
        );
    });
    seed.close();
}

async function main() {
    seedDatabase();
    isolated.assertConfigured(options.default);
    Database.init();
    await LifeState.init();

    // This fixture supplies deterministic local plans; account inference
    // configuration and worker catalogs must not bypass that test double.
    const config = invoke('GameServer/Clan/ClanSimulationConfig');
    const planning = require('../src/GameServer/Clan/ClanPlanningCoordinator');
    const originalLlm = config.llmGoalManagementEnabled;
    const originalWorkerEnabled = planning.enabled;
    config.llmGoalManagementEnabled = false;
    planning.enabled = () => false;
    const originalPlanFor = GearAcquisitionPlanner.planFor;
    const originalSpotEnsure = SpotProfiles.ensure;
    GearAcquisitionPlanner.planFor = (state) => {
        const targetId = 9100 + Number(state.characterId || 0);
        const equipped = state.inventory?.[String(targetId)]?.equipped === true;
        return equipped ? {
            status: 'complete',
            strategy: 'none',
            recipeId: null,
            materials: [],
            next: null
        } : {
            status: 'active',
            grade: 'd',
            strategy: 'direct_drop',
            partyNeed: 'solo_ok',
            partyNeedReason: 'solo_ready',
            requiresParty: false,
            expectedKills: 10,
            target: { selfId: targetId, name: `Clan Blade ${state.characterId}`, slot: 7 },
            next: { spotId: 'clan-gear-test-spot', npcId: 1234, itemId: targetId }
        };
    };
    SpotProfiles.ensure = () => [];

    try {
        const created = await Database.createAutonomousClan({
            name: 'Clan Gear Test',
            leaderId: 4700001,
            memberIds: [4700001, 4700002, 4700003, 4700004, 4700005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 3, goal: null }
        });
        assert.strictEqual(created.ok, true);
        await Database.execute(['UPDATE clans SET level = 3 WHERE id = ?', [created.clanId]]);

        const first = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(first.attempted, 1);
        const [firstRow] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [created.clanId]
        ]);
        const firstGoal = JSON.parse(firstRow.stateJson).goal;
        assert.strictEqual(firstGoal.type, 'equipment');
        assert.strictEqual(Number(firstGoal.target.memberId), 4700001);
        assert.strictEqual(firstGoal.plan.kind, 'farm');
        assert.strictEqual(firstGoal.target.itemId, 4709101);
        assert.deepStrictEqual(firstGoal.assignedMemberIds.sort((a, b) => a - b),
            [4700001, 4700002, 4700003, 4700004, 4700005],
            'an L3 equipment goal must reserve one cohesive clan roster');

        const [targetState] = await Database.execute([
            'SELECT statsJson FROM bot_life_state WHERE characterId = ?',
            [firstGoal.target.memberId]
        ]);
        const targetStats = JSON.parse(targetState.statsJson);
        assert.strictEqual(Number(targetStats.equipmentPlan.clanGoal.clanId), Number(created.clanId));
        assert.strictEqual(targetStats.equipmentPlan.clanGoal.partyPreference, 'clan_first');
        const [helperState] = await Database.execute([
            'SELECT statsJson FROM bot_life_state WHERE characterId = ?',
            [4700002]
        ]);
        const helperStats = JSON.parse(helperState.statsJson);
        assert.strictEqual(Number(helperStats.clanPartyObjective.clanId), Number(created.clanId));
        assert.strictEqual(helperStats.clanPartyObjective.priority, 'required');
        assert.strictEqual(helperStats.clanPartyObjective.clanOperation, 'equipment');
        assert.strictEqual(helperStats.clanPartyObjective.maxPartySize, 5);
        assert.strictEqual(helperStats.clanPartyObjective.minPartySize,
            invoke('GameServer/Clan/ClanSimulationConfig').operationMinMembers);
        assert.strictEqual(
            PartyRequestPlanner.partyObjectiveForState({ stats: helperStats }).clanGoalKey,
            firstGoal.goalKey,
            'eligible clan members must share the beneficiary farm objective'
        );

        const second = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(second.changed, 0, 'an active clan gear goal must remain durable between resolves');

        const equipmentService = invoke('GameServer/Clan/ClanEquipmentService');
        const waiting = await LifeState.findByCharacterId(firstGoal.target.memberId);
        const beganAt = Date.now() - 20 * 60000;
        const oldRequest = { ...waiting.stats.partyRequest, requestedAt: beganAt };
        await LifeState.upsertState({ ...waiting, activity: 'party_wait', stats: { ...waiting.stats,
            eventWait: 'clan_party_assembly', partyRequest: oldRequest, clanPartyObjective: oldRequest } }, 'fixture_wait');
        const fixtureClan = await ClanGoalService.clanProjectionById(created.clanId);
        const fixtureMember = fixtureClan.members.find(member => Number(member.characterId ?? member.id) === firstGoal.target.memberId);
        await equipmentService.assignPlan(fixtureMember, { ...waiting.stats.equipmentPlan,
            materials: [{ selfId: 1864, amount: 1 }] }, fixtureClan, firstGoal);
        const refreshedWait = await LifeState.findByCharacterId(firstGoal.target.memberId);
        assert.equal(refreshedWait.stats.partyRequest.requestedAt, beganAt,
            'revising the clan plan must not restart an unchanged assembly deadline');
        // Forming found no roster: the request closes and the worker releases the waiter
        // without the clan's route (ClanPartyDuty.release).
        const Duty = require('../src/GameServer/Bot/Population/ClanPartyDuty');
        const closedWait = { ...refreshedWait, stats: { ...refreshedWait.stats,
            partyRequest: { ...refreshedWait.stats.partyRequest, status: 'closed', lastReason: 'no_compatible_level_match' } } };
        assert(Duty.released(closedWait), 'a waiter whose clan request closed is released');
        const release = Duty.release(closedWait, Date.now()).patch;
        await LifeState.upsertState({ ...closedWait, ...release }, 'fixture_closed');
        await equipmentService.assignPlan(fixtureMember, waiting.stats.equipmentPlan, fixtureClan, firstGoal);
        const closedState = await LifeState.findByCharacterId(firstGoal.target.memberId);
        assert.equal(closedState.activity, 'hunting');
        assert.equal(closedState.stats.partyRequest.status, 'closed', 'clan reviews keep the closed request');
        assert.equal(closedState.stats.clanPartyObjective.status, 'open', 'the clan keeps its call');
        assert(closedState.stats.equipmentPlan, 'the plan is the clan\'s: a release leaves it to the clan review');
        // The member's next build asks again; the clan's next review hands the route back.
        const reopened = PartyRequestPlanner.partyRequestForPlan(closedState, null, Date.now(), { economy: { worth: () => 0 } });
        assert.equal(reopened.status, 'open');
        await LifeState.upsertState({ ...closedState, stats: { ...closedState.stats, partyRequest: reopened } }, 'fixture_build');
        await equipmentService.assignPlan(fixtureMember, waiting.stats.equipmentPlan, fixtureClan, firstGoal);
        const retried = await LifeState.findByCharacterId(firstGoal.target.memberId);
        assert.equal(retried.stats.partyRequest.status, 'open', 'the clan retries the retained goal after the next build');
        assert(retried.stats.equipmentPlan, 'the clan route is assigned again');

        await Database.setItem(firstGoal.target.memberId, {
            selfId: firstGoal.target.itemId,
            name: firstGoal.target.itemName,
            amount: 1,
            equipped: true,
            slot: firstGoal.target.slot
        });
        const targetBeforeCompletion = await LifeState.findByCharacterId(firstGoal.target.memberId);
        const targetEquipped = await LifeState.refreshInventory(targetBeforeCompletion, { equip: true });
        const originalCachedState = LifeState.cachedState;
        try {
            LifeState.cachedState = (characterId) => Number(characterId) === Number(targetEquipped.characterId)
                ? targetEquipped
                : originalCachedState.call(LifeState, characterId);
            await ColdSimulationCoordinator.afterCommit({
                nextState: targetEquipped,
                proposal: { result: { events: [], debug: {} }, enqueuedAt: Date.now() }
            });
        } finally {
            LifeState.cachedState = originalCachedState;
        }
        const [advanceAction] = await Database.execute([`SELECT actionType, payloadJson
            FROM clan_actions WHERE clanId = ? AND actionType = 'goal_plan'
            ORDER BY id DESC LIMIT 1`, [created.clanId]]);
        assert.strictEqual(advanceAction.actionType, 'goal_plan', 'cold equipment completion must wake the clan goal resolver once');
        assert.strictEqual(JSON.parse(advanceAction.payloadJson).reason, 'equipment_goal_completed');
        // The real cold-owner commit has already persisted this snapshot
        // before afterCommit runs. Mirror that durable state here only after
        // proving that afterCommit itself emitted the wakeup action.
        await LifeState.upsertState(targetEquipped, 'test_cold_equipment_commit');

        const third = await ClanActionService.resolveBatch({ limit: 4, budgetMs: 1000 });
        assert(third.succeeded >= 1, 'the completion signal must run a goal resolver action');
        const [thirdRow] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [created.clanId]
        ]);
        const thirdGoal = JSON.parse(thirdRow.stateJson).goal;
        assert.strictEqual(thirdGoal.type, 'equipment');
        assert.notStrictEqual(Number(thirdGoal.target.memberId), Number(firstGoal.target.memberId));
        const [followUp] = await Database.execute([`SELECT status, availableAt
            FROM clan_actions WHERE clanId = ? AND actionType = 'goal_plan' AND status = 'pending'
            ORDER BY id DESC LIMIT 1`, [created.clanId]]);
        assert.strictEqual(followUp, undefined, 'an unchanged autonomous equipment goal waits for its own input event');
        require('../src/GameServer/Clan/ClanReviewEvents').changed(created.clanId, 'member_gear');
        await ClanActionService.scheduleReviews();
        const [eventReview] = await Database.execute([`SELECT availableAt FROM clan_actions
            WHERE clanId=? AND actionType='goal_plan' AND status='pending'`, [created.clanId]]);
        assert(Number(eventReview.availableAt) <= Date.now(), 'the addressed gear event admits a current review immediately');

        console.log('Clan equipment goal checks passed');
    } finally {
        config.llmGoalManagementEnabled = originalLlm;
        planning.enabled = originalWorkerEnabled;
        GearAcquisitionPlanner.planFor = originalPlanFor;
        SpotProfiles.ensure = originalSpotEnsure;
        await Database.close();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

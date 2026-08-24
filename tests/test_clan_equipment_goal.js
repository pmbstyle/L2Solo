const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-equipment-goal.sqlite');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');

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
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await LifeState.init();

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
        assert.strictEqual(
            PartyRequestPlanner.partyObjectiveForState({ stats: helperStats }).clanGoalKey,
            firstGoal.goalKey,
            'eligible clan members must share the beneficiary farm objective'
        );

        const second = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(second.changed, 0, 'an active clan gear goal must remain durable between resolves');

        await Database.setItem(firstGoal.target.memberId, {
            selfId: firstGoal.target.itemId,
            name: firstGoal.target.itemName,
            amount: 1,
            equipped: true,
            slot: firstGoal.target.slot
        });
        const targetBeforeCompletion = await LifeState.findByCharacterId(firstGoal.target.memberId);
        const targetEquipped = await LifeState.refreshInventory(targetBeforeCompletion, { equip: true });
        await LifeState.upsertState(targetEquipped, 'test_equipment_complete');
        const [advanceAction] = await Database.execute([`SELECT actionType, payloadJson
            FROM clan_actions WHERE clanId = ? AND actionType = 'goal_plan'
            ORDER BY id DESC LIMIT 1`, [created.clanId]]);
        assert.strictEqual(advanceAction.actionType, 'goal_plan', 'equipment completion must wake the clan goal resolver once');
        assert.strictEqual(JSON.parse(advanceAction.payloadJson).reason, 'equipment_goal_completed');

        const third = await ClanActionService.resolveBatch({ limit: 4, budgetMs: 1000 });
        assert(third.succeeded >= 1, 'the completion signal must run a goal resolver action');
        const [thirdRow] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [created.clanId]
        ]);
        const thirdGoal = JSON.parse(thirdRow.stateJson).goal;
        assert.strictEqual(thirdGoal.type, 'equipment');
        assert.notStrictEqual(Number(thirdGoal.target.memberId), Number(firstGoal.target.memberId));

        console.log('Clan equipment goal checks passed');
    } finally {
        GearAcquisitionPlanner.planFor = originalPlanFor;
        SpotProfiles.ensure = originalSpotEnsure;
        await Database.close();
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

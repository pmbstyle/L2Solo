const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice4.sqlite');
const Database = invoke('Database');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice4', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_slice4', ?, ?, 0, 35, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_slice4', ?, 35, 100000, 'hunting', 'cold', ?, ?, ?)`);
    for (let index = 1; index <= 5; index += 1) {
        const id = 4400000 + index;
        const classId = index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : index === 4 ? 43 : 11;
        insertCharacter.run(id, `SliceFour${index}`, classId);
        insertState.run(id, `SliceFour${index}`, JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 100000 } }), JSON.stringify({
            generatedCold: true,
            classId,
            partyHistory: { cruma: { runs: 3 } }
        }), index);
    }
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();

    try {
        const created = await Database.createAutonomousClan({
            name: 'SliceFourClan',
            leaderId: 4400001,
            memberIds: [4400001, 4400002, 4400003, 4400004, 4400005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 0, goal: null }
        });
        assert.strictEqual(created.ok, true);
        const [simulation] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const state = JSON.parse(simulation.stateJson);
        state.level = 2;
        await Database.execute(['UPDATE clans SET level = 2 WHERE id = ?', [created.clanId]]);
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson = ? WHERE clanId = ?', [JSON.stringify(state), created.clanId]]);

        await Database.upsertClanMarketDemand({
            clanId: created.clanId,
            itemId: Config.bloodMarkItemId,
            amount: 1,
            maxPrice: Config.bloodMarkMaxPrice,
            goalKey: `${created.clanId}:legacy-blood-mark`,
            status: 'open'
        });

        const first = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(first.attempted, 1);
        const [afterFirst] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const firstGoal = JSON.parse(afterFirst.stateJson).goal;
        assert.strictEqual(firstGoal.type, 'level');
        assert.strictEqual(Number(firstGoal.target.level), 55);
        assert.strictEqual(firstGoal.plan.kind, 'prepare', 'an underlevel clan must level instead of waiting on the Blood Mark market');
        assert.strictEqual(firstGoal.status, 'preparing');

        const [cancelledDemand] = await Database.fetchClanMarketDemands({
            clanId: created.clanId,
            itemId: Config.bloodMarkItemId,
            status: 'cancelled'
        });
        assert(cancelledDemand, 'a legacy Blood Mark market demand must be cancelled');
        const eventsAfterFirst = await Database.fetchClanGoalEvents(created.clanId, 10);
        assert.strictEqual(eventsAfterFirst.length, 1);

        const second = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(second.changed, 0, 'unchanged goal must not churn its persisted state');

        await Database.execute(['UPDATE characters SET level = 60 WHERE id BETWEEN 4400001 AND 4400004']);
        await Database.execute(['UPDATE bot_life_state SET level = 60 WHERE characterId BETWEEN 4400001 AND 4400004']);
        await Database.execute(['UPDATE characters SET level = 50 WHERE id = 4400005']);
        await Database.execute(['UPDATE bot_life_state SET level = 50 WHERE characterId = 4400005']);
        const almostReady = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(almostReady.changed, 1);
        const [afterAlmostReady] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const almostReadyGoal = JSON.parse(afterAlmostReady.stateJson).goal;
        assert.strictEqual(almostReadyGoal.status, 'preparing');
        assert.strictEqual(Number(almostReadyGoal.progress), 50,
            'the lowest member of the required five must keep the leveling goal active');

        await Database.execute(['UPDATE characters SET level = 60 WHERE clanId = ?', [created.clanId]]);
        await Database.execute(['UPDATE bot_life_state SET level = 60 WHERE characterId BETWEEN 4400001 AND 4400005']);
        const ready = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(ready.changed, 1);
        const [afterReady] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const readyGoal = JSON.parse(afterReady.stateJson).goal;
        assert.strictEqual(readyGoal.type, 'item');
        assert.strictEqual(Number(readyGoal.target.itemId), Number(Config.bloodMarkItemId));
        assert.strictEqual(readyGoal.plan.kind, 'farm', 'a level-ready clan must farm Blood Mark directly');
        assert.strictEqual(readyGoal.status, 'executing');

        for (let failure = 0; failure < Config.catastrophicFailureThreshold; failure += 1) {
            const result = await ClanGoalService.recordCatastrophicFailure(created.clanId);
            assert.strictEqual(result.ok, true);
        }
        const [afterFailures] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const failedGoal = JSON.parse(afterFailures.stateJson).goal;
        assert.strictEqual(Number(failedGoal.catastrophicFailures), Number(Config.catastrophicFailureThreshold));
        assert.strictEqual(failedGoal.plan.kind, 'prepare', 'repeated farm failures must force a different plan instead of hanging');
        assert.strictEqual(failedGoal.status, 'preparing');
        const events = await Database.fetchClanGoalEvents(created.clanId, 20);
        assert(events.filter((event) => event.eventType === 'goal_replanned').length >= Config.catastrophicFailureThreshold);

        const timestamp = Date.now();
        await Database.execute([`INSERT INTO clan_warehouse_items(
            clanId, selfId, name, kind, amount, reservedAmount, createdAt, updatedAt
        ) VALUES (?, ?, 'Blood Mark', 'quest', 1, 0, ?, ?)`, [created.clanId, Config.bloodMarkItemId, timestamp, timestamp]]);
        const completed = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(completed.changed, 1, 'fulfilled L2 conditions must be consumed by the goal resolver');
        const [advancedClan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [created.clanId]]);
        assert.strictEqual(Number(advancedClan.level), 3,
            'an already warehoused Blood Mark must advance L2 without a market or party completion callback');
        const [remainingMark] = await Database.execute([
            'SELECT amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?',
            [created.clanId, Config.bloodMarkItemId]
        ]);
        assert.strictEqual(Number(remainingMark?.amount || 0), 0, 'the direct level-up must consume its Blood Mark');

        console.log('Clan simulation Slice 4 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

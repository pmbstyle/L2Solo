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

        const first = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(first.attempted, 1);
        const [afterFirst] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const firstGoal = JSON.parse(afterFirst.stateJson).goal;
        assert.strictEqual(firstGoal.type, 'item');
        assert.strictEqual(Number(firstGoal.target.itemId), Number(Config.bloodMarkItemId));
        assert.strictEqual(firstGoal.plan.kind, 'market', 'a fresh clan demand must expose a market execution plan');
        assert.strictEqual(firstGoal.status, 'executing');

        const [demand] = await Database.fetchClanMarketDemands({ clanId: created.clanId, itemId: Config.bloodMarkItemId });
        assert(demand, 'Blood Mark demand must persist');
        assert.strictEqual(Number(demand.maxPrice), Number(Config.bloodMarkMaxPrice));
        const demandUpdatedAt = Number(demand.updatedAt);
        const eventsAfterFirst = await Database.fetchClanGoalEvents(created.clanId, 10);
        assert.strictEqual(eventsAfterFirst.length, 1);

        const second = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(second.changed, 0, 'unchanged goal must not churn its persisted state');
        const [sameDemand] = await Database.fetchClanMarketDemands({ clanId: created.clanId, itemId: Config.bloodMarkItemId });
        assert.strictEqual(Number(sameDemand.updatedAt), demandUpdatedAt, 'open demand must not refresh every resolve');

        for (let failure = 0; failure < Config.catastrophicFailureThreshold; failure += 1) {
            const result = await ClanGoalService.recordCatastrophicFailure(created.clanId);
            assert.strictEqual(result.ok, true);
        }
        const [afterFailures] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const failedGoal = JSON.parse(afterFailures.stateJson).goal;
        assert.strictEqual(Number(failedGoal.catastrophicFailures), Number(Config.catastrophicFailureThreshold));
        assert.notStrictEqual(failedGoal.plan.kind, 'market', 'threshold failures must force a different execution plan');
        assert.strictEqual(failedGoal.plan.kind, 'farm', 'a ready role-balanced party should become the fallback plan');
        assert.strictEqual(failedGoal.status, 'executing');
        const events = await Database.fetchClanGoalEvents(created.clanId, 20);
        assert(events.filter((event) => event.eventType === 'goal_replanned').length >= Config.catastrophicFailureThreshold);

        console.log('Clan simulation Slice 4 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

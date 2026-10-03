// The founder pass's time budget bounds its own candidate loop, not the wait for its database reads: on a busy
// world the candidate query alone waited longer than the budget in the statement queue, and no candidate was
// ever evaluated (live test 2026-10-03: 0 clans in 15.7 world hours, 741 of 896 passes over budget).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-founder-budget.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_budget', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_budget', ?, 4, 0, 60, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase, inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_budget', ?, 60, 'hunting', 'cold', '{}', ?, ?)`);
    const insertPersona = seed.prepare(`INSERT INTO bot_personas(
        characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
    ) VALUES (?, 1, ?, 'progression', 'steady_achiever', ?, 'budget persona', 0, 0)`);
    const traits = { ambition: 0.70, assertiveness: 0.60, resilience: 0.60, sociability: 0.50, commitment: 0.40 };
    for (let index = 1; index <= 8; index += 1) {
        const id = 4300000 + index;
        const name = `BudgetCandidate${index}`;
        insertCharacter.run(id, name);
        insertState.run(id, name, JSON.stringify({ generatedCold: true, generatedIndex: index, classId: 4, partyHistory: { b: { runs: 1 } } }), index);
        insertPersona.run(id, String(id), JSON.stringify(traits));
    }
    seed.close();
}

async function main() {
    DataCache.init();
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    ClanSimulationService.resetMetrics();

    // Every read waits three times the budget, as in the live statement queue.
    const budgetMs = 10;
    const execute = Database.execute.bind(Database);
    Database.execute = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, budgetMs * 3));
        return execute(...args);
    };
    try {
        const summary = await ClanSimulationService.resolveBatch(16, { budgetMs });
        assert(summary.attempted >= 1, `the pass must evaluate candidates although its reads waited longer than the budget: ${JSON.stringify(summary)}`);
        console.log(`Clan founder budget checks passed (attempted ${summary.attempted}, budgetStopped ${summary.budgetStopped})`);
    } finally {
        Database.execute = execute;
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

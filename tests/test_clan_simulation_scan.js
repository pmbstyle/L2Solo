const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-scan.sqlite');
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
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_scan', 'test-only');

    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_scan', ?, 4, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_scan', ?, ?, 'hunting', 'cold', '{}', ?, ?)`);
    const insertPersona = seed.prepare(`INSERT INTO bot_personas(
        characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
    ) VALUES (?, 1, ?, 'progression', 'steady_achiever', ?, 'scan regression persona', 0, 0)`);

    const blockedTraits = {
        ambition: 0.70,
        assertiveness: 0.60,
        resilience: 0.60,
        sociability: 0.50,
        commitment: 0.40
    };
    const founderTraits = {
        ambition: 0.90,
        assertiveness: 0.80,
        resilience: 0.80,
        sociability: 0.70,
        commitment: 0.60
    };

    for (let index = 1; index <= 21; index += 1) {
        const id = 4200000 + index;
        const level = index <= 16 ? 60 : 50;
        const name = `ScanCandidate${index}`;
        const stats = {
            generatedCold: true,
            generatedIndex: index,
            classId: 4,
            partyHistory: { scan: { runs: 1 } }
        };
        insertCharacter.run(id, name, level);
        insertState.run(id, name, level, JSON.stringify(stats), index);
        insertPersona.run(id, String(id), JSON.stringify(index <= 16 ? blockedTraits : founderTraits));
    }
    seed.close();
}

async function main() {
    DataCache.init();
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    ClanSimulationService.resetMetrics();

    try {
        const characterIndexes = await Database.execute(['PRAGMA index_list(characters)', []]);
        assert(characterIndexes.some((entry) => entry.name === 'characters_clan_level_id'), 'founder scan ordering index must exist');

        const first = await ClanSimulationService.resolveBatch(16, { budgetMs: 5000 });
        assert.strictEqual(first.created, 0, 'the blocked first page must not create a clan');
        assert.strictEqual(first.blocked, 16, 'the first page should contain only blocked founders');
        assert(ClanSimulationService.metrics().stages.scan_loop.count > 0, 'founder scan-loop latency must be observable');

        const second = await ClanSimulationService.resolveBatch(16, { budgetMs: 5000 });
        assert.strictEqual(second.created, 1, 'the rotating scan must reach the eligible next page');

        const [count] = await Database.execute(['SELECT COUNT(*) AS count FROM clan_simulation_clans', []]);
        assert.strictEqual(Number(count.count), 1);
        console.log('Clan simulation rotating founder scan checks passed');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

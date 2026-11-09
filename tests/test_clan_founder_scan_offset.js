// The founder scan pages through characters with clanId=0. Candidates that join or found a clan leave that
// list, so the next page must start after the candidates that stayed, not after every processed row: counting
// the departed ones skipped as many unseen candidates until the scan wrapped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const isolated = require('./helpers/isolatedSocialDatabase')('clan-founder-scan-offset');
require('../src/Global');
isolated.assertConfigured(options.default);

const rootDir = path.resolve(__dirname, '..');
const databasePath = isolated.world;
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');

const FIRST_ID = 4400001;
const CANDIDATES = 24;
const PAGE = 8;

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_offset', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_offset', ?, 4, 0, 60, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase, inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_offset', ?, 60, 'hunting', 'cold', '{}', ?, ?)`);
    const insertPersona = seed.prepare(`INSERT INTO bot_personas(
        characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
    ) VALUES (?, 2, ?, 'progression', 'steady_achiever', ?, 'offset persona', 0, 0)`);
    const traits = { ambition: 0.70, assertiveness: 0.60, resilience: 0.60, sociability: 0.50, commitment: 0.40 };
    for (let index = 0; index < CANDIDATES; index += 1) {
        const id = FIRST_ID + index;
        const name = `OffsetCandidate${index + 1}`;
        insertCharacter.run(id, name);
        // Only the first candidate has the party history a founder needs: it founds a clan on the first page
        // with recruits from that page, every other candidate is blocked as a founder.
        const partyHistory = index === 0 ? { b: { runs: 1 } } : {};
        insertState.run(id, name, JSON.stringify({ generatedCold: true, generatedIndex: index + 1, classId: 4, partyHistory }), index + 1);
        insertPersona.run(id, String(id), JSON.stringify(traits));
    }
    seed.close();
}

async function main() {
    DataCache.init();
    seedDatabase();
    Database.init();
    ClanSimulationService.resetMetrics();

    const policy = ClanSimulationService.policy;
    const selectExistingClan = policy.selectExistingClan;
    let evaluated = [];
    policy.selectExistingClan = (candidate, ...args) => {
        evaluated.push(Number(candidate.characterId));
        return selectExistingClan.call(policy, candidate, ...args);
    };
    try {
        const first = await ClanSimulationService.resolveBatch(PAGE, { budgetMs: 10000 });
        assert.strictEqual(first.created, 1, `the first page must found one clan: ${JSON.stringify(first)}`);
        const [left] = await Database.execute([`SELECT COUNT(*) AS count FROM characters
            WHERE clanId <> 0 AND id BETWEEN ? AND ?`, [FIRST_ID, FIRST_ID + PAGE - 1]]);
        assert(Number(left.count) >= 5, `the founder and its recruits must leave the clanId=0 list: ${left.count}`);
        const firstEvaluated = new Set(evaluated);

        evaluated = [];
        const second = await ClanSimulationService.resolveBatch(PAGE, { budgetMs: 10000 });
        assert(second.attempted > 0, `the second page must evaluate candidates: ${JSON.stringify(second)}`);
        assert.strictEqual(evaluated[0], FIRST_ID + PAGE,
            `the second page must start at the first unseen candidate, not skip ${left.count}: ${evaluated.join(',')}`);
        assert(evaluated.every((id) => !firstEvaluated.has(id)), 'the second page must not re-read the first page');
        console.log(`Clan founder scan offset checks passed (left ${left.count}, second page from ${evaluated[0] - FIRST_ID + 1})`);
    } finally {
        policy.selectExistingClan = selectExistingClan;
        await Database.close();
        removeDatabaseFiles();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

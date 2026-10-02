const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// Who joins which clan: the author's suitability weighs friendship with the
// clan's members (socialAffinity, 0.20), which needs the candidate's remembered
// relations.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-recruitment-relations.sqlite');
const Database = invoke('Database');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Service = invoke('GameServer/Clan/ClanSimulationService');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');

const CANDIDATE = 4700001, FRIEND = 4700101, STRANGER = 4700201;

async function main() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_recruit', 'test-only');
    seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
        locX, locY, locZ) VALUES (?, 'bot_pop_recruit', 'Candidate', 0, 0, 30, 500, 250, 0, 0, 0, 0, 0, 0, 0)`).run(CANDIDATE);
    seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_recruit', 'Candidate', 30, 0, 'hunting', 'cold', '{}', '{"generatedCold":true}', 1)`).run(CANDIDATE);
    seed.close();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    try {
        // The candidate remembers a friend from shared hunts.
        Memory.accept({ version: 1, ownerId: CANDIDATE, revision: 1, replayFloor: 0, recent: [], relations: [{
            kind: 'character', targetId: FRIEND, at: Date.now(), order: 1,
            affinity: 40, trust: 30, hostility: 0, fear: 0, familiarity: 8, reasons: [{ type: 'hunted_together', at: Date.now() }]
        }] });
        const [candidate] = await Service.candidateProjection(10);
        assert.strictEqual(candidate.characterId, CANDIDATE);
        assert(candidate.socialRelations[FRIEND], 'the candidate projection carries the remembered relations');

        const member = (id) => ({ id, characterId: id, classId: 0, level: 30 });
        const friendClan = { id: 1, level: 1, members: [member(FRIEND), member(4700102)] };
        const strangerClan = { id: 2, level: 1, members: [member(STRANGER), member(4700202)] };
        const withFriend = Policy.clanSuitability(candidate, friendClan, { threshold: 0 }).score;
        const withStrangers = Policy.clanSuitability(candidate, strangerClan, { threshold: 0 }).score;
        assert(withFriend > withStrangers, `a friend's clan scores higher (${withFriend} vs ${withStrangers})`);

        console.log('Clan recruitment relation checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

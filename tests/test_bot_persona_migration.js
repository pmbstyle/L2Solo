const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// Migration 52 (step 3.1, N6a): version 1 personas become version 2 in one
// transaction of the world database.
const Database = invoke('Database');
const Types = require('../src/GameServer/Bot/AI/BotPersonaTypes');
const Migration = require('../src/GameServer/Bot/AI/BotPersonaMigration');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-migration-'));
const worldPath = path.join(directory, 'world.sqlite');
options.default.Database.path = worldPath;

const CLASSES = [1, 4, 8, 9, 12, 14, 16, 17, 21, 2, 5, 23, 24, 27, 28, 29, 34, 36, 37, 40, 41, 42, 45, 47, 50, 51, 54, 55, 56, 57];
const V1 = { progression: ['steady_achiever', 'competitive_climber'], wealth: ['pragmatic_earner', 'patient_crafter'], social: ['steadfast_helper', 'party_regular'] };
const BOTS = 450;
const LEADERS = [3, 40, 77, 120, 160, 201, 255, 300, 333, 410].map((index) => 7000 + index);
const DWARF_LEADER = 7000 + CLASSES.indexOf(56) + CLASSES.length * 2;

function seed() {
    const db = new DatabaseSync(worldPath);
    db.exec(fs.readFileSync(path.join(process.cwd(), 'database', 'sql', 'sqlite.sql'), 'utf8'));
    // A version 1 world has no inclinations column.
    db.exec('ALTER TABLE bot_personas DROP COLUMN inclinationsJson');
    db.prepare("INSERT INTO accounts(username, password) VALUES ('bot_pop_mig', 'x')").run();
    const character = db.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (?, 'bot_pop_mig', ?, ?, 0, 30, 500, 250, 0, 0, 0, 0, 0, 0, 0)`);
    const state = db.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, activity, phase, inventorySummary, statsJson, updatedAt)
        VALUES (?, 'bot_pop_mig', ?, 30, 'hunting', 'cold', '{}', ?, 1)`);
    const persona = db.prepare(`INSERT INTO bot_personas(characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt)
        VALUES (?, 1, ?, ?, ?, ?, 'old card', 1, 1)`);
    for (let index = 0; index < BOTS; index++) {
        const id = 7000 + index;
        const drive = ['progression', 'wealth', 'social'][index % 3];
        const archetype = V1[drive][index % 2];
        const stats = { generatedIndex: 900 + index, partyHistory: { 1: { runs: 2 } },
            ...(index % 2 ? { marketPricing: { 57: { percent: 80 } } } : {}) };
        character.run(id, `Mig${index}`, CLASSES[index % CLASSES.length]);
        state.run(id, `Mig${index}`, JSON.stringify(stats));
        persona.run(id, String(900 + index), drive, archetype, JSON.stringify({ ...Types.TYPES[archetype].traits }));
    }
    const clan = db.prepare('INSERT INTO clans(name, leaderId) VALUES (?, ?)');
    [...LEADERS, DWARF_LEADER].forEach((id, index) => clan.run(`Clan${index}`, id));
    db.close();
}

function rows(db) {
    return db.prepare(`SELECT p.*, c.classId, b.statsJson FROM bot_personas p JOIN characters c ON c.id = p.characterId
        JOIN bot_life_state b ON b.characterId = p.characterId ORDER BY p.characterId`).all();
}

(async () => {
    try {
        seed();
        const before = new DatabaseSync(worldPath);
        const oldDrive = new Map(rows(before).map((row) => [row.characterId, row.primaryDrive]));
        // A crash in the middle (a write that fails) inside the migration
        // runner's transaction (Database.applySchemaMigrations: BEGIN
        // IMMEDIATE, ROLLBACK on error) leaves the world as it was.
        before.exec(`CREATE TRIGGER persona_crash BEFORE UPDATE ON bot_personas WHEN NEW.characterId = ${7000 + BOTS - 5}
            BEGIN SELECT RAISE(ABORT, 'crash'); END`);
        const snapshot = JSON.stringify(rows(before));
        before.exec('BEGIN IMMEDIATE');
        assert.throws(() => Migration.apply(before), /crash/);
        before.exec('ROLLBACK');
        assert.strictEqual(JSON.stringify(rows(before)), snapshot, 'nothing changed: personas, stats, schema');
        assert(!before.prepare('PRAGMA table_info(bot_personas)').all().some((column) => column.name === 'inclinationsJson'));
        before.exec('DROP TRIGGER persona_crash');
        before.close();
        // A copy of the version 1 world, migrated directly, for the leader counts.
        const copyPath = path.join(directory, 'copy.sqlite');
        fs.copyFileSync(worldPath, copyPath);
        const copy = new DatabaseSync(copyPath);
        copy.exec('BEGIN IMMEDIATE');
        const stats = Migration.apply(copy);
        copy.exec('COMMIT');
        assert.strictEqual(stats.migrated, BOTS);
        assert.strictEqual(stats.leaders, LEADERS.length + 1);
        assert(stats.leaderFallbacks <= 2, `leaders below the final gate: ${stats.leaderFallbacks}`);
        assert(stats.leaderPasses >= 1 && stats.leaderPasses <= Migration.LEADER_PASSES);
        assert.strictEqual(stats.marketPricingReset, BOTS / 2);

        Database.init();
        await Database.close();
        const db = new DatabaseSync(worldPath);
        const migrated = rows(db);
        assert.strictEqual(migrated.length, BOTS);
        const counts = {};
        for (const row of migrated) {
            assert.strictEqual(row.version, 2);
            assert.strictEqual(Types.TYPES[row.archetype].drive, row.primaryDrive);
            if (Types.isDwarf(row.classId)) assert.strictEqual(row.primaryDrive, 'wealth', `dwarf ${row.characterId}`);
            else assert.notStrictEqual(row.archetype, 'patient_crafter');
            const inclinations = JSON.parse(row.inclinationsJson);
            for (const name of Types.INCLINATIONS) assert(Math.abs(inclinations[name] - Types.TYPES[row.archetype].inclinations[name]) <= 0.2 + 1e-9);
            assert(row.textCard.startsWith(row.archetype.replace(/_/g, ' ')), 'a new text card');
            const stats = JSON.parse(row.statsJson);
            assert.strictEqual(stats.marketPricing, undefined, 'remembered listing prices reset');
            assert.deepStrictEqual(stats.partyHistory, { 1: { runs: 2 } }, 'the rest of the state stays');
            counts[row.archetype] = (counts[row.archetype] || 0) + 1;
        }
        assert.strictEqual(db.prepare('SELECT classId FROM characters WHERE id = ?').get(7005).classId, CLASSES[5], 'classes stay');
        // The non-leaders follow the shares (a small world: within 4 points; the
        // crafter is limited by crafter classes, its shortfall goes to the earner).
        for (const id of Types.TYPE_IDS) {
            if (id === 'patient_crafter' || id === 'pragmatic_earner') continue;
            assert(Math.abs((counts[id] || 0) / BOTS - Types.TYPES[id].share) <= 0.04, `${id} ${counts[id]}`);
        }
        // The same result as the direct run: the migration is deterministic.
        const withoutTime = (list) => JSON.stringify(list.map((row) => ({ ...row, updatedAt: 0 })));
        assert.strictEqual(withoutTime(rows(copy)), withoutTime(migrated));
        copy.close();
        // Leaders keep their clan's drive (a dwarf's becomes wealth) and pass the
        // gate of the final population (the author's run-time cut-offs), except
        // the fallbacks.
        const thresholds = Policy.founderThresholds(migrated.map((row) => ({ primaryDrive: row.primaryDrive, traits: JSON.parse(row.traitsJson) })));
        let passed = 0, keptDrive = 0;
        for (const id of [...LEADERS, DWARF_LEADER]) {
            const row = migrated.find((entry) => entry.characterId === id);
            keptDrive += Number(row.primaryDrive === (Types.isDwarf(row.classId) ? 'wealth' : oldDrive.get(id)));
            passed += Number(Policy.leaderScore({ traits: JSON.parse(row.traitsJson) }) >= thresholds[row.primaryDrive]);
        }
        assert.deepStrictEqual(thresholds, stats.thresholds, 'the reported cut-offs are the final population\'s');
        assert.strictEqual(passed, LEADERS.length + 1 - stats.leaderFallbacks, `leaders through the final gate: ${passed}`);
        assert(keptDrive >= passed, `leaders keep the clan drive: ${keptDrive}`);
        assert.strictEqual(migrated.find((row) => row.characterId === DWARF_LEADER).primaryDrive, 'wealth');

        // Idempotent: a second run changes nothing.
        const after = JSON.stringify(rows(db));
        db.exec('BEGIN IMMEDIATE');
        assert.deepStrictEqual(Migration.apply(db), { migrated: 0 });
        db.exec('COMMIT');
        assert.strictEqual(JSON.stringify(rows(db)), after);
        db.close();
        Database.init();
        await Database.close();
        const reopened = new DatabaseSync(worldPath);
        assert.strictEqual(JSON.stringify(rows(reopened)), after, 'a restart changes nothing');
        reopened.close();
        console.log('Bot persona migration checks passed', JSON.stringify({ counts, ...stats, leadersThroughFinalGate: passed }));
    } finally {
        await Database.close().catch(() => null);
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

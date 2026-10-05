const assert = require('assert');

require('../src/Global');

// One persona source (step 3.1, N6a): BotPersona.of returns the stored row on
// the main thread (loaded at boot) and in the cold worker (the 'personas'
// table of ColdTableChannel), and never regenerates one.
const Database = invoke('Database');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const TableChannel = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');

// A stored persona that generate() would not produce for this bot: a dwarf
// crafter class stored as a brawler with its own traits.
const subject = { characterId: 501, classId: 57, stats: { generatedIndex: 9 } };
const regenerated = BotPersona.generate(subject);
assert.strictEqual(regenerated.primaryDrive, 'wealth', 'a dwarf is generated wealth');
const row = {
    characterId: 501, version: 2, seed: '9', primaryDrive: 'progression', archetype: 'brawler',
    traitsJson: JSON.stringify({ sociability: 0.4, commitment: 0.5, caution: 0.2, ambition: 0.9, assertiveness: 0.8, empathy: 0.3, resilience: 0.6 }),
    inclinationsJson: JSON.stringify({ pvp: 0.9, justice: 0.1, speculation: 0.05 }), textCard: 'stored card', createdAt: 1, updatedAt: 1
};

(async () => {
    const originalExecute = Database.execute;
    try {
        BotPersona.reset();
        assert.strictEqual(BotPersona.of(subject), null, 'nothing stored, nothing generated');

        // Main thread: loadAll fills the cache and the counts per type.
        Database.execute = ([sql]) => {
            if (String(sql).includes('FROM bot_personas')) return Promise.resolve([row, { ...row, characterId: 502, archetype: 'speculator', primaryDrive: 'wealth' }]);
            throw new Error(`unexpected query ${sql}`);
        };
        assert.strictEqual(await BotPersona.loadAll(), 2);
        Database.execute = () => { throw new Error('of() must not query the database'); };
        const persona = BotPersona.of(subject);
        assert.strictEqual(persona.archetype, 'brawler', 'the stored type, not a regenerated one');
        assert.strictEqual(persona.traits.ambition, 0.9);
        assert.strictEqual(persona.inclinations.pvp, 0.9);
        assert.strictEqual(persona.textCard, 'stored card');
        assert.strictEqual(BotPersona.of(501), persona, 'by id');
        assert.strictEqual(BotPersona.of({ actor: { fetchId: () => 501 } }), persona, 'a hot bot by its actor id');
        assert.strictEqual(BotPersona.of({ characterId: 501, persona: regenerated }), regenerated, 'an attached persona wins');
        assert.deepStrictEqual(BotPersona.typeCounts(), { brawler: 1, speculator: 1 });
        // Derived, never stored: the combat talents.
        assert.deepStrictEqual(persona.talents, { offense: 0.5 + 0.25 * (0.8 + 0.9), defence: 0.5 + 0.25 * (0.2 + 0.6), support: 0.5 + 0.25 * (0.3 + 0.4) });
        assert.strictEqual(persona.shamanStyle, undefined, 'no fixed shaman style');

        // ensure() keeps a stored persona and makes a new bot's row once,
        // counting it and handing it to the workers' table.
        const writes = [];
        Database.execute = ([sql, params]) => {
            writes.push({ sql: String(sql), params });
            if (String(sql).startsWith('SELECT 1')) return Promise.resolve([]);
            if (String(sql).includes('FROM bot_personas WHERE characterId')) return Promise.resolve([]);
            return Promise.resolve({ affectedRows: 1 });
        };
        assert.strictEqual(await BotPersona.ensure(subject), persona);
        assert.strictEqual(writes.length, 0, 'a stored persona is not written again');
        const fresh = { characterId: 503, classId: 53, stats: { generatedIndex: 31 } };
        const [created, again] = await Promise.all([BotPersona.ensure(fresh), BotPersona.ensure(fresh)]);
        assert.strictEqual(created, again, 'one row per bot even when asked twice at once');
        assert.strictEqual(created.primaryDrive, 'wealth', 'a dwarf is wealth');
        const insert = writes.filter((entry) => entry.sql.startsWith('INSERT INTO bot_personas'));
        assert.strictEqual(insert.length, 1);
        assert.strictEqual(insert[0].params[1], 2, 'version 2');
        assert.deepStrictEqual(JSON.parse(insert[0].params[6]), created.inclinations, 'inclinations stored');
        assert(!insert[0].params.some((value) => String(value).includes('offense')), 'talents are not stored');
        assert.strictEqual(BotPersona.typeCounts()[created.archetype], (created.archetype === 'speculator' ? 2 : 1));
        assert.strictEqual(BotPersona.of(503), created);

        // Cold worker: the same rows through the table channel.
        const mirror = new TableMirror();
        const channel = TableChannel.shared;
        channel.attach('test-worker', 'epoch-1', (payload) => { mirror.apply(payload.tables); return true; });
        channel.flush();
        assert.strictEqual(mirror.rows('personas').size, 3, 'every stored persona reaches the worker');
        channel.detach('test-worker');
        const workerCache = mirror.rows('personas');
        BotPersona.reset();
        BotPersona.useRowSource((id) => workerCache.get(id));
        const inWorker = BotPersona.of({ characterId: 501, stats: {} });
        assert.strictEqual(inWorker.archetype, 'brawler');
        assert.deepStrictEqual(inWorker.traits, persona.traits);
        assert.deepStrictEqual(inWorker.inclinations, persona.inclinations);
        assert.deepStrictEqual(inWorker.talents, persona.talents);
        assert.strictEqual(BotPersona.of(501), inWorker, 'cached after the first read');
        assert.deepStrictEqual(BotPersona.of(503).traits, created.traits, 'a new bot reaches the worker too');
        assert.strictEqual(BotPersona.of(999), null);
        console.log('Bot persona source checks passed');
    } finally {
        Database.execute = originalExecute;
        BotPersona.reset();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

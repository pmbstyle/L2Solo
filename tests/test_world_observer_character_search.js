const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { searchPlayers } = require('../src/WorldObserver/CharacterSearch');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE characters(id INTEGER, name TEXT, level INTEGER, classId INTEGER, username TEXT);
    CREATE TABLE bot_life_state(characterId INTEGER, accountName TEXT, statsJson TEXT);
    INSERT INTO characters VALUES (1, 'Slava', 65, 6, 'player'), (2, 'Slave', 20, 0, 'player'),
    (3, 'SlavaBot', 65, 6, 'bot_pop_1'), (4, 'SlavaService', 60, 56, 'bot_craft_1'),
    (5, 'SlavaCold', 65, 6, 'generated'), (6, 'Literal_%', 30, 0, 'player'),
    (7, 'SlavaLegacy', 30, 0, 'player');
    INSERT INTO bot_life_state VALUES (5, 'generated', '{"generatedCold":1}'), (7, 'bot_scale_1', '{}');`);
let calls = 0;
const options = { execute: async ([sql, params]) => { calls++; return db.prepare(sql).all(...params); },
    classes: [{ classId: 6, className: 'Dark Avenger' }], onlineIds: [2] };
(async () => {
    assert.deepStrictEqual(await searchPlayers({ ...options, query: 's' }), []);
    assert.strictEqual(calls, 0, 'short queries should not touch SQLite');
    const matches = await searchPlayers({ ...options, query: 'sla' });
    assert.deepStrictEqual(matches.map(row => row.id), [1, 2], 'offline players are included and all bot sources are excluded');
    assert.strictEqual(matches[0].online, false);
    assert.strictEqual(matches[1].online, true);
    assert.strictEqual(matches[0].className, 'Dark Avenger');
    assert.deepStrictEqual(Object.keys(matches[0]).sort(), ['classId', 'className', 'id', 'kind', 'level', 'name', 'online']);
    assert.strictEqual((await searchPlayers({ ...options, query: 'sla', limit: 1 })).length, 1);
    assert.deepStrictEqual((await searchPlayers({ ...options, query: '_%' })).map(row => row.id), [6], 'wildcards must remain literal');
    assert.deepStrictEqual(await searchPlayers({ ...options, query: "' OR 1=1 --" }), []);
    require('../src/Global');
    const http = require('http');
    const Database = invoke('Database');
    const World = invoke('GameServer/World/World');
    const Observer = invoke('WorldObserver/WorldObserverServer');
    const originalExecute = Database.execute, originalUser = World.user;
    Database.execute = options.execute;
    World.user = { sessions: [{ accountId: 'player', actor: { fetchId: () => 2, fetchIsOnline: () => true } }] };
    const server = http.createServer(Observer.route);
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}/observer/api/characters/search`;
        const response = await fetch(`${base}?q=sla&limit=1`);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual((await response.json()).characters.map(row => row.id), [1]);
        const onlineResponse = await fetch(`${base}?q=slave`);
        assert.strictEqual((await onlineResponse.json()).characters[0].online, true);
        assert.strictEqual((await fetch(base, { method: 'POST' })).status, 405);
    } finally {
        Database.execute = originalExecute; World.user = originalUser;
        await new Promise(resolve => server.close(resolve));
    }
    db.close();
    console.log('Observer character search: offline identities, online state, bot exclusion, bounds and SQL escaping passed');
})().catch(error => { db.close(); console.error(error); process.exitCode = 1; });

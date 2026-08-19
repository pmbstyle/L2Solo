'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-life-events.sqlite');

[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

(async () => {
    await Database.createAccount('life_event_probe', 'secret');
    await Database.createCharacter('life_event_probe', {
        name: 'LifeEventProbe', race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const characterId = Number((await Database.fetchCharacters('life_event_probe'))[0].id);

    for (let index = 0; index < 25; index++) {
        await LifeEvents.record(characterId, 'rest', `rest cycle ${index}`, { spotId: 'probe' }, 2);
    }
    const routineRows = await Database.execute([
        `SELECT eventType, summary, metaJson FROM bot_life_events
         WHERE characterId = ? ORDER BY id`,
        [characterId]
    ]);
    assert.strictEqual(routineRows.length, 1, 'routine rest events inside one window must coalesce into one row');
    assert.strictEqual(routineRows[0].summary, 'rest cycle 24', 'coalescing must retain the latest routine summary');
    assert.strictEqual(JSON.parse(routineRows[0].metaJson).coalescedCount, 25,
        'coalesced metadata must expose how many routine events the row represents');

    await LifeEvents.recordMany(characterId, Array.from({ length: 25 }, (_, index) => ({
        type: 'death',
        summary: `major event ${index}`,
        weight: 4,
        meta: { index }
    })));
    const retained = await Database.execute([
        'SELECT COUNT(*) AS count FROM bot_life_events WHERE characterId = ?',
        [characterId]
    ]);
    assert.strictEqual(Number(retained[0].count), 20,
        'recordMany must finish its awaited prune before resolving');

    console.log('Bot life event coalescing and awaited retention checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');

// "Abandon quest" from the quest journal (packet 0x64) on hand-written quests.
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const QuestService = invoke('GameServer/Quest/QuestService');
const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');
const NativeItemLocations = invoke('GameServer/World/Generics/NativeItemLocations');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-quest-abort-'));
const file = path.join(directory, 'quests.sqlite');
options.default.Database.path = file;
const warnings = [];
const originalWarn = utils.infoWarn;
utils.infoWarn = (...args) => warnings.push(args);

const UMBAR = [-16760, 78268, -3480];

async function sessionFor(id, { level = 20, classId = 44 } = {}) {
    const session = {
        packets: [],
        actor: {
            fetchId: () => id, fetchLevel: () => level, fetchClassId: () => classId, fetchClanId: () => 0,
            backpack: new Backpack({ items: await Database.fetchItems(id), paperdoll: {} })
        },
        dataSendToMe(packet) { this.packets.push(packet); }
    };
    await QuestService.ensureLoaded(session);
    return session;
}
const quest = id => QuestService.quests().find(entry => entry.id === id);
const stateOf = (session, id) => QuestService.stateFor(session, quest(id));
async function abort(session, questId) {
    const packet = Buffer.alloc(5);
    packet.writeInt32LE(questId, 1);
    await QuestAbort(session, packet);
    assert.deepEqual(warnings, []);
}
// RadarControl 0xeb: showRadar, type, x, y, z.
const radarPoints = session => session.packets.filter(p => p[0] === 0xeb)
    .map(p => [p.readInt32LE(9), p.readInt32LE(13), p.readInt32LE(17)].join(':'));

async function abandonedOrcRaiderLeavesNoMapPoint() {
    const session = await sessionFor(1);
    const q414 = quest(414), state = stateOf(session, 414);
    await q414.onEvent(state, 'start');
    await QuestService.giveItem(session, 1580, 10);
    await q414.onTalk(state, { fetchSelfId: () => 7570 });
    assert.equal(state.getInt('cond'), 3);
    assert.deepEqual([...session.questWaypoints.values()], [UMBAR], 'Karukia marks the Umbar camp');

    await abort(session, 414);
    assert.equal(stateOf(session, 414).isStarted(), false);
    assert.deepEqual([...session.questWaypoints.values()], [], 'abandoning removes the Umbar point');

    session.packets.length = 0;
    NativeItemLocations.track(session, { x: 1, y: 2, z: 3 });
    NativeItemLocations.stop(session);
    assert.equal(radarPoints(session).includes(UMBAR.join(':')), false, 'Track and Clear do not bring it back');
}

async function main() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('abort_test', 'test');
    for (let id = 1; id <= 4; id++) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (?, 'abort_test', ?, 44, 3, 20, 500, 250, 0, 0, 0, 0, 0, 0, 0)`).run(id, `AbortTest${id}`);
    }
    seed.close();
    Database.init();
    DataCache.init();

    await abandonedOrcRaiderLeavesNoMapPoint();
    console.log('Quest abort checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll();
    await Database.close();
    utils.infoWarn = originalWarn;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(directory);
});

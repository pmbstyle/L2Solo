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
const count = (session, id) => session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === id).reduce((total, item) => total + item.fetchAmount(), 0);
async function started(session, id, cond = 1) {
    const state = stateOf(session, id);
    await state.setState('started');
    await state.set('cond', cond);
    return state;
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
    for (const id of [1579, 1580, 1589]) assert.equal(count(session, id), 0, `abandoning Q414 takes item ${id}`);

    session.packets.length = 0;
    NativeItemLocations.track(session, { x: 1, y: 2, z: 3 });
    NativeItemLocations.stop(session);
    assert.equal(radarPoints(session).includes(UMBAR.join(':')), false, 'Track and Clear do not bring it back');
}

// A quest without its own abort takes back the items L2J C4 registers for it
// (QuestState.exitQuest(true)); other items stay.
async function abandonedQuestsTakeTheirItems() {
    const session = await sessionFor(2);
    await QuestService.giveItem(session, 57, 1000);
    await QuestService.giveItem(session, 7570, 1);
    for (const [questId, items] of [[1, [[687, 1], [688, 1]]], [42, [[7548, 30]]], [46, [[7563, 1], [7568, 1]]], [151, [[703, 1]]]]) {
        await started(session, questId, 2);
        for (const [id, amount] of items) await QuestService.giveItem(session, id, amount);
        await abort(session, questId);
        assert.equal(stateOf(session, questId).isStarted(), false, `Q${questId} is abandoned`);
        for (const [id] of items) assert.equal(count(session, id), 0, `abandoning Q${questId} takes item ${id}`);
    }
    assert.equal(count(session, 57), 1000, 'Adena stays');
    assert.equal(count(session, 7570), 1, 'Mark of Traveler is not a Q046 quest item');

    const reloaded = await sessionFor(2);
    assert.deepEqual(reloaded.actor.backpack.fetchItems().map(item => item.fetchSelfId()).sort((a, b) => a - b), [57, 7570],
        'the database holds no quest item after the aborts');
    assert.equal(stateOf(reloaded, 1).isStarted(), false);
}

// An equipped quest weapon cannot be taken by the step transaction; the abort
// still succeeds and takes the rest.
async function equippedQuestWeaponStays() {
    await Database.setItem(3, { selfId: 1142, name: 'Rusted Bronze Sword', amount: 1, equipped: true, slot: 7 });
    const session = await sessionFor(3, { classId: 0 });
    await started(session, 401, 4);
    await QuestService.giveItem(session, 1144, 5);
    await abort(session, 401);
    assert.equal(stateOf(session, 401).isStarted(), false);
    assert.equal(count(session, 1144), 0, 'Poison Spider Legs are taken');
    assert.equal(count(session, 1142), 1, 'the equipped Rusted Bronze Sword stays');
}

// The 73 hand-written quests that L2J C4 gives registered quest items.
const ABANDON_ITEM_QUESTS = [1, 2, 3, 4, 5, 6, 7, 8, 42, 43, 44, 45, 46, 47, 48, 49, 101, 102, 103, 104, 105, 106, 107, 108,
    151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170,
    267, 275, 276, 327, 330, 334, 340, 363, 364,
    401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 422];
function questItemListsAreDeclared() {
    assert.equal(ABANDON_ITEM_QUESTS.length, 73);
    for (const id of ABANDON_ITEM_QUESTS) {
        const items = quest(id).questItems;
        assert(Array.isArray(items) && items.length > 0, `Q${id} declares its quest items`);
        for (const itemId of items) assert(DataCache.items.some(item => item.selfId === itemId), `Q${id} item ${itemId} has a template`);
    }
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
    await abandonedQuestsTakeTheirItems();
    await equippedQuestWeaponStays();
    questItemListsAreDeclared();
    console.log('Quest abort checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll();
    await Database.close();
    utils.infoWarn = originalWarn;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(directory);
});

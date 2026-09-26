const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const QuestService = invoke('GameServer/Quest/QuestService');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-soul-quest-'));
const file = path.join(directory, 'quests.sqlite');
options.default.Database.path = file;
const warnings = [];
const originalWarn = utils.infoWarn;
utils.infoWarn = (...args) => warnings.push(args);

async function sessionFor(id, level = 40) {
    const session = {
        packets: [],
        actor: {
            fetchId: () => id, fetchLevel: () => level, fetchClanId: () => 0,
            backpack: new Backpack({ items: await Database.fetchItems(id), paperdoll: {} })
        },
        dataSendToMe(packet) { this.packets.push(packet); }
    };
    await QuestService.ensureLoaded(session);
    return session;
}
const html = session => session.packets.filter(p => p[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
const count = (session, id) => session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === id).reduce((total, item) => total + item.fetchAmount(), 0);
const state = session => session.questStates.get(350);
async function settle(session) {
    await session.questMutationTail;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings, []);
}
async function talk(session, id) {
    session.packets.length = 0;
    NpcTalk(session, { fetchSelfId: () => id, fetchId: () => 100000 + id,
        fetchName: () => 'Magister', fetchTitle: () => '' });
    await settle(session);
}
async function click(session, event) {
    NpcTalkResponse(session, { link: `quest 350 ${event}` });
    await settle(session);
}
async function abort(session) {
    const packet = Buffer.alloc(5);
    packet.writeInt32LE(350, 1);
    await QuestAbort(session, packet);
}

async function main() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('soul_test', 'test');
    for (let id = 1; id <= 4; id++) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (?, 'soul_test', ?, 0, 0, 40, 500, 250, 0, 0, 0, 0, 0, 0, 0)`).run(id, `SoulTest${id}`);
    }
    seed.close();
    Database.init();
    DataCache.init();

    const low = await sessionFor(4, 39);
    await talk(low, 7115);
    assert.doesNotMatch(html(low), /quest 350 .*start/);
    await click(low, '7115_start');
    await click(low, '7115_red');
    assert.equal(state(low).isStarted(), false, 'forged start cannot bypass level 40');
    assert.equal(count(low, 4629), 0);

    for (const [index, npcId, color, crystalId] of [[1, 7115, 'red', 4629], [2, 7194, 'green', 4640], [3, 7856, 'blue', 4651]]) {
        const session = await sessionFor(index);
        await talk(session, npcId);
        assert.match(html(session), new RegExp(`quest 350 ${npcId}_start`));
        await click(session, `${npcId}_${color}`);
        assert.equal(count(session, crystalId), 0, 'cannot claim before accepting');
        await click(session, `${npcId}_start`);
        assert.deepEqual(QuestService.active(session), [{ id: 350, condition: 1 }]);
        assert.match(html(session), /Red Soul Crystal/);
        assert.match(html(session), /Green Soul Crystal/);
        assert.match(html(session), /Blue Soul Crystal/);
        await Promise.all([click(session, `${npcId}_${color}`), click(session, `${npcId}_${color}`)]);
        assert.equal(count(session, crystalId), 1, 'concurrent clicks award exactly one crystal');
        await click(session, `${npcId}_red`);
        assert.equal(session.actor.backpack.fetchItems().length, 1, 'another color cannot bypass inventory check');
        await click(session, `${npcId}_help`);
        assert.match(html(session), /killing blow/);
        assert.match(html(session), /stage 10/);
        await click(session, `${npcId}_unknown`);
        assert.equal(session.actor.backpack.fetchItems().length, 1);
    }

    await WriteQueue.flushAll();
    await Database.close();
    Database.init();
    const restored = await sessionFor(1);
    assert.equal(state(restored).getInt('cond'), 1);
    assert.equal(state(restored).isStarted(), true);
    assert.equal(count(restored, 4629), 1, 'crystal and quest survive reopening SQLite');
    await talk(restored, 7194);
    assert.match(html(restored), /already carry/);
    await click(restored, '7194_quit');
    assert.equal(count(restored, 4629), 0, 'NPC exit removes the starter crystal');
    assert.equal(state(restored).isStarted(), false);
    await click(restored, '7194_green');
    assert.equal(count(restored, 4640), 0, 'stale claim after exit is rejected');
    await click(restored, '7115_start');
    assert.equal(state(restored).isStarted(), false, 'another NPC cannot authorize this event');
    await click(restored, '7194_start');
    await click(restored, '7194_green');
    assert.equal(count(restored, 4640), 1, 'repeatable at a different magister');
    await QuestService.takeItem(restored, 4640, 1);
    await click(restored, '7194_blue');
    assert.equal(count(restored, 4651), 1, 'replacement after loss or storage does not require restarting');
    await abort(restored);
    assert.equal(count(restored, 4651), 0, 'journal abort applies the same cleanup');
    assert.deepEqual(QuestService.active(restored), []);

    // Already-owned crystals must not prevent accepting the quest, but must prevent a new grant.
    // Keep upgraded/broken crystals on exit; only the starter items belong to the quest cleanup.
    for (const itemId of [4630, 4639, 4662, 4663, 4664, 5577, 5578, 5579, 5580, 5581, 5582, 5908, 5911, 5914]) {
        await QuestService.giveItem(restored, itemId, 1);
        await click(restored, '7194_start');
        await click(restored, '7194_blue');
        assert.equal(count(restored, 4651), 0, `existing crystal ${itemId} blocks another grant`);
        await abort(restored);
        assert.equal(count(restored, itemId), 1, `aborting retains crystal ${itemId}`);
        await QuestService.takeItem(restored, itemId, 1);
    }
    const again = await sessionFor(1);
    assert.equal(state(again).isStarted(), false, 'exit persists');
    assert.deepEqual(again.actor.backpack.fetchItems(), []);
    console.log('Soul crystal quest: all NPCs/colors, level gate, replay protection, replacement, abort and SQLite reload passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll();
    await Database.close();
    utils.infoWarn = originalWarn;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(directory);
});

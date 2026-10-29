const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');

// A near bot's body change reaches its slot in the worker: a new item kind in
// the bag of a hot bot makes the coordinator send the bot's row, carrying the
// item and the spot the bot was given, to the worker.
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Actor = invoke('GameServer/Actor/Actor');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-near-fact-post-'));
options.default.Database.path = path.join(dir, 'world.sqlite');

const SOULSHOT = 1835;

async function run() {
    Database.init();
    DataCache.init();
    await Database.createAccount('bot_near_1', 'pw');
    const id = Number((await Database.createCharacter('bot_near_1', {
        name: 'NearOne', race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: -71338, locY: 258271, locZ: -3104
    })).insertId);
    assert(await Life.init());
    const state = await Life.upsertState({ characterId: id, name: 'NearOne', accountName: 'bot_near_1',
        level: 1, phase: 'hot', activity: 'hunting', stats: { classId: 0 }, inventory: {},
        loc: { locX: -71338, locY: 258271, locZ: -3104 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } });
    assert.strictEqual(state.phase, 'hot', 'fixture: the bot is near');

    const session = { accountId: 'bot_near_1', plan: 'hunting', coldLifeState: state,
        currentSpot: { id: 'near-fact-spot', name: 'Near fact spot' },
        fetchAccountId() { return this.accountId; }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor(session, { ...(await Database.fetchCharacters('bot_near_1'))[0],
        ...utils.crushOb(DataCache.classTemplates.find(row => Number(row.classId) === 0)),
        items: [], paperdoll: utils.tupleAlloc(16, {}) });

    // The worker edge: a ready worker whose messages are recorded.
    const sent = [];
    Coordinator.worker = {};
    Coordinator.workerEpoch = 'near-fact-test';
    Coordinator.ready = true;
    Coordinator.started = true;
    Coordinator.post = (type, payload) => { sent.push({ type, payload }); return `${type}:${sent.length}`; };

    session.populationActivating = true;
    session.actor.backpack.insertItem(9001, SOULSHOT, { amount: 100 });
    await new Promise(resolve => setImmediate(resolve));
    await Coordinator.sendSnapshots(false);
    assert.equal(sent.filter(message => message.type === 'snapshot_page').length, 0,
        'a provisional activation body cannot trigger a new occupation');
    session.populationActivating = false;
    Life.notifyNearFacts(session, 'activated');
    await new Promise(resolve => setImmediate(resolve));
    await Coordinator.sendSnapshots(false);

    const rows = sent.filter(message => message.type === 'snapshot_page')
        .flatMap(message => message.payload.rows.map(row => row.state || row));
    const row = rows.find(candidate => Number(candidate.characterId) === id);
    assert(row, 'the bag insert of a near bot sends its row to the worker');
    assert.strictEqual(row.phase, 'hot');
    assert(Number(row.inventory?.[SOULSHOT]?.amount) === 100, 'the row carries the new item');
    assert.strictEqual(row.spotId, 'near-fact-spot', 'the row carries the spot the bot was given');
    assert.strictEqual(Number(row.simulation?.revision || 0), Number(Life.cachedState(id).simulation?.revision || 0),
        'the row carries the cached row\'s revision');

    // A player's bag change sends nothing.
    sent.length = 0;
    session.accountId = 'player_near_1';
    session.actor.backpack.insertItem(9002, 57, { amount: 10 });
    await new Promise(resolve => setImmediate(resolve));
    await Coordinator.sendSnapshots(false);
    assert.strictEqual(sent.filter(message => message.type === 'snapshot_page').length, 0, 'a player posts no near fact');
    console.log('Near fact post: a near bot\'s bag insert reaches the worker with the item and the given spot');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit();
});

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
    const activation = Date.now() - 60000;
    const state = await Life.upsertState({ characterId: id, name: 'NearOne', accountName: 'bot_near_1',
        level: 1, phase: 'hot', activity: 'hunting', stats: { classId: 0 }, inventory: {},
        timing: { lastHotAt: activation, activityStartedAt: activation },
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
    assert.strictEqual(row.timing.lastHotAt, activation, 'the post preserves the persisted activation');
    assert.strictEqual(row.timing.activityStartedAt, activation, 'the post preserves the current activity start');

    // The body's spot moves are the spot aggregate's arrivals and leaves on the worker
    // (near_spot / near_left posts), not moved_by_world: they wake no decision on main.
    const SpotService = invoke('GameServer/Bot/AI/SpotService');
    // A spot post is sent at once (critical); what reached the worker since the move.
    const posted = async move => {
        sent.length = 0;
        move();
        await new Promise(resolve => setImmediate(resolve));
        await Coordinator.criticalSnapshotInFlight;
        await Coordinator.sendSnapshots(false);
        return sent.filter(message => message.type === 'snapshot_page')
            .flatMap(message => message.payload.rows.map(entry => entry.state || entry))
            .filter(candidate => Number(candidate.characterId) === id).at(-1);
    };
    const left = await posted(() => SpotService.leaveSpot(session));
    assert.strictEqual(session.currentSpot, null);
    assert(left, 'the leave reaches the worker');
    assert.strictEqual(left.spotId, null, 'a body that leaves its spot posts that it stands on none');
    const arrived = await posted(() => SpotService.assignSpot(session, { id: 'near-fact-other', name: 'Other spot',
        center: { locX: -71000, locY: 258000, locZ: -3104 }, npcNames: [] }));
    assert.strictEqual(arrived?.spotId, 'near-fact-other', 'its arrival on another spot posts the new spot');
    assert(!(session.nearRaise?.names || []).some(entry => entry.name === 'moved_by_world'),
        'a body\'s own spot change raises no moved_by_world');
    const shopping = await posted(() => {
        session.plan = 'shopping';
        Life.notifyNearFacts(session, 'fixture_shopping');
    });
    const refreshed = await posted(() => Life.notifyNearFacts(session, 'fixture_refresh'));
    assert.strictEqual(shopping.activity, 'shopping');
    assert(shopping.timing.activityStartedAt > activation, 'a real activity change starts a new interval');
    assert.strictEqual(refreshed.timing.activityStartedAt, shopping.timing.activityStartedAt);
    assert.strictEqual(refreshed.timing.lastHotAt, activation);

    // Several changes of one turn (a loot of several kinds, a level) are one post,
    // built after all of them: one row carrying every item.
    sent.length = 0;
    const seqBefore = Number(session.nearSeq || 0);
    session.actor.backpack.insertItem(9003, 1864, { amount: 5 });
    session.actor.backpack.insertItem(9004, 1865, { amount: 3 });
    Life.notifyNearFacts(session, 'level');
    await new Promise(resolve => setImmediate(resolve));
    await Coordinator.sendSnapshots(false);
    assert.strictEqual(Number(session.nearSeq), seqBefore + 1, 'the turn\'s changes are one post');
    const looted = sent.filter(message => message.type === 'snapshot_page')
        .flatMap(message => message.payload.rows.map(entry => entry.state || entry))
        .filter(candidate => Number(candidate.characterId) === id);
    assert.strictEqual(looted.length, 1, 'one row reaches the worker for the turn');
    assert(Number(looted[0].inventory?.[1864]?.amount) === 5 && Number(looted[0].inventory?.[1865]?.amount) === 3,
        'the post carries every change of the turn');

    // The body's arrival can be queued while the shopper asks for consent.
    // Hold the ordinary publisher to reproduce that ordering deterministically.
    const World = invoke('GameServer/World/World');
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
    const originalLookup = World.registeredActorById;
    const originalSend = Coordinator.sendIncrementalEntries;
    const cached = Life.cachedState(id);
    const revision = Number(cached.simulation?.revision || 0);
    const party = { phase: 'hot', hotAt: activation, revision, sequence: 1, needRevision: revision,
        route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } };
    const meeting = { token: 'near-arrival-preparation', actorA: id, actorB: id + 1, seqA: 1, seqB: 1,
        town: 'Giran', point: cached.loc, parties: [party, { ...party }],
        lines: [{ payer: 0, itemId: 42, selfId: 1867, count: 1, price: 10 }] };
    let releasePublication;
    const publication = new Promise(resolve => { releasePublication = resolve; });
    World.registeredActorById = characterId => characterId === id ? { session } : originalLookup.call(World, characterId);
    Coordinator.sendIncrementalEntries = async (...args) => {
        await publication;
        return originalSend.apply(Coordinator, args);
    };
    sent.length = 0;
    Events.raiseDecision(session, 'arrived_town');
    session.actor.backpack.insertItem(9009, 57, { amount: 3000 });
    const cancelled = assert.rejects(Coordinator.requestMeetingPreparation(id, meeting), /trade_meeting_preparation_discarded/);
    try {
        await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
        const commandIndex = sent.findIndex(message => message.type === 'command_request');
        assert(commandIndex > 0, 'the worker receives a source before the command');
        const source = sent[commandIndex - 1].payload.rows[0].state;
        assert.equal(source.activity, 'shopping', 'consent must start on the arrival rather than the persisted departure');
        assert.equal(source.adena, 3000);
        assert(source.raise?.names.some(entry => entry.name === 'arrived_town'));

        const refusals = [];
        const kernel = new ColdSimulationKernel({ resolveSolo: () => null, emit: (type, payload) => {
            if (type === 'command_ack') refusals.push(...payload.results);
            return true;
        } });
        kernel.prepareMeeting = () => new Promise(() => {});
        kernel.upsert({ state: structuredClone(cached) });
        releasePublication();
        await Coordinator.criticalSnapshotInFlight;
        for (const message of sent) {
            if (message.type === 'snapshot_page') kernel.upsertMany(structuredClone(message.payload.rows));
            if (message.type === 'command_request') message.payload.requests.forEach(request => assert(kernel.receiveMeetingPage(request)));
        }
        assert(kernel.commandStartedAt.has(id), 'republication of the same arrival keeps preparation');
        assert.deepEqual(refusals, []);
    } finally {
        releasePublication();
        World.registeredActorById = originalLookup;
        Coordinator.sendIncrementalEntries = originalSend;
        Coordinator.cancelMeetingPreparation(meeting.token);
        await cancelled;
    }

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

'use strict';
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const StateWire = require('../src/GameServer/Bot/Population/ColdStateWire');

async function runWorker(state, predicate, followUp = null) {
    const epoch = `economy-publication-${state.characterId}`, received = [];
    const worker = new Worker(path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
        { workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let failure, exited = false;
    worker.on('error', error => { failure = error; });
    worker.on('message', message => received.push(message));
    const joined = new Promise(resolve => worker.once('exit', code => { exited = true; resolve(code); }));
    async function until(test) {
        const deadline = Date.now() + 20000;
        while (!received.some(test)) {
            if (failure) throw failure;
            const fault = received.find(message => message.type === 'fault');
            if (fault) throw Error(JSON.stringify(fault.payload));
            if (exited || Date.now() >= deadline) throw Error('native economy publication timed out');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return received.find(test);
    }
    function send(type, payload, msgId) {
        const message = Protocol.envelope(type, epoch, payload, msgId);
        assert.equal(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true);
        worker.postMessage(message);
    }
    try {
        const loaded = await until(message => message.type === 'ready' && message.payload.phase === 'loaded');
        assert.equal(loaded.payload.forbiddenDependencies, 0);
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('table_page', { tables: ['board', 'market'].map(name =>
            ({ name, from: null, to: 0, full: true, rows: [], removed: [] })) });
        send('init', { config: { loopIntervalMs: 20, maxInFlight: 1, maxBatch: 1 } }, 'init');
        await until(message => message.type === 'ready' && message.msgId === 'init');
        send('snapshot_page', { rows: [{ state }], initial: true, done: true });
        const result = await until(predicate);
        if (followUp) await followUp({ result, until, received, seen: test => received.some(test),
            post: row => send('snapshot_page', { rows: [{ state: row }], initial: false, done: true }),
            table: tables => send('table_page', { tables }) });
        assert(!received.some(message => message.type === 'fault'));
        send('shutdown', {}, 'shutdown');
        await until(message => message.type === 'drained' && message.msgId === 'shutdown');
        assert.equal(await joined, 0);
        return result;
    } finally { if (!exited) await worker.terminate(); }
}

(async () => {
    const now = Date.now();
    const state = { characterId: 765411, name: 'PublicationOwner', accountName: 'bot_publication',
        phase: 'hot', nearSeq: 3, activity: 'hunting', level: 40, adena: 100000, exp: 0, sp: 1000,
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, currentRegion: 'Giran',
        inventory: {}, stats: { classId: 0, clanId: 9, generatedCold: true },
        timing: { nextResolveAt: now + 60000, lastResolvedAt: now - 60000 }, updatedAt: now,
        simulation: { revision: 1 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    // A workshop gone stale: a far row's echoes to main; a near row's does not
    // (its copy is current by nearSeq). The far crafter reads 1882, the near build 1835.
    const staleFor = id => message => message.type === 'ready'
        && message.payload.phase === 'economy_workshop_stale' && message.payload.characterId === id;
    const far = { ...state, characterId: 765414, name: 'PublicationFar', phase: 'cold', nearSeq: undefined,
        timing: { nextResolveAt: now - 1, lastResolvedAt: now - 60000 },
        stats: { classId: 0, clanId: 9, generatedCold: true, dwarvenCraftLevel: 1, workshop: { entries: [] }, money: [1000, .001, 0, 0] } };
    const decidedFor = id => message => message.type === 'ready' && message.payload.phase === 'economy_decided'
        && message.payload.characterId === id;
    const hot = await runWorker(state, decidedFor(state.characterId),
        async ({ result, until, seen, post, table }) => {
            // A clan member's deposit moves the clan supply the near decision
            // reads: the same post is decided again on it.
            table([{ name: 'clan_supplies', from: null, to: 0, full: true, last: 1, removed: [],
                rows: [[9, [9, 1, [[1864, 3]], 5]]] }]);
            await until(message => message !== result && decidedFor(state.characterId)(message));
            post(far);
            // A moved item marks a done slot only: pages repeat until the far one has finished.
            for (let version = 0; !seen(staleFor(far.characterId)); version++) {
                assert(version < 200, 'the far crafter echoes its stale workshop');
                table([{ name: 'market', from: version, to: version + 1, full: false, last: 1, removed: [],
                    rows: [1835, 1882].map(id => [`i:${id}`, [`i:${id}`, version + 1, 1]]) }]);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert(!seen(staleFor(state.characterId)), 'a near row\'s stale workshop is not echoed to main');
        });
    // A near bot's decision is the whole one a far bot gets (its clan plan
    // included), with the mind it moved and the row's post number beside it.
    const decision = Decisions.compact(hot.payload.economyDecision), near = hot.payload.near;
    assert(decision.clan?.huntPerHour > 0, 'a clan member near the player gets its clan valuation');
    assert.equal(decision.workshop.known, true);
    assert.equal(near.nearSeq, state.nearSeq, 'the decision names the post it answers');
    assert.deepEqual(decision.echo, [near.statsPacket.decisionSeq, near.statsPacket.activityLeaf, near.statsPacket.wishFocus[0]],
        'the card and the moved mind are one decision');

    // The worker owns the near mind: a post carries the body's older mind keys, which are
    // discarded; a raise is taken once and a later post naming it adds nothing.
    const decidedAt = (until, seq, characterId = 765413) => until(message => message.type === 'ready'
        && message.payload.phase === 'economy_decided' && message.payload.characterId === characterId
        && message.payload.near?.nearSeq === seq);
    await runWorker({ ...state, characterId: 765413 }, message => message.type === 'ready'
        && message.payload.phase === 'economy_decided', async ({ result: first, until, received, post }) => {
        const own = first.payload.near.statsPacket.decisionSeq;
        const raised = { ...state, characterId: 765413, nearSeq: 4, updatedAt: now + 1,
            raise: { seq: 1, bits: 1, impossible: true, impossibleSeq: 1 } };
        post({ ...state, characterId: 765414, updatedAt: now + 1 });
        post(raised);
        const answer = (await decidedAt(until, 4)).payload.near, one = answer.statsPacket;
        assert.equal(answer.raiseSeq, 1, 'a raise main posted is taken, on the worker\'s mind');
        assert.equal(one.decisionSeq, own, 'a raise is no decision: the mind\'s sequence stays');
        assert(answer.shots && Number.isFinite(answer.shots.ownedUsePerHour), 'the decision carries its build\'s auto-shot verdict');
        // A writer's copy of the cached row (no post number) is older than the
        // record's post: the record stands and no decision answers it.
        const cached = { ...state };
        delete cached.nearSeq;
        post({ ...cached, characterId: 765413, updatedAt: now + 3 });
        // A second near bot's post queued after it: the planner takes builds in
        // order, so a build on the copy would be answered before this one.
        post({ ...state, characterId: 765414, nearSeq: 4, updatedAt: now + 3 });
        await decidedAt(until, 4, 765414);
        assert(!received.some(message => message.payload?.phase === 'economy_decided' && message.payload.characterId === 765413
            && message.payload.near?.nearSeq === 0), 'a hot row without a newer post number is not decided on');
        post({ ...raised, nearSeq: 5, updatedAt: now + 2 });
        const two = (await decidedAt(until, 5)).payload.near.statsPacket;
        assert.equal(two.decisionSeq, one.decisionSeq, 'a later post naming the same raise neither raises again nor rolls the mind back');
        // The pending bag is cumulative: a later raise still carries the
        // impossible mark of raise 1 (its step drop: test_near_decision_order).
        post({ ...raised, nearSeq: 6, updatedAt: now + 4, raise: { seq: 2, bits: 1, impossible: true, impossibleSeq: 1 } });
        assert.equal((await decidedAt(until, 6)).payload.near.raiseSeq, 2, 'the new raise is taken');
    });

    const instances = Array.from({ length: 2075 }, (_, index) => ({ id: 900000 + index,
        selfId: 952, amount: 1, equipped: false, slot: 0, enchant: 0 }));
    const large = { ...state, characterId: 765412, phase: 'cold', activity: 'shopping',
        stats: { classId: 0, generatedCold: true, money: [1000, .001, 0, 0] },
        timing: { ...state.timing, nextResolveAt: Date.now() - 1 },
        inventory: { 952: { selfId: 952, amount: instances.length, equipped: false, stackable: false, instances } } };
    const command = await runWorker(large, message => message.type === 'command_request');
    // The worker packs large bags on the wire; the coordinator restores them (88eb104f).
    const request = StateWire.unpackPayload('command_request', command.payload).requests[0];
    assert(Protocol.sameCommandCheckpoint(large, request.commandCheckpoint));
    assert.deepEqual(request.state.inventory, large.inventory, 'the complete admitted bag crosses unchanged');
    assert(request.precomputedResult && request.precomputedPlan.statsPacket && request.precomputedPlan.economyDecision,
        'native combat and economy results remain in the command');
    // Packed instances keep this bag under the cap, so the planned state is
    // no longer dropped here; the overflow path is checked on the raw form below.
    assert.notEqual(request.precomputedPlan.plannedState, undefined, 'the packed command keeps its planned state');
    assert(Protocol.byteLength(command) <= Protocol.MAX_MESSAGE_BYTES);
    const expanded = { ...command, payload: { requests: [{ ...request,
        precomputedPlan: { ...request.precomputedPlan, plannedState: large } }] } };
    assert(Protocol.byteLength(expanded) > Protocol.MAX_MESSAGE_BYTES, 'this actual bag reproduces the old overflow');
    assert.equal(Protocol.omitPlannedStates(expanded), true);
    assert.equal(Protocol.validateEnvelope(expanded, 'worker').ok, true);
    assert.equal(Protocol.omitPlannedStates(expanded), false);
    const stillTooLarge = { ...command, payload: { requests: [{ ...request,
        precomputedPlan: { ...request.precomputedPlan, plannedState: undefined },
        state: { ...large, inventory: { ...large.inventory, secondBag: large.inventory[952] } } }] } };
    assert.equal(Protocol.omitPlannedStates(stillTooLarge), false);
    assert.equal(Protocol.validateEnvelope(stillTooLarge, 'worker').reason, 'message_too_large',
        'required source data never bypasses the fixed transport cap');
    console.log('PASS near decision from the worker and oversized lifecycle command', JSON.stringify({
        expandedBytes: Protocol.byteLength({ ...command, payload: { requests: [{ ...request,
            precomputedPlan: { ...request.precomputedPlan, plannedState: large } }] } }),
        commandBytes: Protocol.byteLength(command), instances: instances.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });

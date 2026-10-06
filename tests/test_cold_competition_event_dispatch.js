'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdCompetitionMonitor, INTERVAL_MS, seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const { decide } = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Visible = require('../src/GameServer/Social/VisibleStrength');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const epoch = 'competition-event-dispatch-canonical';

function sameCandidatePositive() {
    const spot = { id: 'event-baseline', npcEntries: [{ selfId: 10, count: 1 }] };
    const entries = [1001, 1002].map(characterId => ({ state: { characterId, name: `Hunter${characterId}`,
        phase: 'cold', activity: 'hunting', level: 40, spotId: spot.id,
        vitals: { hp: 100, maxHp: 100 }, stats: {}, inventory: {}, simulation: { revision: 7 } },
    context: { spot, targetNpcId: 10 } }));
    const memory = new Memory();
    for (const { state } of entries) memory.accept(MemoryPolicy.empty(state.characterId));
    const before = JSON.stringify(entries), beforeMemory = entries.map(({ state }) => memory.snapshot(state.characterId));
    const persona = { traits: {} }, capacity = 1, pressure = 2, base = 1800000000000;
    let at, rng, first, offset, encounterRoll;
    // Select one deterministic opportunity; no population/long simulation run.
    for (let tick = 1; tick <= 8; tick++) {
        const candidateAt = base + tick * INTERVAL_MS;
        const candidate = seeded(`${spot.id}:10:${Math.floor(candidateAt / INTERVAL_MS)}`);
        const a = candidate(), b = candidate(), c = candidate();
        if (c < 1 - Math.exp(-2.4 * INTERVAL_MS / 60000)) {
            at = candidateAt; rng = candidate; first = a; offset = b; encounterRoll = c; break;
        }
    }
    assert(at, 'bounded fixed seeds contain an actual encounter opportunity');
    const monitor = new ColdCompetitionMonitor({ capacityForSpot: () => capacity, personaFor: () => persona });
    monitor.sample(entries, memory, at - INTERVAL_MS);
    assert.equal(monitor.snapshot().evaluated, 0, 'first real sample only seeds its clock');
    monitor.sample(entries, memory, at);
    const events = monitor.snapshot().events;
    assert.equal(events.length, 1, 'two ready independent hunters produce one real forecast');
    const event = events[0], actorIndex = Math.floor(first * 2), peerIndex = (actorIndex + 1 + Math.floor(offset)) % 2;
    const a = entries[actorIndex].state, b = entries[peerIndex].state;
    const rolls = Array.from({ length: 4 }, () => rng());
    const key = `competition:${Math.floor(at / INTERVAL_MS)}:${spot.id}:10:1001:1002`;
    const side = state => ({ id: state.characterId, name: state.name, size: 1, level: state.level, partyId: null,
        own: Visible.stateSide([state], at), seen: Visible.stateSide([state], at) });
    let consumed = 0;
    const expected = decide({ pressure, actor: side(a), peer: side(b), actorPersona: persona, peerPersona: persona,
        towardPeer: memory.assess({ id: a.characterId }, { id: b.characterId }, {}, at),
        towardActor: memory.assess({ id: b.characterId }, { id: a.characterId }, {}, at),
        rng: () => rolls[consumed++], key });
    assert.equal(event.actor.id, a.characterId); assert.equal(event.peer.id, b.characterId);
    assert.equal(event.key, key); assert.deepEqual(event.decisionRolls, rolls);
    assert.equal(event.pressure, pressure); assert.equal(event.capacity, capacity); assert.equal(event.demand, 2);
    assert.equal(event.actor.revision, 7); assert.equal(event.peer.revision, 7);
    assert.equal(event.actor.memoryRevision, 0); assert.equal(event.peer.memoryRevision, 0);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(event[field], value, `shared decision ${field}`);
    assert(consumed > 0 && consumed <= 4, 'actual policy uses the prepared bounded decision rolls');
    assert.equal(JSON.stringify(entries), before, 'forecast does not mutate candidate facts');
    assert.deepEqual(entries.map(({ state }) => memory.snapshot(state.characterId)), beforeMemory);
    console.log('PASS healthy SAMEcandidate seeded selection/shared policy', JSON.stringify({ at,
        actor: event.actor.id, peer: event.peer.id, pressure, encounterRoll, decisionRolls: rolls,
        consumed, action: event.action, reason: event.reason }));
}

const sourceObserver = String.raw`
options.default.Database.path = workerData.dbPaths.world;
options.default.Database.historyPath = workerData.dbPaths.history;
module.exports.sourceFacts = () => {
    const rows = [101,102,103].map(id => {
        const packet = kernel?.states.get(id), record = kernel?.states.locationIndex.getSource(id,'state');
        return { id, present: !!packet, original: !!packet && record?.source === packet.state,
            phase: packet?.state.phase, activity: packet?.state.activity, hp: packet?.state.vitals?.hp,
            spotId: packet?.state.spotId, contextSpotId: packet?.context.spot?.id,
            targetNpcId: packet?.context.targetNpcId, inputTag: packet?.context.inputTag,
            memoryReady: kernel?.interactionMemory.views.get(id)?.ready === true };
    });
    const forbidden = Object.keys(require.cache).filter(file => /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/](GeodataEngine|ActivationPlacement)\.js$/.test(file));
    return { rows, forbidden, pendingActors: competitionCandidates?.pendingActors.size, pendingSpots: competitionCandidates?.pendingSpots.size,
        revengeCooling: [201,202].map(id => competition?.revenge.cooldowns.has('solo:'+id)), allowedTarget: competition?.isTargetAllowed(1),
        lastAt: competition?.lastAt, competitionReady, knowledgeEnabled: Config.knowledgeErrorsEnabled,
        paths: { world: options.default.Database.path, history: options.default.Database.historyPath } };
};`;
const workerSource = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath;
loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8') + '\n' + workerData.sourceObserver, workerData.workerPath);
const post = parentPort.postMessage.bind(parentPort);
let failed = false;
parentPort.postMessage = message => {
    if (!failed && message.type === 'heartbeat' && message.payload.competition?.frame?.events.some(event => event.action === 'revenge' && event.actor.id === 201)) {
        failed = true; post({ failedHeartbeat: true, frame: message.payload.competition.frame });
        throw Error('one generated transport backpressure');
    }
    post(message);
    if (message.type === 'heartbeat') post({ sourceOracle: true, forMsgId: message.msgId, facts: loaded.exports.sourceFacts() });
};`;

function row(id, now) {
    const spot = { id: 'worker-event-ground', capacity: 1, npcEntries: [{ selfId: 1, count: 1, level: 1 }] };
    return { state: { characterId: id, name: `Event${id}`, phase: 'cold', activity: 'hunting', level: 1,
        exp: 0, sp: 0, adena: 0, spotId: spot.id, loc: { locX: 10 + id, locY: 20, locZ: 0 },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, inventory: {},
        stats: { classId: 0, classProgressionLevel: 1, classProgressionClassId: 0 },
        timing: { activityStartedAt: now, lastResolvedAt: now, nextResolveAt: now + 3600000, lastHotAt: 0 },
        simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 }, updatedAt: now },
    context: { spot, targetNpcId: 1, route: null, inputTag: id === 103 ? 'addressed-arrival' : 'initial',
        interactionMemory: MemoryPolicy.empty(id) } };
}

async function actualWorkerArrival() {
    const directory = fs.mkdtempSync(path.resolve(__dirname, '../tmp/competition-event-native-'));
    const dbPaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
    const worker = new Worker(workerSource, { eval: true, workerData: { workerPath, workerEpoch: epoch, dbPaths, sourceObserver },
        resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const messages = [], sent = []; let error, stopped = false, main, releaseLegacy, releaseAction;
    const post = worker.postMessage.bind(worker);
    let dropAcceptedOnce = false;
    worker.postMessage = message => {
        sent.push(message);
        if (dropAcceptedOnce && message.payload?.receipt?.status === 'accepted') { dropAcceptedOnce = false; return; }
        post(message);
    };
    worker.on('message', message => messages.push(message)); worker.on('error', problem => { error = problem; });
    async function wait(predicate, timeout = 15000) {
        const until = Date.now() + timeout;
        while (!messages.some(predicate)) {
            if (error) throw error;
            const fault = messages.find(message => message.type === 'fault');
            if (fault) throw Error(`actual Worker fault: ${JSON.stringify(fault.payload)}`);
            if (Date.now() >= until) throw Error(`bounded actual Worker reply timeout: ${JSON.stringify(messages.slice(-8)
                .map(message => ({ type: message.type, msgId: message.msgId, frame: message.payload?.competition?.frame?.frameId,
                    actors: message.payload?.competition?.frame?.events.map(event => event.actor.id), pending: message.facts?.pendingActors })))}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    }
    function send(type, payload, msgId) {
        const message = Protocol.envelope(type, epoch, payload, msgId);
        assert.equal(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true);
        worker.postMessage(message);
    }
    try {
        const loaded = await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        assert.equal(loaded.payload.forbiddenDependencies, 0);
        send('init', { config: { heartbeatMs: 250, loopIntervalMs: 20, pvpAggression: 1 } }, 'init');
        await wait(message => message.type === 'ready' && message.msgId === 'init');
        const now = Date.now();
        send('snapshot_page', { rows: [row(101, now), row(102, now)], initial: true, done: true }, 'initial');
        await wait(message => message.type === 'ready' && message.msgId === 'initial');
        const first = await wait(message => message.type === 'heartbeat' && message.payload.states === 2
            && message.payload.competition?.activeHunters === 2);
        const initial = await wait(message => message.sourceOracle && message.forMsgId === first.msgId);
        console.log('INITIAL CONTROL', JSON.stringify({ report: first.payload.competition, facts: initial.facts }));
        assert.equal(Protocol.validateEnvelope(first, 'worker', { workerEpoch: epoch }).ok, true);
        assert.equal(initial.facts.allowedTarget, true); assert.equal(initial.facts.competitionReady, true);
        assert.equal(initial.facts.knowledgeEnabled, false); assert.deepEqual(initial.facts.forbidden, []);
        assert.deepEqual(initial.facts.paths, dbPaths);
        assert(initial.facts.rows.slice(0, 2).every(value => value.original && value.memoryReady));
        assert.equal(first.payload.competition.pressuredGroups, 1); assert.equal(first.payload.competition.evaluated, 0);
        console.log('PASS actual Worker/Protocol initial canonical hunters/pressure/memory/isolation');

        const arrival = Date.now();
        send('snapshot_page', { rows: [row(103, arrival)], ack: true }, 'arrival');
        const accepted = await wait(message => message.type === 'ready' && message.msgId === 'arrival');
        assert.equal(accepted.payload.states, 3, 'real snapshot producer accepted the third source');
        const next = await wait(message => message.type === 'heartbeat' && message.payload.states === 3, 2000);
        const current = await wait(message => message.sourceOracle && message.forMsgId === next.msgId, 2000);
        assert.equal(Protocol.validateEnvelope(next, 'worker', { workerEpoch: epoch }).ok, true);
        assert(current.facts.rows.every(value => value.original && value.memoryReady && value.phase === 'cold'
            && value.activity === 'hunting' && value.hp > 0 && value.spotId === value.contextSpotId));
        assert.equal(current.facts.rows[2].inputTag, 'addressed-arrival');
        assert.deepEqual(current.facts.forbidden, []);
        assert.equal(messages.filter(message => message.type === 'claim_request').length, 0, 'far due owners were not combat-resolved');
        assert(Date.now() - arrival < INTERVAL_MS, 'addressed control observes an existing heartbeat before the old sweep');
        console.log(JSON.stringify({ actualAcceptedOwners: 3, actualReadyMemories: 3,
            before: { at: first.payload.competition.at, active: first.payload.competition.activeHunters },
            after: { at: next.payload.competition.at, active: next.payload.competition.activeHunters },
            observerLastAt: current.facts.lastAt, elapsedSinceInputMs: Date.now() - arrival,
            combatClaims: 0, forbidden: current.facts.forbidden }));
        assert.equal(next.payload.competition.activeHunters, 3,
            'accepted cold arrival must reach addressed competition review on the next existing heartbeat');
        assert(next.payload.competition.at > first.payload.competition.at, 'fresh input advances the actual review timestamp');
        console.log('PASS actual addressed arrival reviewed without a 30-second population sweep');

        if (process.argv.includes('--party-expiry-only')) {
            const beforeExpiryInput = messages.length, expiresAt = Date.now() + 1000;
            const party = { partyId: 'worker-deadline-party', leaderId: 303, memberIds: [303, 304], status: 'active',
                spotId: 'worker-deadline-spot', updatedAt: Date.now(), stats: { coldCompetition: { conflictUntil: expiresAt } } };
            const members = [303, 304].map(id => {
                const entry = row(id, Date.now());
                entry.state.spotId = party.spotId; entry.state.partyId = party.partyId;
                entry.context.spot = { ...entry.context.spot, id: party.spotId, capacity: 100 };
                return entry;
            });
            const contributor = row(305, Date.now()); contributor.state.phase = 'hot'; contributor.context.party = party;
            send('snapshot_page', { rows: [...members, contributor], ack: true }, 'party-expiry-input');
            await wait(message => message.type === 'ready' && message.msgId === 'party-expiry-input');
            const prepared = await wait(message => messages.indexOf(message) >= beforeExpiryInput && message.type === 'heartbeat'
                && message.payload.states === 6 && message.payload.competition.at < expiresAt, 2000);
            assert.equal(prepared.payload.competition.activeHunters, 5);
            assert.equal(prepared.payload.competition.consumedSpotKeys, 1);
            const renewed = await wait(message => message.type === 'heartbeat' && message.payload.states === 6
                && message.payload.competition.at >= expiresAt && message.payload.competition.consumedSpotKeys === 1, 2000);
            assert(renewed.payload.competition.at > prepared.payload.competition.at);
            assert.equal(renewed.payload.competition.consumedActorKeys, 3,
                'genuine inactive contributor expiry queues that contributor plus exactly its two party hunters');
            assert.equal(messages.filter(message => message.type === 'claim_request').length, 0);
            console.log('PASS actual Worker inactive newest-party contributor expiry wakes hunter spot without another input',
                JSON.stringify({ beforeAt: prepared.payload.competition.at, expiresAt, afterAt: renewed.payload.competition.at,
                    consumedSpotKeys: 1, consumedActorKeys: 3, combatClaims: 0 }));
            return;
        }

        // Real Main constructor/scheduler/onMessage/Protocol, with held apply as
        // the task boundary. No native gameplay/SQL is invoked by this proof.
        require('../src/Global');
        options.default.Database.path = dbPaths.world; options.default.Database.historyPath = dbPaths.history;
        const Database = invoke('Database');
        assert.equal(Database.isReady(), false);
        const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
        main = new ColdSimulationCoordinator(); main.worker = worker; main.workerEpoch = epoch;
        main.ready = true; main.snapshotsLoaded = true;
        const MainConfig = invoke('GameServer/Bot/Population/PopulationConfig');
        const originalFlags = [MainConfig.coldCompetitionActionsEnabled, MainConfig.coldCompetitionConflictsEnabled,
            MainConfig.coldCompetitionPvpEnabled];
        main.restoreFlags = () => { [MainConfig.coldCompetitionActionsEnabled, MainConfig.coldCompetitionConflictsEnabled,
            MainConfig.coldCompetitionPvpEnabled] = originalFlags; };
        MainConfig.coldCompetitionActionsEnabled = false;
        if (next.payload.competition.frame) await main.onMessage(next, worker, epoch);
        MainConfig.coldCompetitionActionsEnabled = true; MainConfig.coldCompetitionConflictsEnabled = true;
        MainConfig.coldCompetitionPvpEnabled = true;
        const calls = [];
        const legacy = new Promise(resolve => { releaseLegacy = resolve; });
        const action = new Promise(resolve => { releaseAction = resolve; });
        main.competitionActions.budgetNow = () => 0;
        main.competitionActions.apply = async event => {
            calls.push(event.key);
            if (event.key === 'held-legacy') await legacy;
            if (event.actor.id === 201) await action;
            return { ok: true };
        };
        const heldAt = Date.now();
        assert.equal(main.competitionActions.submit({ at: heldAt, events: [{ key: 'held-legacy', at: heldAt,
            action: 'yield', pressure: 2, actor: { id: 501 }, peer: { id: 502 } }] }), true);
        assert(main.competitionActions.running, 'actual scheduler task is busy');
        const frameRows = (a, b, nameSize = 0) => {
            const when = Date.now();
            const rows = [a, b].map(id => {
                const entry = row(id, when);
                entry.state.spotId = `frame-${a}`; entry.state.loc = { locX: id * 10, locY: 0, locZ: 0 };
                entry.state.name = nameSize ? 'x'.repeat(nameSize) : `Event${id}`;
                // Shipped BotPersona.of supports authored/tool state personas.
                entry.state.persona = { traits: { assertiveness: 1, caution: 0, empathy: 0, resilience: 0, commitment: 1 } };
                entry.context.spot = { ...entry.context.spot, id: entry.state.spotId, capacity: 100 };
                return entry;
            });
            let memory = MemoryPolicy.empty(a);
            for (const [i, type] of ['attacked', 'killed', 'killed'].entries()) memory = MemoryPolicy.apply(memory,
                { key: `frame:${a}:${i}`, sourceId: a, targetId: b, type, at: when }, when).snapshot;
            rows[0].context.interactionMemory = memory;
            return rows;
        };
        // The positive existing aggression endpoint makes a real positive
        // grievance deterministic; neither RNG nor policy is replaced.
        const largeRows = frameRows(201, 202, 90000);
        send('snapshot_page', { rows: largeRows, ack: true }, 'byte-input');
        await wait(message => message.type === 'ready' && message.msgId === 'byte-input');
        const byteHeartbeat = await wait(message => message.type === 'heartbeat' && message.payload.states === 5
            && message.payload.competition.pendingActorKeys > 0, 2000);
        const byteFacts = await wait(message => message.sourceOracle && message.forMsgId === byteHeartbeat.msgId);
        assert.equal(Object.hasOwn(byteHeartbeat.payload.competition, 'frame'), false);
        assert.deepEqual(byteFacts.facts.revengeCooling, [false, false], 'oversized forecast must have no committed cooldown');
        assert(byteHeartbeat.bytes <= Protocol.MAX_MESSAGE_BYTES);
        console.log('PASS actual Worker byte-bound input retained before forecast cooldown');
        send('snapshot_page', { rows: frameRows(201, 202, 40000), ack: true }, 'frame-A-input');
        await wait(message => message.type === 'ready' && message.msgId === 'frame-A-input');
        const failed = await wait(message => message.failedHeartbeat, 2000);
        const firstFrame = await wait(message => message.type === 'heartbeat'
            && message.payload.competition.frame?.frameId === failed.frame.frameId, 2000);
        const frameA = firstFrame.payload.competition.frame;
        assert.deepEqual(frameA, failed.frame, 'failed send retains exact immutable origin/content');
        assert(firstFrame.bytes > Protocol.MAX_MESSAGE_BYTES * 0.9 && firstFrame.bytes <= Protocol.MAX_MESSAGE_BYTES,
            'near-limit real frame includes fractional telemetry and the newly armed cooldown head');
        assert.equal(Protocol.validateEnvelope(firstFrame, 'worker', { workerEpoch: epoch }).ok, true);
        assert(frameA.events.some(event => event.action === 'revenge' && event.actor.id === 201));
        assert.equal(firstFrame.payload.competition.deliverySendFailures, 1);
        await main.onMessage(firstFrame, worker, epoch);
        assert.equal(sent.at(-1).payload.receipt.status, 'deferred');
        assert.deepEqual(calls, ['held-legacy']);
        send('snapshot_page', { rows: frameRows(203, 204), ack: true }, 'frame-B-input');
        await wait(message => message.type === 'ready' && message.msgId === 'frame-B-input');
        send('competition_release', { events: [], receipt: { frameId: frameA.frameId + 99, at: frameA.at, status: 'accepted' } }, 'wrong-frame');
        const retry = await wait(message => message.type === 'heartbeat' && message.msgId !== firstFrame.msgId
            && message.payload.states === 7 && message.payload.competition.frame?.frameId === frameA.frameId, 2000);
        assert.deepEqual(retry.payload.competition.frame, frameA); assert.notEqual(retry.msgId, firstFrame.msgId);
        const pending = await wait(message => message.sourceOracle && message.forMsgId === retry.msgId);
        assert(pending.facts.pendingActors > 0, 'new source input stays coalesced while old frame waits');
        releaseLegacy(); await main.competitionActions.running;
        dropAcceptedOnce = true;
        const admissionBoundary = messages.length;
        await main.onMessage(retry, worker, epoch);
        assert.equal(sent.at(-1).payload.receipt.status, 'accepted');
        assert(main.competitionActions.running, 'accepted is real async task ownership, not completion');
        const replay = await wait(message => messages.indexOf(message) >= admissionBoundary
            && message.type === 'heartbeat' && message.msgId !== retry.msgId
            && message.payload.competition.frame?.frameId === frameA.frameId, 2000);
        await main.onMessage(replay, worker, epoch);
        assert.equal(sent.at(-1).payload.receipt.status, 'accepted');
        assert.equal(calls.filter(key => frameA.events.some(event => event.key === key)).length, 1,
            'lost admission receipt replays without a second installed task');
        const secondFrame = await wait(message => message.type === 'heartbeat'
            && message.payload.competition.frame?.frameId > frameA.frameId, 2000);
        const frameB = secondFrame.payload.competition.frame;
        assert(frameB.events.some(event => event.action === 'revenge' && event.actor.id === 203));
        await main.onMessage(secondFrame, worker, epoch);
        assert.equal(sent.at(-1).payload.receipt.status, 'deferred', 'new frame survives another owner task');
        releaseAction(); await main.competitionActions.running;
        const retryB = await wait(message => message.type === 'heartbeat' && message.msgId !== secondFrame.msgId
            && message.payload.competition.frame?.frameId === frameB.frameId, 2000);
        assert.deepEqual(retryB.payload.competition.frame, frameB);
        await main.onMessage(retryB, worker, epoch); await main.competitionActions.running;
        assert.equal(sent.at(-1).payload.receipt.status, 'accepted');
        const clear = await wait(message => message.type === 'heartbeat' && message.payload.states === 7
            && message.payload.competition.at >= frameB.at && !Object.hasOwn(message.payload.competition, 'frame'), 2000);
        assert.deepEqual(clear.payload.competition.events, [], 'retired frame cannot enter legacy fallback');
        assert.equal(calls.filter(key => frameA.events.some(event => event.key === key)).length, 1);
        assert.equal(calls.filter(key => frameB.events.some(event => event.key === key)).length, 1);
        assert.equal(Database.isReady(), false); assert.equal(messages.filter(message => message.type === 'claim_request').length, 0);
        console.log('PASS actual Worker + Main: failed send/deferred/newinput/lost ACK/replay/fresh IDs/exact frame admission');

    } finally {
        releaseLegacy?.(); releaseAction?.();
        if (main?.competitionActions.running) await main.competitionActions.running;
        main?.restoreFlags?.();
        try {
            send('shutdown', {}, 'stop');
            await wait(message => message.type === 'drained' && message.msgId === 'stop', 5000);
            stopped = true;
        } finally {
            await worker.terminate();
            const opened = [dbPaths.world, dbPaths.history].filter(file => fs.existsSync(file));
            fs.rmSync(directory, { recursive: true, force: true });
            console.log('CLEANUP', JSON.stringify({ joinedWorker: true, drained: stopped, databaseFilesCreated: opened.length,
                disposableRemoved: !fs.existsSync(directory) }));
        }
    }
}

(async () => {
    assert.equal(Config.knowledgeErrorsEnabled, false, 'fixture requires the actual OFF switch');
    sameCandidatePositive();
    await actualWorkerArrival();
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

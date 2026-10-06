'use strict';
const assert = require('node:assert/strict');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { ColdCompetitionMonitor, INTERVAL_MS, seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Candidates = require('../src/GameServer/Bot/Population/ColdCompetitionCandidates');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const base = 1800000000000;
function setup(fitsFrame) {
    let time = base;
    const emitted = [];
    const kernel = new ColdSimulationKernel({ now: () => time, resolveSolo: () => { throw Error('unexpected resolve'); },
        emit: (...args) => emitted.push(args) });
    const monitor = new ColdCompetitionMonitor({ capacityForSpot: spot => spot.capacity, personaFor: () => ({ traits: {} }) });
    const candidates = new Candidates({ records: id => kernel.states.locationIndex.getSource(id, 'state'),
        packets: id => kernel.states.get(id), memory: kernel.interactionMemory, monitor, deadlines: kernel,
        sequence: id => kernel.states.safetyNodes.get(id)?.sequence, fitsFrame });
    kernel.decisionEvents = candidates;
    return { kernel, monitor, candidates, emitted, at: value => { time = value; } };
}
function row(id, spotId = 'local', overrides = {}, context = {}) {
    const spot = { id: spotId, capacity: 1, npcEntries: [{ selfId: 10, count: 1 }] };
    return { state: { characterId: id, name: `Hunter${id}`, phase: 'cold', activity: 'hunting', level: 40,
        spotId, loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100, maxHp: 100 }, inventory: {}, stats: {},
        timing: { nextResolveAt: base + 3600000, lastResolvedAt: base }, simulation: { revision: 2, ownerId: 'legacy_main' }, ...overrides },
    context: { spot, targetNpcId: 10, interactionMemory: P.empty(id), ...context } };
}
function opportunity(spotId) {
    for (let tick = 1; tick <= 8; tick++) {
        const at = base + tick * INTERVAL_MS, rng = seeded(`${spotId}:10:${Math.floor(at / INTERVAL_MS)}`);
        rng(); rng();
        if (rng() < 1 - Math.exp(-2.4 * INTERVAL_MS / 60000)) return at;
    }
    throw Error('fixed bounded seed opportunity missing');
}
function replace(kernel, id, state = {}, context = {}) {
    const current = kernel.states.get(id);
    return kernel.upsert({ state: { ...current.state, ...state }, context: { ...current.context, ...context } });
}

// No all-packet discovery can masquerade as a local read after preparation.
for (const unrelated of [32, 64]) {
    const { kernel, candidates, monitor } = setup();
    kernel.upsertMany([row(1), row(2), ...Array.from({ length: unrelated }, (_, i) => row(100 + i, `remote-${i}`))]);
    while (candidates.pendingSpots.size || candidates.pendingActors.size) candidates.reviewBatch(base);
    let reads = 0;
    for (let i = 0; i < unrelated; i++) {
        const packet = kernel.states.get(100 + i);
        Object.defineProperty(packet.context, 'spot', { get() { reads++; throw Error('unrelated context access'); } });
        Object.defineProperty(packet.state, 'level', { get() { reads++; throw Error('unrelated actor access'); } });
    }
    kernel.states.values = () => { throw Error('population materialization'); };
    kernel.states.entries = () => { throw Error('population iteration'); };
    replace(kernel, 1, {}, { addressed: true });
    candidates.reviewBatch(base + 1);
    assert.equal(reads, 0); assert.equal(monitor.report.consumedSpotKeys, 1);
    assert.equal(monitor.report.activeHunters, unrelated + 2);
}
console.log('PASS32/64 unrelated getters0; common current-source local reads only');

// An inactive contributor can own the newest party context. Dependencies exist
// before the missing teammate becomes available, with no new party payload.
{
    const { kernel, candidates, monitor, at } = setup();
    const key = 'party-alpha', party = { partyId: key, leaderId: 7, memberIds: [7, 8], status: 'active',
        spotId: 'party-spot', updatedAt: 100, stats: { objective: { npcId: 10 } } };
    kernel.upsertMany([row(7, 'party-spot', { partyId: key }, { party: { ...party, updatedAt: 50 } }),
        row(9, 'party-spot'), row(20, 'irrelevant', { phase: 'hot' }, { party }),
        row(21, 'irrelevant', { phase: 'hot' }, { party: { ...party, memberIds: [7, 22] } })]);
    candidates.reviewBatch(base);
    assert.equal(candidates.currentParty(key), party, 'equal updatedAt keeps first insertion even ineligible contributor');
    assert(candidates.memberParties.get(8).has(key), 'incomplete bounded roster remains an inverse dependency');
    assert(monitor.report.skipped.incompleteParty > 0);
    const before = monitor.report.evaluated;
    const choiceAt = opportunity('party-spot'); at(choiceAt);
    kernel.upsert(row(8, 'party-spot', { activity: 'resting', partyId: key }));
    const frame = candidates.reviewBatch(choiceAt);
    assert(frame && frame.events.length === 1, 'member-only recovery wakes complete resting roster');
    const event = frame.events[0], participant = [event.actor, event.peer].find(side => side.partyId === key);
    assert.equal(participant.size, 2); assert.equal(participant.activeSize, 1);
    assert.equal(participant.partyUpdatedAt, 100); assert.equal(monitor.report.evaluated, before + 1);
    assert(Object.isFrozen(frame) && Object.isFrozen(event.actor));
    const version = kernel.states.get(7).version, original = kernel.states.get(7).state;
    kernel.upsert({ state: { ...original, simulation: { revision: 1 }, phase: 'hot' },
        context: { ...kernel.states.get(7).context, marker: 'stale-state-fresh-context' } });
    assert.equal(kernel.states.get(7).state, original); assert.equal(kernel.states.get(7).context.marker, 'stale-state-fresh-context');
    assert.equal(kernel.states.get(7).version, version);
    assert.equal(candidates.reviewBatch(choiceAt + 1), frame, 'new evidence cannot overwrite inflight frame');
    assert.equal(candidates.receipt({ frameId: frame.frameId + 1, at: frame.at, status: 'accepted' }), false);
    assert.equal(candidates.receipt({ frameId: frame.frameId, at: frame.at, status: 'deferred' }), true);
    assert.equal(candidates.frame, frame);
    assert.equal(candidates.receipt({ frameId: frame.frameId, at: frame.at, status: 'accepted' }), true);
    assert(candidates.pendingSpots.has('party-spot'), 'new input survives admission of old frame');
    const until = monitor.bots.get(key);
    assert.equal(until, choiceAt + 120000);
    replace(kernel, 7, {}, { replacement: true });
    assert.equal(monitor.bots.get(key), until, 'same-key packet replacement preserves authored cooldown');
    const oldPacket = kernel.states.get(7), oldRecord = kernel.states.locationIndex.getSource(7, 'state');
    kernel.remove(7); kernel.upsert(row(7, 'party-spot', { partyId: key }, { party }));
    assert.equal(monitor.bots.get(key), until, 'same-key remove/reinsert keeps policy until');
    assert.equal(candidates.ownerRemoved(7, oldRecord, oldPacket), false, 'late old detach preserves replacement');
    monitor.bots.set(key, until + 1);
    candidates.releaseForecasts([event]);
    assert.equal(monitor.bots.get(key), until + 1, 'old forecast release cannot remove newer cooldown');
    assert.equal(kernel.states.locationIndex.getSource(7, 'state').source, kernel.states.get(7).state);
}
console.log('PASS newest/incomplete party dependency, same-key policy lifetime, frame/newinput/receipt identities');

// The SAME state reference can receive a different context. Old spot/party
// tags and the old eligibility alarm must detach before the new packet wins.
{
    const { kernel, candidates, at } = setup();
    const first = row(30, 'old-spot', {}, { party: { partyId: 'old-party', leaderId: 30, memberIds: [30, 31],
        updatedAt: 1, stats: { coldCompetition: { conflictUntil: base + 100 } } } });
    kernel.upsert(first);
    const source = kernel.states.get(30).state, oldPacket = kernel.states.get(30);
    const oldRecord = kernel.states.locationIndex.getSource(30, 'state');
    const oldAlarm = [...kernel.decisionAlarms.values()].find(entry => entry.dueAt === base + 100);
    assert(oldAlarm); assert(candidates.spots.get('old-spot').records.has(oldRecord));
    kernel.upsert({ state: source, context: { ...first.context, spot: { ...first.context.spot, id: 'different-context-spot' },
        party: { partyId: 'new-party', leaderId: 30, memberIds: [30, 32], updatedAt: 2,
            stats: { coldCompetition: { conflictUntil: base + 200 } } } } });
    const currentRecord = kernel.states.locationIndex.getSource(30, 'state');
    assert.equal(kernel.states.get(30).state, source); assert.notEqual(kernel.states.get(30), oldPacket);
    assert.equal(currentRecord, oldRecord, 'same original source preserves canonical record identity');
    assert.equal(candidates.spots.get('old-spot').records.size, 0);
    assert.equal(candidates.currentParty('old-party'), null); assert.equal(candidates.memberParties.has(31), false);
    assert(candidates.memberParties.get(32).has('new-party'));
    assert.equal(kernel.decisionAlarms.has(oldAlarm.key), false, 'old context deadline is cancelled');
    assert.equal(candidates.ownerRemoved(30, oldRecord, oldPacket), false, 'late predecessor cannot detach current context');
    candidates.pendingActors.clear(); candidates.pendingSpots.clear();
    at(base + 100); assert.equal(kernel.drainDecisionDeadlines(base + 100, { remaining: 64 }), 0);
    assert.equal(candidates.pendingActors.size, 0);
    at(base + 200); assert.equal(kernel.drainDecisionDeadlines(base + 200, { remaining: 64 }), 1);
    assert(candidates.pendingActors.has(30), 'only current context expiry queues current evidence');
    assert.equal(candidates.activeHunters, 0);
    kernel.upsert({ state: source, context: first.context });
    assert.equal(candidates.activeHunters, 1); assert.equal(candidates.spots.get('old-spot').records.size, 1);
    assert.equal(candidates.currentParty('new-party'), null);
}
console.log('PASS same-source context replacement detaches old spot/party/deadline; late predecessor and old expiry harmless');

// The newest party context may live on an inactive contributor outside the
// roster. Its genuine conflict expiry still affects that party's hunters.
{
    const { kernel, candidates, at } = setup();
    const party = { partyId: 'deadline-party', leaderId: 7, memberIds: [7, 8], status: 'active',
        spotId: 'deadline-spot', updatedAt: 100, stats: { coldCompetition: { conflictUntil: base + 100 } } };
    kernel.upsertMany([row(7, 'deadline-spot', { partyId: party.partyId }),
        row(8, 'deadline-spot', { partyId: party.partyId }), row(20, 'elsewhere', { phase: 'hot' }, { party })]);
    assert.equal(candidates.currentParty(party.partyId), party);
    candidates.pendingActors.clear(); candidates.pendingSpots.clear(); at(base + 100);
    assert.equal(kernel.drainDecisionDeadlines(base + 100, { remaining: 64 }), 1);
    assert(candidates.pendingSpots.has('deadline-spot'), 'inactive newest-party contributor expiry must wake affected hunter spot');
    assert(candidates.pendingActors.has(7) && candidates.pendingActors.has(8));
}
console.log('PASS inactive newest-party contributor deadline queues affected hunters');

// Every consumed key is budgeted even if no source, no pressure or no outcome.
{
    const { candidates, monitor } = setup();
    for (let i = 0; i < 70; i++) candidates.queueSpot(`empty-${i}`);
    for (let i = 0; i < 260; i++) candidates.queueActor(i + 1);
    assert.equal(candidates.reviewBatch(base), null);
    assert.equal(monitor.report.consumedSpotKeys, 32); assert.equal(monitor.report.consumedActorKeys, 128);
    assert.equal(candidates.pendingSpots.size, 38); assert.equal(candidates.pendingActors.size, 132);
    assert.equal(candidates.pendingSpots.keys().next().value, 'empty-32');
    assert.equal(candidates.pendingActors.keys().next().value, 129);
    candidates.reviewBatch(base + 1);
    assert.equal(candidates.pendingSpots.size, 6); assert.equal(candidates.pendingActors.size, 4);
}
console.log('PASS zero-outcome32spot/128actor key budget retains FIFO overflow');

// Byte refusal happens before any forecast cooldown; current evidence remains.
for (const fit of [() => false, () => { throw Error('generated quote failure'); }]) {
    const { kernel, candidates, monitor, at } = setup(fit);
    kernel.upsertMany([row(1, 'bytes'), row(2, 'bytes')]); candidates.reviewBatch(base);
    const time = opportunity('bytes'); at(time); replace(kernel, 1);
    assert.equal(candidates.reviewBatch(time), null);
    assert.equal(monitor.pairs.size, 0); assert.equal(monitor.bots.size, 0);
    assert(candidates.pendingSpots.has('bytes')); assert.equal(candidates.frame, null);
}
console.log('PASS byte-omitted forecast leaves no policy cooldown and retains input');

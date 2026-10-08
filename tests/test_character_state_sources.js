'use strict';
const assert = require('assert');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const born = 1000;
const make = (id, patch = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting',
    loc: { locX: 1, locY: 2, locZ: 999 }, stats: {}, inventory: {}, updatedAt: born,
    timing: { lastResolvedAt: born, nextResolveAt: born + 3600000 },
    simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 }, ...patch });
const kernel = options => new ColdSimulationKernel({ resolveSolo: () => ({}), now: () => born, ...options });
const backingSize = value => Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value);

(async () => {
    const strict = new Index(), actor = { id: 1, source: {}, phase: 'hot', loc: { locX: 1, locY: 2, locZ: 3 } };
    strict.put(actor); assert.strictEqual(strict.get(1), actor);
    assert.throws(() => strict.put({ ...actor, loc: { locX: NaN, locY: 2, locZ: 3 } }), /invalid_character_location/);
    assert.strictEqual(strict.get(1), actor);
    const cache = new Cache(), first = make(1);
    cache.set(1, first); assert.strictEqual(cache.get(1), first); assert.strictEqual(backingSize(cache), 0);
    cache.set(0, false); assert(cache.has(0)); assert.strictEqual(cache.get(0), false);
    assert.throws(() => new Cache({ locationIndex: cache.locationIndex }), /already_owned/);
    const k = kernel(), context = { targetNpcId: 1 };
    assert(k.upsert({ state: first, context }));
    const oldPacket = k.states.get(1);
    assert.strictEqual(oldPacket.state, first); assert.strictEqual(oldPacket.context, context);
    console.log('current default strict/index/cache primitive/original Kernel packet positives: PASS');
    assert.strictEqual(backingSize(k.states), 0, 'retained current packets use the common record, with no native Map backing');

    const Sources = require('../src/GameServer/World/CharacterStateSources');
    const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
    assert.throws(() => Runtime.beginWorkerProjectorRole('cold-worker'), /worker_projector/);
    for (const fakeRole of [{}, false, 0]) {
        assert.throws(() => new Cache({ locationIndex: Runtime.index, workerProjectorRole: fakeRole }), /worker_projector/);
    }
    assert.throws(() => cache.passiveWorkerStateSources({}), /worker_projector/);
    assert.throws(() => Sources.passiveForCache(cache.locationIndex, cache), /passive/);
    assert.throws(() => Sources.registerCacheOwner(cache.locationIndex, {}, { role: {}, isCurrent: () => true }), /already_owned/);
    assert.throws(() => Sources.issueNativeGrant(cache.locationIndex, cache, {}, 'cold-worker'), /passive_grant/);
    assert.throws(() => Sources.attachKernel({}), /state_sources/);
    assert.strictEqual(cache.get(1), first);

    const cap = Sources.standalone(), handle = Sources.attachKernel(cap);
    assert.throws(() => Sources.attachKernel(cap), /already_attached/);
    const recordPacket = { state: make(11), context: { route: null }, version: 7 };
    assert.strictEqual(handle.publish(11, recordPacket), recordPacket);
    const record = handle.index.getSource(11, 'state');
    assert.strictEqual(record.source, recordPacket.state); assert.strictEqual(handle.get(11), recordPacket);
    const cell = handle.index.cells.get('0_0').state.cold;
    const movedContext = { ...recordPacket, context: { fresh: true } };
    handle.publish(11, movedContext);
    assert.strictEqual(handle.index.getSource(11, 'state'), record);
    assert.strictEqual(handle.index.cells.get('0_0').state.cold, cell);
    assert.strictEqual(recordPacket.context.route, null); assert.strictEqual(handle.get(11), movedContext);
    const replacement = { state: make(11, { adena: 31 }), context: {}, version: 7 };
    handle.publish(11, replacement);
    assert.strictEqual(handle.index.getSource(11, 'state').source, replacement.state);
    assert.strictEqual(handle.remove(11, recordPacket.state), false);
    assert.strictEqual(handle.get(11), replacement);
    assert.strictEqual(record.source, recordPacket.state, 'old yielded raw record keeps original source');

    const a = { id: 11, source: {}, phase: 'hot', loc: { locX: 1, locY: 2, locZ: 3 } };
    handle.index.put(a);
    const live = handle.values(); assert.strictEqual(live.next().value, replacement);
    const next = { state: make(12), context: {}, version: 1 }; handle.publish(12, next);
    assert.strictEqual(live.next().value, next); assert(live.next().done);
    handle.clear(); assert.strictEqual(handle.size(), 0); assert.strictEqual(handle.index.get(11), a);
    assert.throws(() => Sources.attachKernel(cap), /already_attached/, 'clear does not release attachment');
    assert.strictEqual(handle.remove(11, replacement.state), false);

    const second = kernel(); second.upsert({ state: make(1, { adena: 999 }), context: {} });
    assert.notStrictEqual(second.states.locationIndex, k.states.locationIndex);
    const stale = make(1, { simulation: { ...first.simulation, revision: 1 } }), freshContext = { fresh: true };
    assert.strictEqual(k.upsert({ state: stale, context: freshContext }), false);
    assert.strictEqual(k.states.get(1).state, first); assert.strictEqual(k.states.get(1).context, freshContext);
    assert.strictEqual(k.states.locationIndex.getSource(1, 'state').source, first);
    const heapToken = k.scheduleTokens.get(1);
    const sameRevision = make(1, { adena: 31 }); k.upsert({ state: sameRevision, context: freshContext });
    assert.strictEqual(k.states.get(1).version, oldPacket.version);
    assert.strictEqual(k.scheduleTokens.get(1), heapToken);
    assert.strictEqual(oldPacket.state, first); assert.strictEqual(oldPacket.context, context);
    assert.strictEqual(k.states.locationIndex.getSource(1, 'state').source, sameRevision);
    for (const id of [-2, Infinity, 1e100]) {
        const original = make(id); assert(k.upsert({ state: original, context: {} }));
        assert.strictEqual(k.states.locationIndex.getSource(id, 'state').source, original);
    }
    for (const [id, patch] of [[21, { phase: 'warm' }], [22, { phase: 'hot' }], [23, { activity: 'pk_hunting' }]]) {
        const original = make(id, patch);
        Object.defineProperty(original, 'loc', { get() { throw Error('inactive_point_read'); } });
        k.upsert({ state: original, context: {} });
        assert.strictEqual(k.states.locationIndex.getSource(id, 'state').source, original);
        assert.strictEqual(k.states.locationIndex.records.get(id).state.indexed, false);
        assert.strictEqual(original.phase, patch.phase || 'cold');
    }
    const malformed = make(24, { loc: { locX: 'bad', locY: 0 } });
    k.upsert({ state: malformed, context: {} });
    assert.strictEqual(k.states.locationIndex.records.get(24).state.indexed, false);
    const missing = make(25, { loc: {} }); k.upsert({ state: missing, context: {} });
    assert(k.states.locationIndex.records.get(25).state.indexed);
    let rawReads = 0;
    for (let id = 30; id < 94; id++) {
        const original = make(id, { phase: 'hot' });
        Object.defineProperty(original, 'loc', { get() { rawReads++; throw Error('unrelated_point_read'); } });
        k.upsert({ state: original, context: {} });
    }
    assert.strictEqual(rawReads, 0);
    k.states.get(1); k.states.has(1); k.states.locationIndex.nearSources({ locX: 0, locY: 0, locZ: 0 }, 10, { view: 'state' });
    assert.strictEqual(rawReads, 0);
    assert.strictEqual(k.fence(1).characterId, 1);
    assert.strictEqual(k.states.locationIndex.getSource(1, 'state'), null);
    assert.strictEqual(second.states.get(1).state.adena, 999);

    const ordered = kernel(); for (let id = 1; id <= 3; id++) ordered.upsert({ state: make(id), context: {} });
    assert.equal(ordered.states.startSafetyCycle, undefined);
    assert.equal(ordered.states.inspectSafetyPage, undefined);
    assert.equal(ordered.states.safetyNodes, undefined);
    ordered.remove(2); ordered.upsert({ state: make(4), context: {} });
    assert.deepEqual([...ordered.states.keys()], [1, 3, 4], 'original state order needs no second safety list');
    const calls = [], receiver = {};
    function collect(value, key, map) { calls.push([this, value, key, map]); }
    collect.call = () => { throw Error('own_call_used'); };
    ordered.states.forEach(collect, receiver);
    assert.deepStrictEqual(calls.map(row => row[2]), [1, 3, 4]); assert(calls.every(row => row[0] === receiver && row[3] === ordered.states));
    ordered.states.clear(); assert.throws(() => ordered.states.forEach(null), TypeError);
    assert.strictEqual(backingSize(ordered.states), 0); assert.strictEqual(ordered.states.locationIndex.sourceSize('state'), 0);
    await k.shutdown(); assert(k.states.size > 0, 'shutdown keeps retained sources');

    // Exercise the actual Kernel proposal/ACK path; only its existing pure resolver/projector providers are injected.
    let clock = 3000; const messages = [];
    const pending = kernel({ now: () => clock, resolveSolo: () => ({ patch: {}, materialize: {}, events: [], nextResolveAt: 9000 }),
        projectResolve: source => ({ ...source, loc: { locX: 12000, locY: 1, locZ: 0 } }),
        emit: (type, payload, msgId) => messages.push({ type, payload, msgId }) });
    const input = make(200, { timing: { lastResolvedAt: 1000, nextResolveAt: 2000 } });
    pending.upsert({ state: input, context: {} }); pending.tick();
    const claim = messages.find(message => message.type === 'claim_request'); assert(claim);
    const grant = { ok: true, characterId: 200, ownerId: 'cold_simulation_owner', revision: 3,
        leaseId: 'source-projection', leaseUntil: 30000, purpose: claim.payload.candidates[0].purpose };
    pending.onClaimAck({ grants: [grant] }, claim.msgId); await pending.resolveChain;
    const proposal = pending.dirty.get(200) || messages.find(message => message.type === 'proposal_batch')?.payload.proposals[0];
    assert(proposal?.nextState);
    assert.strictEqual(pending.states.locationIndex.getSource(200, 'state').source, input,
        'projected geometry is not current before admitted commit');
    pending.flush(null, true);
    const sent = messages.find(message => message.type === 'proposal_batch'); assert(sent);
    const output = { ...proposal.nextState, simulation: { ownerId: 'cold_simulation_owner', revision: 4,
        leaseId: grant.leaseId, leaseUntil: grant.leaseUntil } };
    const accepted = pending.onCommitAck({ results: [{ ok: true, characterId: 200, state: output,
        inputToken: proposal.token, proposalId: proposal.proposalId }] });
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(pending.states.locationIndex.getSource(200, 'state').source, output);
    clock++;
    console.log('Character current-state source/provider/geometry/authority/Map and proposal lifetime checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(root + '/src/Global');
const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
const Protocol = require(root + '/src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationKernel } = require(root + '/src/GameServer/Bot/Population/ColdSimulationKernel');
const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'n53-ack-lifetime-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
options.default.Database.historyPath = path.join(dir, 'history.sqlite');
let now = 1000000, sequence = 0;
const failures = [];
const tokenOf = token => ({ characterId: token.characterId, ownerId: token.ownerId,
    revision: token.revision, leaseId: token.leaseId, leaseUntil: token.leaseUntil });
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
async function create(partyId = null) {
    const number = ++sequence, account = `bot_ack_life_${number}`, name = `AckLife${number}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 10, locY: 20, locZ: -30 })).insertId);
    await Database.execute([`INSERT INTO bot_life_state
        (characterId,accountName,characterName,phase,activity,partyId,locX,locY,locZ,
         hp,maxHp,mp,maxMp,adena,statsJson,inventorySummary,updatedAt)
        VALUES (?,? ,?,'cold','hunting',?,10,20,-30,100,100,100,100,1200,'{}','{}',?)`,
    [id, account, name, partyId, now]]);
    const state = { characterId: id, accountName: account, name, partyId, phase: 'cold', activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 }, inventory: {}, adena: 1200, stats: {}, updatedAt: now,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { lastResolvedAt: now, nextResolveAt: now },
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0, leaseId: null, leaseUntil: 0 } };
    LifeState.acceptSimulationOwnership(id, state.simulation, state); return state;
}
const resolve = () => ({ patch: {}, events: [], materialize: {}, nextResolveAt: now + 60000 });
function harness(states, { resolver = resolve, party = null } = {}) {
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => now, maxInFlight: 128,
        resolveSolo: resolver, resolveParty: () => new Promise(() => {}),
        emit: (type, payload, msgId) => { messages.push({ type, payload, msgId }); return true; } });
    states.forEach((state, index) => kernel.upsert({ state, context: { spot: { id: 'ack-lifetime' },
        ...(party ? { party, partyMembers: states, isPartyLeader: index === 0 } : {}) } }));
    kernel.tick(); return { kernel, messages };
}
async function claim(state) {
    const result = await Owner.claimBatch([{ state, options: { allowParty: !!state.partyId, allowLifecycle: true } }],
        { timestamp: now, leaseMs: 30000 });
    assert.equal(result.grants.length, 1); return result.grants[0];
}
async function accept(h, grant) {
    const request = h.messages.filter(message => message.type === 'claim_request').at(-1);
    h.kernel.onClaimAck({ grants: [grant] }, request.msgId);
    await h.kernel.resolveChain; h.kernel.flush(null, true);
    return h.messages.filter(message => message.type === 'proposal_batch').at(-1)?.payload.proposals[0];
}
async function durable(id) {
    return { life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0],
        character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]))[0],
        items: await Database.execute(['SELECT * FROM items WHERE characterId=? ORDER BY id', [id]]) };
}
function local(kernel, id) {
    const scheduled = kernel.scheduleTokens.get(id);
    return JSON.stringify({ state: kernel.states.get(id)?.state, context: kernel.states.get(id)?.context,
        version: kernel.versions.get(id), active: kernel.inFlight.get(id)?.grant,
        pending: kernel.pendingReleases?.get(id), dirty: kernel.dirty.get(id)?.proposalId,
        claiming: kernel.claiming.has(id), attempt: kernel.claimAttempts.get(id),
        schedule: scheduled && { token: scheduled.token, version: scheduled.version, dueAt: scheduled.dueAt },
        stale: kernel.stats.stale, snapshots: kernel.stats.snapshots, heap: kernel.heap.size });
}
const commitAck = (result, proposal, state) => ({ ...result, characterId: proposal.characterId,
    inputToken: tokenOf(proposal.token), proposalId: proposal.proposalId, state, context: {} });
const releaseAck = (result, request, token, state) => ({ ...result, characterId: token.characterId,
    inputToken: tokenOf(token), releaseRequestId: request.msgId, state, context: {} });
(async () => {
    Database.init();
    for (const kind of ['Commit', 'Release']) await check(`native stale ${kind} ACK preserves a replacement; current native ACK settles once`, async () => {
        const state = await create(), h = harness([state]), first = await claim(state);
        const oldProposal = await accept(h, first);
        let oldRelease;
        if (kind === 'Release' && typeof h.kernel.requestRelease === 'function') {
            h.kernel.requestRelease([{ token: first, reason: 'late_ack_control' }]); oldRelease = h.messages.at(-1);
        }
        now = first.leaseUntil + 1; h.kernel.recoverStalled(now); await Owner.recoverExpiredLeases(now);
        const currentState = LifeState.cachedState(state.characterId);
        h.kernel.upsert({ state: { ...currentState, timing: { ...currentState.timing, nextResolveAt: now } }, context: {} });
        h.kernel.tick(); const current = await claim(currentState), proposal = await accept(h, current);
        const active = h.kernel.inFlight.get(state.characterId), before = await durable(state.characterId);
        const localBefore = local(h.kernel, state.characterId);
        const stale = kind === 'Commit' ? await Owner.commit(first, currentState, { timestamp: now })
            : (await Owner.releaseBatch([first], { timestamp: now, releaseInvalidated: true }))[0];
        assert.equal(stale.reason, 'stale_revision');
        const ack = kind === 'Commit' ? commitAck(stale, oldProposal, currentState)
            : releaseAck(stale, oldRelease || {}, first, currentState);
        if (kind === 'Commit') h.kernel.onCommitAck({ results: [ack] });
        else h.kernel.onReleaseAck({ results: [ack] });
        assert.equal(h.kernel.inFlight.get(state.characterId), active, 'old native refusal cannot remove the new held grant');
        assert.equal(local(h.kernel, state.characterId), localBefore);
        assert.deepEqual(await durable(state.characterId), before, 'native stale CAS and ACK conserve physical/life state');
        let result, currentAck;
        if (kind === 'Commit') {
            result = await Owner.commit(current, { ...currentState, adena: 1225,
                timing: { ...currentState.timing, nextResolveAt: now + 60000 } }, { timestamp: now });
            currentAck = commitAck(result, proposal, LifeState.cachedState(state.characterId));
        } else {
            h.kernel.requestRelease([{ token: current, reason: 'current_ack_control' }]);
            const request = h.messages.at(-1);
            result = (await Owner.releaseBatch([current], { timestamp: now, releaseInvalidated: true }))[0];
            currentAck = releaseAck(result, request, current, LifeState.cachedState(state.characterId));
        }
        assert(result.ok);
        if (kind === 'Commit') assert.equal((await durable(state.characterId)).life.adena, 1225);
        const accepted = kind === 'Commit' ? h.kernel.onCommitAck({ results: [currentAck] })
            : h.kernel.onReleaseAck({ results: [currentAck] });
        assert.equal(accepted.length, 1); assert(!h.kernel.inFlight.has(state.characterId));
        assert.equal(h.kernel.states.get(state.characterId).state.simulation.revision, result.revision);
        const done = local(h.kernel, state.characterId), durableDone = await durable(state.characterId);
        const replay = kind === 'Commit' ? h.kernel.onCommitAck({ results: [currentAck] })
            : h.kernel.onReleaseAck({ results: [currentAck] });
        assert.equal(replay.length, 0); assert.equal(local(h.kernel, state.characterId), done);
        assert.deepEqual(await durable(state.characterId), durableDone);
    });
    await check('commit admission requires a sent proposal and exact input tuple, preserving newer cached state', async () => {
        const state = await create(), h = harness([state]), grant = await claim(state), proposal = await accept(h, grant);
        const base = commitAck({ ok: true }, proposal, { ...state, phase: 'hot' });
        const before = local(h.kernel, state.characterId);
        for (const bad of [{ ...base, inputToken: undefined }, { ...base, proposalId: undefined },
            { ...base, proposalId: 'different' }, { ...base, inputToken: { ...base.inputToken, revision: grant.revision + 1 } },
            { ...base, inputToken: { ...base.inputToken, leaseId: 'different' } },
            { ...base, inputToken: { ...base.inputToken, ownerId: 'legacy_main' } }]) {
            h.kernel.onCommitAck({ results: [bad] }); assert.equal(local(h.kernel, state.characterId), before);
        }
        h.kernel.upsert({ state: { ...state, simulation: { ownerId: 'legacy_main', revision: grant.revision + 1,
            leaseId: null, leaseUntil: 0 }, timing: { nextResolveAt: now + 90000 } }, context: { fresh: true } });
        const accepted = h.kernel.onCommitAck({ results: [{ ...base, state: { ...state,
            simulation: { ownerId: 'legacy_main', revision: grant.revision, leaseId: null, leaseUntil: 0 } } }] });
        assert.equal(accepted.length, 1); assert(!h.kernel.inFlight.has(state.characterId));
        assert.equal(h.kernel.states.get(state.characterId).state.simulation.revision, grant.revision + 1);
        assert(h.kernel.hasNormalCoverage(state.characterId));
        const unsentState = await create(), unsent = harness([unsentState]), unsentToken = await claim(unsentState);
        const request = unsent.messages.find(message => message.type === 'claim_request');
        unsent.kernel.onClaimAck({ grants: [unsentToken] }, request.msgId); await unsent.kernel.resolveChain;
        const unsentProposal = unsent.kernel.dirty.get(unsentState.characterId); assert(unsentProposal);
        const unsentBefore = local(unsent.kernel, unsentState.characterId);
        assert.equal(unsent.kernel.onCommitAck({ results: [commitAck({ ok: true }, unsentProposal, unsentState)] }).length, 0);
        assert.equal(local(unsent.kernel, unsentState.characterId), unsentBefore);
    });
    await check('a renewed deadline is not token identity and the original sent proposal still settles natively', async () => {
        const state = await create(), h = harness([state]), grant = await claim(state), proposal = await accept(h, grant);
        now = grant.leaseUntil - 1;
        const renewed = await Owner.renewActiveLeases([tokenOf(grant)], { now: () => now, canRenew: () => true });
        h.kernel.onLeaseRenewal({ renewals: renewed }); assert(renewed[0].ok);
        now = grant.leaseUntil + 1;
        const result = await Owner.commit(grant, { ...LifeState.cachedState(state.characterId),
            timing: { nextResolveAt: now + 60000 } }, { timestamp: now }); assert(result.ok);
        assert.equal(h.kernel.onCommitAck({ results: [commitAck(result, proposal,
            LifeState.cachedState(state.characterId))] }).length, 1);
    });
    await check('actual resolver-error release survives retired holder and rebases only matching native receipt', async () => {
        const state = await create(), h = harness([state], { resolver: () => { throw Error('controlled_resolver_error'); } });
        const grant = await claim(state); await accept(h, grant);
        assert(!h.kernel.inFlight.has(state.characterId));
        const request = h.messages.find(message => message.type === 'release_request'); assert(request);
        const result = (await Owner.releaseBatch([grant], { timestamp: now, releaseInvalidated: true }))[0]; assert(result.ok);
        const ack = releaseAck(result, request, grant, LifeState.cachedState(state.characterId));
        const before = local(h.kernel, state.characterId);
        h.kernel.onReleaseAck({ results: [{ ...ack, releaseRequestId: 'different' }] });
        assert.equal(local(h.kernel, state.characterId), before);
        assert.equal(h.kernel.onReleaseAck({ results: [ack] }).length, 1);
        assert.equal(h.kernel.states.get(state.characterId).state.simulation.revision, result.revision);
        assert(h.kernel.hasNormalCoverage(state.characterId));
        const after = local(h.kernel, state.characterId);
        assert.equal(h.kernel.onReleaseAck({ results: [ack] }).length, 0); assert.equal(local(h.kernel, state.characterId), after);
    });
    await check('matching rejected partial-party release is admitted after the party run retires', async () => {
        const partyId = `partial-ack-${sequence}`, states = [await create(partyId), await create(partyId)];
        const party = { partyId, leaderId: states[0].characterId, memberIds: states.map(state => state.characterId) };
        const h = harness(states, { party }), request = h.messages.find(message => message.type === 'claim_request');
        const grant = await claim(states[0]);
        h.kernel.onClaimAck({ grants: [{ ...grant, purpose: request.payload.candidates[0].purpose }], rejected: [{
            characterId: states[1].characterId, reason: 'controlled_refusal', purpose: request.payload.candidates[1].purpose
        }] }, request.msgId);
        assert.equal(h.kernel.partyRuns.size, 0); assert(!h.kernel.inFlight.has(states[0].characterId));
        const release = h.messages.find(message => message.type === 'release_request'); assert(release?.msgId);
        const [result] = await Owner.releaseBatch([grant], { timestamp: now, releaseInvalidated: true }); assert(result.ok);
        assert.equal(h.kernel.onReleaseAck({ results: [releaseAck(result, release, grant,
            LifeState.cachedState(states[0].characterId))] }).length, 1);
        assert.equal(h.kernel.states.get(states[0].characterId).state.simulation.revision, result.revision);
    });
    await check('release receipt cannot revive after replacement claim, explicit remove, fence, deadline or shutdown', async () => {
        for (const boundary of ['replacement', 'remove', 'fence', 'hot', 'deadline', 'shutdown']) {
            const state = await create(), h = harness([state], { resolver: () => { throw Error('release_boundary'); } });
            const grant = await claim(state); await accept(h, grant);
            const request = h.messages.find(message => message.type === 'release_request');
            if (boundary === 'replacement') { h.kernel.requeue(state.characterId, now); h.kernel.tick(); assert(h.kernel.claiming.has(state.characterId)); }
            if (boundary === 'remove') h.kernel.remove(state.characterId);
            if (boundary === 'fence') h.kernel.fence(state.characterId);
            if (boundary === 'hot') h.kernel.upsert({ state: { ...state, phase: 'hot' } });
            if (boundary === 'deadline') now = grant.leaseUntil + 1;
            if (boundary === 'shutdown') await h.kernel.shutdown();
            const before = local(h.kernel, state.characterId);
            const accepted = h.kernel.onReleaseAck({ results: [releaseAck({ ok: true }, request, grant,
                { ...state, simulation: { ownerId: 'legacy_main', revision: grant.revision + 1 } })] });
            assert.equal(accepted.length, 0, boundary);
            // Expiry may remove its dead receipt; it cannot mutate runnable/local ownership facts.
            const after = local(h.kernel, state.characterId);
            if (boundary !== 'deadline') assert.equal(after, before, boundary);
            else assert.equal(h.kernel.states.get(state.characterId).state.simulation.revision, 0);
        }
    });
    await check('release producer registers before synchronous echo and bounds retention without sweeps', () => {
        const kernel = new ColdSimulationKernel({ now: () => now, resolveSolo: resolve }); let reply;
        kernel.emit = (type, payload, msgId) => {
            assert.equal(type, 'release_request'); assert(msgId);
            reply = kernel.onReleaseAck({ results: payload.releases.map(entry => releaseAck({ ok: true }, { msgId }, entry.token)) });
        };
        const state = { characterId: 90000, phase: 'cold', activity: 'hunting', stats: {}, timing: { nextResolveAt: now } };
        kernel.upsert({ state });
        const token = { ok: true, characterId: state.characterId, ownerId: Owner.OWNER_ID,
            revision: 1, leaseId: 'sync-release', leaseUntil: now + 30000 };
        kernel.requestRelease([{ token, reason: 'sync' }]); assert.equal(reply.length, 1);
        kernel.emit = () => true;
        for (let index = 0; index < 128 * Protocol.MAX_BATCH + 1; index++) {
            kernel.requestRelease([{ token: { ...token, characterId: index + 1, leaseId: `bound-${index}` } }]);
        }
        assert.equal(kernel.pendingReleases.size, 128 * Protocol.MAX_BATCH);
        assert(!kernel.pendingReleases.has(1), 'old local admission is evicted without suppressing native release requests');
    });
    await check('Protocol rejects missing/coerced/cross-ID ACK fields while preserving byte/epoch/batch limits', () => {
        const inputToken = { characterId: 1, ownerId: Owner.OWNER_ID, revision: 1, leaseId: 'protocol-ack', leaseUntil: now + 30000 };
        for (const type of ['commit_ack', 'release_ack']) {
            const result = { ok: true, characterId: 1, inputToken,
                ...(type === 'commit_ack' ? { proposalId: 'protocol-ack:1' } : { releaseRequestId: 'release:1' }) };
            const message = Protocol.envelope(type, 'ack-epoch', { results: [result] });
            assert(Protocol.validateEnvelope(message, 'main').ok);
            for (const bad of [{ ...result, inputToken: null }, { ...result, characterId: 2 },
                Object.assign([], result),
                { ...result, inputToken: { ...inputToken, revision: '1' } },
                { ...result, proposalId: undefined, releaseRequestId: undefined }]) {
                assert(!Protocol.validateEnvelope({ ...message, payload: { results: [bad] } }, 'main').ok);
            }
            assert(!Protocol.validateEnvelope({ ...message, payload: { results: [result, result] } }, 'main').ok);
            assert(!Protocol.validateEnvelope(message, 'main', { bytes: Protocol.MAX_MESSAGE_BYTES + 1 }).ok);
            assert(!Protocol.validateEnvelope(message, 'main', { workerEpoch: 'replacement' }).ok);
        }
    });
    await check('actual Worker keeps stale ACK effects inert and rearms board only for current accepted ACK', async () => {
        const workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js', epoch = 'ack-lifetime-worker';
        const source = String.raw`
const fs=require('fs'),path=require('path'),Module=require('module');
const {parentPort,workerData}=require('worker_threads');
const loaded=new Module(workerData.workerPath,module); loaded.filename=workerData.workerPath;
loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+'\nlet rearmCount=0; const realRearm=marketEvents.rearm.bind(marketEvents); marketEvents.rearm=id=>{rearmCount++;return realRearm(id);}; module.exports.control=(op,state)=>{if(op==="seed"||op==="seedError"){kernel.planLifecycle=null;kernel.resolveSolo=()=>{if(op==="seedError")throw Error("worker_controlled_error");return {patch:{},events:[],materialize:{},nextResolveAt:Date.now()+60000};};kernel.upsert({state,context:{}});kernel.tick();}return {active:kernel.inFlight.size,phase:kernel.states.get(state.characterId)?.state.phase,revision:kernel.states.get(state.characterId)?.state.simulation?.revision,rearms:rearmCount};};',workerData.workerPath);
parentPort.on('message',m=>{if(m.control)parentPort.postMessage({controlAck:m.controlId,value:loaded.exports.control(m.control,m.state)});});`;
        const worker = new Worker(source, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
        const messages = []; let fault, seq = 0;
        worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
        const wait = async predicate => {
            const deadline = Date.now() + 10000;
            while (!messages.some(predicate)) {
                if (fault) throw fault;
                if (Date.now() >= deadline) throw Error('bounded actual Worker ACK timeout');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return messages.find(predicate);
        };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        const control = async (op, state) => {
            const controlId = ++seq; worker.postMessage({ control: op, state, controlId });
            return (await wait(message => message.controlAck === controlId)).value;
        };
        try {
            await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
            send('init', { config: { loopIntervalMs: 100000, heartbeatIntervalMs: 100000, maxInFlight: 1 } });
            await wait(message => message.type === 'ready' && message.payload.phase === 'running');
            const at = Date.now(), state = { characterId: 90001, phase: 'cold', activity: 'hunting', stats: {},
                inventory: {}, timing: { nextResolveAt: at }, simulation: { ownerId: 'legacy_main', revision: 0 } };
            await control('seed', state);
            const request = await wait(message => message.type === 'claim_request');
            const token = { ok: true, characterId: state.characterId, ownerId: Owner.OWNER_ID,
                revision: 1, leaseId: 'worker-current', leaseUntil: at + 30000 };
            send('claim_ack', { grants: [token] }, request.msgId);
            const batch = await wait(message => message.type === 'proposal_batch'), proposal = batch.payload.proposals[0];
            const before = await control('inspect', state);
            send('commit_ack', { results: [{ ok: false, characterId: state.characterId,
                inputToken: { ...tokenOf(token), leaseId: 'worker-old' }, proposalId: 'worker-old:1',
                state: { ...state, phase: 'hot' }, context: {} }] });
            assert.deepEqual(await control('inspect', state), before);
            const current = commitAck({ ok: true }, proposal, { ...state, timing: { nextResolveAt: at + 60000 },
                simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 } });
            send('commit_ack', { results: [current] });
            const after = await control('inspect', state);
            assert.equal(after.active, 0); assert.equal(after.revision, 2); assert.equal(after.rearms, before.rearms + 1);
            send('commit_ack', { results: [current] }); assert.deepEqual(await control('inspect', state), after);
            const errorState = { ...state, characterId: 90002 };
            await control('seedError', errorState);
            const errorRequest = await wait(message => message.type === 'claim_request'
                && message.payload.candidates.some(candidate => candidate.characterId === errorState.characterId));
            const errorToken = { ...token, characterId: errorState.characterId, leaseId: 'worker-error' };
            send('claim_ack', { grants: [errorToken] }, errorRequest.msgId);
            const release = await wait(message => message.type === 'release_request');
            const errorBefore = await control('inspect', errorState);
            const ack = releaseAck({ ok: true }, release, errorToken, { ...errorState,
                simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 } });
            send('release_ack', { results: [{ ...ack, releaseRequestId: 'old-release' }] });
            assert.deepEqual(await control('inspect', errorState), errorBefore);
            send('release_ack', { results: [ack] });
            const errorAfter = await control('inspect', errorState);
            assert.equal(errorAfter.revision, 2); assert.equal(errorAfter.rearms, errorBefore.rearms + 1);
            send('release_ack', { results: [ack] }); assert.deepEqual(await control('inspect', errorState), errorAfter);
        } finally { await worker.terminate(); }
    });
    if (failures.length) { console.error(`${failures.length} failed groups`); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Writes.flushAll(); await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

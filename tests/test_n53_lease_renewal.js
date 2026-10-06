const assert = require('assert');
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
const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'n53-lease-renewal-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
options.default.Database.historyPath = path.join(dir, 'history.sqlite');
const failures = [];
let now = 1000000, sequence = 0;
const opts = (extra = {}) => ({ now: () => now, leaseMs: 30000, canRenew: () => true, ...extra });
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
async function create(partyId = null) {
    const number = ++sequence, account = `bot_renew_${number}`, name = `Renew${number}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 10, locY: 20, locZ: -30 })).insertId);
    await Database.execute([`INSERT INTO bot_life_state
        (characterId,accountName,characterName,phase,activity,partyId,locX,locY,locZ,
         hp,maxHp,mp,maxMp,statsJson,inventorySummary,updatedAt)
        VALUES (?,? ,?,'cold','hunting',?,10,20,-30,100,100,100,100,'{}','{}',?)`,
    [id, account, name, partyId, now]]);
    const state = { characterId: id, accountName: account, name, partyId, phase: 'cold', activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 }, inventory: {}, stats: {}, updatedAt: now,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { lastResolvedAt: now, nextResolveAt: now },
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0, leaseId: null, leaseUntil: 0 } };
    LifeState.acceptSimulationOwnership(id, state.simulation, state);
    return state;
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
function harness(states, party = null) {
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => now, maxInFlight: 128,
        resolveSolo: () => new Promise(() => {}), resolveParty: () => new Promise(() => {}),
        emit: (type, payload, msgId) => { messages.push({ type, payload, msgId }); return true; } });
    states.forEach((state, index) => kernel.upsert({ state, context: { spot: { id: 'renewal' },
        ...(party ? { party, partyMembers: states, isPartyLeader: index === 0 } : {}) } }));
    kernel.tick();
    return { kernel, request: messages.find(message => message.type === 'claim_request') };
}
async function claim(states) {
    const results = await Owner.claimBatch(states.map(state => ({ state,
        options: { allowParty: !!state.partyId, allowLifecycle: true } })), { timestamp: now, leaseMs: 30000 });
    assert.equal(results.grants.length, states.length); return results.grants;
}
async function renewHeld(kernel) {
    // Baseline-only adapter retains the real pre-feature blanket selection so
    // the native regression has evidence beyond a missing producer method.
    if (typeof kernel.leaseRenewalPages !== 'function') {
        return Owner.renewActiveLeases({ timestamp: now, leaseMs: 30000 });
    }
    const results = [];
    for (const tokens of kernel.leaseRenewalPages({ replyBy: now + 5000 })) {
        results.push(...await Owner.renewActiveLeases(tokens, opts()));
    }
    kernel.onLeaseRenewal({ renewals: results }); return results;
}
async function flushBarrier(work) {
    let entered, resume;
    const entry = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    Database.registerCharacterWriteFlush(() => { entered(); return gate; });
    try { await work({ entry, resume }); }
    finally { resume(); Database.registerCharacterWriteFlush(null); }
}
(async () => {
    Database.init();
    await check('late unmatched native grant expires while another accepted holder renews', async () => {
        const lost = await create(), active = await create();
        const a = harness([lost]), b = harness([active]);
        const [lostGrant, activeGrant] = await claim([lost, active]);
        b.kernel.onClaimAck({ grants: [activeGrant] }, b.request.msgId);
        now += 5000; a.kernel.recoverStalled(now);
        a.kernel.onClaimAck({ grants: [lostGrant] }, a.request.msgId);
        assert.equal(a.kernel.inFlight.size, 0);
        for (let index = 0; index < 8; index++, now += 5000) {
            await renewHeld(b.kernel); await Owner.recoverExpiredLeases(now);
        }
        assert.equal((await row(lost.characterId)).simulationOwner, Owner.LEGACY_OWNER_ID,
            'native lease abandoned by the worker must not be selected for renewal');
        assert.equal((await row(active.characterId)).simulationLeaseUntil,
            b.kernel.inFlight.get(active.characterId).grant.leaseUntil);
        assert(b.kernel.inFlight.get(active.characterId).grant.leaseUntil > activeGrant.leaseUntil);
    });
    await check('live partial-party rights renew; actual timeout retirement stops native extension', async () => {
        const partyId = `renew-party-${sequence}`;
        const states = [await create(partyId), await create(partyId)];
        const party = { partyId, status: 'active', leaderId: states[0].characterId,
            memberIds: states.map(state => state.characterId), nextResolveAt: now };
        const h = harness(states, party), grants = await claim(states);
        h.kernel.onClaimAck({ grants: [{ ...grants[0], purpose: h.request.payload.candidates[0].purpose }] }, h.request.msgId);
        now += 1000; await renewHeld(h.kernel);
        const liveUntil = h.kernel.partyRuns.get(partyId).grants.get(states[0].characterId).leaseUntil;
        const expectedLiveUntil = now + 30000;
        now += 4000; h.kernel.recoverStalled(now); assert.equal(h.kernel.partyRuns.size, 0);
        for (let index = 0; index < 8; index++, now += 5000) {
            await renewHeld(h.kernel); await Owner.recoverExpiredLeases(now);
        }
        assert.equal((await row(states[0].characterId)).simulationOwner, Owner.LEGACY_OWNER_ID);
        assert.equal(liveUntil, expectedLiveUntil);
    });
    await check('held pages are bounded, exclude retired identities, and avoid all-state/party-map scans', async () => {
        const states = [];
        for (let index = 0; index < 65; index++) states.push({ characterId: 10000 + index, phase: 'cold',
            activity: 'hunting', inventory: {}, stats: {}, simulation: { revision: 0 }, timing: { nextResolveAt: now } });
        const h = harness(states);
        const requests = [h.request];
        h.kernel.tick();
        // The public tick issues at most64; fill the second actual attempt.
        for (const [id, attempt] of h.kernel.claimAttempts) if (!requests.some(request => request.msgId === attempt.requestId)) {
            requests.push({ msgId: attempt.requestId, payload: { candidates: [{ characterId: id }] } });
        }
        requests.forEach(request => h.kernel.onClaimAck({ grants: request.payload.candidates.map(candidate => ({ ok: true,
            characterId: candidate.characterId, ownerId: Owner.OWNER_ID, revision: 1,
            leaseId: `held-${candidate.characterId}`, leaseUntil: now + 30000 })) }, request.msgId));
        assert.equal(h.kernel.inFlight.size, 65);
        for (const target of [h.kernel.states, h.kernel.partyRuns]) target.values = () => { throw new Error('global scan forbidden'); };
        h.kernel.snapshot = () => { throw new Error('snapshot forbidden'); };
        const pages = h.kernel.leaseRenewalPages({ replyBy: now + 5000 });
        const first = pages.next(); assert.equal(first.value.length, 64);
        const lastId = [...h.kernel.inFlight.keys()].find(id => !first.value.some(token => token.characterId === id));
        h.kernel.fence(lastId);
        assert.equal(pages.next().done, true, 'removed holder cannot survive a pagination yield');
        assert.equal([...h.kernel.leaseRenewalPages({ replyBy: now })].length, 0);
    });
    await check('completed party aliases renew once and fence/timeout holders never leak into proofs', async () => {
        const partyId = `completed-${sequence}`, states = [await create(partyId), await create(partyId)];
        const party = { partyId, status: 'active', leaderId: states[0].characterId,
            memberIds: states.map(state => state.characterId), nextResolveAt: now };
        const h = harness(states, party), grants = await claim(states);
        h.kernel.onClaimAck({ grants: grants.map((grant, i) => ({ ...grant,
            purpose: h.request.payload.candidates[i].purpose })) }, h.request.msgId);
        const tokens = [...h.kernel.leaseRenewalPages({ replyBy: now + 5000 })].flat();
        assert.equal(tokens.length, 2); assert.equal(new Set(tokens.map(token => token.characterId)).size, 2);
        now += 1000; await renewHeld(h.kernel);
        assert.equal(h.kernel.partyRuns.get(partyId).grants.get(states[0].characterId).leaseUntil, now + 30000);
        h.kernel.fence(states[0].characterId);
        assert.equal([...h.kernel.leaseRenewalPages({ replyBy: now + 5000 })].flat().length, 1);
    });
    await check('strict Protocol admits correlated bounded pages and rejects forged tokens/bytes', () => {
        const token = { characterId: 1, ownerId: Owner.OWNER_ID, revision: 1, leaseId: 'strict', leaseUntil: now + 30000 };
        const probe = Protocol.envelope('lease_renewal_probe', 'epoch', { replyBy: now + 5000 }, 'round');
        assert(Protocol.validateEnvelope(probe, 'main').ok);
        const page = Protocol.envelope('lease_renewal_candidates', 'epoch', {
            requestId: 'round', pageIndex: 0, done: true, tokens: [token] }, 'page');
        assert(Protocol.validateEnvelope(page, 'worker').ok);
        for (const malformed of [{ ...token, characterId: '1' }, { ...token, revision: true },
            { ...token, ownerId: 'legacy_main' }, { ...token, leaseUntil: Infinity }]) {
            assert(!Protocol.validateEnvelope({ ...page, payload: { ...page.payload, tokens: [malformed] } }, 'worker').ok);
        }
        assert(!Protocol.validateEnvelope({ ...page, payload: { ...page.payload, tokens: [token, token] } }, 'worker').ok);
        assert(!Protocol.validateEnvelope(page, 'worker', { bytes: Protocol.MAX_MESSAGE_BYTES + 1 }).ok);
        assert(!Protocol.validateEnvelope(page, 'worker', { workerEpoch: 'replacement' }).ok);
    });
    await check('invalid native batch has no flush/write and no blanket fallback', async () => {
        const state = await create(), [token] = await claim([state]), before = await row(state.characterId);
        let flushes = 0; Database.registerCharacterWriteFlush(() => { flushes++; });
        try {
            assert.deepEqual(await Owner.renewActiveLeases([], opts()), []);
            for (const tokens of [[token, token], Array(65).fill(token), [token, { ...token, revision: true }]]) {
                await assert.rejects(Database.renewColdSimulationLeases(tokens, opts()), /invalid_lease_renewal_batch/);
            }
            await assert.rejects(Owner.renewActiveLeases({ leaseMs: 30000 }), /invalid_lease_renewal_batch/);
            assert.equal(flushes, 0); assert.deepEqual(await row(state.characterId), before);
        } finally { Database.registerCharacterWriteFlush(null); }
    });
    await check('post-flush current cutoff prevents reviving an expired lease; source/fence refuses before write', async () => {
        assert.equal(typeof Protocol.leaseRenewalToken, 'function', 'post-flush renewal API is not present on baseline');
        const state = await create(), [token] = await claim([state]), before = await row(state.characterId);
        await flushBarrier(async ({ entry, resume }) => {
            const pending = Owner.renewActiveLeases([token], opts()); await entry;
            now = token.leaseUntil + 1; resume();
            const result = await pending; assert.equal(result[0].ok, false); assert.equal(result[0].reason, 'lease_expired');
        });
        assert.deepEqual(await row(state.characterId), before);
        await Owner.recoverExpiredLeases(now);
        const latest = LifeState.cachedState(state.characterId), [fresh] = await claim([latest]);
        const freshBefore = await row(state.characterId); let source = true;
        await flushBarrier(async ({ entry, resume }) => {
            const pending = Owner.renewActiveLeases([fresh], opts({ canRenew: () => source })); await entry;
            source = false; resume(); assert.equal((await pending)[0].reason, 'renewal_source_changed');
        });
        assert.deepEqual(await row(state.characterId), freshBefore);
    });
    await check('native tuple/phase guards preserve current ownership and physical state', async () => {
        const state = await create(), [token] = await claim([state]);
        const handed = await Owner.handoffToMain(LifeState.cachedState(state.characterId)); assert(handed.ok);
        const before = await row(state.characterId);
        assert.equal((await Owner.renewActiveLeases([token], opts()))[0].ok, false);
        assert.deepEqual(await row(state.characterId), before);
        const other = await create(), [hotToken] = await claim([other]);
        const cached = LifeState.cachedState(other.characterId);
        const hot = await Owner.handoffToMain(cached, { timestamp: now });
        assert(hot.ok);
        assert(await LifeState.upsertState({ ...LifeState.snapshot(other.characterId), phase: 'hot' }, 'n53_renewal_hot_handoff'));
        const hotBefore = await row(other.characterId); assert.equal(hotBefore.phase, 'hot');
        assert.equal((await Owner.renewActiveLeases([hotToken], opts()))[0].reason, 'not_cold');
        assert.deepEqual(await row(other.characterId), hotBefore);
    });
    await check('retirement after a fresh proof allows only one finite extension then natural expiry', async () => {
        const partyId = `proof-retired-${sequence}`, states = [await create(partyId), await create(partyId)];
        const party = { partyId, status: 'active', leaderId: states[0].characterId,
            memberIds: states.map(state => state.characterId), nextResolveAt: now };
        const h = harness(states, party), grants = await claim(states);
        h.kernel.onClaimAck({ grants: [{ ...grants[0], purpose: h.request.payload.candidates[0].purpose }] }, h.request.msgId);
        now += h.kernel.claimAckTimeoutMs - 1;
        const proof = h.kernel.leaseRenewalPages({ replyBy: now + 5000 }).next().value;
        assert.equal(proof.length, 1);
        now++; h.kernel.recoverStalled(now); assert.equal(h.kernel.partyRuns.size, 0);
        const [extended] = await Owner.renewActiveLeases(proof, opts()); assert(extended.ok);
        assert.equal(extended.leaseUntil, now + 30000);
        assert.deepEqual(await renewHeld(h.kernel), []);
        now = extended.leaseUntil + 1; await Owner.recoverExpiredLeases(now);
        assert.equal((await row(states[0].characterId)).simulationOwner, Owner.LEGACY_OWNER_ID);
    });
    await check('a failing clock after a prior row rolls back the native batch and leaves cache unchanged', async () => {
        const states = [await create(), await create()], tokens = await claim(states);
        const before = await Promise.all(states.map(state => row(state.characterId)));
        let reads = 0;
        await assert.rejects(Owner.renewActiveLeases(tokens, opts({ now: () => ++reads === 1 ? now + 1000 : NaN })),
            /invalid_lease_renewal_clock/);
        assert.deepEqual(await Promise.all(states.map(state => row(state.characterId))), before);
        states.forEach((state, i) => assert.equal(LifeState.cachedState(state.characterId).simulation.leaseUntil, tokens[i].leaseUntil));
    });
    await check('post-await native/cache advance cannot be overwritten by old renewal reflection', async () => {
        const state = await create(), [token] = await claim([state]);
        const original = Database.renewColdSimulationLeases; let advanced;
        Database.renewColdSimulationLeases = async (...args) => {
            const results = await original.apply(Database, args);
            advanced = await Owner.handoffToMain(LifeState.cachedState(state.characterId));
            assert(advanced.ok); return results;
        };
        try { now += 1000; assert((await Owner.renewActiveLeases([token], opts()))[0].ok); }
        finally { Database.renewColdSimulationLeases = original; }
        assert.equal(LifeState.cachedState(state.characterId).simulation.revision, advanced.revision);
        assert.equal(LifeState.cachedState(state.characterId).simulation.ownerId, Owner.LEGACY_OWNER_ID);
        assert.equal((await row(state.characterId)).simulationRevision, advanced.revision);
    });
    await check('actual Worker emits one correlated page per ACK and removes retired holders between pages', async () => {
        const epoch = 'native-renewal', workerPath = root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js';
        // Actual source and Protocol. Appended fixture controls use public
        // Kernel selection/ACK/fence; only expensive combat is held at a barrier.
        const source = String.raw`
const fs = require('fs'), path = require('path'), Module = require('module');
const { parentPort, workerData } = require('worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename=workerData.workerPath; loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+'\nmodule.exports.control=(op,entries)=>{if(op==="seed"){kernel.planLifecycle=null;kernel.resolveSolo=()=>new Promise(()=>{});kernel.upsertMany(entries);kernel.tick();kernel.tick();}if(op==="poison"){kernel.snapshot=()=>{throw Error("global_snapshot_forbidden");};kernel.states.values=()=>{throw Error("all_states_forbidden");};kernel.partyRuns.values=()=>{throw Error("all_parties_forbidden");};}return {waiting:leaseProbe?.waiting||null,active:kernel.inFlight.size};};',workerData.workerPath);
parentPort.on('message',m=>{if(m.control)parentPort.postMessage({controlAck:m.controlId,value:loaded.exports.control(m.control,m.entries)});});`;
        const worker = new Worker(source, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
        const messages = []; let fault, request = 0;
        worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
        const wait = async predicate => {
            const deadline = Date.now() + 10000;
            while (!messages.some(predicate)) {
                if (fault) throw fault;
                if (Date.now() > deadline) throw new Error('bounded renewal Worker timeout');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return messages.find(predicate);
        };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        const control = async (op, entries) => {
            const controlId = `control:${++request}`; worker.postMessage({ control: op, entries, controlId });
            return (await wait(message => message.controlAck === controlId)).value;
        };
        try {
            await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
            send('init', { config: { loopIntervalMs: 100000, heartbeatMs: 100000, maxInFlight: 128 } }, 'init');
            await wait(message => message.type === 'ready' && message.payload.phase === 'running');
            send('snapshot_page', { rows: [], initial: true, done: true }, 'initial');
            await wait(message => message.type === 'ready' && message.payload.phase === 'snapshots_loaded');
            const wall = Date.now(), entries = Array.from({ length: 65 }, (_, index) => ({ state: {
                characterId: 20000 + index, phase: 'cold', activity: 'hunting', inventory: {}, stats: {},
                timing: { nextResolveAt: wall }, simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0 }, updatedAt: wall
            }, context: { spot: { id: 'wire' } } }));
            await control('seed', entries);
            const claims = messages.filter(message => message.type === 'claim_request'); assert.equal(claims.length, 2);
            claims.forEach(message => send('claim_ack', { grants: message.payload.candidates.map(candidate => ({ ok: true,
                characterId: candidate.characterId, ownerId: Owner.OWNER_ID, revision: 1,
                leaseId: `wire-${candidate.characterId}`, leaseUntil: wall + 30000 })), rejected: [] }, message.msgId));
            assert.equal((await control('poison')).active, 65);
            const pages = round => messages.filter(message => message.type === 'lease_renewal_candidates' && message.payload.requestId === round);
            send('lease_renewal_probe', { replyBy: Date.now() + 5000 }, 'round1');
            const first = await wait(message => message.type === 'lease_renewal_candidates' && message.payload.requestId === 'round1');
            assert(Protocol.validateEnvelope(first, 'worker', { workerEpoch: epoch }).ok);
            assert.equal(first.payload.tokens.length, 64); assert.equal(first.payload.pageIndex, 0); assert(!first.payload.done);
            send('lease_renewal', { renewals: [] }, 'old-page');
            assert.equal((await control('observe')).waiting, first.msgId); assert.equal(pages('round1').length, 1);
            const lastId = entries.find(entry => !first.payload.tokens.some(token => token.characterId === entry.state.characterId)).state.characterId;
            send('lease_renewal', { renewals: [{ ok: true, characterId: lastId, ownerId: Owner.OWNER_ID,
                revision: 1, leaseId: `wire-${lastId}`, leaseUntil: wall + 60000 }] }, first.msgId);
            assert.equal((await control('observe')).waiting, first.msgId, 'a foreign current token cannot consume this page');
            send('lease_renewal', { renewals: first.payload.tokens.map(token => ({ ...token, ok: true, leaseUntil: wall + 60000 })) }, first.msgId);
            const second = await wait(message => message.type === 'lease_renewal_candidates'
                && message.payload.requestId === 'round1' && message.payload.pageIndex === 1);
            assert.equal(second.payload.tokens.length, 1); assert.equal(second.payload.tokens[0].characterId, lastId);
            send('lease_renewal', { renewals: [] }, second.msgId);
            const done = await wait(message => message.type === 'lease_renewal_candidates'
                && message.payload.requestId === 'round1' && message.payload.pageIndex === 2);
            assert(done.payload.done); assert.deepEqual(done.payload.tokens, []);
            assert.equal(new Set(pages('round1').map(message => message.msgId)).size, 3);
            send('lease_renewal', { renewals: [] }, done.msgId); assert.equal((await control('observe')).waiting, null);
            send('lease_renewal_probe', { replyBy: Date.now() + 5000 }, 'round2');
            const pending = await wait(message => message.type === 'lease_renewal_candidates' && message.payload.requestId === 'round2');
            send('fence', { characterId: lastId }, 'fence-last'); await wait(message => message.type === 'fence_ack' && message.msgId === 'fence-last');
            send('lease_renewal', { renewals: [] }, pending.msgId);
            const terminal = await wait(message => message.type === 'lease_renewal_candidates'
                && message.payload.requestId === 'round2' && message.payload.pageIndex === 1);
            assert(terminal.payload.done); assert.deepEqual(terminal.payload.tokens, []);
            send('lease_renewal', { renewals: [] }, terminal.msgId); await control('observe');
            send('lease_renewal_probe', { replyBy: Date.now() - 1 }, 'expired-round');
            assert.equal((await control('observe')).waiting, null); assert.equal(pages('expired-round').length, 0);
        } finally { await worker.terminate(); }
    });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Database.registerCharacterWriteFlush(null); await Writes.flushAll(); await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (failures.length) { console.error(`${failures.length} failed groups`); process.exitCode = 1; }
});

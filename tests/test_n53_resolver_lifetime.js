process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(root + '/src/Global');
const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
const { ColdSimulationKernel } = require(root + '/src/GameServer/Bot/Population/ColdSimulationKernel');
const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'n53-resolver-life-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
options.default.Database.historyPath = path.join(dir, 'history.sqlite');
let now = 1000000, sequence = 0;
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
async function create(partyId = null) {
    const number = ++sequence, account = `bot_resolve_life_${number}`, name = `ResolveLife${number}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 10, locY: 20, locZ: -30 })).insertId);
    await Database.execute([`INSERT INTO bot_life_state
        (characterId,accountName,characterName,phase,activity,partyId,locX,locY,locZ,
         hp,maxHp,mp,maxMp,statsJson,inventorySummary,updatedAt)
        VALUES (?,? ,?,'cold','hunting',?,10,20,-30,100,100,100,100,'{}','{}',?)`, [id, account, name, partyId, now]]);
    const state = { characterId: id, accountName: account, name, partyId, ...(partyId ? { party: { partyId } } : {}),
        phase: 'cold', activity: 'hunting', loc: { locX: 10, locY: 20, locZ: -30 }, inventory: {}, stats: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, updatedAt: now,
        timing: { lastResolvedAt: now, nextResolveAt: now },
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0, leaseId: null, leaseUntil: 0 } };
    Life.acceptSimulationOwnership(id, state.simulation, state); return state;
}
async function durable(states) {
    return Promise.all(states.map(async state => ({
        life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [state.characterId]]))[0],
        character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [state.characterId]]))[0],
        items: await Database.execute(['SELECT * FROM items WHERE characterId=? ORDER BY id', [state.characterId]])
    })));
}
const result = () => ({ patch: {}, events: [], materialize: {}, nextResolveAt: now + 60000 });
const projected = state => ({ ...state, stats: { ...state.stats, frame: 'current' },
    timing: { ...state.timing, lastResolvedAt: now, nextResolveAt: now + 60000 } });
function harness(states, { stage = 'resolve', party = null, currentError = false } = {}) {
    let enter, finish, fail, gateValue, first = true, projectionCalls = 0, starts = 0;
    const startedIds = [];
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const messages = [], context = index => ({ spot: { id: 'resolver-life' }, ...(party ? {
        party, partyMembers: states, isPartyLeader: index === 0
    } : {}) });
    const hold = value => { first = false; gateValue = value; enter(); return gate; };
    const resolution = members => ({ nextResolveAt: now + 60000, partyPatch: {}, events: [],
        memberResults: members.map(state => ({ state, result: result() })) });
    const kernel = new ColdSimulationKernel({ now: () => now, maxInFlight: 8, maxAtomicPartySize: 8,
        planLifecycle: () => stage === 'plan' && first ? hold(null) : null,
        resolveSolo: ({ state }) => {
            starts++;
            startedIds.push(state.characterId);
            if (currentError) throw Error('current_solo_error');
            return stage === 'resolve' && first ? hold(result()) : result();
        },
        resolveParty: ({ members }) => {
            starts++;
            if (currentError) throw Error('current_party_error');
            return stage === 'resolve' && first ? hold(resolution(members)) : resolution(members);
        },
        projectResolve: state => {
            projectionCalls++;
            if (stage === 'project' && first && (!party || projectionCalls === 2)) return hold(projected(state));
            return projected(state);
        },
        emit: (type, payload, msgId) => messages.push({ type, payload, msgId }) });
    states.forEach((state, index) => kernel.upsert({ state, context: context(index) })); kernel.tick();
    return { kernel, messages, context, states, startedIds, get starts() { return starts; },
        async entered() {
            let timer;
            try { await Promise.race([entered, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(Error('native resolver did not enter its bounded barrier')), 1000);
            })]); } finally { clearTimeout(timer); }
        }, finish: () => finish(gateValue), fail: () => fail(Error('controlled_old_resolver_error')) };
}
async function claimAndAccept(h, states) {
    const request = h.messages.filter(message => message.type === 'claim_request').at(-1); assert(request);
    assert.notEqual(request.msgId, h.lastAcceptedRequestId, 'replacement has its own newly issued claim request');
    for (const state of states) {
        assert(h.kernel.claiming.has(state.characterId), 'native claim is requested by an actual pending Kernel attempt');
        assert.equal(h.kernel.claimAttempts.get(state.characterId)?.requestId, request.msgId);
    }
    const claimed = await Owner.claimBatch(states.map(state => ({ state, options: { allowParty: !!state.partyId,
        allowLifecycle: true } })), { timestamp: now });
    assert.equal(claimed.grants.length, states.length);
    h.kernel.onClaimAck({ grants: claimed.grants.map(grant => ({ ...grant,
        purpose: request.payload.candidates.find(candidate => candidate.characterId === grant.characterId).purpose })) }, request.msgId);
    h.lastAcceptedRequestId = request.msgId;
    for (const grant of claimed.grants) {
        assert.equal(h.kernel.inFlight.get(grant.characterId)?.grant.leaseId, grant.leaseId,
            'matching native grant is accepted as the exact active Kernel holder');
    }
    return claimed.grants;
}
async function replace(h, grants) {
    now = Math.max(...grants.map(grant => grant.leaseUntil)) + 1;
    h.kernel.recoverStalled(now); await Owner.recoverExpiredLeases(now);
    const retryAt = h.kernel.scheduleTokens.get(h.states[0].characterId)?.dueAt || now;
    const fresh = h.states.map(state => Life.cachedState(state.characterId));
    fresh.forEach((state, index) => h.kernel.upsert({ state: { ...state,
        timing: { ...state.timing, nextResolveAt: now } }, context: h.context(index) }));
    // A fresh native revision invalidates the old recovery token. Explicitly
    // attach its existing retry deadline to the refreshed leader version.
    // This adjacent scheduler setup does not bypass claim/ACK admission.
    h.kernel.requeue(fresh[0].characterId, retryAt);
    now = Math.max(now, retryAt);
    h.kernel.tick();
    const current = await claimAndAccept(h, fresh);
    current.forEach((grant, i) => assert.notEqual(grant.leaseId, grants[i].leaseId)); return current;
}
function proposals(h) { return h.messages.filter(message => message.type === 'proposal_batch').flatMap(message => message.payload.proposals); }
async function currentCommit(h, current) {
    h.kernel.flush(null, true);
    const sent = proposals(h);
    assert.equal(sent.length, current.length, 'only new current source publishes one proposal per holder');
    assert(sent.every(proposal => current.some(grant => grant.leaseId === proposal.token.leaseId)));
    const nativeResults = current.length > 1 ? await Owner.commitAndReleaseBatch(sent.map(proposal => ({
        token: proposal.token, nextState: proposal.nextState, options: proposal.options, proposal
    })), { timestamp: now }) : [await Owner.commit(sent[0].token, sent[0].nextState,
        { timestamp: now, allowLifecycle: true })];
    for (const proposal of sent) {
        const native = nativeResults.find(value => value.characterId === proposal.characterId); assert(native?.ok, JSON.stringify(nativeResults));
        assert.equal(h.kernel.onCommitAck({ results: [{ ...native, characterId: proposal.characterId,
            inputToken: proposal.token, proposalId: proposal.proposalId,
            state: Life.cachedState(proposal.characterId), context: h.context(h.states.findIndex(state => state.characterId === proposal.characterId))
        }] }).length, 1);
    }
    assert.equal(h.kernel.inFlight.size, 0);
}
async function staleTrial(kind, stage, outcome) {
    const partyId = kind === 'party' ? `resolver-party-${sequence}` : null;
    const states = [await create(partyId)]; if (partyId) states.push(await create(partyId));
    const party = partyId ? { partyId, status: 'active', leaderId: states[0].characterId,
        memberIds: states.map(state => state.characterId), startedAt: now, nextResolveAt: now, stats: {} } : null;
    const h = harness(states, { stage, party }), first = await claimAndAccept(h, states);
    try {
        await h.entered();
        const current = await replace(h, first), before = await durable(states);
        const active = new Map(current.map(grant => [grant.characterId, h.kernel.inFlight.get(grant.characterId)]));
        const currentRun = partyId ? h.kernel.partyRuns.get(partyId) : null;
        if (partyId) assert(currentRun?.grants.size === states.length, 'replacement party is a complete accepted run');
        if (outcome === 'reject') h.fail(); else h.finish();
        await h.kernel.resolveChain;
        assert.deepEqual(await durable(states), before, 'stale producer outcomes have no native physical mutation');
        for (const [id, holder] of active) assert.equal(h.kernel.inFlight.get(id), holder, 'old outcome preserves new exact active source');
        assert.equal(h.starts, kind === 'solo' && stage === 'plan' ? 1 : 2, 'new current resolver actually starts');
        assert.equal(h.kernel.stats.resolved, states.length, 'only current outcomes contribute resolved work');
        assert.equal(h.messages.filter(message => message.type === 'release_request').length, 0, 'stale source does not request current cleanup');
        assert.equal(h.messages.filter(message => message.type === 'fault').length, 0);
        await currentCommit(h, current);
    } finally { h.finish(); }
}
(async () => {
    Database.init();
    await check('native solo delayed error preserves replacement before catch and new resolver commits', () => staleTrial('solo', 'resolve', 'reject'));
    for (const stage of ['plan', 'resolve', 'project']) await check(`native solo late ${stage} success publishes only current work`,
        () => staleTrial('solo', stage, 'success'));
    await check('native party delayed error cannot delete replacement run in finally or retire new members', () => staleTrial('party', 'resolve', 'reject'));
    for (const stage of ['resolve', 'project']) await check(`native party late ${stage} success preserves replacement run and membership`,
        () => staleTrial('party', stage, 'success'));
    await check('current solo and party errors still send exact native release and accept matching receipts', async () => {
        for (const kind of ['solo', 'party']) {
            const partyId = kind === 'party' ? `current-error-party-${sequence}` : null;
            const states = [await create(partyId)]; if (partyId) states.push(await create(partyId));
            const party = partyId ? { partyId, status: 'active', leaderId: states[0].characterId,
                memberIds: states.map(state => state.characterId), startedAt: now, stats: {} } : null;
            const h = harness(states, { party, currentError: true }), grants = await claimAndAccept(h, states);
            await h.kernel.resolveChain;
            const request = h.messages.find(message => message.type === 'release_request'); assert(request?.msgId);
            const native = await Owner.releaseBatch(grants, { timestamp: now, releaseInvalidated: true }); assert(native.every(result => result.ok));
            const accepted = h.kernel.onReleaseAck({ results: native.map((result, index) => ({ ...result,
                inputToken: grants[index], releaseRequestId: request.msgId, state: Life.cachedState(grants[index].characterId),
                context: h.context(index) })) });
            assert.equal(accepted.length, states.length); assert.equal(h.kernel.inFlight.size, 0);
        }
    });
    await check('native renewal during awaited resolver keeps current tuple valid and publishes once', async () => {
        const states = [await create()], h = harness(states), grants = await claimAndAccept(h, states);
        try {
            await h.entered(); now = grants[0].leaseUntil - 1;
            const renewed = await Owner.renewActiveLeases(grants, { now: () => now, canRenew: () => true }); assert(renewed[0].ok);
            h.kernel.onLeaseRenewal({ renewals: renewed }); now = grants[0].leaseUntil + 1;
            h.finish(); await h.kernel.resolveChain; await currentCommit(h, grants);
            assert.equal(h.starts, 1);
        } finally { h.finish(); }
    });
    await check('accepted queued solo callback keeps its original holder instead of adopting a replacement', async () => {
        const states = [await create(), await create()], h = harness(states), grants = await claimAndAccept(h, states);
        try {
            await h.entered(); now = grants[1].leaseUntil - 1;
            const renewed = await Owner.renewActiveLeases([grants[0]], { now: () => now, canRenew: () => true });
            assert(renewed[0].ok); h.kernel.onLeaseRenewal({ renewals: renewed });
            const activeX = h.kernel.inFlight.get(states[0].characterId);
            const retry = { ...h, states: [states[1]], lastAcceptedRequestId: h.lastAcceptedRequestId,
                context: () => h.context(1) };
            const currentY = await replace(retry, [grants[1]]), activeY = h.kernel.inFlight.get(states[1].characterId);
            const before = await durable(states);
            h.finish(); await h.kernel.resolveChain;
            assert.deepEqual(await durable(states), before, 'queued stale outcome preserves native physical facts');
            assert.equal(h.kernel.inFlight.get(states[0].characterId), activeX);
            assert.equal(h.kernel.inFlight.get(states[1].characterId), activeY);
            assert.deepEqual(h.startedIds, states.map(state => state.characterId), 'old queued Y cannot resolve current Y twice');
            assert.equal(h.kernel.stats.resolved, 2);
            await currentCommit(h, [grants[0], currentY[0]]);
        } finally { h.finish(); }
    });
    await check('fence and shutdown suppress a still-awaited source without publication or release', async () => {
        for (const boundary of ['fence', 'shutdown']) {
            const states = [await create()], h = harness(states), grants = await claimAndAccept(h, states);
            try {
                await h.entered(); let stopped;
                if (boundary === 'fence') h.kernel.fence(states[0].characterId);
                else stopped = h.kernel.shutdown();
                h.finish(); await h.kernel.resolveChain; if (stopped) await stopped;
                assert.equal(proposals(h).length, 0, boundary);
                assert.equal(h.messages.filter(message => message.type === 'release_request').length, 0, boundary);
                assert.equal((await durable(states))[0].life.simulationLeaseId, grants[0].leaseId);
            } finally { h.finish(); }
        }
    });
    if (failures.length) { console.error(`${failures.length} failed groups`); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Writes.flushAll(); await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

'use strict';

// A worker capability must survive native clan-hall dispatch and the inner queue.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gameRoot = path.resolve(__dirname, '..');
const isolated = require('./helpers/isolatedSocialDatabase')('hall-native-admission', gameRoot);
require(path.join(gameRoot, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));
const failures = [];
let serial = 0;
async function facts(id) {
    const found = {};
    await Database.flushHistory();
    for (const table of ['bot_life_state', 'characters', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines', 'history_outbox']) {
        found[table] = await Database.execute([`SELECT * FROM ${table} ORDER BY rowid`]);
    }
    found.history = await Database.readHistory(['SELECT * FROM bot_life_events ORDER BY id']);
    found.cache = clone(Life.cachedState(id));
    return found;
}
async function seed() {
    const account = `bot_inner_admission_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `InnerAdmission${serial}`, race: 0,
        classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    const time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `InnerAdmission${serial}`,
        phase: 'cold', activity: 'resting', level: 1, exp: 0, sp: 0, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: 1, classProgressionClassId: 0,
            clanHallVisit: { hallId: 999, startedAt: time - 300000, expiresAt: time - 1000 },
            restUntil: time + 30000 } }, 'inner_admission_seed'));
    return id;
}
async function inner(mode) {
    const id = await seed(), state = clone(Life.snapshot(id)), time = Date.now();
    const request = { kind: 'lifecycle', characterId: id, commandId: `inner:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedPlan: null,
        precomputedResult: { patch: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: time + 30000 } };
    const originalCheckpoint = clone(request.commandCheckpoint);
    // Request extras cannot supply or disable the internal Main capability.
    request.workerAdmission = null;
    const originalRequest = JSON.stringify(request);
    const firstEntered = deferred(), firstGate = deferred(), secondEntered = deferred(), secondGate = deferred();
    const populationEntered = deferred();
    const first = Life.serializeClanLevelUp(id, async () => { firstEntered.resolve(); await firstGate.promise; });
    await firstEntered.promise;
    const c = new ColdSimulationCoordinator(), sent = [], calls = [], admissions = [];
    c.workerEpoch = `inner-native:${serial}`; c.ready = true;
    const worker = label => ({ terminate: async () => {}, postMessage(message) {
        sent.push({ label, message: clone(message) });
        if (message.type === 'fence') setImmediate(() => c.onMessage(Protocol.envelope('fence_ack',
            message.workerEpoch, { characterId: id, proposal: null, token: null }, message.msgId), c.worker, c.workerEpoch));
        if (message.type === 'shutdown') setImmediate(() => c.onMessage(Protocol.envelope('drained',
            message.workerEpoch, { ok: true }, message.msgId), c.worker, c.workerEpoch));
    } });
    c.worker = worker('A');
    const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    c.population = { executeWorkerLifecycleCommand(...args) {
        calls.push(args[0]); admissions.push(args[2]?.workerAdmission);
        const work = Population.executeWorkerLifecycleCommand(...args);
        populationEntered.resolve(); return work;
    } };
    let second;
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch,
            { requests: [request] }, `inner-message:${serial}`), originalWorker, originalEpoch);
        for (let n = 0; n < 20 && !c.commandInflight.has(id); n++) await new Promise(done => setImmediate(done));
        assert(c.commandInflight.has(id), 'actual Main owns the whole original snapshot-settle admission');
        assert.equal(calls.length, 0, 'first genuine pending writer is still held before Main dispatch');
        // The real Main helper already captured first. Its snapshot wait does
        // not include this later queue job; native applyResolve will include it.
        second = Life.serializeClanLevelUp(id, async () => { secondEntered.resolve(); await secondGate.promise; });
        firstGate.resolve(); await first; await secondEntered.promise; await populationEntered.promise;
        assert.equal(calls.length, 1, 'Main current source genuinely dispatched Population after first snapshot settled');
        assert.equal(calls[0], Life.cachedState(id), 'native gateway receives the actual authoritative cache row');
        assert(admissions[0], 'Main authors its own internal capability');
        assert(Object.isFrozen(admissions[0])); assert(Object.isFrozen(admissions[0].commandCheckpoint));
        assert.notEqual(admissions[0].commandCheckpoint, request.commandCheckpoint, 'immutable authority is a copy of the original checkpoint');
        assert(c.commandInflight.has(id), 'inner native apply is owned and outstanding behind second held writer');
        assert.equal((await facts(id)).characters.find(row => row.id === id).hp, 85, 'no application before inner entry');
        if (mode === 'replace') { c.worker = worker('B'); c.workerEpoch = 'inner-replacement'; }
        if (mode === 'changed') {
            // A generated durable checkpoint mutation, normalized through the
            // actual cache reader; no fake activity/hot phase or runnable row.
            await Database.execute(['UPDATE bot_life_state SET updatedAt = ? WHERE characterId = ?', [Date.now() + 1000, id]]);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]))[0]);
            assert.equal(Protocol.sameCommandCheckpoint(request.commandCheckpoint, Life.cachedState(id)), false);
        }
        const verdict = admissions[0].check();
        assert.equal(verdict?.reason ?? verdict, mode === 'replace' ? 'stale_worker_source' : mode === 'changed' ? 'stale_command' : null, 'real Main capability status before inner writer');
        const before = await facts(id);
        secondGate.resolve(); await second; await c.commandTail;
        const after = await facts(id), receipts = sent.filter(row => row.message.type === 'command_ack');
        console.log(JSON.stringify({ mode, dispatches: calls.length,
            hpBefore: before.characters.find(row => row.id === id).hp, hpAfter: after.characters.find(row => row.id === id).hp,
            checkpointBefore: before.cache.updatedAt, checkpointAfter: after.cache.updatedAt,
            receipts: receipts.map(row => [row.label, row.message.payload.results[0]?.reason]) }));
        assert.equal(JSON.stringify(request), originalRequest, 'dispatch and native hall transition preserve the request');
        assert.equal(c.commandInflight.size, 0);
        if (mode === 'current') {
            assert.equal(after.characters.find(row => row.id === id).hp, 85, 'hall cancellation conserves HP');
            assert.equal(after.cache.stats.clanHallVisit, null, 'real expired hall visit is durably cancelled');
            assert.equal(after.cache.activity, 'hunting');
            assert(after.history.some(row => row.characterId === id && row.eventType === 'clan_hall_visit'), 'real hall event persists');
            assert(after.cache.timing.lastResolvedAt > state.timing.lastResolvedAt);
            assert.equal(receipts.length, 1); assert.equal(receipts[0].message.payload.results[0].ok, true);
            assert.equal(receipts[0].label, 'A');
            assert.deepEqual(receipts[0].message.payload.results[0].commandCheckpoint, originalCheckpoint,
                'successful own progression still echoes original input checkpoint');
        } else {
            assert.deepEqual(after, before, 'refused inner admission must conserve all native/cache facts before first writer');
            if (mode === 'replace') assert.equal(receipts.length, 0);
            else {
                assert.equal(receipts.length, 1); const receipt = receipts[0].message.payload.results[0];
                assert.equal(receipt.ok, false); assert.deepEqual(receipt.commandCheckpoint, request.commandCheckpoint);
                assert.equal(receipt.commandId, request.commandId);
                assert.equal(receipt.reason, 'stale_command');
            }
        }
    } finally {
        firstGate.resolve(); secondGate.resolve(); await first.catch(() => null); await second?.catch(() => null);
        await c.commandTail.catch(() => null);
    }
}

(async () => {
 Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
 for (const mode of ['current','replace','changed']) {
  try { await inner(mode); console.log('PASS hall native '+mode); }
  catch(error) { failures.push(mode); console.error('FAIL hall native '+mode+': '+error.stack); }
 }
 const id = await seed(), state = Life.snapshot(id), at = Date.now();
 const request = {kind:'lifecycle',characterId:id,commandId:'hall-manual',commandCheckpoint:Protocol.commandCheckpoint(state),state,context:{},precomputedPlan:null,precomputedResult:{patch:{},events:[],materialize:{exp:0,sp:0,adena:0,items:[]},nextResolveAt:at+30000}};
 const applied = await Population.executeWorkerLifecycleCommand(state,request);
 assert.equal(applied.ok,true,'optional-absent manual hall compatibility');
 const manual = await facts(id); assert.equal(manual.cache.stats.clanHallVisit,null); assert.equal(manual.cache.activity,'hunting'); assert(manual.history.some(row=>row.characterId===id && row.eventType==='clan_hall_visit'));
 console.log('PASS hall native manual optional-absent');
 if(failures.length) throw Error('Hall inner admission failures: '+failures.join(','));
})().catch(error => {console.error(error);process.exitCode=1;}).finally(async()=>{await Database.close();fs.rmSync(isolated.directory,{recursive:true,force:true});});

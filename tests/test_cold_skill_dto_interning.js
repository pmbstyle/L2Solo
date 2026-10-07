'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Worker, isMainThread, workerData } = require('node:worker_threads');
require('./helpers/databaseIsolation');
function exact(value) {
    if (value === null || value === undefined) return [String(value)];
    if (typeof value === 'number') { const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleLE(value); return ['number', bytes.toString('hex')]; }
    if (typeof value !== 'object') return [typeof value, value];
    if (ArrayBuffer.isView(value)) return [value.constructor.name, Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')];
    if (value instanceof Map) return ['Map', [...value].map(([key, row]) => [exact(key), exact(row)])];
    if (value instanceof Set) return ['Set', [...value].map(exact)];
    return [Object.getPrototypeOf(value)?.constructor?.name || null, Object.keys(value).map(key => [key, exact(value[key])])];
}
function outputs(state, clock, target) {
    const P = invoke('GameServer/Bot/Population/ColdCombatProfile'), C = invoke('GameServer/Bot/Population/ColdClassPolicy');
    const M = invoke('GameServer/Bot/AI/BotTargetMatchup'), profile = P.profileFor(state, clock);
    return exact({ profile, offensive: P.offensiveSkills(profile), summons: P.summonSkills(profile), corpse: P.corpseSummonSkills(profile),
        music: P.partyMusicSkills(profile), selection: C.select(profile, { hp: profile.maxHp, mp: profile.maxMp, cooldowns: {}, time: clock, charges: 0, mob: target }),
        matchup: M.evaluate([profile], target) });
}
function native(id, classId, level, clock) {
    const state = { characterId: id, phase: 'cold', activity: 'resting', level, exp: 0, sp: 0, adena: 10000, updatedAt: clock,
        stats: { classId, classProgressionClassId: classId, classProgressionLevel: level }, inventory: { 1835: { selfId: 1835, amount: 5000 }, 1785: { selfId: 1785, amount: 50 }, 20: { selfId: 20, amount: 1 } },
        timing: { activityStartedAt: clock, nextResolveAt: clock + 3600000, lastResolvedAt: clock },
        simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 },
        loc: { locX: 80000 + id, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, mp: 1000 } };
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(20); assert(recipe);
    state.inventory[recipe.recipeItemId] = { selfId: recipe.recipeItemId, amount: 1 };
    if (classId === 57) state.stats.shotCraft = { recipeId: 20 };
    state.stats.coldCombat = invoke('GameServer/Bot/Population/ColdCombatProfile').treeSnapshot(state, clock);
    assert(state.stats.coldCombat.skills.length, 'native authored class skills'); return state;
}
async function inspect(kernel, Life, request) {
    const clock = workerData.clock, target = workerData.target;
    const counters = () => kernel.states.skillDtoSize();
    const shotFacts = () => { const { itemTemplates, ...dynamic } = kernel.states.shotIndex.marketSnapshot(clock);
        assert.strictEqual(itemTemplates, kernel.states.shotIndex.itemTemplates); return exact(dynamic); };
    const state = id => kernel.states.get(id).state;
    if (request === 'native') {
        const arrays = [...kernel.states.values()].map(row => row.state.stats.coldCombat.skills);
        for (let i = 0; i < arrays.length; i += 2) {
            assert.strictEqual(arrays[i][0], arrays[i + 1][0], 'equal native DTOs share storage after canonical publication');
            assert.notStrictEqual(arrays[i], arrays[i + 1], 'mutable membership arrays remain individual');
        }
        [...kernel.states.values()].forEach((row, i) => {
            assert.deepEqual(exact(row.state), workerData.raw[i]); assert.deepEqual(outputs(row.state, clock, target), workerData.expected[i]);
            row.state.stats.coldCombat.skills.forEach(dto => assert(Object.isFrozen(dto)));
        });
        const before = counters(), canonical = state(1), array = canonical.stats.coldCombat.skills;
        const stale = structuredClone(canonical); stale.simulation.revision--;
        assert.equal(kernel.upsert({ state: stale, context: { stale: true } }), false);
        assert.strictEqual(state(1), canonical); assert(!Object.isFrozen(stale.stats.coldCombat.skills[0])); assert.deepEqual(counters(), before);
        kernel.states.set(1, { ...kernel.states.get(1), context: { fresh: true } });
        assert.strictEqual(state(1).stats.coldCombat.skills, array); assert.deepEqual(counters(), before);
        let writes = 0; const proxyByDto = new WeakMap(), dtoByProxy = new WeakMap();
        for (const membership of arrays) for (let i = 0; i < membership.length; i++) {
            const dto = membership[i]; let proxy = proxyByDto.get(dto);
            if (!proxy) { const trap = () => { writes++; throw Error('native DTO mutation'); };
                proxy = new Proxy(dto, { set: trap, deleteProperty: trap, defineProperty: trap, setPrototypeOf: trap });
                proxyByDto.set(dto, proxy); dtoByProxy.set(proxy, dto); }
            membership[i] = proxy;
        }
        try { [...kernel.states.values()].forEach((row, i) => assert.deepEqual(outputs(row.state, clock, target), workerData.expected[i])); }
        finally { for (const membership of arrays) for (let i = 0; i < membership.length; i++) membership[i] = dtoByProxy.get(membership[i]); }
        assert.equal(writes, 0); return { owners: arrays.length, nativeClasses: 7, nativeConsumerWrites: writes, counters: counters() };
    }
    if (request === 'replacement') {
        assert.deepEqual(outputs(state(1), clock, target), workerData.learnedExpected);
        assert.equal(state(1).stats.classId, 1); assert.equal(state(1).level, 60); assert.equal(state(2).stats.classId, 0);
        const before = counters(); kernel.upsert({ state: structuredClone(state(1)), context: {} }); assert.deepEqual(counters(), before);
        return { nativeClassRankAndClone: true };
    }
    if (request === 'failure') {
        const index = kernel.states.locationIndex, observations = [];
        const spatial = () => exact(index.nearSources({ locX: 80000, locY: 148000, locZ: 0 }, 2000,
            { view: 'state', kind: 'cold' }).map(record => record.id));
        for (const mode of ['setSource', 'updateSource', 'ownerMutation', 'firstSource', 'shotUpdate']) {
            const id = mode === 'firstSource' ? 990001 : mode === 'setSource' ? 3 : 1;
            const prior = kernel.states.get(id), record = index.getSource(id, 'state'), before = counters();
            const sourceCount = kernel.states.size, shotCounts = kernel.states.shotIndex.size();
            assert(shotCounts.spare > 0 && shotCounts.recipeHolders > 0, 'nonempty native shot/recipe holder state');
            const incoming = mode === 'updateSource' ? prior.state : structuredClone(prior?.state || state(1));
            incoming.characterId = id;
            if (mode !== 'updateSource') {
                incoming.loc.locX += 12000; incoming.stats.coldCombat.skills[0].power += 0.001;
                incoming.inventory[1835].amount += 300;
                incoming.inventory[invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(20).recipeItemId].amount += 2;
            }
            const array = incoming.stats.coldCombat.skills, refs = [...array], descriptors = refs.map(row => Object.getOwnPropertyDescriptors(row));
            const error = new Error('native publication fault ' + mode); let changed = false;
            const key = mode === 'updateSource' ? 'updateSource' : 'setSource', original = index[key];
            const cache = Life.__dtoCache(), revision = Object.getOwnPropertyDescriptor(cache, 'revision');
            const shotsIndex = kernel.states.shotIndex, originalUpdate = shotsIndex.update;
            if (mode === 'shotUpdate') shotsIndex.update = function (...args) {
                const result = Reflect.apply(originalUpdate, this, args); changed = true; throw error;
            };
            else if (mode === 'ownerMutation') Object.defineProperty(cache, 'revision', {
                configurable: true, get: () => revision.value,
                set() { changed = index.getSource(id, 'state').source === incoming; throw error; }
            });
            else index[key] = function (...args) {
                const result = Reflect.apply(original, this, args);
                if (args[0] === id && args[1] === 'state') { changed = index.getSource(id, 'state').source === incoming; throw error; }
                return result;
            };
            try { assert.throws(() => kernel.states.set(id, { ...(prior || {}), state: incoming, context: { failed: true } }), value => value === error); }
            finally { index[key] = original; shotsIndex.update = originalUpdate; Object.defineProperty(cache, 'revision', revision); }
            assert(changed, 'actual native operation executed before throw');
            assert.strictEqual(incoming.stats.coldCombat.skills, array);
            array.forEach((row, i) => { assert.strictEqual(row, refs[i]); assert.deepEqual(Object.getOwnPropertyDescriptors(row), descriptors[i]); });
            if (['updateSource', 'shotUpdate'].includes(mode)) {
                assert.strictEqual(kernel.states.get(id), prior); assert.strictEqual(index.getSource(id, 'state'), record);
                assert.deepEqual(counters(), before);
            } else {
                assert.strictEqual(kernel.states.get(id).state, incoming); assert.strictEqual(index.getSource(id, 'state').source, incoming);
                assert.equal(kernel.states.size, sourceCount + (prior ? 0 : 1));
                if (before) assert.equal(counters().owners, before.owners - (mode === 'setSource' || mode === 'ownerMutation' ? 1 : 0));
                assert(!Object.isFrozen(array[0]), 'failed native publication never interns incoming skills');
            }
            observations.push({ mode, state: exact(kernel.states.get(id)?.state), spatial: spatial(), shots: shotFacts(), shotCounts: shotsIndex.size() });
        }
        // The native failure outcomes above intentionally retain baseline
        // partial-publication semantics; pool cleanup is independent of them.
        kernel.states.clear();
        if (counters()) for (const key of ['owners', 'unique', 'buckets', 'acquiredSlots']) assert.equal(counters()[key], 0);
        const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(observations)).digest('hex');
        return { nativeFailureFactsDigest: digest, incomingReferencesAndDescriptorsUntouched: true,
            exactNativeErrorIdentity: true, partialPublicationLedgerReleased: true, poolEmptyAfterClear: true };
    }
    if (request === 'optimizationFailure') {
        const { SkillDtoInterner } = require('../src/GameServer/Bot/Population/SkillDtoInterner');
        const prior = kernel.states.get(1), incoming = structuredClone(prior.state), before = counters();
        incoming.stats.coldCombat.skills[0].power = 999.123456789;
        const refs = [...incoming.stats.coldCombat.skills], descriptors = refs.map(row => Object.getOwnPropertyDescriptors(row));
        const original = SkillDtoInterner.prototype.hash, log = global.utils.infoWarn; let reported = 0;
        SkillDtoInterner.prototype.hash = function (row) {
            if (row.power === 999.123456789) throw Error('actual prepared acquisition interrupted');
            return Reflect.apply(original, this, [row]);
        };
        global.utils.infoWarn = () => { reported++; throw Error('diagnostic logger interrupted'); };
        try { assert.strictEqual(kernel.states.set(1, { ...prior, state: incoming }), kernel.states); }
        finally { SkillDtoInterner.prototype.hash = original; global.utils.infoWarn = log; }
        assert.strictEqual(state(1), incoming); assert.equal(reported, 1);
        incoming.stats.coldCombat.skills.forEach((row, i) => {
            assert.strictEqual(row, refs[i]); assert.deepEqual(Object.getOwnPropertyDescriptors(row), descriptors[i]);
        });
        assert.equal(counters().owners, before.owners - 1); assert.equal(counters().sharingFailures, before.sharingFailures + 1);
        kernel.states.set(1, kernel.states.get(1)); assert.equal(counters().owners, before.owners);
        return { nativeSuccessPreserved: true, preparedReferencesRestored: true, staleLedgerReleased: true,
            guardedDiagnostic: true, observableSharingFailures: counters().sharingFailures };
    }
    if (request === 'release') {
        state(1).stats.coldCombat.skills[0] = state(2).stats.coldCombat.skills[0]; kernel.fence(1); kernel.remove(1);
        assert.equal(counters().owners, 13);
        const hot = structuredClone(state(2)); hot.phase = 'hot'; hot.simulation.revision++; kernel.upsert({ state: hot });
        assert.equal(counters().owners, 12); assert(!Object.isFrozen(hot.stats.coldCombat.skills[0]));
        const third = state(3); kernel.states.sources.remove(3, third); assert.equal(kernel.states.delete(3), false); assert.equal(counters().owners, 11);
        for (const [id, row] of [...kernel.states.entries()]) kernel.states.sources.remove(id, row.state);
        assert.equal(kernel.states.size, 0); assert(counters().owners > 0); kernel.states.clear();
        for (const key of ['owners', 'unique', 'buckets', 'acquiredSlots']) assert.equal(counters()[key], 0);
        return { fenceMutationHotDoubleRemoveOrphanClear: true };
    }
    if (request === 'edges') {
        const { SkillDtoInterner, FIELDS } = require('../src/GameServer/Bot/Population/SkillDtoInterner');
        const variant = power => ({ ...workerData.example, power });
        const pool = new SkillDtoInterner({ hashOverride: () => 42 }), bits = new DataView(new ArrayBuffer(8));
        bits.setBigUint64(0, 0x7ff8000000000001n, true); const nan1 = bits.getFloat64(0, true);
        bits.setBigUint64(0, 0x7ff8000000000002n, true); const nan2 = bits.getFloat64(0, true);
        const values = [0, -0, 1 / 3, Infinity, -Infinity, nan1, nan2], a = values.map(variant), b = values.map(variant), raw = exact(a);
        pool.register(1, a); pool.register(2, b); assert.deepEqual(exact(a), raw);
        a.forEach((row, i) => assert.strictEqual(row, b[i])); assert.notStrictEqual(a[0], a[1]); assert.notStrictEqual(a[5], a[6]);
        assert.equal(pool.size().unique, values.length); a[0] = b[1]; pool.remove(1); assert.equal(pool.size().unique, values.length); pool.clear();
        const full = new SkillDtoInterner(), all = Array.from({ length: 4097 }, (_, i) => variant(i)), originals = [...all];
        full.register(1, all); assert.equal(full.size().unique, 4096); assert.strictEqual(all[4096], originals[4096]); assert(!Object.isFrozen(all[4096]));
        all[4096] = all[0]; full.clear(); assert.equal(full.size().acquiredSlots, 0); assert.equal(full.size().unique, 0);
        let reads = 0; const getter = { ...workerData.example }; Object.defineProperty(getter, 'power', { enumerable: true, get() { reads++; throw Error('getter'); } });
        const proxy = new Proxy(workerData.example, { ownKeys() { reads++; throw Error('proxy'); } });
        const unknown = [{ ...workerData.example, extra: 1 }, getter, proxy, Object.fromEntries([...FIELDS].reverse().map(key => [key, workerData.example[key]]))], originalUnknown = [...unknown];
        full.register(2, unknown); unknown.forEach((row, i) => assert.strictEqual(row, originalUnknown[i])); assert.equal(reads, 0);
        const row = variant(10); full.register(3, Object.freeze([row])); assert(!Object.isFrozen(row)); const sparse = new Array(2); sparse[1] = row;
        full.register(4, sparse); assert(!(0 in sparse));
        let fail = false; const tx = new SkillDtoInterner({ hashOverride: dto => { if (fail && dto.power === 99) throw Error('interrupted'); return 1; } });
        tx.register(1, [variant(3)]); const before = tx.size(), incoming = [variant(4), variant(99)], refs = [...incoming]; fail = true;
        assert.throws(() => tx.prepare(1, incoming), /interrupted/); incoming.forEach((dto, i) => { assert.strictEqual(dto, refs[i]); assert(!Object.isFrozen(dto)); }); assert.deepEqual(tx.size(), before);
        fail = false; const pending = tx.prepare(1, incoming); tx.rollback(pending); assert.deepEqual(tx.size(), before);
        assert.throws(() => tx.commit(pending), /invalid_skill_dto_stage/); const commit = tx.prepare(1, incoming); tx.commit(commit); const committed = tx.size();
        assert.throws(() => tx.commit(commit), /invalid_skill_dto_stage/); assert.throws(() => tx.rollback(commit), /invalid_skill_dto_stage/); assert.deepEqual(tx.size(), committed);
        tx.clear(); full.clear(); assert.equal(tx.size().unique, 0); assert.equal(full.size().unique, 0);
        const foreign = new SkillDtoInterner({ maxUnique: 1 }), held = [variant(1)], fallback = [variant(2)];
        foreign.register(1, held); foreign.register(2, fallback); fallback[0] = held[0]; foreign.remove(2); assert.equal(foreign.size().unique, 1); foreign.clear();
        return { exactFloatsNaNsOrderCollision: true, full4096Fallback4097: true, unknownReadonlyNoAccessor: true,
            capturedLedgerMutationForeignRefs: true, partialFailureAndConsumedToken: true };
    }
    throw Error('unknown DTO probe');
}
module.exports.inspect = inspect;

async function main() {
    const isolated = require('./helpers/isolatedSocialDatabase')('cold-skill-dto');
    require('../src/Global'); isolated.assertConfigured(global.options.default); invoke('GameServer/DataCache').init();
    const clock = Date.now(), P = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const npc = invoke('GameServer/DataCache').npcs.find(row => row.stats?.pDef > 0 && row.stats?.pAtk > 0 && row.vitals?.maxHp > 0 && row.rewards?.exp > 0); assert(npc);
    const target = { ...P.npcCombatStats(npc), selfId: npc.selfId }, classes = [0, 1, 15, 25, 44, 49, 57];
    const states = classes.flatMap((classId, i) => [native(i * 2 + 1, classId, 52, clock), native(i * 2 + 2, classId, 52, clock)]);
    const learned = native(1, 1, 60, clock); learned.simulation.revision = 3; learned.updatedAt++;
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol'), epoch = 'native-dto-transaction';
    const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), { parentPort, workerData } = require('node:worker_threads');
let opens = 0; const sqlite = require('node:sqlite'), Native = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends Native { constructor() { opens++; throw Error('pure Worker SQLite open forbidden'); } };
const originalLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (loaded, filename) {
    if (!filename.endsWith('/Population/BotLifeState.js')) return Reflect.apply(originalLoader, this, [loaded, filename]);
    loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__dtoCache = () => cache;', filename);
};
const loaded = new Module(workerData.workerPath, module); loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
try { loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + '\nmodule.exports.dtoProbe = request => require(workerData.testPath).inspect(kernel, LifeStateProjector, request);', workerData.workerPath); }
finally { Module._extensions['.js'] = originalLoader; }
parentPort.on('message', async message => {
    if (!message.dtoProbe) return;
    try { const value = await loaded.exports.dtoProbe(message.dtoProbe), assert = require('node:assert/strict');
        const forbidden = Object.keys(require.cache).filter(file => /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/]Bot[\\/]BotManager\.js$|[\\/]GameServer[\\/]Network[\\/]/.test(file));
        assert.deepEqual(forbidden, []); assert.equal(opens, 0); parentPort.postMessage({ dtoReply: message.msgId, value, forbidden, opens });
    } catch (error) { parentPort.postMessage({ dtoReply: message.msgId, error: error.stack }); }
});`;
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, clock, target, raw: states.map(exact), expected: states.map(state => outputs(state, clock, target)),
        learnedExpected: outputs(learned, clock, target), example: states[0].stats.coldCombat.skills[0], testPath: __filename,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const messages = []; let fault; worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    async function wait(predicate) { const deadline = Date.now() + 30000; while (!messages.some(predicate)) { if (fault) throw fault; if (Date.now() > deadline) throw Error('native DTO bounded timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } return messages.find(predicate); }
    async function probe(stage) { worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, stage), dtoProbe: stage }); const result = await wait(row => row.dtoReply === stage); if (result.error) throw Error(result.error); console.log('PASS', stage, JSON.stringify(result.value)); }
    try {
        await wait(row => row.type === 'ready' && row.payload.phase === 'loaded'); worker.postMessage(Protocol.envelope('init', epoch, { config: { pvpAggression: 0 } }, 'init'));
        await wait(row => row.type === 'ready' && row.payload.phase === 'running'); worker.postMessage(Protocol.envelope('pause', epoch, {}, 'pause'));
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: states.map(state => ({ state, context: { route: null } })), initial: true, done: true, ack: true }, 'initial'));
        await wait(row => row.type === 'ready' && row.msgId === 'initial'); await probe('native');
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: [{ state: learned, context: { route: null } }], initial: false, done: true, ack: true }, 'learned'));
        await wait(row => row.type === 'ready' && row.msgId === 'learned'); await probe('replacement'); await probe('failure');
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: states.map(state => ({ state, context: { route: null } })), initial: false, done: true, ack: true }, 'repopulate'));
        await wait(row => row.type === 'ready' && row.msgId === 'repopulate');
        for (const stage of ['optimizationFailure', 'release', 'edges']) await probe(stage);
        worker.postMessage(Protocol.envelope('shutdown', epoch, {}, 'shutdown')); await wait(row => row.type === 'drained');
    } finally { await worker.terminate(); fs.rmSync(isolated.directory, { recursive: true, force: true }); }
    console.log('PASS actual guarded Worker native DTO consumers, successful publication sharing, native failure parity and acquired-reference release, and exact fallback');
}
if (isMainThread) main().catch(error => { console.error(error.stack); process.exitCode = 1; });

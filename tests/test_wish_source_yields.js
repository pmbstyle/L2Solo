'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wish-source-yields');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const originalRate = process.env.L2NODE_PROGRESSION_RATE;
const originalRewards = Data.npcRewards;
const originalRandom = Math.random;
const subject = Providers.build;
// The wish's farm path reads Planner.sourceFacts (Task 2). The reference is
// a planner copy whose facts compute the yield directly and count the spot's
// NPC rows, so the cached yields and atlas counts must give a byte-equal wish.
const plannerFile = require.resolve('../src/GameServer/Bot/AI/GearAcquisitionPlanner');
const plannerCopy = new Module(plannerFile, module);
plannerCopy.filename = plannerFile; plannerCopy.paths = Module._nodeModulePaths(path.dirname(plannerFile));
const cachedYield = '        const { chance, expectedYield } = dropYieldFor(reward, itemId, kind, npcLevel, killerLevel, ratesKey);\n';
const atlasShare = '            * Number(entry.sourceCount || 0) / Math.max(1, Number(entry.totalCount || 0));\n';
let source = fs.readFileSync(plannerFile, 'utf8');
assert(source.includes(cachedYield) && source.includes(atlasShare));
source = source.replace(cachedYield, `        const { chance, expectedYield } = itemDropYield(reward, itemId, kind, { npcLevel, killerLevel });
`).replace(atlasShare, `            * (entry.spot.npcEntries || []).filter(npc => Number(npc.selfId) === Number(entry.reward.selfId))
                .reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0)
            / Math.max(1, (entry.spot.npcEntries || []).reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0));
`);
plannerCopy._compile(source, plannerFile);
const reference = { exports: { build(...args) {
    const cached = Planner.sourceFacts;
    Planner.sourceFacts = plannerCopy.exports.sourceFacts;
    try { return subject(...args); } finally { Planner.sourceFacts = cached; }
} } };
// Farm facts need a known route to the spot's town (Task 2, D6).
const preparedTrip = () => 0;
preparedTrip.details = () => ({ known: true, hours: .25, fees: 0 });
const digestible = value => JSON.stringify(value, (_, row) => row instanceof Map ? [...row] : row);
const timestamp = 1791335800000;
function review(build, state, deps) {
    Economy.reset(); Profile.forgetBuild(state.characterId);
    const before = structuredClone(state);
    Providers.build = build;
    try {
        const ctx = Economy.forState(state, deps);
        assert.deepEqual(state, before);
        return { ctx, output: { projection: ctx.projection, network: ctx.network,
            packet: ctx.statsPacket, watch: ctx.watchList, inputKey: ctx.inputKey } };
    } finally { Providers.build = subject; }
}
try {
    // Direct parity includes both types, all penalty boundaries, unknown level,
    // changed rates, repeated NPC rows and a name-only (zero own count) source.
    const reward = originalRewards.find(row => row.rewards?.some(group => group.items?.length)
        && row.spoils?.some(group => group.items?.length));
    assert(reward);
    const spots = [{ id: 'mixed', avgLevel: 60, npcEntries: [
        { selfId: reward.selfId, count: 2 }, { selfId: String(reward.selfId), count: 3 },
        { selfId: 999999, count: 0 }] }, { id: 'name-only', npcEntries: [
        { name: reward.template.name, count: 4 }] }, { id: 'ordinary-npc-must-not-become-raid',
        raidBoss: true, raidBossTemplateId: Number(reward.selfId), npcEntries: [{ selfId: reward.selfId, count: 1 }] }];
    let checks = 0;
    for (const preset of ['x1', 'x10', 'x50']) {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        const index = Planner.sourceIndexFor(spots);
        for (const [id, entries] of index) for (const entry of entries) {
            if (entry.reward !== reward) continue;
            assert.notEqual(entry.spot.id, 'ordinary-npc-must-not-become-raid');
            assert.equal(entry.totalCount, entry.spot.id === 'mixed' ? 6 : 4);
            assert.equal(entry.sourceCount, entry.spot.id === 'mixed' ? 5 : 0);
            for (const level of [0, entry.npcLevel + 8, entry.npcLevel + 9, entry.npcLevel + 19, entry.npcLevel + 20]) {
                for (const npcLevel of [entry.npcLevel, 0]) {
                    const exact = { ...entry, npcLevel };
                    assert.deepEqual(Planner.sourceYieldReaderFor(level)(exact, id),
                        Planner.itemDropYield(entry.reward, id, entry.kind, { npcLevel, killerLevel: level }));
                    checks++;
                }
            }
        }
    }
    const malformedSpots = [{ id: 'malformed-counts', npcEntries: [
        { selfId: reward.selfId, count: 'bad' }, { selfId: String(reward.selfId), count: 2 },
        { selfId: 'bad-id', name: reward.template.name, count: 3 },
        { selfId: 'bad-id', count: 4 }] }];
    const malformed = [...Planner.sourceIndexFor(malformedSpots).values()].flat().find(row => row.reward === reward);
    assert(Number.isNaN(malformed.totalCount));
    assert(Number.isNaN(malformed.sourceCount), 'later valid counts must not erase earlier NaN');
    const index = Planner.sourceIndexFor(spots);
    const beforeEmpty = Planner.sourceCacheSize();
    assert.equal(Planner.sourceIndexFor([]).size, 0);
    assert.equal(Planner.sourceIndexFor(), Planner.sourceIndexFor([]));
    assert.equal(Planner.sourceIndexFor(spots), index);
    assert.deepEqual(Planner.sourceCacheSize(), beforeEmpty);
    const entry = [...index.values()].flat().find(row => row.reward === reward && row.kind === 'drop');
    const itemId = reward.rewards.find(group => group.items?.length).items[0].selfId;
    const oldYield = Planner.sourceYieldReaderFor(1)(entry, itemId);
    Data.npcRewards = originalRewards.map(row => row === reward ? { ...row, rewards: row.rewards.map(group => ({
        ...group, items: group.items.map(item => ({ ...item, min: Number(item.min || 1) + 100, max: Number(item.max || item.min || 1) + 100 })) })) } : row);
    const newIndex = Planner.sourceIndexFor(spots);
    const replaced = newIndex.get(Number(itemId)).find(row => row.reward.selfId === reward.selfId && row.kind === 'drop');
    assert.notDeepEqual(Planner.sourceYieldReaderFor(1)(replaced, itemId), oldYield);
    assert.deepEqual(Planner.sourceYieldReaderFor(1)(replaced, itemId), Planner.itemDropYield(replaced.reward, itemId, 'drop', { npcLevel: replaced.npcLevel, killerLevel: 1 }));
    const replacementSpots = structuredClone(spots); replacementSpots[0].npcEntries[0].count = 10;
    assert.equal(Planner.sourceIndexFor(replacementSpots).get(Number(itemId)).find(row => row.spot.id === 'mixed').sourceCount, 13);

    // Force eviction with cheap, deterministic catalog data; retained cardinality
    // remains the existing cap and eviction cannot change a recomputed result.
    const tiny = { selfId: reward.selfId, template: reward.template, rewards: [{ overall: 100, items: [{ selfId: 1869, chance: 100, min: 1, max: 1 }] }] };
    Data.npcRewards = [tiny];
    const boundedIndex = Planner.sourceIndexFor(spots);
    const boundedSource = boundedIndex.get(1869)[0], reader = Planner.sourceYieldReaderFor(1);
    const remembered = reader(boundedSource, 1869);
    for (let item = 100000; item < 116400; item++) reader(boundedSource, item);
    assert.equal(Planner.sourceCacheSize().yields, 16384);
    assert.deepEqual(reader(boundedSource, 1869), remembered);
    assert.equal(Planner.sourceCacheSize().yields, 16384);
    Data.npcRewards = originalRewards;

    let seed = 20261005;
    Math.random = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
        x = (x + Math.imul(x ^ x >>> 7, 61 | x)) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
    const world = { user: { sessions: [] }, npc: { spawns: [], grid: {}, nextId: 1000000,
        periodMode: 'day', periodRevision: 0, periodDefinitions: [], raidBossRespawnTimers: new Map(),
        raidBossState: new Map(), gridKeys: new WeakMap() }, items: { spawns: [], nextId: 5000000 },
        addNpcToGrid() {}, indexSpawnsInGrid() {} };
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    const World = invoke('GameServer/World/World'); World.npc = world.npc; World.user = world.user;
    invoke('GameServer/Bot/AI/SpotService').reset();
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles'); Profiles.reset();
    const nativeSpots = Profiles.ensure(); assert(nativeSpots.length > 1800);
    Math.random = originalRandom;
    const nativeIndex = Planner.sourceIndexFor(nativeSpots);
    const records = new Set([...nativeIndex.values()].flat());
    for (const row of records) {
        const counts = row.spot.npcEntries || [];
        assert.equal(row.totalCount, counts.reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0));
        assert.equal(row.sourceCount, counts.filter(npc => Number(npc.selfId) === Number(row.reward.selfId))
            .reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0));
    }
    const crafter = require('./fixtures/wish_spot_native_state.json');
    const board = new BoardIndex();
    let projections = 0;
    for (const preset of ['x1', 'x10', 'x50']) for (const classId of [crafter.stats.classId, 8, 55]) {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        const state = structuredClone(crafter);
        state.stats.classId = classId;
        state.stats.role = classId === 55 ? 'spoiler' : classId === 8 ? 'nuker' : 'crafter';
        const deps = { spots: nativeSpots, board, timestamp, occupancy: new Map(), npcOffersFor: () => [], tripCost: preparedTrip };
        const baseline = review(reference.exports.build, structuredClone(state), deps);
        const optimized = review(subject, structuredClone(state), deps);
        assert.deepEqual(optimized.output, baseline.output);
        assert.equal(digestible(optimized.output), digestible(baseline.output), 'whole projection/network/packet/watch is byte-equal');
        projections++;
    }
    const emptyDeps = { spots: [], board, timestamp, occupancy: new Map(), npcOffersFor: () => [], tripCost: preparedTrip };
    assert.deepEqual(review(subject, structuredClone(crafter), emptyDeps).output,
        review(reference.exports.build, structuredClone(crafter), emptyDeps).output);
    process.env.L2NODE_PROGRESSION_RATE = 'x10';
    const deps = { spots: nativeSpots, board, timestamp, occupancy: new Map(), npcOffersFor: () => [], tripCost: preparedTrip };
    const prepared = review(subject, structuredClone(crafter), deps).ctx;
    // Optional small, interleaved native provider replay. No world/server run,
    // no injected timing in production, no assertion about live improvement.
    if (process.env.WISH_SOURCE_BENCH === '1') {
        const outputs = [subject, reference.exports.build].map(build => digestible(build(crafter, prepared, deps)));
        assert.equal(outputs[0], outputs[1]);
        for (let i = 0; i < 10; i++) for (const build of [subject, reference.exports.build]) build(crafter, prepared, deps);
        const rows = { baseline: [], optimized: [] };
        if (global.gc) global.gc();
        const beforeHeap = process.memoryUsage().heapUsed;
        for (let block = 0; block < 6; block++) for (const name of block % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
            const build = name === 'optimized' ? subject : reference.exports.build;
            const start = performance.now();
            for (let i = 0; i < 10; i++) build(crafter, prepared, deps);
            rows[name].push((performance.now() - start) / 10);
        }
        if (global.gc) global.gc();
        const afterHeap = global.gc ? process.memoryUsage().heapUsed : null;
        const indexHeap = {};
        if (global.gc) {
            const plannerFile = require.resolve('../src/GameServer/Bot/AI/GearAcquisitionPlanner');
            const plannerSource = fs.readFileSync(plannerFile, 'utf8');
            for (const variant of ['legacyRecords', 'countedRecords']) {
                let copy = new Module(plannerFile, module);
                copy.filename = plannerFile; copy.paths = Module._nodeModulePaths(path.dirname(plannerFile));
                let code = plannerSource;
                if (variant === 'legacyRecords') code = code.replace(
                    /record = \{ reward, spot, kind, npcLevel, totalCount: counts.total,\s*sourceCount: counts.byNpc.get\(Number\(reward.selfId\)\) \?\? 0 \};/,
                    'record = { reward, spot, kind, npcLevel };');
                assert(variant !== 'legacyRecords' || code !== plannerSource);
                copy._compile(code, plannerFile);
                global.gc();
                const before = process.memoryUsage().heapUsed;
                copy.exports.sourceIndexFor(nativeSpots);
                global.gc();
                indexHeap[variant] = process.memoryUsage().heapUsed - before;
                const childIndex = module.children.indexOf(copy);
                if (childIndex >= 0) module.children.splice(childIndex, 1);
                copy = null;
                global.gc();
            }
        }
        console.log(JSON.stringify({ benchmark: 'same prepared native provider, 60 builds each, six interleaved blocks',
            meanMs: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.reduce((a,b) => a+b, 0) / values.length])),
            blocksMs: rows, indexRetainedHeapDeltaBytes: indexHeap, wholeProcessHeapBeforeGcWindow: beforeHeap, wholeProcessHeapAfterGcWindow: afterHeap,
            sourceCache: Planner.sourceCacheSize() }));
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log(JSON.stringify({ directYieldChecks: checks, byteEqualWholeProjections: projections,
        nativeSpots: nativeSpots.length, sharedSourceRecords: records.size, addedNumericPayloadEstimateBytes: records.size * 16,
        sourceCache: Planner.sourceCacheSize(), perBotRetainedBytes: 0 }));
    console.log('test_wish_source_yields PASS');
} finally {
    Providers.build = subject; Data.npcRewards = originalRewards; Math.random = originalRandom;
    if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = originalRate;
    Economy.reset();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);

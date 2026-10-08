'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('source-reward-atlas');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const originalRewards = DataCache.npcRewards, originalNpcs = DataCache.npcs;
const originalFind = ItemTemplateIndex.find;

// Reference is the pre-atlas algorithm: global reward traversal and current
// selection joins. It pins row order, duplicate handling and raid exclusion.
const legacySource = `const NO_SOURCES = new Map();
function sourceIndexFor(spots = []) {
    if (!spots?.length) return NO_SOURCES;
    const rewards = DataCache.npcRewards || [];
    if (sourceIndexCache.spots === spots && sourceIndexCache.rewards === rewards) {
        return sourceIndexCache.byItemId;
    }

    const spotByNpc = new Map();
    const spotByName = new Map();
    // Counts belong to the immutable source atlas, not to each bot review.
    // This scratch index dies after construction; records retain two numbers.
    const spotCounts = new Map();
    const appendSpot = (index, key, spot) => {
        if (!key || !spot) return;
        const existing = index.get(key) || [];
        if (!existing.some((candidate) => candidate.id === spot.id)) existing.push(spot);
        index.set(key, existing);
    };
    (spots || []).forEach((spot) => {
        let total = 0;
        const byNpc = new Map();
        for (const entry of spot.npcEntries || []) {
            if (entry.selfId) appendSpot(spotByNpc, Number(entry.selfId), spot);
            if (entry.name) appendSpot(spotByName, String(entry.name).trim().toLowerCase(), spot);
            const count = Math.max(1, Number(entry.count || 1));
            const npcId = Number(entry.selfId);
            total += count;
            // Number(NaN) never matched the previous equality-based scan.
            if (!Number.isNaN(npcId)) byNpc.set(npcId, (byNpc.has(npcId) ? byNpc.get(npcId) : 0) + count);
        }
        spotCounts.set(spot, { total, byNpc });
    });

    const byItemId = new Map();
    rewards.forEach((reward) => {
        const protectedRaid = BotRaidSafety.isProtectedRaidEntity(ItemTemplateIndex.find(DataCache.npcs, reward.selfId));
        const spotsForNpc = [...new Map([
            ...(spotByNpc.get(Number(reward.selfId)) || []),
            ...(spotByName.get(String(reward.template?.name || '').trim().toLowerCase()) || [])
        ].map((spot) => [spot.id, spot])).values()];
        if (!spotsForNpc.length) return;
        // Only the explicit raid-source atlas may opt a protected NPC into
        // equipment planning. Mentioning that NPC in an ordinary spot never
        // bypasses the global bot raid guard.
        const eligibleSpots = protectedRaid
            ? spotsForNpc.filter((spot) => spot?.raidBoss === true
                && Number(spot.raidBossTemplateId || 0) === Number(reward.selfId))
            : spotsForNpc.filter((spot) => spot?.raidBoss !== true);
        if (!eligibleSpots.length) return;
        const itemKinds = [
            ['drop', reward.rewards || []],
            ['spoil', reward.spoils || []]
        ].flatMap(([kind, groups]) => groups.flatMap((group) => (
            (group.items || []).map((item) => ({ id: Number(item.selfId || 0), kind })).filter((item) => item.id)
        )));
        const npcLevel = Number(ItemTemplateIndex.find(DataCache.npcs, reward.selfId)?.template?.level || 0);
        eligibleSpots.forEach((spot) => {
            // The same NPC/spot/kind serves many items. Its immutable index
            // record is shared rather than copied into every item's list.
            const records = new Map();
            itemKinds.forEach(({ id, kind }) => {
                const entries = byItemId.get(id) || [];
                if (!entries.some((entry) => entry.reward === reward && entry.spot.id === spot.id && entry.kind === kind)) {
                    let record = records.get(kind);
                    if (!record) {
                        const counts = spotCounts.get(spot);
                        record = { reward, spot, kind, npcLevel, totalCount: counts.total,
                            sourceCount: counts.byNpc.get(Number(reward.selfId)) ?? 0 };
                        records.set(kind, record);
                    }
                    entries.push(record);
                }
                byItemId.set(id, entries);
            });
        });
    });

    sourceIndexCache = { spots, rewards, byItemId, resolved: new Map(), yields: new Map() };
    return byItemId;
}
`;
function reference(spots) {
    const context = { DataCache, ItemTemplateIndex, BotRaidSafety };
    vm.createContext(context);
    vm.runInContext('let sourceIndexCache = { spots: null, rewards: null, byItemId: new Map(), resolved: new Map(), yields: new Map() };'
        + legacySource + '; this.sourceIndexFor = sourceIndexFor;', context);
    return context.sourceIndexFor(spots);
}
function summary(index) {
    return JSON.stringify([...index].map(([id, rows]) => [id, rows.map(row => ({
        rewardOrdinal: DataCache.npcRewards.indexOf(row.reward), spotId: row.spot.id,
        raidBoss: row.spot.raidBoss, raidBossTemplateId: row.spot.raidBossTemplateId,
        roster: row.spot.raidRosterSize, kind: row.kind, npcLevel: row.npcLevel,
        totalCount: row.totalCount, sourceCount: row.sourceCount
    }))]));
}
let paritySelections = 0;
function parity(spots) {
    assert.equal(summary(Planner.sourceIndexFor(spots)), summary(reference(spots)));
    paritySelections++;
}
try {
    const normal = originalRewards.find(row => Number(row.selfId) === 16);
    const raid = originalRewards.find(row => Number(row.selfId) === 10372);
    assert(normal && raid);
    const normalSpot = { id: 'normal', npcEntries: [{ selfId: normal.selfId, name: normal.template.name, count: 3 }] };
    const raidSpot = { id: 'raid', raidBoss: true, raidBossTemplateId: raid.selfId, raidRosterSize: 7,
        npcEntries: [{ selfId: raid.selfId, name: raid.template.name, count: 1 }] };
    const aliasSpot = { id: 'alias', npcEntries: [{ name: '  ' + normal.template.name.toUpperCase() + ' ', count: 5 }] };
    for (const spots of [[normalSpot], [aliasSpot], [raidSpot], [raidSpot, aliasSpot, normalSpot],
        [{ ...raidSpot, raidBoss: false }], [{ ...raidSpot, raidBossTemplateId: normal.selfId }],
        [{ ...normalSpot, raidBoss: true, raidBossTemplateId: normal.selfId }]]) parity(spots);

    // Same reward reached through both aliases produces one row per kind;
    // source order follows the catalog, rather than the selected-entry order.
    const loot = (selfId, name) => ({ selfId, template: { name }, rewards: [
        { items: [{ selfId: 1869 }, { selfId: 1869 }, { selfId: 1870 }] }],
        spoils: [{ items: [{ selfId: 1869 }] }] });
    DataCache.npcRewards = [loot(16, 'Shared'), loot(17, 'Shared'), loot(16, 'Other')];
    const aliases = [{ id: 'first', npcEntries: [
        { selfId: 17, name: ' shared ', count: 4 }, { selfId: 16, name: 'Other', count: 2 },
        { selfId: 16, name: 'Shared', count: 1 }] },
    { id: 'name', npcEntries: [{ name: 'SHARED', count: 7 }] },
    // Matching by ID and name with the same spot ID preserves the previous
    // Map's last value and first insertion position, including current counts.
    { id: 'first', npcEntries: [{ name: 'Shared', count: 9 }] }];
    parity(aliases);
    const chosen = Planner.sourceIndexFor(aliases).get(1869);
    assert.deepEqual(chosen.map(row => DataCache.npcRewards.indexOf(row.reward)), [0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
    parity(structuredClone(aliases));
    DataCache.npcRewards.push(DataCache.npcRewards[0]);
    DataCache.npcRewards = DataCache.npcRewards.slice();
    parity(aliases);
    assert.equal(Planner.sourceIndexFor(aliases).get(1869).length, chosen.length,
        'same reward reference repeated in the catalog does not repeat sources');

    DataCache.npcRewards = originalRewards.slice();
    let traversals = 0, visits = 0, npcLookups = 0;
    DataCache.npcRewards.forEach = function (callback) {
        traversals++;
        return Array.prototype.forEach.call(this, (row, ordinal) => { visits++; callback(row, ordinal); });
    };
    ItemTemplateIndex.find = (catalog, id) => {
        if (catalog === DataCache.npcs) npcLookups++;
        return originalFind(catalog, id);
    };
    const spots = [raidSpot, normalSpot, aliasSpot];
    const first = Planner.sourceIndexFor(spots), digest = summary(first);
    assert.equal(traversals, 1);
    assert.equal(visits, originalRewards.length);
    assert.equal(npcLookups, originalRewards.length, 'one metadata lookup per static reward');
    assert.equal(Planner.sourceIndexFor(spots), first);
    const clone = structuredClone(spots);
    assert.equal(summary(Planner.sourceIndexFor(clone)), digest);
    assert.equal(traversals, 1, 'equal replacement arrays do not traverse global rewards');
    assert.equal(npcLookups, originalRewards.length, 'selection does not repeat NPC metadata lookups');
    clone[0].raidRosterSize = 9;
    clone[1].npcEntries[0].count = 11;
    const refreshed = Planner.sourceIndexFor(structuredClone(clone));
    const normalRow = [...refreshed.values()].flat().find(row => row.reward === normal && row.spot.id === 'normal');
    assert.equal(normalRow.totalCount, 11);
    assert.equal(normalRow.sourceCount, 11);
    assert.equal([...refreshed.values()].flat().find(row => row.reward === raid).spot.raidRosterSize, 9);
    assert.deepEqual(Planner.sourceCacheSize(), { resolved: 0, packedBytes: 0, yields: 0 });
    const withoutRaid = structuredClone(clone); withoutRaid[0].raidBoss = false;
    assert(![...Planner.sourceIndexFor(withoutRaid).values()].flat().some(row => row.reward === raid));
    assert.equal(traversals, 1);

    // Even the exact same selected array must refresh on either catalog swap.
    const npc = originalFind(originalNpcs, normal.selfId);
    DataCache.npcs = originalNpcs.map(row => row === npc ? { ...row, template: { ...row.template, level: 99 } } : row);
    const changedNpcs = Planner.sourceIndexFor(spots);
    assert.equal(traversals, 2);
    assert.equal([...changedNpcs.values()].flat().find(row => row.reward === normal).npcLevel, 99);
    DataCache.npcs = originalNpcs.map(row => row === npc ? { ...row, template: { ...row.template, raidBoss: true } } : row);
    assert(![...Planner.sourceIndexFor(spots).values()].flat().some(row => row.reward === normal),
        'replaced NPC catalog refreshes static raid protection even on the same selected array');
    parity([{ ...normalSpot, raidBoss: true, raidBossTemplateId: normal.selfId }]);
    DataCache.npcs = originalNpcs;
    DataCache.npcRewards = [loot(16, normal.template.name)];
    const changedRewards = Planner.sourceIndexFor(spots);
    assert.deepEqual([...changedRewards.keys()], [1869, 1870]);
    assert.equal(changedRewards.get(1869)[0].reward, DataCache.npcRewards[0]);
    ItemTemplateIndex.find = originalFind;
    DataCache.npcRewards = originalRewards;
    parity(spots);

    // Measure only the new fixed atlas, after priming the existing NPC index.
    // Excludes selected-view records, whole-worker memory and runtime timing.
    let atlasRetainedHeapBytes = null;
    if (global.gc) {
        const source = fs.readFileSync(require.resolve('../src/GameServer/Bot/AI/GearAcquisitionPlanner'), 'utf8');
        const start = source.indexOf('let sourceRewardAtlas =');
        const end = source.indexOf('function sourceIndexFor(', start);
        const context = { ItemTemplateIndex, BotRaidSafety };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end) + '; this.atlasFor = sourceRewardAtlasFor;', context);
        originalFind(originalNpcs, normal.selfId);
        global.gc();
        const before = process.memoryUsage().heapUsed;
        context.atlasFor(originalRewards, originalNpcs);
        global.gc();
        atlasRetainedHeapBytes = process.memoryUsage().heapUsed - before;
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log(JSON.stringify({ paritySelections, rewardRows: originalRewards.length,
        firstFullTraversals: 1, repeatFullTraversals: 0, firstNpcMetadataLookups: originalRewards.length,
        repeatNpcMetadataLookups: 0, atlasRetainedHeapBytes, perBotRetainedBytes: 0,
        limits: 'offline source index parity and operation counts; fixed atlas retained heap only, no world CPU/worker-fit claim' }));
    console.log('test_source_reward_atlas PASS');
} finally {
    ItemTemplateIndex.find = originalFind;
    DataCache.npcRewards = originalRewards; DataCache.npcs = originalNpcs;
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);

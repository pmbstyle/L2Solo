'use strict';

// Shared game-data relations. The current selected view owns no bot state.
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const SpotIndex = require('../Bot/AI/SpotIndex');
const EMPTY = Object.freeze([]);

// Numeric first-match semantics match the legacy reward reader. This lookup
// needs no selected spots or full reward/raid atlas.
function rewardForNpc(npcId) {
    return ItemTemplateIndex.find(DataCache.npcRewards, npcId) || null;
}

// No spots, no sources. A caller without spots (a default `[]`, a new array
// each call) must not evict the index built for the real spot list: the
// cache holds one list, and the next wish review would rebuild it in full.
const NO_SOURCES = new Map();
let sourceIndexCache = { spots: null, rewards: null, npcs: null, byItemId: NO_SOURCES };
// Each index record's reward ordinal, for merging two indexes in reward order.
const recordOrdinals = new WeakMap();
// Reward relations belong to their source array, including cold-combat name
// lookups. NPC metadata is prepared only for readers that need it. Weak keys
// release replaced sources; no atlas retains actors or selected spots.
let sourceRewardAtlas = null;
const rewardAtlases = new WeakMap();
function rewardAtlasFor(rewards) {
    if (!Array.isArray(rewards)) return null;
    const cached = rewardAtlases.get(rewards);
    if (cached && cached.rewardsLength === rewards.length) return cached;
    const byNpc = new Map();
    const byName = new Map();
    const append = (index, key, row) => {
        const rows = index.get(key) || [];
        rows.push(row);
        index.set(key, rows);
    };
    rewards.forEach((reward, ordinal) => {
        if (!reward) return;
        const row = { reward, ordinal };
        append(byNpc, Number(reward.selfId), row);
        if ((reward.rewards || []).length > 0 || (reward.spoils || []).length > 0) {
            append(byName, String(reward.template?.name || '').trim().toLowerCase(), row);
        }
    });
    for (const rows of byName.values()) Object.freeze(rows);
    const atlas = { rewards, rewardsLength: rewards.length, byNpc, byName };
    rewardAtlases.set(rewards, atlas);
    return atlas;
}

function sourceRewardAtlasFor(rewards, npcs) {
    const atlas = rewardAtlasFor(rewards);
    if (!atlas.metadataPrepared || atlas.npcs !== npcs || atlas.npcsLength !== npcs?.length) {
        for (const rows of atlas.byNpc.values()) for (const row of rows) {
            const npc = ItemTemplateIndex.find(npcs, row.reward.selfId);
            row.npcLevel = Number(npc?.template?.level || 0);
            row.protectedRaid = BotRaidSafety.isProtectedRaidEntity(npc);
        }
        atlas.metadataPrepared = true;
        atlas.npcs = npcs;
        atlas.npcsLength = npcs?.length;
    }
    sourceRewardAtlas = atlas;
    return sourceRewardAtlas;
}

// ALL nonempty loot/spoil rows, with original ordinals and normalized names.
// Callers keep their own candidate arrays, weights and random selection.
function rewardRowsForName(name, rewards = DataCache.npcRewards) {
    return rewardAtlasFor(rewards)?.byName.get(String(name || '').trim().toLowerCase()) || EMPTY;
}

// All declared reward sources, independent of planner spots and raid access.
// This lazy reverse belongs to the existing reward atlas. One borrowed record
// per reward/kind is shared by its item lists; every original group is retained.
function rawSourcesForItem(itemId, kind) {
    if (!Array.isArray(DataCache.npcRewards)) return null;
    const atlas = sourceRewardAtlasFor(DataCache.npcRewards, DataCache.npcs);
    if (!atlas.rawByKind) {
        atlas.rawByKind = { drops: new Map(), spoils: new Map() };
        for (const reward of atlas.rewards) {
            for (const [field, rowKind] of [['drops', 'drop'], ['spoils', 'spoil']]) {
                const index = atlas.rawByKind[field], seen = new Set();
                const row = Object.freeze({ reward, npcId: Number(reward.selfId), kind: rowKind });
                for (const group of reward[field === 'drops' ? 'rewards' : 'spoils'] || []) {
                    for (const item of group.items || []) {
                        const id = Number(item.selfId);
                        if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;
                        seen.add(id);
                        if (!index.has(id)) index.set(id, []);
                        index.get(id).push(row);
                    }
                }
            }
        }
        for (const index of Object.values(atlas.rawByKind)) {
            for (const rows of index.values()) Object.freeze(rows);
        }
    }
    return atlas.rawByKind[kind]?.get(Number(itemId)) || EMPTY;
}
function rewardAllowedAtSpot(spot, reward, protectedRaid) {
    return protectedRaid ? spot?.raidBoss === true && Number(spot.raidBossTemplateId || 0) === Number(reward.selfId)
        : !!spot && spot.raidBoss !== true;
}

// Addressed source proof: the same native ID/name and raid permission relation
// as the selected index, without replacing its one retained planner view.
function rewardSelectedAtSpot(spot, reward) {
    if (!spot || !reward) return false;
    const npc = ItemTemplateIndex.find(DataCache.npcs, reward.selfId);
    if (!rewardAllowedAtSpot(spot, reward, BotRaidSafety.isProtectedRaidEntity(npc))) return false;
    const name = String(reward.template?.name || '').trim().toLowerCase();
    return (spot.npcEntries || []).some(entry => entry.selfId && Number(entry.selfId) === Number(reward.selfId)
        || name && entry.name && String(entry.name).trim().toLowerCase() === name);
}
// One index over a spot list (the shape every reader gets): item id ->
// records in reward order, then spot order within a reward.
function indexSpots(spots, atlas) {
    const selectedRewards = new Set();
    const spotByNpc = new Map();
    const spotByName = new Map();
    // Source weights and raid decorations belong to this current selection.
    // Physical topology belongs to SpotIndex, not to planner source weights.
    const spotCounts = new Map();
    const appendSpot = (index, key, spot) => {
        if (!key || !spot) return;
        const existing = index.get(key) || new Map();
        if (!existing.has(spot.id)) existing.set(spot.id, spot);
        index.set(key, existing);
    };
    (spots || []).forEach((spot) => {
        let total = 0;
        const byNpc = new Map();
        for (const entry of spot.npcEntries || []) {
            if (entry.selfId) {
                const npcId = Number(entry.selfId);
                if (npcId && !spotByNpc.has(npcId)) {
                    for (const row of atlas.byNpc.get(npcId) || []) selectedRewards.add(row);
                }
                appendSpot(spotByNpc, npcId, spot);
            }
            if (entry.name) {
                const name = String(entry.name).trim().toLowerCase();
                if (name && !spotByName.has(name)) {
                    for (const row of atlas.byName.get(name) || []) selectedRewards.add(row);
                }
                appendSpot(spotByName, name, spot);
            }
            const count = Math.max(1, Number(entry.count || 1));
            const npcId = Number(entry.selfId);
            total += count;
            // Number(NaN) never matched the previous equality-based scan.
            if (!Number.isNaN(npcId)) byNpc.set(npcId, (byNpc.has(npcId) ? byNpc.get(npcId) : 0) + count);
        }
        spotCounts.set(spot, { total, byNpc });
    });

    const byItemId = new Map();
    // Scratch sets replace scans of each growing item's source list. A repeated
    // reward object/spot/kind keeps its first record, as before; all joins die
    // after construction, leaving only the current selected view.
    const recordsByReward = new Map();
    // Union ID/name matches, retaining original reward order for ties and aliases.
    [...selectedRewards].sort((left, right) => left.ordinal - right.ordinal).forEach(({ reward, ordinal, npcLevel, protectedRaid }) => {
        const spotsForNpc = [...new Map([
            ...(spotByNpc.get(Number(reward.selfId)) || []),
            ...(spotByName.get(String(reward.template?.name || '').trim().toLowerCase()) || [])
        ]).values()];
        if (!spotsForNpc.length) return;
        // Only the explicit raid-source atlas may opt a protected NPC into
        // equipment planning. Mentioning that NPC in an ordinary spot never
        // bypasses the global bot raid guard.
        const eligibleSpots = spotsForNpc.filter(spot => rewardAllowedAtSpot(spot, reward, protectedRaid));
        if (!eligibleSpots.length) return;
        const itemKinds = [
            ['drop', reward.rewards || []],
            ['spoil', reward.spoils || []]
        ].flatMap(([kind, groups]) => groups.flatMap((group) => (
            (group.items || []).map((item) => ({ id: Number(item.selfId || 0), kind })).filter((item) => item.id)
        )));
        eligibleSpots.forEach((spot) => {
            // The same NPC/spot/kind serves many items. Its immutable index
            // record is shared rather than copied into every item's list.
            let recordsBySpot = recordsByReward.get(reward);
            if (!recordsBySpot) {
                recordsBySpot = new Map();
                recordsByReward.set(reward, recordsBySpot);
            }
            let records = recordsBySpot.get(spot.id);
            if (!records) {
                records = new Map();
                recordsBySpot.set(spot.id, records);
            }
            itemKinds.forEach(({ id, kind }) => {
                let entry = records.get(kind);
                if (!entry) {
                    const counts = spotCounts.get(spot);
                    const record = { reward, spot, kind, npcLevel, totalCount: counts.total,
                        sourceCount: counts.byNpc.get(Number(reward.selfId)) ?? 0 };
                    recordOrdinals.set(record, ordinal);
                    entry = { record, itemIds: new Set() };
                    records.set(kind, entry);
                }
                if (entry.itemIds.has(id)) return;
                entry.itemIds.add(id);
                const entries = byItemId.get(id) || [];
                entries.push(entry.record);
                byItemId.set(id, entries);
            });
        });
    });

    return byItemId;
}

function sameRows(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
}

// A protected raid reward is eligible only at its own raid spot and every
// other reward only at a non-raid spot (rewardAllowedAtSpot), so a list's
// index is the index of its non-raid rows merged, by reward order, with the
// index of its raid rows. The non-raid rows are the spot catalogue, the same
// rows in every clan worker plan message (each message brings a new array):
// their index is built once per row list, rewards and NPCs. Each clan's raid
// decorations are a few rows on top (a small overlay, the last few held).
const MAX_OVERLAYS = 8;
const NO_ROWS = Object.freeze({ byItemId: NO_SOURCES, ids: new Set() });
let baseIndex = null;
let overlays = [];
function baseIndexFor(rows, rewards, npcs, atlas) {
    const held = baseIndex;
    if (held && held.rewards === rewards && held.npcs === npcs && held.rewardsLength === rewards.length
        && held.npcsLength === npcs?.length && sameRows(held.rows, rows)) return held;
    baseIndex = { rows, rewards, npcs, rewardsLength: rewards.length, npcsLength: npcs?.length,
        ids: new Set(rows.map(spot => spot.id)), byItemId: indexSpots(rows, atlas) };
    overlays = [];
    return baseIndex;
}

function mergeByOrdinal(base = EMPTY, extra) {
    const merged = [];
    let left = 0, right = 0;
    while (left < base.length || right < extra.length) {
        if (right >= extra.length || left < base.length
            && recordOrdinals.get(base[left]) < recordOrdinals.get(extra[right])) merged.push(base[left++]);
        else merged.push(extra[right++]);
    }
    return merged;
}

function overlayIndexFor(base, raids, atlas) {
    const held = overlays.find(entry => entry.base === base && sameRows(entry.raids, raids));
    if (held) return held.byItemId;
    const byItemId = new Map(base.byItemId);
    for (const [itemId, records] of indexSpots(raids, atlas)) {
        byItemId.set(itemId, mergeByOrdinal(base.byItemId.get(itemId), records));
    }
    overlays.push({ base, raids, byItemId });
    if (overlays.length > MAX_OVERLAYS) overlays.shift();
    return byItemId;
}

function sourcesByItem(spots = []) {
    if (!spots?.length) return NO_SOURCES;
    const rewards = DataCache.npcRewards || [];
    const npcs = DataCache.npcs;
    if (sourceIndexCache.spots === spots && sourceIndexCache.rewards === rewards && sourceIndexCache.npcs === npcs
        && sourceIndexCache.spotsLength === spots.length && sourceIndexCache.rewardsLength === rewards.length
        && sourceIndexCache.npcsLength === npcs?.length) {
        return sourceIndexCache.byItemId;
    }
    const atlas = sourceRewardAtlasFor(rewards, npcs);
    const rows = [], raids = [];
    for (const spot of spots) (spot?.raidBoss === true ? raids : rows).push(spot);
    // A raid-only list (no catalogue rows) keeps the held catalogue index.
    const base = rows.length ? baseIndexFor(rows, rewards, npcs, atlas) : NO_ROWS;
    // A raid row sharing a non-raid row's id would be deduplicated against it
    // in one joint list: index such a list as a whole.
    const byItemId = !raids.length ? base.byItemId
        : raids.some(spot => base.ids.has(spot.id)) ? indexSpots(spots, atlas)
            : overlayIndexFor(base, raids, atlas);
    sourceIndexCache = { spots, rewards, npcs, spotsLength: spots.length, rewardsLength: rewards.length,
        npcsLength: npcs?.length, byItemId };
    return byItemId;
}

function rawCounts(spot, npcId) {
    let count = 0, totalCount = 0, knownCount = true, knownTotal = true, hasNpc = false;
    for (const entry of spot.npcEntries || []) {
        const amount = entry.count, valid = Number.isSafeInteger(amount) && amount >= 0;
        if (!valid || !Number.isSafeInteger(totalCount + amount)) knownTotal = false;
        else totalCount += amount;
        if (Number(entry.selfId) !== npcId) continue;
        hasNpc = true;
        if (!valid || !Number.isSafeInteger(count + amount)) knownCount = false;
        else count += amount;
    }
    return { count: knownCount ? count : null, totalCount: knownTotal ? totalCount : null, hasNpc };
}

function selectedNpcSpots(npcId, spots = []) {
    if (!spots?.length) return EMPTY;
    const id = Number(npcId);
    if (!Number.isSafeInteger(id) || id < 1) return EMPTY;
    const rows = [];
    for (const spot of SpotIndex.spotsForNpc(spots, id) || EMPTY) {
        const counts = rawCounts(spot, id);
        rows.push({ spot, npcId: id, count: counts.count, totalCount: counts.totalCount, countKind: 'catalogue_raw_counts' });
    }
    return rows;
}

function selectedSpotNpcs(spotId, spots = []) {
    if (!spots?.length) return null;
    const spot = SpotIndex.spotById(spots, spotId);
    return spot ? { spot, npcEntries: spot.npcEntries || EMPTY,
        totalCount: rawCounts(spot).totalCount, countKind: 'catalogue_raw_counts' } : null;
}

function potentialSpawnData() {
    return require('./SpawnCatalog').potentialSpawnData();
}

module.exports = { sourcesByItem, rawSourcesForItem, rewardForNpc, rewardRowsForName, selectedNpcSpots, selectedSpotNpcs, potentialSpawnData, rewardSelectedAtSpot };

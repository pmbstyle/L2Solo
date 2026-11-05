'use strict';

const Data = invoke('GameServer/DataCache');
const Rates = invoke('GameServer/ProgressionRates');
const Index = require('../../Item/ItemTemplateIndex');
const Drops = require('../Population/BackgroundDropResolver');
const Sell = require('../../Items/NpcSellRules');
const Diagnostics = require('./EconomyDiagnostics');

const MAX_NPC_VALUES = 16384;
const MAX_SPOT_VALUES = 32768;
let revision = [];
let revisionId = 0;
let compositions = new WeakMap();
// The spot rows: one Map from the row's key to its slot, the row (adena,
// drop, spoil) as three numbers at the slot in a slab, the keys by slot a
// ring in insertion order: at the cap the oldest row's slot takes the new one
// (a wipe re-measured the whole atlas at once). A spot is keyed by a number
// it gets at its first row (spotNumbers), so a key is one number, not a
// string, and no Map is held per spot: a Map per spot, a string key and an
// object per row held 16.6-19.7 MB of each thread's heap (perf heap profiles,
// mostly kill spots of a few rows each); the slab is 768 KB at the cap.
const ROW_NUMBERS = 3;
let spotNumbers = new WeakMap();
let nextSpotNumber = 0;
const spotValues = new Map();
let spotValueOrder = [];
let spotValueNext = 0;
let spotValueSlab = new Float64Array(0);
let rewardGroups = new WeakMap();
const npcValues = new Map();

// rates: the profile a caller read a moment earlier in the same synchronous
// call (SpotValueTable), so one rate read serves both revision checks (L75).
function refresh(rates = Rates.profile()) {
    const current = [rates, Data.npcs, Data.npcs?.length, Data.npcRewards,
        Data.npcRewards?.length, Data.items, Data.items?.length, Data.skills, Data.skills?.length];
    if (current.some((value, index) => value !== revision[index])) {
        revision = current;
        revisionId++;
        compositions = new WeakMap();
        spotNumbers = new WeakMap();
        nextSpotNumber = 0;
        spotValues.clear();
        spotValueOrder = [];
        spotValueNext = 0;
        rewardGroups = new WeakMap();
        npcValues.clear();
    }
}

// Use the same defeated-NPC reward mapping as native cold kills, including
// world/datapack ID aliases. Never choose a reward variant by a field name.
function composition(spot) {
    let held = compositions.get(spot);
    if (held) return held;
    const Policy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
    const entries = spot.npcEntries?.length ? spot.npcEntries
        : (spot.npcSelfIds || []).map(selfId => ({ selfId, count: 1 }));
    const nativeSpot = spot.npcNames?.length ? spot : { ...spot, npcNames: entries
        .map(entry => Index.find(Data.npcs, entry.selfId)?.template?.name).filter(Boolean) };
    held = entries.flatMap(entry => {
        const npc = Index.find(Data.npcs, entry.selfId);
        if (!npc || !Policy.canHunt(npc)
            || invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)) return [];
        return [{ npcId: Number(entry.selfId), level: Number(npc.template?.level || 1),
            count: Math.max(1, Number(entry.count) || 1),
            reward: Drops.rewardDataForSpot(nativeSpot, () => 0, entry.selfId) }];
    });
    compositions.set(spot, held);
    return held;
}

function itemPrice(itemId) {
    const item = Index.find(Data.items, itemId);
    return !item || item.template?.kind === 'Other.Quest' ? 0
        : Sell.npcBuyPrice(Number(item.template?.price || 0));
}

function groupsFor(reward) {
    if (!reward) return [];
    let groups = rewardGroups.get(reward);
    if (groups) return groups;
    groups = [];
    for (const kind of ['drop', 'spoil']) for (const group of reward[kind === 'drop' ? 'rewards' : 'spoils'] || []) {
        const rate = Rates.groupRate(group, kind), items = group.items || [];
        const total = kind === 'drop' ? items.reduce((sum, item) =>
            sum + Rates.dropItemSelectionWeight(group, item, rate), 0) : 100;
        const expected = { group, kind, adena: 0, items: 0 };
        for (const item of items) {
            let share, amount;
            if (kind === 'drop') {
                share = total > 0 ? Rates.dropItemSelectionWeight(group, item, rate) / total : 0;
                amount = Rates.expectedDropAmount(group, item, rate);
            } else {
                share = Rates.spoilItemChance(item);
                const min = Math.max(1, Math.floor(Number(item.min) || 1));
                amount = (min + Math.max(min, Math.floor(Number(item.max) || min))) / 2;
            }
            if (kind === 'drop' && Number(item.selfId) === 57) expected.adena += share * amount;
            else expected.items += share * amount * itemPrice(item.selfId);
        }
        groups.push(expected);
    }
    rewardGroups.set(reward, groups);
    return groups;
}

// Analytical expectation of the native group roll, category selection and
// high-rate amount overflow. One pass per group; no random draws or combat.
function npcValue(entry, killerLevel) {
    const rule = Rates.deepBlueRule({ npcLevel: entry.level, killerLevel });
    const key = `${entry.npcId}:${entry.reward?.selfId || 0}:${rule.active ? rule.penaltyPercent : 0}`;
    let held = npcValues.get(key);
    if (held) return held;
    held = { adena: 0, drop: 0, spoil: 0 };
    for (const expected of groupsFor(entry.reward)) {
        const roll = Rates.rewardGroupRoll(expected.group, expected.kind,
            { npcLevel: entry.level, killerLevel }, () => 0);
        const chance = roll.chance / 100;
        held.adena += chance * expected.adena;
        held[expected.kind] += chance * expected.items * (expected.kind === 'spoil' ? roll.amountMultiplier : 1);
    }
    if (npcValues.size >= MAX_NPC_VALUES) npcValues.delete(npcValues.keys().next().value);
    npcValues.set(key, held);
    return held;
}

// Spawn-weighted rewards per kill. The NPC's own level controls Deep Blue;
// the spoiler's learned skill controls landing, independently of the killer.
function value(spot, killerLevel, { spoilSkillLevel = 0, spoilerLevel = killerLevel } = {}) {
    if (!spot || typeof spot !== 'object') return null;
    const rates = Rates.profile();
    refresh(rates);
    const key = rowKey(spot, killerLevel, spoilSkillLevel, spoilSkillLevel > 0 ? spoilerLevel : 0);
    const kept = spotValues.get(key);
    if (kept !== undefined) {
        const n = spotValueSlab, at = kept * ROW_NUMBERS;
        return { adena: n[at], drop: n[at + 1], spoil: n[at + 2] };
    }
    const entries = composition(spot);
    if (!entries.length) return null;
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const held = { adena: 0, drop: 0, spoil: 0 };
    for (const entry of entries) {
        const reward = npcValue(entry, killerLevel), share = entry.count / total;
        // Native ColdKillRewards uses this fallback only when no reward data
        // exists. It must not fabricate ordinary loot for that NPC.
        held.adena += share * (entry.reward ? reward.adena
            : (Number(spot.rewards?.adenaMin || 0) + Number(spot.rewards?.adenaMax || 0)) / 2 * rates.adena);
        held.drop += share * reward.drop;
        if (spoilSkillLevel > 0) held.spoil += share * reward.spoil
            * invoke('GameServer/Formulas').spoilSuccessChance({ skillId: 254,
                skillLevel: spoilSkillLevel, attackerLevel: spoilerLevel, targetLevel: entry.level });
    }
    const slot = spotValueNext;
    spotValueNext = (spotValueNext + 1) % MAX_SPOT_VALUES;
    if (spotValueOrder.length > slot) {
        // A ring: the slot of the oldest held row takes the new one.
        spotValues.delete(spotValueOrder[slot]);
        Diagnostics.count('spot_reward', 'evict', 'oldest');
    }
    if (slot >= spotValueSlab.length / ROW_NUMBERS) {
        // The slab grows by doubling up to the cap: a small memo stays small.
        const grown = new Float64Array(Math.min(MAX_SPOT_VALUES, Math.max(1024, 2 * spotValueSlab.length / ROW_NUMBERS)) * ROW_NUMBERS);
        grown.set(spotValueSlab);
        spotValueSlab = grown;
    }
    spotValueOrder[slot] = key;
    spotValues.set(key, slot);
    const n = spotValueSlab, at = slot * ROW_NUMBERS;
    n[at] = held.adena; n[at + 1] = held.drop; n[at + 2] = held.spoil;
    return held;
}

// A row's key, its inputs: the spot, the killer's level, the Spoil skill
// level and the spoiler's level (0 without Spoil). One number below 2^53 for
// integer levels below 128 and a skill level below 32; any other argument
// set keeps a string of the four parts (a level "24" is not 24: its own row).
const KEY_LEVELS = 128, KEY_SKILLS = 32;
function rowKey(spot, killerLevel, skill, spoilerLevel) {
    let number = spotNumbers.get(spot);
    if (number === undefined) spotNumbers.set(spot, number = nextSpotNumber++);
    if (keyPart(killerLevel, KEY_LEVELS) && keyPart(skill, KEY_SKILLS) && keyPart(spoilerLevel, KEY_LEVELS))
        return ((number * KEY_LEVELS + killerLevel) * KEY_SKILLS + skill) * KEY_LEVELS + spoilerLevel;
    return `${number}:${typeof killerLevel}${killerLevel}:${typeof skill}${skill}:${typeof spoilerLevel}${spoilerLevel}`;
}
function keyPart(value, limit) {
    return Number.isInteger(value) && value >= 0 && value < limit;
}

function spoilSkillLevel(state) {
    return Number(invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state)
        .find(skill => Number(skill.selfId) === 254)?.level || 0);
}

module.exports = { value, spoilSkillLevel, revision(rates) { refresh(rates); return revisionId; }, MAX_NPC_VALUES, MAX_SPOT_VALUES };

const fs = require('fs');
const path = require('path');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Rewards = require('../Economy/SpotRewardExpectation');
const SpotIndex = require('./SpotIndex');
const DiagnosticConfig = require('../Population/PopulationConfig');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

// The world spot table (market-sim step 3.3(c), N44): what an hour of solo
// hunting on a spot gives a bot of a role and level, with shots or without.
// scripts/generate-spot-table.js measures it offline with the author's cold
// combat and writes data/Bots/spot-table.json; each thread (main and the cold
// worker) loads that file once on first use. A lookup is O(1).
//
// Per spot, role and shots the file keeps one row measured at a reference
// level; per role and spot level band a curve says how each value changes
// with the bot's level over the spot's level. Kills are capped by what the
// spot's monster count allows. Values are at rate x1; the server's rates are
// applied here. Reward amounts/chances come from NPC groups; the measured
// drop-rate response is retained only for physical bag growth.
const DEFAULT_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-table.json');
const REWARD_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-reward-npcs.json');
let offlineSpots = null;

function rewardSpot(spotId) {
    // Main and worker prefer their actual, immutable period catalogs. A
    // standalone lookup has a compact authored spawn catalog, never a World.
    const actual = SpotIndex.spotById(rewardSpots, spotId);
    if (actual) return actual;
    if (!offlineSpots) offlineSpots = new Map(JSON.parse(fs.readFileSync(REWARD_FILE, 'utf8')).rows.map(
        ([id, entries, adenaMin, adenaMax]) => [id, { id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })),
            rewards: { adenaMin, adenaMax } }]));
    return offlineSpots.get(String(spotId)) || null;
}

let table = null;
let file = DEFAULT_FILE;
const bestRows = new Map();
const incomeRows = new Map();
const incomeBases = new Map();
// Four doubles and one index per cell: at most 9 MiB per thread.
const MAX_INCOME_BASE_CELLS = 262144;
let incomeBaseCells = 0;
// Cache use for the cold worker heartbeat (L104); counted only with developer diagnostics.
// memoEvictions, incomeEvictions, baseEvictions count the oldest-row drops at their caps; resets the
// wholesale clears that dropped rows (catalog, table or rate change).
const stats = { memoHits: 0, memoMisses: 0, memoEvictions: 0, incomeEvictions: 0, baseEvictions: 0, resets: 0,
    bestHits: 0, bestMisses: 0, incomeHits: 0, incomeMisses: 0, spotIdRanks: 0 };
function countReset(rows) { DiagnosticConfig.developerDiagnostics && rows && (stats.resets += 1); }
function cachedRows() { return valueMemo.size + bestRows.size + incomeRows.size + incomeBases.size; }
function cacheStats() {
    return { memo: valueMemo.size, best: bestRows.size, income: incomeRows.size, bases: incomeBases.size,
        cells: incomeBaseCells, ...stats };
}
let incomeTable, incomeRates;
const EMPTY_SPOTS = [];
let spotSource = () => EMPTY_SPOTS;
let rewardSpots = EMPTY_SPOTS, rewardSpotCount = 0;
let rewardRevision = 0;
// Moves whenever the table's rows are dropped (spot catalog, rewards, rates, table file): a reader keeping
// values computed from the table keeps them while it holds (ShotStock.blessedPays, HuntCycle).
let tableRevision = 0;
const spoilLevels = new Map();

function useSpots(source) {
    spotSource = typeof source === 'function' ? source : () => source || EMPTY_SPOTS;
}

// rates: the profile the caller has just read (one rate read per call, L75).
function refreshCatalog(rates) {
    const spots = spotSource() || EMPTY_SPOTS;
    const revision = Rewards.revision(rates);
    if (catalogMoved(spots) || revision !== rewardRevision) {
        if (catalogMoved(spots)) checkCatalog(spots);
        rewardSpots = spots; rewardSpotCount = spots.length;
        rewardRevision = revision;
        dropRows();
        spoilLevels.clear();
    }
}

function catalogMoved(spots) {
    return spots !== rewardSpots || spots.length !== rewardSpotCount;
}

// The server's catalogue against the table's, one line per catalogue (a
// repeated one is not logged again): the hunting spots the table has no row
// set for (they get no value: a table of another catalogue, other geodata
// floors) and the geodata the table was measured on against the server's.
let catalogLine = null;
function checkCatalog(spots) {
    if (!spots.length) return;
    const t = load();
    let hunting = 0, missing = 0;
    for (const spot of spots) {
        if (spot.raidBoss === true) continue;
        hunting++;
        if (!t.spotIndex.has(String(spot.id))) missing++;
    }
    const tableGeodata = t.header.inputs?.geodata ?? null, serverGeodata = geodataProfile();
    const line = `${missing}|${hunting}|${tableGeodata}|${serverGeodata}`;
    if (line === catalogLine) return;
    catalogLine = line;
    const log = global.utils?.[missing || tableGeodata !== serverGeodata ? 'infoWarn' : 'infoSuccess'];
    log?.('SpotTable', '%d of %d catalogue spots missing from the spot table; geodata: table %s, server %s',
        missing, hunting, tableGeodata, serverGeodata);
}

// The profile of the geodata pack the server stands on (its manifest's, the
// pack scripts/geodata-release.json names), or null without one. Read once:
// the pack changes only with a restart.
let geodataName;
function geodataProfile() {
    if (geodataName !== undefined) return geodataName;
    try {
        const directory = invoke('GameServer/Geodata/GeodataEngine').getGeodataDir(); // lazy: optional read once, at the first catalogue check (an offline table reader needs no geodata)
        geodataName = JSON.parse(fs.readFileSync(path.join(directory, '.l2solo-geodata-manifest.json'), 'utf8')).profile || null;
    } catch (_) { geodataName = null; }
    return geodataName;
}

// The table's computed rows go with the inputs they came from.
function dropRows() {
    tableRevision++;
    countReset(cachedRows());
    clearValueMemo(); bestRows.clear(); incomeRows.clear();
    clearIncomeBases();
}

// The Spoil level of the class a table key measured at a level (0 without
// Spoil): a spoiler line's own loot.
function roleSpoilLevel(role, level) {
    const key = `${role}|${level}`;
    if (!spoilLevels.has(key)) {
        const classId = roleClass(role, level);
        spoilLevels.set(key, classId === null ? 0 : Rewards.spoilSkillLevel({ level, stats: { classId } }));
    }
    return spoilLevels.get(key);
}
// value() is a pure function of the table, the rate profile and its four
// arguments; every bot of a role and level asks the same spots. One bounded
// answer per argument set, dropped when the table or the profile changes
// (ProgressionRates keeps one profile object while the rates are equal).
const MAX_VALUE_MEMO = 32768;
const valueMemo = new Map();
// ARCH-NOTE: PERF valueMemo's keys by slot, a ring in insertion order; valueMemoTail is the next
// slot to fill, at the cap the oldest row's, so the drop at the cap reads the oldest key here.
// Asking the Map for its first key walks every slot an earlier drop left empty (4.3 s per 131k
// drops at the cap).
const valueMemoOrder = [];
let valueMemoTail = 0;
function clearValueMemo() { valueMemo.clear(); valueMemoOrder.length = 0; valueMemoTail = 0; }
// The Map holds a key's slot; the row lives at that slot as 13 numbers in a slab and a flag
// byte. A new row drops the key filed at its slot, so a slot holds its key's row while the key
// lives. L104: at the cap (x10, 24k real rows) the memo held 7.0 MB of the cold worker heap
// with object rows, 1.0 MB so, plus the slab's 3 MB outside the JS heap (arrayBuffers). The ring fills
// its slots in order before it wraps, so the slab grows by doubling and a small memo stays small.
const ROW_NUMBERS = 13;
const NO_ROW = 1, NO_STACKS = 2, NO_REWARDS = 4;
const ADENA = 4, LOOT = 7, SHOTS = 8, POTIONS = 9, PRODUCTION = 12;
let memoNumbers = new Float64Array(0), memoFlags = new Uint8Array(0);
function growSlab() {
    const rows = Math.min(MAX_VALUE_MEMO, Math.max(1024, memoFlags.length * 2));
    const numbers = new Float64Array(rows * ROW_NUMBERS), flags = new Uint8Array(rows);
    numbers.set(memoNumbers);
    flags.set(memoFlags);
    memoNumbers = numbers;
    memoFlags = flags;
}
function storeRow(slot, row) {
    if (slot >= memoFlags.length) growSlab();
    if (!row) { memoFlags[slot] = NO_ROW; return; }
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    n[at] = row.kills; n[at + 1] = row.deaths; n[at + 2] = row.exp; n[at + 3] = row.sp; n[at + ADENA] = row.adena;
    n[at + 5] = row.dropLoot; n[at + 6] = row.spoilLoot; n[at + LOOT] = row.loot; n[at + SHOTS] = row.shots;
    n[at + POTIONS] = row.potions; n[at + 10] = row.stacks ?? 0; n[at + 11] = row.busyShare;
    n[at + PRODUCTION] = row.production ?? NaN;
    memoFlags[slot] = (row.stacks === null ? NO_STACKS : 0) | (row.rewardSource === 'npc_rewards' ? 0 : NO_REWARDS);
}
// A fresh row of computeValue's shape and key order, or null.
function rowAt(slot) {
    const flags = memoFlags[slot];
    if (flags & NO_ROW) return null;
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    return { kills: n[at], deaths: n[at + 1], exp: n[at + 2], sp: n[at + 3], adena: n[at + ADENA], dropLoot: n[at + 5],
        spoilLoot: n[at + 6], loot: n[at + LOOT], rewardSource: flags & NO_REWARDS ? 'unavailable' : 'npc_rewards',
        shots: n[at + SHOTS], potions: n[at + POTIONS], stacks: flags & NO_STACKS ? null : n[at + 10], busyShare: n[at + 11],
        production: Number.isNaN(n[at + PRODUCTION]) ? null : n[at + PRODUCTION] };
}
let valueMemoTable = null, valueMemoRates = null;
function refreshValueMemo(t, rates) {
    if (t !== valueMemoTable || rates !== valueMemoRates) {
        countReset(valueMemo.size);
        clearValueMemo();
        valueMemoTable = t;
        valueMemoRates = rates;
    }
}
function clearIncomeBases() { incomeBases.clear(); incomeBaseCells = 0; }

// A curve with no value at a gap (no curve spot hunts there) takes the
// nearest higher gap's value, else the nearest lower one.
function filled(values, neutral) {
    const out = values.slice();
    for (let i = 0; i < out.length; i++) {
        if (out[i] !== null) continue;
        let j = i + 1;
        while (j < out.length && values[j] === null) j++;
        if (j < out.length) { out[i] = values[j]; continue; }
        j = i - 1;
        while (j >= 0 && values[j] === null) j--;
        out[i] = j >= 0 ? values[j] : neutral;
    }
    return out;
}

function roleSlot(t, role) {
    return t.roleIndex.get(typeof role === 'string' ? role : `${role}`);
}

// A spot's index in the table, by its own id or by the id of a cell piece it
// took in (SpotIndex.spotById over the server's catalogue: a spotId saved
// before the cut names the spot that holds its field now), or undefined.
function spotSlot(t, spotId) {
    const key = typeof spotId === 'string' ? spotId : `${spotId}`;
    const own = t.spotIndex.get(key);
    if (own !== undefined) return own;
    const named = SpotIndex.spotById(spotSource() || EMPTY_SPOTS, key)?.id;
    return named === undefined ? undefined : t.spotIndex.get(String(named));
}

// The table key of a bot. A table by class lines (header roleLines, user
// 10-29): its class's line (a third class its second's; a base or first
// class the line of its role's alias when that line holds the class, else
// the first line that does; a split-kit first class its future second
// class's line, user 10-30). An older table by roles: BotRoles.tableRoleFor.
function roleFor(state = {}) {
    const role = BotRoles.tableRoleFor(state);
    const inputs = load().header.inputs;
    if (!inputs.roleLines) return role;
    const classId = state.stats?.classId ?? state.classId ?? null;
    const future = BotRoles.kitClassId({ classId, characterId: state.characterId });
    return lineOf(inputs, future ?? BotRoles.roleClassId(classId), role);
}

function lineOf(inputs, classId, role) {
    if (!Number.isInteger(classId)) return role;
    if (inputs.roleClasses[classId]) return String(classId);
    const own = inputs.roleLines[role];
    if (own && inputs.roleClasses[own]?.includes(classId)) return own;
    return load().roles.find((line) => inputs.roleClasses[line]?.includes(classId)) || role;
}

// A row's shots state: 0 none, 1 the weapon's shots (true), 2 Blessed
// Spiritshot (the generator's SHOTS; a table before it has no 2).
function shotKey(shots) {
    return shots === 2 ? 2 : shots ? 1 : 0;
}

function load() {
    if (table) return table;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const field = (fields, name) => {
        const index = fields.indexOf(name);
        if (index < 0) throw new Error(`spot table: missing field ${name}`);
        return index;
    };
    const roleIndex = new Map(raw.roles.map((role, index) => [role, index]));
    // A table by class lines answers a role name by its alias line.
    for (const [alias, line] of Object.entries(raw.header.inputs?.roleLines || {})) {
        if (roleIndex.has(line)) roleIndex.set(alias, roleIndex.get(line));
    }
    const spotIndex = new Map(raw.spots.map((spot, index) => [String(spot[0]), index]));
    // A role without any measured curve keeps its rows' values at every gap.
    const neutral = Object.fromEntries(raw.curveFields.map((name) => [name, raw.gaps.map(() => (name === 'deaths' ? 0 : 1))]));
    const maxBand = Math.max(0, ...raw.spots.map((spot) => Math.floor(spot[1] / raw.header.inputs.bandLevels)));
    // curves[role][band]: every band takes its own curve, else the nearest
    // measured band of the role, lower first.
    const curves = raw.roles.map((role) => {
        const measured = raw.curves[role] || {};
        const byBand = new Map(Object.entries(measured).map(([band, curve]) => [Number(band), Object.fromEntries(
            raw.curveFields.map((name) => [name, filled(curve[name], name === 'deaths' ? 0 : 1)]))]));
        const out = [];
        for (let band = 0; band <= maxBand; band++) {
            let curve = null;
            for (let distance = 0; !curve && distance <= maxBand + 1; distance++) {
                curve = byBand.get(band - distance) || byBand.get(band + distance) || null;
            }
            out.push(curve || neutral);
        }
        return out;
    });
    table = {
        header: raw.header,
        roles: raw.roles,
        roleIndex,
        spotIndex,
        spots: raw.spots,
        rows: raw.rows,
        curves,
        kitSurface: raw.kitSurface || null,
        maxBand,
        gaps: raw.gaps,
        shotsIndex: new Map(raw.shots.map((shots, index) => [shotKey(shots), index])),
        bandLevels: raw.header.inputs.bandLevels,
        maxLevel: raw.header.inputs.maxLevel,
        f: {
            minGap: field(raw.rowFields, 'minGap'), refGap: field(raw.rowFields, 'refGap'), kph: field(raw.rowFields, 'kph'),
            busy: field(raw.rowFields, 'busy'), deaths: field(raw.rowFields, 'deaths'), exp: field(raw.rowFields, 'exp'),
            sp: field(raw.rowFields, 'sp'), adena: field(raw.rowFields, 'adena'), loot: field(raw.rowFields, 'loot'),
            shots: field(raw.rowFields, 'shots'), potions: field(raw.rowFields, 'potions'),
            stacks: raw.rowFields.indexOf('stacks'),
            // The hunt cycle columns (cycle); a table before them has none.
            fight: raw.rowFields.indexOf('fight'), rest: raw.rowFields.indexOf('rest'), taken: raw.rowFields.indexOf('taken'),
            spellTaken: raw.rowFields.indexOf('spellTaken'),
            // Per-mob rows (pull, cap, mix); a table before them counts fights.
            pull: raw.rowFields.indexOf('pull'), cap: raw.rowFields.indexOf('cap'), mix: raw.rowFields.indexOf('mix'),
            // The gate per curve gap (cap and admitted mix); a table before it reads the reference's.
            gate: raw.rowFields.indexOf('gate'),
            hpLost: raw.rowFields.indexOf('hpLost'), mpLost: raw.rowFields.indexOf('mpLost')
        }
    };
    return table;
}

// A curve's value at any gap: linear between the measured gaps, flat beyond.
function at(values, gaps, gap) {
    if (gap <= gaps[0]) return values[0];
    const last = gaps.length - 1;
    if (gap >= gaps[last]) return values[last];
    const step = gaps[1] - gaps[0];
    const index = Math.floor((gap - gaps[0]) / step);
    const share = (gap - gaps[index]) / step;
    return values[index] + (values[index + 1] - values[index]) * share;
}

// Loot does not grow in proportion to the drop rate (a group stops at 100%
// and then drops one item): the spot keeps its loot at drop rate 10 and 50
// over rate x its loot at rate 1; other rates take the log-linear blend.
function lootRateFactor(spot, dropRate) {
    const [, , , , , at10, at50] = spot;
    if (!(dropRate > 1)) return 1;
    if (dropRate <= 10) return 1 + (at10 - 1) * Math.log10(dropRate);
    if (dropRate <= 50) return at10 + (at50 - at10) * Math.log(dropRate / 10) / Math.log(5);
    return at50;
}

const expGapFactor = require('../../Progression/MobExperience').gapFactor;
const NpcIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');

// What one hour of solo hunting gives: kills, deaths, exp, SP, adena, loot at
// the NPC buy-back, shots and potions used, and the share of the hour spent in
// combat and recovery (the bots' own records count only that share), and the
// mobs per hour the spawns it may fight give back (production: what a crowd
// of hunters shares, huntShare; null without production data). Null when the
// spot or role is unknown or the bot finds no target it may fight alone there
// at this level. spotId: a spot's own id or a piece's it took in (spotSlot).
function value(spotId, role, level, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    // Callers own the result: a fresh row.
    return rowAt(memoValue(t, rates, spotId, role, level, shots, skill));
}

// The memo key: one small integer for a known spot, role, an integer level
// and spoil skill (no string per call); any other argument set keeps the
// five-part string. Each part is read as its string, as the string key reads
// it ("5" and 5 share one row), so both forms name the same rows: one Map,
// the same entries and the same oldest-first eviction. Levels below 128
// (80 is the top) and Spoil levels below 32 keep the key of 31 class lines
// over ~1600 spots under MEMO_MAX_KEY.
const MEMO_LEVELS = 128, MEMO_SKILLS = 32, MEMO_MAX_KEY = 2 ** 30;
function memoPart(value, limit) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < limit ? value : -1;
    const text = `${value}`, number = Number(text);
    return Number.isInteger(number) && number >= 0 && number < limit && `${number}` === text ? number : -1;
}
function memoKey(t, spotId, role, level, shots, skill) {
    const s = spotSlot(t, spotId);
    const r = roleSlot(t, role);
    const l = memoPart(level, MEMO_LEVELS), k = memoPart(skill, MEMO_SKILLS);
    if (s !== undefined && r !== undefined && l >= 0 && k >= 0) {
        const key = (((s * t.roles.length + r) * 3 + shotKey(shots)) * MEMO_LEVELS + l) * MEMO_SKILLS + k;
        if (key < MEMO_MAX_KEY) return key;
    }
    return `${spotId}\u0000${role}\u0000${level}\u0000${shotKey(shots)}\u0000${skill}`;
}
// The slot of the argument set's row; valid until the next memoValue call.
// known: as computeValue's.
function memoValue(t, rates, spotId, role, level, shots, skill, known = undefined) {
    const key = memoKey(t, spotId, role, level, shots, skill);
    let slot = valueMemo.get(key);
    if (slot === undefined) {
        DiagnosticConfig.developerDiagnostics && (stats.memoMisses += 1);
        const row = computeValue(t, rates, spotId, role, level, shots, skill, known);
        slot = valueMemoTail;
        valueMemoTail = (valueMemoTail + 1) % MAX_VALUE_MEMO;
        const dropped = valueMemoOrder[slot];
        if (dropped !== undefined && valueMemo.delete(dropped)) DiagnosticConfig.developerDiagnostics && (stats.memoEvictions += 1);
        valueMemoOrder[slot] = key;
        storeRow(slot, row);
        valueMemo.set(key, slot);
    } else DiagnosticConfig.developerDiagnostics && (stats.memoHits += 1);
    return slot;
}

// A row's measured kills by species ([selfId, share, ...]), or null for a
// table before the mix.
function rowMix(t, row) {
    const mix = t.f.mix < 0 ? null : row?.[t.f.mix];
    return Array.isArray(mix) && mix.length ? mix : null;
}

// A row's gate at a bot's level gap (the generator's gapGate, measured at the
// curve gaps; combat reads it at or above the row's minGap): { cap, mask } at
// the nearest gap at or below it, mask the bits of the mix species the bot
// may fight alone there; null when it may fight none; undefined for a table
// before the gate (the reference's cap and mix).
function gateAt(t, row, gap) {
    const gate = t.f.gate < 0 ? null : row?.[t.f.gate];
    if (!Array.isArray(gate)) return undefined;
    let i = t.gaps.length - 1;
    while (i > 0 && t.gaps[i] > gap) i--;
    // Between a closed gap and an open one, the row's own minGap already
    // says the bot hunts: the open one's.
    let value = Number(gate[i]) || 0;
    if (!value && gap > t.gaps[i] && i + 1 < t.gaps.length) value = Number(gate[i + 1]) || 0;
    return value > 0 ? { cap: Math.floor(value / 256), mask: value % 256 } : null;
}
const ALL_SPECIES = 255;

// The spot a row's kills are priced on (Rewards): the species its bot killed
// in their measured shares (an entry's count is its share: the kill draw
// weighs by count), else the spot's spawns. One per row, so the reward
// memos hold it. User 10-29: a bot kills only what it may fight alone, so a
// spot's other mobs neither pay nor set the level gap.
// mask: the species of the mix the bot may fight at its gap (gateAt). Only
// the measured species the spot spawns in this period count (a live spot of
// other spawns than the table's prices by its own spawns).
const killSpots = new WeakMap();
function killSpot(t, row, spotId, mask = ALL_SPECIES) {
    const base = rewardSpot(spotId), mix = rowMix(t, row);
    if (!mix || !base) return base;
    let byMask = killSpots.get(row);
    if (!byMask) killSpots.set(row, byMask = new Map());
    // Keyed by the live spot too: its spawns of the period decide which of
    // the measured species are there now.
    const key = `${mask}|${base.npcEntries?.length || 0}`;
    let held = byMask.get(key);
    if (!held || held.base !== base) {
        const present = new Set((base.npcEntries || []).map(entry => Number(entry.selfId)));
        const npcEntries = [];
        for (let at = 0; at < mix.length; at += 2) {
            if (!(mask & (1 << (at / 2))) || !present.has(Number(mix[at]))) continue;
            npcEntries.push({ selfId: mix[at], count: Math.max(1, Math.round(mix[at + 1] * 1000)) });
        }
        held = { base, spot: npcEntries.length ? { ...base, npcEntries, npcSelfIds: undefined } : base };
        byMask.set(key, held);
    }
    return held.spot;
}

// The mobs per hour the spawns of the species a bot may fight at its gap
// give back (their respawns), every spawn of them whole (gapProduction takes
// the admitted part of it). mask as killSpot's; null without production data
// (an offline spot).
const productions = new WeakMap();
function productionCap(t, row, spotId, mask = ALL_SPECIES) {
    const base = rewardSpot(spotId);
    if (!base?.npcEntries?.length) return null;
    let byMask = productions.get(row);
    if (!byMask) productions.set(row, byMask = new Map());
    const key = `${mask}|${base.npcEntries.length}`;
    let held = byMask.get(key);
    if (!held || held.base !== base) {
        const mix = rowMix(t, row), species = mix ? new Set() : null;
        for (let at = 0; mix && at < mix.length; at += 2) if (mask & (1 << (at / 2))) species.add(Number(mix[at]));
        let rows = 0, cap = 0;
        for (const entry of base.npcEntries) {
            if (!Number.isFinite(entry.production)) continue;
            rows += 1;
            if (!species || species.has(Number(entry.selfId))) cap += entry.production;
        }
        held = { base, cap: rows && cap > 0 ? cap : null };
        byMask.set(key, held);
    }
    return held.cap;
}

// The mobs per hour a bot may take of a spot's spawns at its gap (E69, the
// one owner of the rule): the production of the species it may fight
// (productionCap) times the part of it it may fight, as
// BackgroundResolver.soloShareMobs counts each spawn group's production times
// its admitted share. gate: gateAt's; its share, the admitted part, is 1
// where the table does not measure it. Today's tables do not (the field is on
// branch t106dev-spots, T128): a pack species taken in some pulls only counts
// whole here, while the fight counts its admitted share. Null without
// production data.
function gapProduction(t, row, spotId, gate) {
    const spawns = productionCap(t, row, spotId, gate?.mask ?? ALL_SPECIES);
    return spawns === null ? null : spawns * (gate?.share ?? 1);
}

// The exp level-gap factor of a row's kills for a bot of level: the
// species' own factors (MobExperience) in their measured shares, else the
// spot's mean level's.
const mixLevels = new WeakMap();
function killGapFactor(t, row, level, spotLevel, mask = ALL_SPECIES) {
    const mix = rowMix(t, row);
    if (!mix) return expGapFactor(level - spotLevel);
    let levels = mixLevels.get(row);
    if (!levels) {
        levels = [];
        for (let at = 0; at < mix.length; at += 2)
            levels.push(Number(NpcIndex.find(DataCache.npcs, mix[at])?.template?.level) || spotLevel);
        mixLevels.set(row, levels);
    }
    let factor = 0, weight = 0;
    for (let at = 0; at < mix.length; at += 2) {
        if (!(mask & (1 << (at / 2)))) continue;
        factor += mix[at + 1] * expGapFactor(level - levels[at / 2]);
        weight += mix[at + 1];
    }
    return weight > 0 ? factor / weight : expGapFactor(level - spotLevel);
}

// A row's kills per hour at the bot's gap with the walk of that gap: the
// row measured the walk to its reference's admitted spawns (a cap is 3600 /
// the walk per mob, BackgroundResolver.soloWalkMs); the bot of the gap walks
// to its own (T106). Without a gate, the kills as measured.
function walked(t, row, refGap, gate, kills) {
    const reference = gate && gateAt(t, row, refGap);
    if (!reference || !(kills > 0) || !(gate.cap > 0) || !(reference.cap > 0)) return kills;
    return 3600 / (3600 / kills + 3600 / gate.cap - 3600 / reference.cap);
}

// The mobs per hour a row's kills may reach: its cap at the bot's gap (gate),
// else its own at the reference (the spawns its bot may fight), else the
// spot's for every monster.
function rowCap(t, row, spot, gate) {
    return gate ? gate.cap : t.f.cap >= 0 ? row[t.f.cap] : spot[3] * spot[4];
}

// The table-only part of a spot's hour (no rewards): the measured row, the level curve and the kills, or
// null when the bot finds no target it may fight alone there at this level. s, r: the spot's and role's
// table indexes.
function combat(t, s, r, level, shots) {
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(shotKey(shots))];
    if (!row) return null;
    const spot = t.spots[s], spotLevel = spot[1];
    const botLevel = Math.min(t.maxLevel, Number(level));
    const gap = botLevel - spotLevel;
    if (!(gap >= row[t.f.minGap])) return null;
    // Spots down to the first deep-blue level only (user 10-29: below it the
    // C4 drop falls to 30% and less).
    if (gap > ProgressionRates.DEEP_BLUE_LEVEL_GAP) return null;
    const gate = gateAt(t, row, gap);
    if (gate === null) return null;
    const mask = gate?.mask ?? ALL_SPECIES;
    const curve = t.curves[r][Math.floor(spotLevel / t.bandLevels)];
    const refGap = row[t.f.refGap];
    const measured = row[t.f.kph] * ratio(curve.kph, t.gaps, refGap, gap);
    const production = gapProduction(t, row, spot[0], gate);
    const cap = Math.min(rowCap(t, row, spot, gate), production ?? Infinity);
    const kills = Math.min(walked(t, row, refGap, gate, measured), cap);
    if (!(kills > 0)) return null;
    return { row, curve, gap, refGap, kills, cap, production, gate, mask, expRatio: ratio(curve.exp, t.gaps, refGap, gap),
        busyRatio: ratio(curve.busy, t.gaps, refGap, gap), gapFactor: killGapFactor(t, row, botLevel, spotLevel, mask) };
}
// A curve's value at the bot's gap over its value at the row's reference gap.
function ratio(values, gaps, refGap, gap) {
    const reference = at(values, gaps, refGap);
    return reference > 0 ? at(values, gaps, gap) / reference : 1;
}
// Exp of the hour: kills x the row's exp per kill at the bot's gap x the exp rate.
function hourExp(t, rates, c) {
    return c.kills * (c.row[t.f.exp] * c.expRatio * c.gapFactor) * rates.exp;
}

// known: the spot's combat() for these arguments when the caller read it.
function computeValue(t, rates, spotId, role, level, shots, skill = roleSpoilLevel(role, level), known = undefined) {
    const s = spotSlot(t, spotId);
    const r = roleSlot(t, role);
    if (s === undefined || r === undefined) return null;
    const c = known === undefined ? combat(t, s, r, level, shots) : known;
    if (!c) return null;
    spotId = t.spots[s][0];
    const { row, curve, gap, refGap, kills, expRatio, busyRatio, gapFactor, mask } = c;
    // Combat remains an offline measurement. Money comes from the native
    // reward groups at each defeated NPC's level and the current rates.
    // Keep the original multiplication order and return a fresh result.
    const lootFactor = lootRateFactor(t.spots[s], rates.drop);
    const rewards = Rewards.value(killSpot(t, row, spotId, mask), Math.min(t.maxLevel, Number(level)), { spoilSkillLevel: skill });
    const busy = row[t.f.busy] * busyRatio;
    return {
        kills,
        deaths: kills * Math.max(0, row[t.f.deaths] + at(curve.deaths, t.gaps, gap) - at(curve.deaths, t.gaps, refGap)),
        exp: hourExp(t, rates, c),
        sp: kills * row[t.f.sp] * expRatio * gapFactor * rates.sp,
        adena: kills * (rewards?.adena || 0),
        dropLoot: kills * (rewards?.drop || 0),
        spoilLoot: kills * (rewards?.spoil || 0),
        loot: kills * ((rewards?.drop || 0) + (rewards?.spoil || 0)),
        rewardSource: rewards ? 'npc_rewards' : 'unavailable',
        shots: kills * row[t.f.shots] * busyRatio,
        potions: kills * row[t.f.potions] * busyRatio,
        stacks: t.f.stacks < 0 || row[t.f.stacks] === null ? null
            : kills * row[t.f.stacks] * lootFactor,
        busyShare: Math.min(1, kills * busy / 3600),
        production: c.production
    };
}

// One kill of the reference bot (the role's class in the author's kit) at the
// spot for the role at the level, the hunt cycle model's input (HuntCycle):
// fight and rest seconds, the mob's damage before heals (taken; spellTaken
// its part from spells, 0 in a table before the column), the HP and
// MP it ends short (hpLost, mpLost), deaths, money (adena and loot at the NPC
// buy-back), shots and potions per kill, all at the bot's level gap (the
// curves; HP lost follows taken, MP lost the fight); kph the kills per hour
// at the bot's gap (value()'s), cap the spot's, pull the monsters per pull; the kills'
// mean accuracy and evasion. Null where value() has no row or the table has
// no cycle columns.
// The mobs per hour the spawns a bot of role and level may fight on a spot
// give back (value()'s production, from the value memo), or null (no row, no
// production data): the whole a crowd of hunters shares (huntShare).
function production(spotId, role, level, shots = true) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const slot = memoValue(t, rates, spotId, role, level, shots, roleSpoilLevel(role, level));
    const held = memoFlags[slot] & NO_ROW ? NaN : memoNumbers[slot * ROW_NUMBERS + PRODUCTION];
    return Number.isNaN(held) ? null : held;
}

// The share of its row's kills one of `hunters` bots on a spot keeps: the
// mobs per hour the spawns it may fight give back (production, value()'s)
// over the hunters, over its kills (an hour's), at most 1; 1 without
// production data. The one share rule of a spot's value: the live crowd
// (SpotEconomics) and the full spot of the ranking (fullShare).
function huntShare(production, hunters, kills) {
    return production > 0 && kills > 0 && hunters > 0 ? Math.min(1, production / hunters / kills) : 1;
}

function cycle(spotId, role, level, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const s = spotSlot(t, spotId), r = roleSlot(t, role);
    if (s === undefined || r === undefined || t.f.fight < 0) return null;
    const c = combat(t, s, r, level, shots);
    if (!c) return null;
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const slot = memoValue(t, rates, spotId, role, level, shots, skill);
    if (memoFlags[slot] & NO_ROW) return null;
    const n = memoNumbers, at = slot * ROW_NUMBERS, kills = n[at];
    const { row, curve, gap, refGap } = c, f = t.f, spot = t.spots[s];
    const fight = ratio(curve.fight, t.gaps, refGap, gap), taken = ratio(curve.taken, t.gaps, refGap, gap);
    // kph: the hour's kills, value()'s (combat: the walk at the bot's gap, at
    // most the cap); cap: the spawns' and their production's (T127 D3).
    return { spotId: spot[0], kph: kills, cap: c.cap, pull: 1,
        fight: row[f.fight] * fight, rest: row[f.rest] * ratio(curve.rest, t.gaps, refGap, gap),
        taken: row[f.taken] * taken, spellTaken: f.spellTaken < 0 ? 0 : row[f.spellTaken] * taken, hpLost: row[f.hpLost] * taken, mpLost: row[f.mpLost] * fight,
        deaths: n[at + 1] / kills, money: (n[at + ADENA] + n[at + LOOT]) / kills,
        shots: n[at + SHOTS] / kills, potions: n[at + POTIONS] / kills,
        mobAccur: Number(spot[7]) || 0, mobEvasion: Number(spot[8]) || 0 };
}

// The class the table measured a role with at a level (its header's
// roleClasses: below 20, 20-39, 40 and up; a role name its alias line's),
// or null for an unknown role.
function roleClass(role, level) {
    const classes = lineClasses(role);
    return classes ? classes[level < 20 ? 0 : level < 40 ? 1 : 2] : null;
}

// The second class a role's line is named by (its fights from 40), or null.
function lineClass(role) {
    return lineClasses(role)?.[2] ?? null;
}

function lineClasses(role) {
    const inputs = load().header.inputs, name = `${role}`;
    return inputs.roleClasses?.[name] || inputs.roleClasses?.[inputs.roleLines?.[name]];
}

// The level of a spot in the table (its monsters' average), or null.
function spotLevel(spotId) {
    const t = load();
    const s = spotSlot(t, spotId);
    return s === undefined ? null : t.spots[s][1];
}

// The level the table measured the spot at for the role: where the role
// hunts it in the author's combat.
function referenceLevel(spotId, role, shots = true) {
    const t = load();
    const s = spotSlot(t, spotId);
    const r = roleSlot(t, role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(shotKey(shots))];
    return row ? t.spots[s][1] + row[t.f.refGap] : null;
}

// Static role/level/shot result, shared by every bot of that role: the row
// of the most exp (or income: adena and loot) per hour a bot keeps on a spot
// full of the bots it has room for (fullShare, rankIncome's ranking), the
// row itself one bot's. Built once per game-data combination, never by
// walking the population.
function best(role, level, shots = true, metric = 'exp') {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        dropRows();
    }
    const key = `${role}:${level}:${shotKey(shots)}:${metric}`;
    if (bestRows.has(key)) { DiagnosticConfig.developerDiagnostics && (stats.bestHits += 1); return bestRows.get(key); }
    DiagnosticConfig.developerDiagnostics && (stats.bestMisses += 1);
    // The table's combat part of each spot is read once; exp needs no rewards,
    // so only the income metric prices every row, and only the winner's full
    // row is priced for exp. It bypasses the per-bot memo.
    const r = roleSlot(t, role);
    let bestIndex = -1, bestHeld = 0, bestRow = null;
    for (let s = 0; r !== undefined && s < t.spots.length; s++) {
        const c = combat(t, s, r, level, shots);
        if (!c) continue;
        const row = metric === 'income' ? computeValue(t, rates, t.spots[s][0], role, level, shots, undefined, c) : null;
        if (metric === 'income' && !row) continue;
        const held = (row ? row.adena + row.loot : hourExp(t, rates, c)) * fullShare(t, s, c, c.kills);
        if (bestIndex < 0 || held > bestHeld) { bestIndex = s; bestHeld = held; bestRow = row; }
    }
    const spotId = bestIndex < 0 ? null : t.spots[bestIndex][0];
    const result = bestIndex < 0 ? null : { ...(bestRow || computeValue(t, rates, spotId, role, level, shots)), spotId };
    bestRows.set(key, result);
    return result;
}
// The table and rates of one income read, the shared rows reset when either moved.
function incomeSource() {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        dropRows();
    }
    refreshValueMemo(t, rates);
    return { t, rates };
}
// A shared bounded shortlist keeps route reviews from scanning the atlas
// on every actor tick. Final safety, occupancy and travel remain actor facts.
function rankedIncome(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const key = `${role}:${level}:${costs.shots}:${costs.potions}:${minGap}:${shotKey(shots)}:${skill}`;
    if (incomeRows.has(key)) {
        DiagnosticConfig.developerDiagnostics && (stats.incomeHits += 1);
        const held = incomeRows.get(key);
        incomeRows.delete(key); incomeRows.set(key, held);
        return held;
    }
    DiagnosticConfig.developerDiagnostics && (stats.incomeMisses += 1);
    const ranked = rankIncome(t, rates, role, level, costs, minGap, shots, skill);
    const result = Object.freeze(ranked.map(({ index, income }) => {
        const spotId = t.spots[index][0];
        return Object.freeze({ ...rowAt(memoValue(t, rates, spotId, role, level, shots, skill)), income, spotId, useShots: shots });
    }));
    if (incomeRows.size >= 128) {
        incomeRows.delete(incomeRows.keys().next().value);
        DiagnosticConfig.developerDiagnostics && (stats.incomeEvictions += 1);
    }
    incomeRows.set(key, result);
    return result;
}
// The spot ids of rankedIncome's shortlist, in its order. For a caller that
// prices consumables with the bot's own beliefs: those prices are no key of
// the shared shortlist (every bot would add its own row and evict the shared
// game-data rows), and only the ids are read, so no row objects are built.
function rankedSpotIds(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    DiagnosticConfig.developerDiagnostics && (stats.spotIdRanks += 1);
    return rankIncome(t, rates, role, level, costs, minGap, shots, skill).map(({ index }) => t.spots[index][0]);
}
// The positive incomes of the role/level band at these consumable prices,
// best first, ties to the spot whose level is closest to the bot's, then by
// spot id; the first 64: [{ index, income }]. Best by what one bot gets on
// the spot when it holds all the bots it has room for (T123, user 10-30:
// a spot ranks by what it gives with the bots it holds, not one bot's
// kills): the row's kills at most the production of its spawns over that
// room (fullShare); `income` stays the one bot's row. One basis per role and level
// spans the widest band any reader asks (BASIS_MIN_GAP, the income route's);
// a narrower minGap filters its rows, so the readers share one basis.
const BASIS_MIN_GAP = -15;
function rankIncome(t, rates, role, level, costs, minGap, shots, skill) {
    const basisGap = Math.min(minGap, BASIS_MIN_GAP);
    const basisKey = `${role}:${level}:${basisGap}:${shotKey(shots)}:${skill}`;
    let basis = incomeBases.get(basisKey);
    if (basis) {
        incomeBases.delete(basisKey); incomeBases.set(basisKey, basis);
    } else {
        // Keep only the scalars needed to price a band. Retaining full value
        // objects here duplicated the point memo and evicted active bands
        // after 32768 cells, forcing the atlas to be measured again per bot.
        const indexes = new Uint32Array(t.spots.length);
        const values = new Float64Array(t.spots.length * 3);
        const shares = new Float64Array(t.spots.length);
        let count = 0;
        const r = roleSlot(t, role);
        for (let index = 0; r !== undefined && index < t.spots.length; index++) {
            const spot = t.spots[index];
            if (spot[1] - level < basisGap || spot[1] - level > 8) continue;
            // One combat read per spot: the row's (on a memo miss) and its share's.
            const c = combat(t, index, r, level, shots);
            if (!c) continue;
            const slot = memoValue(t, rates, spot[0], role, level, shots, skill, c);
            if (memoFlags[slot] & NO_ROW) continue;
            const at = slot * ROW_NUMBERS;
            indexes[count] = index;
            values[count * 3] = memoNumbers[at + ADENA] + memoNumbers[at + LOOT];
            values[count * 3 + 1] = memoNumbers[at + SHOTS];
            values[count * 3 + 2] = memoNumbers[at + POTIONS];
            shares[count] = fullShare(t, index, c, memoNumbers[at]);
            count++;
        }
        basis = { indexes: indexes.slice(0, count), values: values.slice(0, count * 3), shares: shares.slice(0, count) };
        while (incomeBases.size && (incomeBases.size >= 256 || incomeBaseCells + count > MAX_INCOME_BASE_CELLS)) {
            const oldest = incomeBases.keys().next().value;
            incomeBaseCells -= incomeBases.get(oldest).indexes.length;
            incomeBases.delete(oldest);
            DiagnosticConfig.developerDiagnostics && (stats.baseEvictions += 1);
        }
        if (count <= MAX_INCOME_BASE_CELLS) { incomeBases.set(basisKey, basis); incomeBaseCells += count; }
    }
    // New quotes price compact bands; only the selected spots need complete
    // combat/reward rows. Preserve every candidate, the exact prices and ties.
    const rows = [];
    for (let index = 0; index < basis.indexes.length; index++) {
        if (t.spots[basis.indexes[index]][1] - level < minGap) continue;
        const income = basis.values[index * 3] - basis.values[index * 3 + 1] * costs.shots
            - basis.values[index * 3 + 2] * costs.potions;
        if (income > 0) rows.push({ index: basis.indexes[index], income, held: income * basis.shares[index] });
    }
    rows.sort((a, b) => b.held - a.held
        || Math.abs(t.spots[a.index][1] - level) - Math.abs(t.spots[b.index][1] - level)
        || String(t.spots[a.index][0]).localeCompare(String(t.spots[b.index][0])));
    return rows.slice(0, 64);
}
// The share of its row's kills one bot keeps on a spot full of hunters
// (huntShare): the bots the spot has room for (LevelingRoutes.roomForSpot,
// the room check at arrival). c: the spot's combat() for the bot. The live
// hunters on a spot crowd a bot's own value (SpotEconomics.create, crowded).
function fullShare(t, s, c, kills) {
    if (!(c.production > 0 && kills > 0)) return 1;
    const spot = SpotIndex.spotById(rewardSpots, t.spots[s][0]) || { density: t.spots[s][2] };
    return huntShare(c.production, (LevelingRoutes ||= invoke('GameServer/Bot/AI/LevelingRoutes')).roomForSpot(spot), kills); // lazy: cycle LevelingRoutes' chain loads the combat profiles
}
let LevelingRoutes = null;

function roles() {
    return load().roles;
}

// The kit surface of a table key at a level (user 10-29): { fight, taken }
// coefficients over HuntCycle.KIT_FEATURES, measured on its band's curve
// spots (the nearest measured band, lower first), or null (an older table, a
// band without enough fights).
function kitSurface(role, level) {
    const t = load(), byBand = t.kitSurface?.rows?.[`${role}`] || t.kitSurface?.rows?.[t.header.inputs.roleLines?.[role]];
    if (!byBand) return null;
    const want = Math.floor(Number(level) / t.bandLevels);
    for (let distance = 0; distance <= t.maxBand + 1; distance++) {
        const row = byBand[want - distance] || byBand[want + distance];
        if (row) return { fight: row[0], taken: row[1] };
    }
    return null;
}

// The table's revision as of now. The spot catalog is checked at once; rates and rewards are seen at the
// table's own next read (rates are a restart input; the clan worker's rate switch comes with its NPC snapshot).
function revision() {
    if (catalogMoved(spotSource() || EMPTY_SPOTS)) incomeSource();
    return tableRevision;
}

// Tests: read another file, or the default one again.
function useFile(next = DEFAULT_FILE) {
    file = next;
    table = null;
    tableRevision++;
    bestRows.clear();
    clearValueMemo();
    clearIncomeBases();
}

module.exports = { value, cycle, production, huntShare, geodataProfile, kitSurface, roleClass, lineClass, roleFor, roleSpoilLevel, spotLevel, referenceLevel, roles, revision, best, rankedIncome, rankedSpotIds, useFile, useSpots, expGapFactor, cacheStats, DEFAULT_FILE };

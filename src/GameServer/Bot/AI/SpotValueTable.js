const fs = require('fs');
const path = require('path');
const ProgressionRates = invoke('GameServer/ProgressionRates');

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
// applied here (loot with the spot's measured response to the drop rate).
const DEFAULT_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-table.json');

let table = null;
let file = DEFAULT_FILE;
const bestRows = new Map();
const incomeRows = new Map();
let incomeTable, incomeRates;
// value() is a pure function of the table, the rate profile and its four
// arguments; every bot of a role and level asks the same spots. One bounded
// answer per argument set, dropped when the table or the profile changes
// (ProgressionRates keeps one profile object while the rates are equal).
const MAX_VALUE_MEMO = 32768;
const valueMemo = new Map();
let valueMemoTable = null, valueMemoRates = null;

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

function load() {
    if (table) return table;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const field = (fields, name) => {
        const index = fields.indexOf(name);
        if (index < 0) throw new Error(`spot table: missing field ${name}`);
        return index;
    };
    const roleIndex = new Map(raw.roles.map((role, index) => [role, index]));
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
        gaps: raw.gaps,
        shotsIndex: new Map(raw.shots.map((shots, index) => [Boolean(shots), index])),
        bandLevels: raw.header.inputs.bandLevels,
        maxLevel: raw.header.inputs.maxLevel,
        f: {
            minGap: field(raw.rowFields, 'minGap'), refGap: field(raw.rowFields, 'refGap'), kph: field(raw.rowFields, 'kph'),
            busy: field(raw.rowFields, 'busy'), deaths: field(raw.rowFields, 'deaths'), exp: field(raw.rowFields, 'exp'),
            sp: field(raw.rowFields, 'sp'), adena: field(raw.rowFields, 'adena'), loot: field(raw.rowFields, 'loot'),
            shots: field(raw.rowFields, 'shots'), potions: field(raw.rowFields, 'potions'),
            stacks: raw.rowFields.indexOf('stacks')
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

// What one hour of solo hunting gives: kills, deaths, exp, SP, adena, loot at
// the NPC buy-back, shots and potions used, and the share of the hour spent in
// combat and recovery (the bots' own records count only that share). Null
// when the spot or role is unknown or the bot finds no target it may fight
// alone there at this level.
function value(spotId, role, level, shots = true) {
    const t = load(), rates = ProgressionRates.profile();
    if (t !== valueMemoTable || rates !== valueMemoRates) {
        valueMemo.clear();
        valueMemoTable = t;
        valueMemoRates = rates;
    }
    const key = `${spotId}\u0000${role}\u0000${level}\u0000${shots ? 1 : 0}`;
    let row = valueMemo.get(key);
    if (row === undefined) {
        row = computeValue(t, rates, spotId, role, level, shots);
        if (valueMemo.size >= MAX_VALUE_MEMO) valueMemo.delete(valueMemo.keys().next().value);
        valueMemo.set(key, row);
    }
    // Callers own the result: a copy, never the remembered row.
    return row && { ...row };
}

function computeValue(t, rates, spotId, role, level, shots) {
    const s = t.spotIndex.get(String(spotId));
    const r = t.roleIndex.get(role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(Boolean(shots))];
    if (!row) return null;
    const [, spotLevel, , spotCap, pull] = t.spots[s];
    const gap = Math.min(t.maxLevel, Number(level)) - spotLevel;
    if (!(gap >= row[t.f.minGap])) return null;
    const curve = t.curves[r][Math.floor(spotLevel / t.bandLevels)];
    const refGap = row[t.f.refGap];
    const ratio = (name) => {
        const reference = at(curve[name], t.gaps, refGap);
        return reference > 0 ? at(curve[name], t.gaps, gap) / reference : 1;
    };
    const kills = Math.min(row[t.f.kph] * ratio('kph'), spotCap) * pull;
    if (!(kills > 0)) return null;
    // One lookup has fixed curve/gap/rates: XP and SP share their ratio,
    // adena and loot share theirs, and combat/shots/potions share busy.
    // Keep the original multiplication order and return a fresh result.
    const expRatio = ratio('exp'), busyRatio = ratio('busy'), adenaRatio = ratio('adena');
    const gapFactor = expGapFactor(gap), lootFactor = lootRateFactor(t.spots[s], rates.drop);
    const exp = row[t.f.exp] * expRatio * gapFactor;
    const busy = row[t.f.busy] * busyRatio;
    return {
        kills,
        deaths: kills * Math.max(0, row[t.f.deaths] + at(curve.deaths, t.gaps, gap) - at(curve.deaths, t.gaps, refGap)),
        exp: kills * exp * rates.exp,
        sp: kills * row[t.f.sp] * expRatio * gapFactor * rates.sp,
        adena: kills * row[t.f.adena] * adenaRatio * rates.adena,
        // Loot follows the adena curve: same drop groups and deep-blue rule.
        loot: kills * row[t.f.loot] * adenaRatio * rates.drop * lootFactor,
        shots: kills * row[t.f.shots] * busyRatio,
        potions: kills * row[t.f.potions] * busyRatio,
        stacks: t.f.stacks < 0 || row[t.f.stacks] === null ? null
            : kills * row[t.f.stacks] * lootFactor,
        busyShare: Math.min(1, kills * busy / 3600)
    };
}

// The level of a spot in the table (its monsters' average), or null.
function spotLevel(spotId) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    return s === undefined ? null : t.spots[s][1];
}

// The level the table measured the spot at for the role: where the role
// hunts it in the author's combat.
function referenceLevel(spotId, role, shots = true) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    const r = t.roleIndex.get(role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(Boolean(shots))];
    return row ? t.spots[s][1] + row[t.f.refGap] : null;
}

// Static role/level/shot result, shared by every bot of that role. Built
// once per game-data combination, never by walking the population.
function best(role, level, shots = true, metric = 'exp') {
    const key = `${role}:${level}:${Boolean(shots)}:${metric}`;
    if (bestRows.has(key)) return bestRows.get(key);
    let bestRow = null;
    // A whole-table scan reads each spot once: it bypasses the per-bot memo.
    const t = load(), rates = ProgressionRates.profile();
    for (const spot of t.spots) {
        const row = computeValue(t, rates, spot[0], role, level, shots);
        if (row && (!bestRow || (metric === 'income' ? row.adena + row.loot > bestRow.adena + bestRow.loot : row.exp > bestRow.exp))) bestRow = { ...row, spotId: spot[0] };
    }
    bestRows.set(key, bestRow);
    return bestRow;
}
// A shared bounded shortlist keeps route reviews from scanning the atlas
// on every actor tick. Final safety, occupancy and travel remain actor facts.
function rankedIncome(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true) {
    const t = load(), rates = ProgressionRates.profile();
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        incomeRows.clear(); bestRows.clear(); valueMemo.clear();
        valueMemoTable = t; valueMemoRates = rates;
    }
    const key = `${role}:${level}:${costs.shots}:${costs.potions}:${minGap}:${Number(shots)}`;
    if (incomeRows.has(key)) return incomeRows.get(key);
    const rows = [];
    for (const spot of t.spots) {
        if (spot[1] - level < minGap || spot[1] - level > 8) continue;
        const row = computeValue(t, rates, spot[0], role, level, shots);
        if (!row) continue;
        const income = row.adena + row.loot - row.shots * costs.shots - row.potions * costs.potions;
        if (income > 0) rows.push({ ...row, income, spotId: spot[0], useShots: shots });
    }
    rows.sort((a, b) => b.income - a.income || String(a.spotId).localeCompare(String(b.spotId)));
    const result = Object.freeze(rows.slice(0, 64).map(Object.freeze));
    if (incomeRows.size >= 128) incomeRows.delete(incomeRows.keys().next().value);
    incomeRows.set(key, result);
    return result;
}
function roles() {
    return load().roles;
}

// Tests: read another file, or the default one again.
function useFile(next = DEFAULT_FILE) {
    file = next;
    table = null;
    bestRows.clear();
    valueMemo.clear();
}

module.exports = { value, spotLevel, referenceLevel, roles, best, rankedIncome, useFile, expGapFactor, DEFAULT_FILE };

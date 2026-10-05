const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Rates = invoke('GameServer/ProgressionRates');
const DataCache = invoke('GameServer/DataCache');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const MAX_SPOTS = 8;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Income grows steeply with level (zones and gear grades), about 2-4x from one
// band to the next and about 2x inside one: 10 levels keep a band's bots alike
// and still give each band of a full world a hundred or more samples.
const BAND_LEVELS = 10;
function signature(state, mode) {
    const inventory = state.inventory || {};
    const items = Array.isArray(inventory) ? inventory : Object.values(inventory);
    const equipped = items.filter(item => item.equipped || Number(item.equippedCount) > 0)
        .map(item => `${item.selfId}:${item.enchant || 0}`).sort();
    const level = levelOf(state);
    const grouped = mode ? ['party','duo','party_pve'].includes(mode)
        : !!state.party?.partyId || ['party','duo'].includes(state.stats?.routeMode) || state.activity==='grouped';
    // Pre-migration samples used gross rewards and cannot establish net profit.
    return ['net-xp-v1',Roles.classIdOf(state),level,grouped?'party':'solo',Rates.profile().exp,...equipped].join(':');
}
function levelOf(state) {
    return Number(state.fetchLevel?.() || state.level || state.stats?.level || 1);
}
// What the loot of a hunt is worth: adena dropped as an item at face value,
// every other item at the NPC buy price.
function lootValue(items = []) {
    let value = 0;
    for (const item of items) {
        const amount = Math.max(0, Number(item.amount || 0));
        if (Number(item.selfId) === 57) { value += amount; continue; }
        const price = Number(ItemTemplateIndex.find(DataCache.items, item.selfId)?.template?.price || 0);
        value += NpcSellRules.npcBuyPrice(price) * amount;
    }
    return value;
}
function record(state, { spotId, combatMs, recoveryMs = 0, exp = 0, adena = 0, loot = 0, kills = 0, timestamp = Date.now() }) {
    const key = signature(state);
    const prior = Array.isArray(state.stats?.huntEfficiency) ? state.stats.huntEfficiency : [];
    const kept = prior.filter(row => row.signature === key && timestamp >= row.at && timestamp-row.at < MAX_AGE_MS);
    const cycleMs = Math.max(0,Number(combatMs)) + Math.max(0,Number(recoveryMs));
    if (!spotId || !Number.isFinite(cycleMs) || cycleMs <= 0 || !Number.isFinite(exp)) return kept;
    const old = kept.find(row => row.spotId === spotId);
    // Rows saved before income was recorded start their income from this sample.
    const mix = (field,value) => old && Number.isFinite(old[field]) ? Number(old[field])*0.75+value*0.25 : value;
    const next = { spotId,signature:key,at:timestamp,samples:Math.min(32,(old?.samples||0)+1),
        exp:mix('exp',exp),cycleMs:mix('cycleMs',cycleMs),
        adena:mix('adena',Math.max(0,Number(adena)||0)),loot:mix('loot',Math.max(0,Number(loot)||0)),
        kills:mix('kills',Math.max(0,Number(kills)||0)),
        source:'cold_combat_and_estimated_recovery' };
    const rows = [next,...kept.filter(row=>row.spotId!==spotId)].slice(0,MAX_SPOTS);
    noteLevelBand(state, rows, timestamp);
    return rows;
}
function sampledRows(state, timestamp, mode) {
    const rows = state.stats?.huntEfficiency;
    if (!Array.isArray(rows) || !rows.length) return [];
    const key = signature(state,mode);
    return rows.filter(row => row.signature===key && row.samples>=3 && timestamp>=row.at && timestamp-row.at<MAX_AGE_MS
            && Number.isFinite(row.exp) && Number.isFinite(row.cycleMs) && row.cycleMs>0);
}
function scores(state, timestamp = Date.now(), mode) {
    const rows = sampledRows(state, timestamp, mode);
    const best = Math.max(0,...rows.map(row=>row.exp/row.cycleMs));
    if (!(best>0)) return new Map(rows.map(row=>[row.spotId,-40]));
    // A bounded preference leaves unknown spots available for exploration and
    // cannot override party/level/territory safety gates in LevelingRoutes.
    return new Map(rows.map(row=>[row.spotId,Math.round(Math.max(-40,Math.min(15,55*row.exp/row.cycleMs/best-40)))]));
}
// The best measured income among at most MAX_SPOTS rows: adena plus loot at
// the NPC buy price, per hour of the hunt cycle and per kill, and the exp per
// hour of that same row.
function bestIncome(rows) {
    let best = null;
    for (const row of rows) {
        if (!Number.isFinite(row.adena) || !Number.isFinite(row.loot) || !Number.isFinite(row.kills)) continue;
        const income = row.adena + row.loot;
        const perHour = income / row.cycleMs * HOUR_MS;
        if (best && perHour <= best.perHour) continue;
        best = { perHour, perKill: row.kills > 0 ? income / row.kills : 0, expPerHour: row.exp / row.cycleMs * HOUR_MS };
    }
    return best;
}

// The measured hour value of the sampled bots of each level band: the latest
// best income of each bot, the median read in O(1). New samples arrive on
// every cold commit, so a band is re-sorted at most once a minute after a new
// sample (a median over 6 hours of samples) or once its oldest sample expired.
// Each thread keeps its own table, fed by the samples it records or the cold
// commits it applies.
const BAND_RESORT_MS = 60 * 1000;
const bands = new Map();
function bandOf(level) {
    return Math.floor(Math.max(1, Number(level) || 1) / BAND_LEVELS);
}
function noteLevelBand(state, rows, timestamp) {
    const id = Number(state.characterId || 0);
    if (!id) return;
    const best = bestIncome(rows.filter(row => row.samples >= 3));
    if (!best) return;
    const band = bandOf(levelOf(state));
    if (!bands.has(band)) bands.set(band, { values: new Map(), median: null, changed: false });
    const entry = bands.get(band);
    entry.values.set(id, { ...best, at: timestamp });
    entry.changed = true;
}
// A cold commit applied on the main thread: its samples were recorded in the
// worker, where record() already kept only the rows of the bot's signature.
function observe(state, timestamp = Date.now()) {
    const rows = state?.stats?.huntEfficiency;
    if (!Array.isArray(rows) || !rows.length) return;
    noteLevelBand(state, rows.filter(row => timestamp >= row.at && timestamp - row.at < MAX_AGE_MS
        && Number(row.cycleMs) > 0), timestamp);
}
function bandMedian(band, timestamp) {
    const entry = bands.get(band);
    if (!entry) return null;
    const stale = !entry.median
        || timestamp - entry.median.oldestAt >= MAX_AGE_MS
        || (entry.changed && timestamp - entry.median.sortedAt >= BAND_RESORT_MS);
    if (stale) {
        entry.changed = false;
        const perHour = [], perKill = [], expPerHour = [];
        let oldestAt = Infinity;
        for (const [id, value] of entry.values) {
            if (timestamp - value.at >= MAX_AGE_MS) { entry.values.delete(id); continue; }
            perHour.push(value.perHour);
            perKill.push(value.perKill);
            expPerHour.push(value.expPerHour);
            oldestAt = Math.min(oldestAt, value.at);
        }
        if (!perHour.length) { entry.median = null; return null; }
        perHour.sort((a, b) => a - b);
        perKill.sort((a, b) => a - b);
        expPerHour.sort((a, b) => a - b);
        const middle = Math.floor(perHour.length / 2);
        entry.median = { perHour: perHour[middle], perKill: perKill[middle], expPerHour: expPerHour[middle],
            bots: perHour.length, oldestAt,
            sortedAt: timestamp };
    }
    return entry.median;
}
function levelBandValue(level, timestamp) {
    const own = bandOf(level);
    const median = bandMedian(own, timestamp);
    if (median) return median;
    // An empty band borrows the nearest measured one, lower first.
    for (let distance = 1; distance <= 10; distance += 1) {
        const near = bandMedian(own - distance, timestamp) || bandMedian(own + distance, timestamp);
        if (near) return near;
    }
    return null;
}
// What an hour of hunting is worth to this bot now: its own best measured
// income, else the measured median of its level band. Before any bot of the
// world has a sample, the planner's per-kill estimate at the author's six
// kills per ten minutes stands in. expPerHour is the exp per hour of the row
// that gave the income (the band's median of those), null when nothing is
// measured.
function hourValue(state, timestamp = Date.now(), mode) {
    const own = bestIncome(sampledRows(state, timestamp, mode));
    if (own) return { perHour: Math.round(own.perHour), perKill: Math.max(1, Math.round(own.perKill)),
        expPerHour: Math.round(own.expPerHour), source: 'own' };
    const level = levelOf(state);
    const band = levelBandValue(level, timestamp);
    if (band) return { perHour: Math.round(band.perHour), perKill: Math.max(1, Math.round(band.perKill)),
        expPerHour: Math.round(band.expPerHour), source: 'level_band' };
    const perKill = Math.max(20, level * 25);
    return { perHour: perKill * 36, perKill, expPerHour: null, source: 'default' };
}
function resetLevelBands() {
    bands.clear();
}
module.exports = { record, scores, signature, lootValue, hourValue, observe, resetLevelBands,
    BAND_LEVELS, MAX_SPOTS, MAX_AGE_MS };

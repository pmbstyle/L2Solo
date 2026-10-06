const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Rates = invoke('GameServer/ProgressionRates');
const DataCache = invoke('GameServer/DataCache');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const MAX_SPOTS = 8;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// The bot hunts in a party or alone: the author keeps the two apart.
function situationOf(state, mode) {
    const grouped = mode ? ['party','duo','party_pve'].includes(mode)
        : !!state.party?.partyId || ['party','duo'].includes(state.stats?.routeMode) || state.activity==='grouped';
    return grouped ? 'party' : 'solo';
}
function signature(state, mode) {
    const inventory = state.inventory || {};
    const items = Array.isArray(inventory) ? inventory : Object.values(inventory);
    const equipped = items.filter(item => item.equipped || Number(item.equippedCount) > 0)
        .map(item => `${item.selfId}:${item.enchant || 0}`).sort();
    const level = levelOf(state);
    // Pre-migration samples used gross rewards and cannot establish net profit.
    return ['net-xp-v1',Roles.classIdOf(state),level,situationOf(state,mode),Rates.profile().exp,...equipped].join(':');
}
// The situation a row was recorded in (the fourth part of its signature).
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
// One sample of a spot: cycleMs is the round's time on the spot, from its
// start to the next round (the fights, the rest, the wait between rounds).
function record(state, { spotId, cycleMs, exp = 0, adena = 0, loot = 0, kills = 0, timestamp = Date.now() }) {
    const key = signature(state);
    const prior = Array.isArray(state.stats?.huntEfficiency) ? state.stats.huntEfficiency : [];
    const kept = prior.filter(row => row.signature === key && timestamp >= row.at && timestamp-row.at < MAX_AGE_MS);
    cycleMs = Math.max(0,Number(cycleMs));
    if (!spotId || !Number.isFinite(cycleMs) || cycleMs <= 0 || !Number.isFinite(exp)) return kept;
    const old = kept.find(row => row.spotId === spotId);
    // Rows saved before income was recorded start their income from this sample.
    const mix = (field,value) => old && Number.isFinite(old[field]) ? Number(old[field])*0.75+value*0.25 : value;
    const next = { spotId,signature:key,at:timestamp,samples:Math.min(32,(old?.samples||0)+1),
        exp:mix('exp',exp),cycleMs:mix('cycleMs',cycleMs),
        adena:mix('adena',Math.max(0,Number(adena)||0)),loot:mix('loot',Math.max(0,Number(loot)||0)),
        kills:mix('kills',Math.max(0,Number(kills)||0)),
        source:'cold_round' };
    const rows = [next,...kept.filter(row=>row.spotId!==spotId)].slice(0,MAX_SPOTS);

    return rows;
}

const { SERVER_STARTED_AT } = require('../Population/Uptime');

// Time on the spot against all time (E36): the round time each record
// schedules against the uptime that really passed until the next record,
// two running sums that fade over the life of a row. A gap that spans a
// restart, or a stint near the player (hot: no record), starts anew: it
// counts neither way.
function nextClock(state, timestamp, cycleMs, startedAt) {
    const clock = state.stats?.huntClock;
    const at = Number(clock?.at || 0);
    let onSpot = Number(clock?.onSpot || 0);
    let total = Number(clock?.total || 0);
    const hotAt = Number(state.timing?.lastHotAt || 0);
    if (at > 0 && at >= startedAt && hotAt <= at && timestamp > at) {
        const elapsed = timestamp - at;
        const keep = Math.exp(-elapsed / MAX_AGE_MS);
        onSpot = onSpot * keep + Math.min(elapsed, Math.max(0, Number(clock.cycleMs || 0)));
        total = total * keep + elapsed;
    }
    return { at: timestamp, cycleMs: Math.round(cycleMs), onSpot: Math.round(onSpot), total: Math.round(total) };
}
function onSpotShare(state) {
    const clock = state?.stats?.huntClock;
    const total = Number(clock?.total || 0);
    if (!(total > 0)) return 1;
    return Math.max(0, Math.min(1, Number(clock.onSpot || 0) / total));
}

// The one record of a hunting round, solo or a party member's own share
// (prepareResolve): `exp` is the net exp the round gave the bot. The round
// lasts until the bot's next round. Returns the stats to merge, or {} for a
// result that was no hunting round.
function recordRound(state, result, { spotId, exp = 0, timestamp = Date.now(), startedAt = SERVER_STARTED_AT } = {}) {
    const debug = result?.debug || {};
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const life = Valuation.progressStats(state, { timestamp, startedAt, kills: debug.wins,
        losses: debug.deaths || (state.activity !== 'dead' && result.patch?.activity === 'dead' ? 1 : 0),
        lossHours: invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { timestamp }).deathHours, risky: !!state.stats?.pvpIntent,
        persona: invoke('GameServer/Bot/AI/BotPersona').of(state), knowledgeEnabled: Learning.knowledgeEnabled() });
    if (!(Number(debug.combatMs) > 0 || Number(debug.fights) > 0)) return life;
    const cycleMs = Math.max(0, Number(result.nextResolveAt || 0) - timestamp);
    const huntClock = nextClock(state, timestamp, cycleMs, startedAt);
    const items = result.materialize?.items || [];
    const huntEfficiency = record(state, {
        spotId: spotId || debug.spotId, cycleMs, exp, timestamp,
        adena: Number(result.materialize?.adena || 0), loot: lootValue(items), kills: Number(debug.wins || 0),
        share: onSpotShare({ stats: { huntClock } })
    });
    return { ...life, huntEfficiency, huntClock };
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
// `share` is the bot's time on the spot against all its time: the hour of
// a bot counts its trips, its town visits and its waits (E36).
function bestIncome(rows, share = 1) {
    let best = null;
    for (const row of rows) {
        if (!Number.isFinite(row.adena) || !Number.isFinite(row.loot) || !Number.isFinite(row.kills)) continue;
        const income = row.adena + row.loot;
        const perHour = income / row.cycleMs * HOUR_MS * share;
        if (best && perHour <= best.perHour) continue;
        best = { perHour, perKill: row.kills > 0 ? income / row.kills : 0, expPerHour: row.exp / row.cycleMs * HOUR_MS * share };
    }
    return best;
}

// No cohort median: a bot calibrates the common table only with its own
// samples. This base income is independent from the wish network, so price
// priors and providers cannot recurse through the common value of an hour.
function huntIncome(state, timestamp = Date.now(), mode) {
    const own = bestIncome(sampledRows(state, timestamp, mode), onSpotShare(state));
    if (own) return { ...own, source: 'own' };
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const role = state.party?.role || state.stats?.role || Roles.inferRole(state.stats?.classId || state.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    const current = state.spotId && Table.value(state.spotId, tableRole, levelOf(state), true);
    const progress = current || Table.best(tableRole, levelOf(state), true);
    const row = current?.adena + current?.loot > 0 ? current : Table.best(tableRole, levelOf(state), true, 'income');
    if (!row) return { perHour: 0, perKill: 0, expPerHour: 0, source: 'unavailable' };
    const income = row.adena + row.loot;
    return { perHour: income * onSpotShare(state), perKill: row.kills > 0 ? income / row.kills : 0,
        expPerHour: (progress?.exp || 0) * onSpotShare(state), source: 'table',
        spotId: row.spotId || state.spotId, progressSpotId: progress?.spotId || state.spotId };
}
function hourValue(state, timestamp = Date.now(), mode) {
    const context = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { timestamp, mode });
    return { perHour: context.hourAdena, perKill: context.hunt.perKill,
        expPerHour: context.hunt.expPerHour, source: 'wish_network' };
}
// Kept as lifecycle adapters for callers which accepted earlier samples.
function observe() {}
function resetLevelBands() {}
module.exports = { record, recordRound, scores, signature, situationOf, lootValue, hourValue, onSpotShare, observe,
    resetLevelBands, huntIncome, estimate: huntIncome, sampledRows, bestIncome, MAX_SPOTS, MAX_AGE_MS, SERVER_STARTED_AT };

'use strict';
const Uptime = require('../Population/Uptime');
const HOUR_MS = 3600000;
// The demand window is an hour of trade at x50 and stretches with the drop rate
// (RateScale.supplyScale): at x1 deals come about fifty times slower, so the
// same evidence takes fifty hours to gather. Our rule.
const windowMs = () => HOUR_MS / invoke('GameServer/Bot/Economy/RateScale').supplyScale();
// The receipts a start replays: the last 24 windows (a day at x50).
const replayMs = () => 24 * windowMs();
const history = new Map();
let mirror = null;
let townsByName;

// Public completed purchases, per item and town. No category rate,
// listing count, foreign bag or wallet is a source of customer demand.
function deal(id, quantity, town, timestamp, enchant = 0) {
    id = Number(id);
    townsByName ||= new Set(Object.values(require('../../World/TownRespawn').towns).map(row => row.name));
    if (!Number.isSafeInteger(id) || id <= 0 || id === 57 || !townsByName.has(town) || !Number.isSafeInteger(quantity) || quantity <= 0
        || !Number.isFinite(timestamp) || enchant !== 0) return null;
    let item = history.get(id);
    if (!item) history.set(id, item = { deals: 0, towns: new Map() });
    const previous = item.towns.get(town) || { units: 0, arrivals: 0, at: timestamp };
    const at = Math.max(previous.at, timestamp);
    const window = windowMs();
    const decay = Math.exp(-Uptime.between(previous.at, at) / window);
    const receiptDecay = Math.exp(-Uptime.between(timestamp, at) / window);
    item.towns.set(town, { units: previous.units * decay + quantity * receiptDecay,
        arrivals: previous.arrivals * decay + receiptDecay, at });
    item.deals++;
    return row(id, item);
}
function row(id, item) {
    const result = [`h:${id}`, item.deals];
    for (const [town, value] of item.towns) result.push(town, value.units, value.arrivals, value.at);
    return result;
}
function rows() { return [...history].map(([id, item]) => row(id, item)); }
function observed(id, timestamp) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || Number(id) === 57) return null;
    const value = mirror ? mirror().get(`h:${id}`) : history.has(Number(id)) ? row(Number(id), history.get(Number(id))) : null;
    if (!value || value[1] < 2) return null;
    const towns = [], window = windowMs();
    for (let at = 2; at + 3 < value.length; at += 4) {
        const decay = Math.exp(-Uptime.between(value[at + 3], timestamp) / window);
        const units = value[at + 1] * decay, arrivals = value[at + 2] * decay;
        if (units >= 1 && arrivals >= .1) towns.push({ town: value[at], units, arrivals });
    }
    return { revision: value[1], towns };
}
function forecast(id, town = null, timestamp = Date.now()) {
    const evidence = observed(id, timestamp);
    if (!evidence) return null;
    const selected = evidence.towns.filter(value => !town || value.town === town);
    const units = selected.reduce((sum, value) => sum + value.units, 0);
    const arrivals = selected.reduce((sum, value) => sum + value.arrivals, 0);
    // A conservative half window of the observed item flow is a finite
    // forecast, never a funded order or a promise of perpetual sales.
    const applicableUnits = Math.floor(units / 2), windowHours = windowMs() / HOUR_MS;
    return applicableUnits > 0 ? { known: true, selfId: Number(id), enchant: 0, town,
        origin: 'public_item_trades', authority: { selfId: Number(id), revision: evidence.revision },
        applicableUnits, arrivalsPerHour: arrivals / windowHours, delayHours: windowHours / 2,
        observedAt: timestamp, availability: { from: timestamp, until: timestamp },
        guaranteed: false, repeatable: false } : null;
}
function towns(id, timestamp = Date.now()) { return observed(id, timestamp)?.towns.map(value => value.town) || []; }
// Replay interleaved board and fixed-shop receipts in timestamp order.
// These aggregates expose item flow, never buyers, wallets or private wants.
function load(rows) {
    for (const row of rows || []) deal(row.selfId, Number(row.quantity), row.town, Number(row.occurredAt), row.enchant ?? null);
}
function reset() { history.clear(); mirror = null; }
module.exports = { deal, rows, forecast, towns, reset, replayMs, useTable: source => { mirror = source; }, load };

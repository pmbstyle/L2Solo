'use strict';
// The bots' funded purchase plans per town and item (our rule: a crafter stocks what the
// bots about to buy want, not only what the board shows: 417 standing bot buy lines filled
// 0.07 % in a x50 run, so the board alone lags the bots' wants). A bot's plan counts
// one unit of its equipment plan's market target in the plan's market town while the plan
// is active and the bot holds at least FUNDED_SHARE of its price (our choice: halfway
// saved, it buys soon). Kept on main from the committed states the bot life cache
// publishes (the worker's commits and main's own writes): each publication moves at most
// one bot's entry, O(1), no scan over the bots; the first read subscribes and replays the
// cache in its own slices (LifeStateCache.subscribePublications), so reads before the
// replay ends count fewer plans. The worker keeps none (main reads it for the crafter
// restock only).
const FUNDED_SHARE = 0.5;
const wants = new Map(), counts = new Map();
let unsubscribe = null;

// The key `${town}|${selfId}` a state's funded market plan counts under, else null.
function wantOf(state) {
    const plan = state?.stats?.equipmentPlan;
    if (plan?.status !== 'active' || plan.strategy !== 'market') return null;
    const selfId = Number(plan.target?.selfId), town = plan.market?.town, price = Number(plan.market?.price);
    if (!(selfId > 0) || !town || !(price > 0) || !Number.isFinite(price)) return null;
    return Math.max(0, Number(state.adena) || 0) >= FUNDED_SHARE * price ? `${town}|${selfId}` : null;
}
function move(key, units) {
    if (!key) return;
    const next = (counts.get(key) || 0) + units;
    if (next > 0) counts.set(key, next); else counts.delete(key);
}
function observe({ characterId, state, kind }) {
    if (kind === 'reset') { wants.clear(); counts.clear(); return; }
    const id = Number(characterId), key = state ? wantOf(state) : null, was = wants.get(id) || null;
    if (key === was) return;
    move(was, -1); move(key, 1);
    if (key) wants.set(id, key); else wants.delete(id);
}
function subscribe() {
    if (unsubscribe || !require('node:worker_threads').isMainThread) return;
    unsubscribe = invoke('GameServer/Bot/Population/BotLifeState').subscribePublications(observe, { replay: true });
}
// The funded plans for selfId in town.
function units(selfId, town) {
    subscribe();
    return counts.get(`${town}|${Number(selfId)}`) || 0;
}
function reset() {
    unsubscribe?.(); unsubscribe = null;
    wants.clear(); counts.clear();
}

module.exports = { units, wantOf, observe, reset, FUNDED_SHARE };

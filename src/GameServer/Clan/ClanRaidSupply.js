'use strict';

const Supply = require('../Bot/Population/RaidSupplyPolicy');
const Errands = require('../Bot/Population/CombinedErrandPolicy');
const TIMEOUT_MS = 10 * 60 * 1000;

// Only the selected clan roster receives an expiring personal purchase order.
// Assessment uses the worker's book; this admission rechecks main's live quote.
function reserve(state, objective, target, market, claimed, timestamp = Date.now()) {
    const roster = objective?.fullRoster;
    if (!roster || !target || !(target.target > 0)) return { ok: true, marker: null };
    const missing = Math.max(0, target.target - Number(state.inventory?.[target.selfId]?.amount || 0));
    if (!missing) return { ok: true, marker: null };
    const cash = Supply.cash(state);
    const quote = market.planPurchase(state, target.selfId, missing, { purpose: 'raid_supply', money: cash, claimed });
    if (!quote || quote.units < missing) return { ok: false, code: 'raid_supplies_unavailable' };
    const budget = Supply.quoteBudget(quote, missing);
    if (!Number.isFinite(budget.cashNeeded) || !(budget.priceCap > 0) || budget.cashNeeded > cash)
        return { ok: false, code: 'raid_consumables_funds' };
    for (const { line, count } of quote.lines || []) {
        const key = `${line.recordId}:${line.lineId}`;
        claimed.set(key, (claimed.get(key) || 0) + count);
    }
    return { ok: true, marker: {
        id: `clanraid_${roster.generation}_${state.characterId}`, owner: 'clan', clanId: objective.clanId,
        goalKey: objective.clanGoalKey, generation: roster.generation, expiresAt: timestamp + TIMEOUT_MS,
        supply: { selfId: target.selfId, target: target.target, town: quote.town, ...budget }
    } };
}

// Called only on this member's existing cold lifecycle command. Travel,
// arrival quotes, debit and the return trip keep their native owners.
async function advance(state, life, market, timestamp = Date.now()) {
    const marker = Supply.held(state, timestamp);
    if (marker?.owner !== 'clan' || state.stats?.travel || state.stats?.marketReturn
        || ['traveling', 'shopping', 'dead'].includes(state.activity)) return state;
    const s = marker.supply;
    const missing = Math.max(0, s.target - Number(state.inventory?.[s.selfId]?.amount || 0));
    if (!missing) {
        const next = Errands.withPending(state, Errands.pending(state).filter(e => e.raidPreparationId !== marker.id));
        return await life.upsertState({ ...next, activity: 'party_wait',
            stats: { ...next.stats, raidSupplyPreparation: null },
            timing: { ...next.timing, nextResolveAt: timestamp + 1000 } }, 'clan_raid_supplied') || state;
    }
    const result = await market.acquire(state, s.selfId, missing, { purpose: 'raid_supply',
        raidPreparationId: marker.id, towns: [s.town], maxPrice: s.priceCap, money: Supply.cash(state) });
    return result.state || state;
}

module.exports = { reserve, advance };

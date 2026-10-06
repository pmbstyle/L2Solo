'use strict';

const ERRAND_MS = 30 * 60 * 1000;

function key(errand) { return `${errand.town}:${Number(errand.selfId)}:${errand.purpose || 'supply'}:${errand.tag || ''}`; }

function pending(state, timestamp = Date.now(), town = null) {
    const unique = new Map();
    for (const errand of [...(state?.stats?.marketErrands || []), state?.stats?.marketErrand]) {
        if (!errand || !(Number(errand.selfId) > 0) || !(Number(errand.amount) > 0) || !errand.town
            || timestamp - Number(errand.at || 0) >= ERRAND_MS || (town && errand.town !== town)) continue;
        unique.set(key(errand), errand);
    }
    return [...unique.values()].slice(0, 8);
}

function withPending(state, errands) {
    return { ...state, stats: { ...(state.stats || {}), marketErrands: errands.slice(0, 8), marketErrand: errands[0] || null } };
}

function enqueue(state, errand, timestamp = Date.now()) {
    const errands = pending(state, timestamp);
    const index = errands.findIndex(existing => key(existing) === key(errand));
    if (index < 0) errands.push(errand);
    else errands[index] = errand; // A replanned demand replaces itself; it is not another reservation.
    return withPending(state, errands);
}

function complete(state, errand, timestamp = Date.now()) {
    return withPending(state, pending(state, timestamp).filter(existing => key(existing) !== key(errand)
        || Number(existing.at) !== Number(errand.at) || Number(existing.amount) !== Number(errand.amount)));
}

function edge(previous, current, result = {}) {
    if (!current || ['resting', 'traveling', 'dead'].includes(current.activity)) return null;
    if (!previous || previous.activity !== current.activity) return 'activity';
    if (Number(previous.level) !== Number(current.level)) return 'level';
    if (Number(previous.adena) !== Number(current.adena)) return 'deal';
    const items = result.materialize?.items || [];
    if (items.length) return 'bag';
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const plan = ShotStock.planForState(current);
    if (Number(previous.inventory?.[plan.selfId]?.amount || 0) !== Number(current.inventory?.[plan.selfId]?.amount || 0)) return 'shots';
    if (previous.inventory !== current.inventory) {
        const old = previous.inventory || {};
        const next = current.inventory || {};
        if (Object.keys(old).length !== Object.keys(next).length
            || Object.keys(next).some(id => Number(old[id]?.amount || 0) !== Number(next[id]?.amount || 0))) return 'bag';
    }
    const beforePlan = previous.stats?.equipmentPlan;
    const afterPlan = current.stats?.equipmentPlan;
    if (beforePlan?.status !== afterPlan?.status || beforePlan?.target?.selfId !== afterPlan?.target?.selfId
        || previous.stats?.marketErrand?.at !== current.stats?.marketErrand?.at) return 'plan';
    return null;
}

function visit(state, town, timestamp = Date.now(), reason = null) {
    return { ...state, stats: { ...(state.stats || {}), townVisit: { town, startedAt: timestamp, reason } } };
}

module.exports = { ERRAND_MS, key, pending, enqueue, complete, withPending, edge, visit };

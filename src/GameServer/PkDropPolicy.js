'use strict';

// The same ordered C4 policy drives physical death drops and their valuation.
const CONTINUE_CHANCE = 0.4;
const MAX_DROPS = 10;
const STARTER_IDS = new Set(require('../../data/Templates/Items/items.json')
    .flatMap(row => row.items.map(item => Number(item.selfId))));
const HERO_IDS = new Set(Array.from({ length: 11 }, (_, i) => 6611 + i));

function value(item, method, key, fallback) {
    return typeof item?.[method] === 'function' ? item[method]() : item?.[key] ?? item?.model?.[key] ?? fallback;
}
function eligible(item) {
    const id = Number(value(item, 'fetchSelfId', 'selfId', 0));
    const kind = String(value(item, 'fetchKind', 'kind', ''));
    const data = item?.model || item || {};
    return id > 0 && ![57, 5575].includes(id) && !STARTER_IDS.has(id) && !HERO_IDS.has(id)
        && !/quest|shadow|hero/i.test(kind) && !data.quest && !data.questItem
        && !data.shadow && !data.hero && !data.starter && !data.newbie
        && data.droppable !== false && !value(item, 'fetchPetLocked', 'petLocked', false)
        && Number(value(item, 'fetchAmount', 'amount', 1)) > 0;
}
function chance(item) {
    if (!value(item, 'fetchEquipped', 'equipped', false)) return 0.5;
    return String(value(item, 'fetchKind', 'kind', '')).includes('Weapon') ? 0.1 : 0.4;
}
function enabled(state) {
    return Number(state?.fetchKarma?.() ?? state?.stats?.karma ?? state?.karma ?? 0) > 0
        && Number(state?.fetchPk?.() ?? state?.stats?.pk ?? state?.stats?.pkKills ?? state?.pk ?? 0) >= 6;
}
function continuationChance() {
    const configured = Number(global.options?.default?.General?.pkDeathDropChance ?? CONTINUE_CHANCE);
    return Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : CONTINUE_CHANCE;
}
function inventory(state) {
    if (state?.backpack?.fetchItems) return state.backpack.fetchItems();
    if (Array.isArray(state?.inventory)) return state.inventory;
    return Object.entries(state?.inventory || {}).flatMap(([key, row]) => {
        if (row?.instances?.length) return row.instances.map(instance => ({ ...row, ...instance, selfId: Number(row.selfId ?? key) }));
        return [{ ...row, selfId: Number(row?.selfId ?? key) }];
    });
}
function candidates(state) { return enabled(state) ? inventory(state).filter(eligible) : []; }
function rollPlan(state, rng = Math.random) {
    const items = candidates(state), drops = [];
    let i = 0;
    while (i < items.length && drops.length < MAX_DROPS && rng() < continuationChance()) {
        let dropped = false;
        while (i < items.length) {
            const item = items[i++];
            if (rng() >= chance(item)) continue;
            drops.push(item); dropped = true; break;
        }
        if (!dropped) break;
    }
    return drops;
}
function expectedValue(state, priceOf) {
    if (typeof priceOf !== 'function') throw new TypeError('PK drop price provider required');
    const items = candidates(state);
    const worth = items.map(item => Math.max(0, Number(priceOf(Number(value(item, 'fetchSelfId', 'selfId', 0)), item)) || 0)
        * Math.max(0, Number(value(item, 'fetchAmount', 'amount', 1)) || 0));
    let previous = new Float64Array(items.length + 1);
    for (let k = 1; k <= MAX_DROPS; k++) {
        const current = new Float64Array(items.length + 1);
        let scan = 0;
        for (let i = items.length - 1; i >= 0; i--) {
            const p = chance(items[i]);
            scan = p * (worth[i] + previous[i + 1]) + (1 - p) * scan;
            current[i] = continuationChance() * scan;
        }
        previous = current;
    }
    return previous[0];
}
module.exports = { CONTINUE_CHANCE, MAX_DROPS, continuationChance, STARTER_IDS, eligible, chance, enabled, candidates, rollPlan, expectedValue };

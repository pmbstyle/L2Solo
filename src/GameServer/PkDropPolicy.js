'use strict';

// The C4 death drop of a PK (Lisvus L2PcInstance.onDieDropItem, Rates and PVP
// properties): with karma and at least MinimumPKRequiredToDrop PKs, one
// KarmaRateDrop roll decides whether anything drops; then one pass over the
// inventory drops each eligible item on its own chance (KarmaRateDropItem 50 %
// in the bag, KarmaRateDropEquip 40 % worn, KarmaRateDropEquipWeapon 10 % a
// worn weapon) until KarmaDropLimit items. Hot PkDeathDrop, the cold commit
// (Database) and EconomicValuation's expected loss read this one rule.
const MIN_PK = 5;
const DROP_CHANCE = 0.7;
const MAX_DROPS = 10;
const BeginnerShots = require('./Items/C4BeginnerShots');
const STARTER_IDS = require('./Knowledge/StarterItemCatalog').importIds(require('../../data/Templates/Items/items.json'));
const HERO_IDS = new Set(Array.from({ length: 11 }, (_, i) => 6611 + i));

function value(item, method, key, fallback) {
    return typeof item?.[method] === 'function' ? item[method]() : item?.[key] ?? item?.model?.[key] ?? fallback;
}
function eligible(item) {
    const id = Number(value(item, 'fetchSelfId', 'selfId', 0));
    const kind = String(value(item, 'fetchKind', 'kind', ''));
    const data = item?.model || item || {};
    return id > 0 && ![57, 5575].includes(id) && !STARTER_IDS.has(id) && !HERO_IDS.has(id)
        && !BeginnerShots.isRestricted(id)
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
        && Number(state?.fetchPk?.() ?? state?.stats?.pk ?? state?.stats?.pkKills ?? state?.pk ?? 0) >= MIN_PK;
}
// KarmaRateDrop, configurable as General.pkDeathDropChance.
function dropChance() {
    const configured = Number(global.options?.default?.General?.pkDeathDropChance ?? DROP_CHANCE);
    return Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : DROP_CHANCE;
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
    if (!items.length || rng() >= dropChance()) return drops;
    for (const item of items) {
        if (drops.length >= MAX_DROPS) break;
        if (rng() < chance(item)) drops.push(item);
    }
    return drops;
}
// The expected worth lost: the drop roll times each item's chance to drop
// while fewer than MAX_DROPS items before it in the pass have dropped
// (dropped[k]: the chance that exactly k have).
function expectedValue(state, priceOf) {
    if (typeof priceOf !== 'function') throw new TypeError('PK drop price provider required');
    const items = candidates(state);
    let dropped = new Float64Array(MAX_DROPS), total = 0;
    dropped[0] = 1;
    for (const item of items) {
        const worth = Math.max(0, Number(priceOf(Number(value(item, 'fetchSelfId', 'selfId', 0)), item)) || 0)
            * Math.max(0, Number(value(item, 'fetchAmount', 'amount', 1)) || 0);
        const p = chance(item), next = new Float64Array(MAX_DROPS);
        let open = 0;
        for (let k = 0; k < MAX_DROPS; k++) {
            open += dropped[k];
            next[k] += dropped[k] * (1 - p);
            if (k + 1 < MAX_DROPS) next[k + 1] += dropped[k] * p;
        }
        total += worth * p * open;
        dropped = next;
    }
    return dropChance() * total;
}
module.exports = { MIN_PK, DROP_CHANCE, MAX_DROPS, dropChance, STARTER_IDS, eligible, chance, enabled, candidates, rollPlan, expectedValue };

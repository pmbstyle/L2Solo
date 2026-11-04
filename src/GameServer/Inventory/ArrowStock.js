'use strict';

// A bot's arrow stock: one grade, the equipped bow's, up to MAX_AMOUNT and below
// the first weight penalty (a bot's bow spends no arrows, Actor/BowResources, so
// the stock is weight only). Our rule, not C4; players hold what they like.
// Purchases ask `admitted` where a path sizes its quantity (WishPurchaseEvidence,
// NpcRestockPlan, BuyAdPolicy, BotLifeState.marketPurchaseBlocker) and the commit
// re-reads it inside the transaction (Database checkArrowPurchaseUnsafe); the
// sale reads saleAmounts (ItemDisposition, MarketListingPolicy). Hot, cold, worker.
const BY_RANK = Object.freeze({ none: 17, d: 1341, c: 1342, b: 1343, a: 1344, s: 1345 });
const ARROW_IDS = new Set(Object.values(BY_RANK));
const MAX_AMOUNT = 2000;
// Kept whatever else the bag weighs (our choice): selling these never clears a
// load the other items make, it only sends the archer to town to sell its ammunition.
const KEEP_FLOOR = 500;
const Index = require('../Item/ItemTemplateIndex');

function isArrow(item) {
    return ARROW_IDS.has(Number(item?.fetchSelfId?.() ?? item?.selfId))
        || (item?.fetchKind?.() ?? item?.kind) === 'Other.Arrow';
}

// Use the class's combat kit, including a scout's chosen bow/dagger path;
// a party assignment or an old saved role does not make a caster an archer.
function keeps(value) {
    return invoke('GameServer/Bot/AI/BotRoles').inferRole(value) === 'archer';
}

function items(value) {
    return value?.backpack?.fetchItems?.() || Object.values(value?.inventory || {});
}

const selfId = item => Number(item?.fetchSelfId?.() ?? item?.selfId);
const amount = item => Math.max(0, Number(item?.fetchAmount?.() ?? item?.amount) || 0);
// SurvivalFloor is also imported by pure planners before the game is initialized.
const template = item => Index.find(invoke('GameServer/DataCache').items, typeof item === 'number' ? item : selfId(item));
const mass = item => Math.max(0, Number(template(item)?.template?.mass ?? item?.fetchMass?.() ?? item?.mass) || 0);

function currentId(value) {
    if (!keeps(value)) return null;
    let weapon = value?.backpack?.fetchEquippedWeapon?.();
    if (!weapon) weapon = items(value).filter(item =>
        (item.fetchEquipped?.() ?? item.equipped) || Number(item.equippedCount) > 0)
        .filter(item => String(item.fetchKind?.() ?? template(item)?.template?.kind ?? item.kind).startsWith('Weapon.'))
        .sort((a, b) => selfId(a) - selfId(b))[0];
    if (!weapon || (weapon.fetchKind?.() ?? template(weapon)?.template?.kind ?? weapon.kind) !== 'Weapon.Bow') return null;
    const rank = String(weapon.fetchRank?.() ?? template(weapon)?.etc?.rank ?? weapon.rank ?? 'none').toLowerCase();
    return BY_RANK[rank] || null;
}

function loadLimit(value) {
    const maximum = typeof value?.fetchMaxLoad === 'function' ? value.fetchMaxLoad()
        : invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(value).maxLoad;
    return maximum > 0 ? Math.ceil(maximum / 2) - 1 : 0;
}

function totalLoad(value) {
    return items(value).reduce((sum, item) => sum + amount(item) * mass(item), 0);
}

// A single compatible grade, with room below the first native weight penalty
// and never below KEEP_FLOOR. Wrong grades are excluded from the retained kit
// because this same cleanup sells them; a purchase still counts their physical
// weight until that sale, and buys only into the room.
function keptAmounts(value) {
    const id = currentId(value);
    if (!id) return {};
    const otherLoad = items(value).reduce((sum, item) => sum + (isArrow(item) ? 0 : amount(item) * mass(item)), 0);
    const unitMass = mass(id);
    const capacity = unitMass > 0 ? Math.floor(Math.max(0, loadLimit(value) - otherLoad) / unitMass) : MAX_AMOUNT;
    return { [id]: Math.min(MAX_AMOUNT, Math.max(KEEP_FLOOR, capacity)) };
}

function saleAmounts(value) {
    const held = new Map();
    for (const item of items(value)) if (isArrow(item)) held.set(selfId(item), (held.get(selfId(item)) || 0) + amount(item));
    if (!held.size) return held;
    const kept = keptAmounts(value);
    for (const [id, count] of held) held.set(id, Math.max(0, count - Number(kept[id] || 0)));
    return held;
}

function unused(value) {
    const sale = saleAmounts(value);
    return items(value).filter(item => isArrow(item) && amount(item) > 0 && sale.get(selfId(item)) > 0);
}

function purchaseAmount(value, id, requested) {
    id = Number(id);
    if (id !== currentId(value)) return 0;
    const pendingOwner = value?.session?.coldLifeState || value;
    if (pendingOwner?.incomingPending) return 0;
    const incoming = pendingOwner?.acceptedIncoming || {};
    const owned = items(value).filter(item => selfId(item) === id).reduce((sum, item) => sum + amount(item), 0)
        + Number(incoming[id] || 0);
    const incomingLoad = Object.entries(incoming).reduce((sum, [key, count]) => sum + mass(Number(key)) * Number(count || 0), 0);
    const unitMass = mass(id), room = Math.max(0, loadLimit(value) - totalLoad(value) - incomingLoad);
    const capacity = unitMass > 0 ? Math.floor(room / unitMass) : MAX_AMOUNT;
    return Math.max(0, Math.min(Math.floor(Number(requested) || 0), MAX_AMOUNT - owned, capacity));
}

// How many of `requested` units of an item a bot may take in: all of an item
// that is no arrow, else the stock's room.
function admitted(value, selfId, requested) {
    return isArrow({ selfId }) ? purchaseAmount(value, selfId, requested) : requested;
}

module.exports = { BY_RANK, MAX_AMOUNT, KEEP_FLOOR, isArrow, keeps, currentId, keptAmounts, saleAmounts, unused, purchaseAmount, admitted };

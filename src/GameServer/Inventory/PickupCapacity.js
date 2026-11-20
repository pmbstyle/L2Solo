const Limits = require('./InventoryLimits');
const ItemIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const pending = new WeakMap();

// Selection and the final claim must use the same capacity rules, including
// awards that have not reached the live backpack yet. A check reserves nothing.
function check(actor, selfId, amount, groundItem) {
    const backpack = actor?.backpack;
    if (!backpack) return { reason: 'invalid_recipient' };
    if (!Number.isSafeInteger(amount) || amount < 1) return { reason: 'invalid_amount' };
    const template = ItemIndex.find(DataCache.items, selfId);
    const stackable = template?.etc?.stackable ?? groundItem.fetchStackable?.() ?? (selfId === 57);
    const mass = Math.max(0, Number(template?.template?.mass ?? groundItem.fetchMass?.() ?? 0));
    const items = backpack.fetchItems?.() || [];
    const reservations = pending.get(backpack) || new Set();
    const stacks = new Set();
    let slots = 0, load = 0;
    for (const item of items) {
        const count = Number(item.fetchAmount());
        if (!(count > 0)) continue;
        slots += item.fetchStackable() ? 1 : count;
        if (item.fetchStackable()) stacks.add(Number(item.fetchSelfId()));
        load += Number(item.fetchMass()) * count;
    }
    for (const reservation of reservations) {
        slots += reservation.stackable ? Number(!stacks.has(reservation.selfId)) : reservation.amount;
        if (reservation.stackable) stacks.add(reservation.selfId);
        load += reservation.mass * reservation.amount;
    }
    const reason = refusal({ slots, load, limit: Limits.forActor(actor), maxLoad: actor.fetchMaxLoad?.(), held: stacks.has(selfId) },
        { stackable, mass, amount });
    return reason ? { reason } : { selfId, amount, stackable, mass };
}

// The C4 pickup rule, one for a body near a player (check) and a far round (RoundLoot.keep):
// a drop that needs a slot past the bag's limit, or with mass past its carrying load, stays on
// the ground. bag: { slots, load, limit, maxLoad, held: a stack of the drop is in the bag };
// drop: { stackable, mass, amount }. Returns why it stays ('slots', 'weight'), null when it fits.
function refusal({ slots, load, limit, maxLoad, held }, { stackable, mass, amount }) {
    if (slots + (stackable ? Number(!held) : amount) > limit) return 'slots';
    // Weightless drops (notably Adena) do not worsen an existing overload.
    if (mass > 0 && Number.isFinite(maxLoad) && load + mass * amount > maxLoad) return 'weight';
    return null;
}

// Several ground claims can arrive before the first award reaches the live
// backpack. Count their reserved slots and weight until each award settles.
function reserve(actor, selfId, amount, groundItem) {
    const reservation = check(actor, selfId, amount, groundItem);
    if (reservation.reason) return reservation;
    const backpack = actor.backpack;
    const reservations = pending.get(backpack) || new Set();
    reservations.add(reservation);
    pending.set(backpack, reservations);
    return { release() {
        reservations.delete(reservation);
        if (!reservations.size && pending.get(backpack) === reservations) pending.delete(backpack);
    } };
}

module.exports = { check, reserve, refusal };

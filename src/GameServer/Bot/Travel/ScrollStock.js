// A bot keeps a few Scrolls of Escape for its town trips (part of H13, user
// 2026-10-05): on a town visit it buys up to the target at the local NPC, as it
// restocks healing potions (HealingPotionStock.restockPlan: what is missing,
// from the Adena above the consumables reserve), and the sale keeps that many
// (H12 narrowed: the stock is no longer NPC junk; a surplus is sold).
const ConsumableRestock = invoke('GameServer/Inventory/ConsumableRestock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const TripPayment = require('./TripPayment');

// Temporary carried target (user, 2026-10-08), pending travel-based stock planning.
const TARGET_AMOUNT = 10;
const SCROLL = Object.freeze({ selfId: TripPayment.SCROLL_OF_ESCAPE, name: 'Scroll of Escape' });

function heldAmount(value, inventory = value?.inventory) {
    if (inventory) return Math.max(0, Number(inventory[String(SCROLL.selfId)]?.amount || 0));
    return Math.max(0, Number(value?.backpack?.fetchItemFromSelfId?.(SCROLL.selfId)?.fetchAmount?.() || 0));
}

// What the sale keeps: the scrolls up to the target.
function keptAmounts(value) {
    const kept = Math.min(TARGET_AMOUNT, heldAmount(value));
    return kept > 0 ? { [SCROLL.selfId]: kept } : {};
}

function restockPlan(value, options = {}) {
    const currentAmount = heldAmount(value, options.inventory || value?.inventory);
    const adena = Math.max(0, Number(options.adena ?? value?.adena
        ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const unitPrice = Math.max(0, Number(options.unitPrice) || 0);
    const reserve = Math.max(0, Number(options.reserve ?? HealingPotionStock.operationalReserve(value)) || 0);
    const desired = Math.max(0, TARGET_AMOUNT - currentAmount);
    const affordable = unitPrice > 0 ? Math.floor(Math.max(0, adena - reserve) / unitPrice) : 0;
    const amount = Math.min(desired, affordable);
    return {
        selfId: SCROLL.selfId,
        name: SCROLL.name,
        targetAmount: TARGET_AMOUNT,
        currentAmount,
        amount,
        unitPrice,
        cost: amount * unitPrice,
        adena,
        reserve,
        needed: desired > 0,
        affordable: amount > 0
    };
}

// The scroll's price at the cheapest NPC of a town; 0 = not sold there.
function localNpcPrice(town) {
    return HealingPotionStock.localNpcPrice(SCROLL, town);
}

// The cold state's purchase patch (LifeState.applyConsumablePurchase), or null.
function coldPurchasePatch(state, options = {}) {
    const plan = restockPlan(state, { ...options, inventory: state?.inventory || {} });
    return plan.affordable ? ConsumableRestock.coldPatch(state, plan) : null;
}

function purchaseActorRestock(actor, options = {}) {
    if (!actor?.backpack || typeof actor.fetchId !== 'function') return Promise.resolve({ ok: false, reason: 'missing_actor' });
    const plan = restockPlan(actor, options);
    if (!plan.needed) return Promise.resolve({ ok: true, changed: false, ...plan });
    if (!plan.affordable) return Promise.resolve({ ok: false, reason: 'wallet_reserve', ...plan });
    return ConsumableRestock.buyForActor(actor, plan).then((bought) => (bought.ok
        ? { ok: true, changed: true, ...plan, nextAdena: bought.nextAdena, nextAmount: bought.nextAmount }
        : { ok: false, reason: bought.reason, ...plan }));
}

module.exports = { TARGET_AMOUNT, keptAmounts, restockPlan, localNpcPrice, coldPurchasePatch, purchaseActorRestock };

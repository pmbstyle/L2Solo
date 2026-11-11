// A bot carries a Scroll of Escape for its trip back to town when the walk it
// saves is worth its price (the kit rule in
// EconomyContext.kitReader: one per outing, no survival line, a broke bot
// walks): on a town visit it buys the one missing at the local NPC from the
// money its queue does not hold (a side purchase the writer checks against the
// bot's hour), and the sale keeps every scroll it holds (each saves a walk;
// none is junk). Our rule, not C4.
const ConsumableRestock = invoke('GameServer/Inventory/ConsumableRestock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const TripPayment = require('./TripPayment');
const Funding = require('../Economy/PurchaseFunding');

const SCROLL = Object.freeze({ selfId: TripPayment.SCROLL_OF_ESCAPE, name: 'Scroll of Escape' });

function heldAmount(value, inventory = value?.inventory) {
    if (inventory) return Math.max(0, Number(inventory[String(SCROLL.selfId)]?.amount || 0));
    return Math.max(0, Number(value?.backpack?.fetchItemFromSelfId?.(SCROLL.selfId)?.fetchAmount?.() || 0));
}

// What the sale keeps: every scroll the bot holds.
function keptAmounts(value) {
    const kept = heldAmount(value);
    return kept > 0 ? { [SCROLL.selfId]: kept } : {};
}

function restockPlan(value, options = {}) {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const state = value?.backpack ? Economy.stateForActor(value) : value;
    // Main reads the build's kit rates (keptKit: a near bot's decision is taken in the background).
    const onMain = require('node:worker_threads').isMainThread;
    const context = options.context || (onMain ? Economy.keptKit(state) : Economy.forState(state));
    // kit: the visit's own amounts (NpcRestockPlan.collect at the local quote, a hot visit's held kit);
    // the wish's rank at the bot's own estimate (EconomyContext.visitStock).
    const { row: stock, estimate } = Economy.visitStock(context, options.kit, 'scrolls');
    const currentAmount = heldAmount(value, options.inventory || value?.inventory);
    const adena = Math.max(0, Number(options.adena ?? value?.adena
        ?? value?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0));
    const unitPrice = Math.max(0, Number(options.unitPrice) || 0);
    const reserve = Math.max(0, Number(options.reserve ?? context.refillReserve) || 0);
    const desired = Math.max(0, stock.target - currentAmount);
    const wish = context.network?.queue?.find(row => Number(row.object?.itemId) === Number(SCROLL.selfId));
    const fundedState = context.statsPacket ? { ...state, stats: { ...state.stats, money: context.statsPacket.money } } : state;
    // No row in the money queue (the kit comes first): the time a scroll saves
    // buys it from the money the queue does not hold.
    const funding = wish || !(unitPrice > 0) || Funding.itemRate(fundedState.stats?.money, SCROLL.selfId) !== undefined
        ? {} : { side: stock.benefitPerUnit / unitPrice };
    const allowance = Funding.stockAllowance(fundedState, wish, SCROLL.selfId, Funding.survivalTranche(context, SCROLL.selfId, unitPrice),
        Funding.quoteScale(estimate, unitPrice), funding);
    const affordable = unitPrice > 0 ? Math.floor(allowance / unitPrice) : 0;
    const amount = Math.min(desired, affordable);
    return {
        selfId: SCROLL.selfId,
        name: SCROLL.name,
        targetAmount: stock.target,
        currentAmount,
        amount,
        unitPrice,
        funding,
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

module.exports = { keptAmounts, restockPlan, localNpcPrice, coldPurchasePatch, purchaseActorRestock };

'use strict';
// A bot's look at its own board lines: the own_lines decision's answer (Situations),
// taken on the worker at its situations only (a town arrival, a line undercut, a line
// filled), far and near alike, never by the clock. Every own priced line is looked at
// against the board as it stands; MarketPricing.look answers each (a new price, a
// withdrawal or none). Called by ColdSimulationWorker (ownLines).
const BidPurchaseAlternative = require('./BidPurchaseAlternative');
const MAX_OWNED_LINES = 14;

// Only indexed owner facts can prove protection at a bounded natural look.
// Deep equipment/combine allocations wait for their worker preparation.
function indexedFeasibility(state, line, reserved = null) {
    const item = state.inventory?.[line.selfId], plan = state.stats?.equipmentPlan;
    if (item?.protected || item?.acceptedCustomer || item?.assignedClan || item?.available === false) return false;
    const target = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        && Number(plan?.target?.selfId) === Number(line.selfId) ? 1 : 0;
    const held = Math.max(Number(item?.protectedAmount || 0), Number(item?.starterMobLootAmount || 0),
        Number(item?.reservedAmount || 0), Number(state.stats?.clanMaterialDemand?.[line.selfId] || 0),
        Number(reserved?.[line.selfId] || 0), target);
    if (held > Number(item?.amount || 0)) return false;
    return reserved ? true : undefined;
}

function scalarWorth(ctx, id) {
    if (typeof ctx.preparedWorth === 'function') return ctx.preparedWorth(id);
    // A direct fixture may explicitly provide a prepared scalar reader. This
    // never constructs an economic graph or falls back to a market price.
    return typeof ctx.economy?.worth === 'function' && !ctx.economy?.price ? ctx.economy.worth(id) : NaN;
}

// Why a line is looked at (MarketPricing.look's reasons): 1 the board as it stands
// (every look), 2 its count or fills moved since its price was set, 4 a price its
// limits no longer allow (a bid above its purchase cap or cash, or a worth that
// moved), 8 a bid looked at on a town visit (visit: the look of an arrival).
function reasonOf(line, ctx, visit) {
    let reason = 1;
    if (Number.isFinite(line.pricing.seenCount) && Number(line.pricing.seenCount) !== Number(line.count)
        || Number(line.fills || 0) > Number(line.pricing.seenFills || 0)) reason |= 2;
    if (line.storeType !== 3) return reason;
    if (visit) reason |= 8;
    const purchaseCap = BidPurchaseAlternative.forLine(line, ctx);
    ctx.purchaseCaps.set(line.lineId, purchaseCap);
    const worth = Number(scalarWorth(ctx, line.selfId));
    const cap = Number.isFinite(worth) && worth >= 0 ? Math.floor(Math.min(worth, BidPurchaseAlternative.cashCap(line, ctx))) : NaN;
    if (line.price > purchaseCap || line.price > cap
        || Number.isFinite(worth) && worth >= 0 && Math.floor(worth) !== Math.floor(Number(line.pricing.worth))) reason |= 4;
    return reason;
}

function review(state, lines, ctx, { visit = false } = {}) {
    ctx = { ...ctx, purchaseCaps: new Map() };
    const own = lines.filter(line => line.pricing && line.count > 0
        && (!line.ownerId || Number(line.ownerId) === Number(state.characterId))).slice(0, MAX_OWNED_LINES);
    if (!own.length) return null;
    const reviewReasons = new Map(own.map(line => [line.lineId, reasonOf(line, ctx, visit)]));
    return invoke('GameServer/Bot/Economy/MarketPricing').look(state, own, { ...ctx, visit, reviewReasons });
}

module.exports = { MAX_OWNED_LINES, review, indexedFeasibility };

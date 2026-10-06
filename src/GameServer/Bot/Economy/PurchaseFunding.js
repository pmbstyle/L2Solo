// Whether a bot can pay for a purchase: the one rule behind every funding
// check (goal review, planner, worker routing, buy orders). The budget is the
// bot's wallet plus the Adena its own AFK buy order already holds (escrow); the
// only already committed survival costs precede its one wish queue.

function budget(state = {}, escrow = 0) {
    return Math.max(0, Number(state.adena || state.inventory?.[57]?.amount || 0))
        + Math.max(0, Number(escrow || 0));
}

// Only the survival trip/potion commitment is reserved. Wishes compete in
// one money queue, so neither a wallet percentage nor a level cushion belongs
// in a funding check.
function operatingReserve(state = {}) {
    return require('./EconomyContext').survivalReserve(state);
}

// Adena still missing to buy at `price` while keeping `reserve`; 0 = funded.
function shortfall(state = {}, price = 0, reserve = 0, escrow = 0) {
    return Math.max(0, Number(price || 0) + Number(reserve || 0) - budget(state, escrow));
}

// Adena left over once a purchase at `price` and its `reserve` are covered.
function surplus(state = {}, price = 0, reserve = 0) {
    return Math.max(0, budget(state) - Number(price || 0) - Number(reserve || 0));
}

// What the bot may spend on a purchase now.
function spendable(state = {}, escrow = 0, options = {}) {
    return Math.max(0, budget(state, escrow) - operatingReserve(state, escrow, options));
}

// The escrow a trip to a shop can spend. The trip withdraws the order only
// for a purchase planned at an NPC shop (that plan never keeps a WTB); any
// other plan keeps its order, which buys remotely, so the trip gains nothing.
function tripEscrow(plan, escrow = 0) {
    return plan?.market?.sourceType === 'npc' ? escrow : 0;
}

module.exports = { budget, operatingReserve, shortfall, surplus, spendable, tripEscrow };

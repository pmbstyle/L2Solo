// What a bot's trip costs, one rule for hot and cold bots (N2, user 2026-10-04):
// a trip to a town from outside it reads one Scroll of Escape, a hop between
// towns pays the gatekeeper's fee as a player does (TravelRoutes), a trip to a
// hunting spot is free. A hot bot pays from its backpack, a cold bot from its
// stored state (inventory summary and adena); the cold payment is written with
// the trip (BotLifeState.upsertState syncs the items of a newly paid trip).
const TravelRoutes = require('./TravelRoutes');

const SCROLL_OF_ESCAPE = 736;
// The SoE recall cast (skill 2013), as BotTownTravel and BotSpotTravel cast it.
const SCROLL_CAST_MS = 20000;

// The gatekeeper fee from where a bot stands (the town its scroll reaches)
// into the town at `to`; null when no gatekeeper route leads there.
function fee(from, to) {
    const route = TravelRoutes.between(from, to).route;
    return route ? route.fee : null;
}

function coldAmount(state, selfId) {
    return Math.max(0, Number(state?.inventory?.[String(selfId)]?.amount || 0));
}

function coldAdena(state) {
    return Math.max(0, Number(state?.adena ?? coldAmount(state, 57)) || 0);
}

function hasColdScroll(state) {
    return coldAmount(state, SCROLL_OF_ESCAPE) > 0;
}

// The state after paying: one scroll if `scroll`, `fee` adena. Null when the
// bot lacks either.
function payCold(state, { scroll = false, fee: amount = 0 } = {}) {
    const adena = coldAdena(state);
    if (scroll && !hasColdScroll(state)) return null;
    if (amount > adena) return null;
    if (!scroll && amount <= 0) return state;
    const inventory = { ...(state.inventory || {}) };
    if (scroll) {
        const key = String(SCROLL_OF_ESCAPE);
        inventory[key] = { ...inventory[key], amount: coldAmount(state, SCROLL_OF_ESCAPE) - 1 };
    }
    if (amount > 0) inventory['57'] = { ...(inventory['57'] || {}), selfId: 57, name: 'Adena', amount: adena - amount };
    return { ...state, adena: adena - amount, inventory };
}

function actorItem(bot, selfId) {
    return bot?.backpack?.fetchItemFromSelfId?.(selfId) || null;
}

function actorAdena(bot) {
    return Math.max(0, Number(actorItem(bot, 57)?.fetchAmount?.() || 0));
}

function hasActorScroll(bot) {
    return Number(actorItem(bot, SCROLL_OF_ESCAPE)?.fetchAmount?.() || 0) > 0;
}

// A hot bot pays from its backpack. False (nothing taken) when it lacks either.
function payActor(session, bot, { scroll = false, fee: amount = 0 } = {}) {
    const scrollItem = scroll ? actorItem(bot, SCROLL_OF_ESCAPE) : null;
    if (scroll && !(Number(scrollItem?.fetchAmount?.() || 0) > 0)) return false;
    if (amount > actorAdena(bot)) return false;
    if (scrollItem) bot.backpack.deleteItem(session, scrollItem.fetchId(), 1);
    if (amount > 0) bot.backpack.deleteItem(session, actorItem(bot, 57).fetchId(), amount);
    return true;
}

module.exports = {
    SCROLL_OF_ESCAPE,
    SCROLL_CAST_MS,
    fee,
    coldAdena,
    hasColdScroll,
    payCold,
    actorAdena,
    hasActorScroll,
    payActor
};

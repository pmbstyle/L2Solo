const ServerResponse = invoke('GameServer/Network/Response');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { BUY } = require('../../AfkTrade/BoardIndex');

const { bidFor } = require('./BuyAdPolicy');

// A bot in a market town asks for the item it could not find: a buy ad on
// the board (step 3.3) whose escrow leaves its wallet, in a town chosen by
// the same roll as shops. The author's budget-backed stall (money left in
// the wallet, the bot waiting in town) is gone; the bot goes back to its hunt and its next save
// brings what the ad bought.
function open(state, goal) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, opened: false, reason: 'not_shopping' });
    }
    return invoke('GameServer/Bot/Economy/BotAfkMarketService').openBuyAd(state, goal).then((result) => {
        if (result.opened) MarketTelemetry.buyStoreOpened?.();
        return result;
    });
}

// A hot store with nothing left closes, as after a player's sale to it (Sell.js).
function closeSoldOutStore(actor, store) {
    actor.setPrivateStoreType?.(0);
    actor.setPrivateStore?.({ ...store, items: [] });
    actor.session?.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
}

// Sells one line of the bot's bag into the best buy record of the town: a
// deal on the board, one transaction (AfkTradeService.sellToShop); the item
// leaves the bot's bag and the price comes from the record's escrow.
async function settleLine(sellerState, line, town, options = {}) {
    const offer = options.offer || MarketOpportunity.bestBuyOffer(line.selfId, {
        town,
        sellerCharacterId: sellerState.characterId
    });
    if (!offer) return { state: sellerState, sold: false };
    const qty = Math.min(
        Number(line.count || 0),
        Number(offer.count || 0),
        Math.max(1, Number(options.maxQty || Infinity))
    );
    if (qty <= 0) return { state: sellerState, sold: false };
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    let done;
    try {
        const trade = await AfkTrade.sellToShop(
            sellerState.characterId,
            offer.store,
            line.selfId,
            qty,
            { objectId: line.objectId || line.id, lineId: offer.lineId, expectedPrice: offer.price, coldState: sellerState }
        );
        if (trade.pending) return { state: LifeState.cachedState(sellerState.characterId) || sellerState, sold: false, pending: true, meetingId: trade.meetingId };
        done = AfkTrade.committedTrade(trade, sellerState.characterId);
        if (!done.committed) return { state: sellerState, sold: false, reason: 'cold_state_sync_failed' };
    } catch (error) {
        utils.infoWarn('BotMarket', 'AFK buy-store sale failed for %s: %s', sellerState.name, error.message);
        return { state: sellerState, sold: false, reason: 'offer_changed' };
    }
    // A seller that went hot keeps its row: the job goes on with its own state.
    const seller = done.state || sellerState;
    MarketTelemetry.dynamicBuyerSale?.(offer, qty, {
        sellerCharacterId: seller.characterId,
        sellerName: seller.name,
        town
    });
    return {
        state: seller,
        sold: true,
        hot: done.hot,
        buyer: null,
        offer,
        qty,
        adena: Number(offer.price) * qty
    };
}

// The buy ads a bot chose to answer (MarketListingPolicy.evaluate: the side
// that acts travels, E45). options.now: the decision point.
function answers(state, options = {}) {
    return invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(state, { ...options, unlimited: true }).answers;
}

// A bot in a town sells into the buy ads there it chose to answer: one deal
// per ad on the board, from its bag, the escrow paying it at once.
// options.answers: the visit's decision when the caller made it.
async function sellToBestBuyer(state, town = state?.currentRegion, options = {}) {
    let seller = state;
    const sales = [];
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    for (const answer of options.answers || answers(state, options)) {
        if (answer.line.town !== town) continue;
        const offer = AfkTrade.offerOf(answer.line, town);
        if (!offer) continue;
        const result = await settleLine(seller, answer.item, town, { offer, maxQty: answer.count });
        seller = result.state || seller;
        if (result.pending) return { ...result, state: seller, sold: sales.length > 0, sales,
            itemCount: sales.reduce((sum, sale) => sum + sale.qty, 0), adena: sales.reduce((sum, sale) => sum + sale.adena, 0) };
        if (result.sold) sales.push(result);
        // The bot went hot: its bag is the actor's now.
        if (result.hot) break;
    }
    return {
        state: seller,
        sold: sales.length > 0,
        sales,
        itemCount: sales.reduce((sum, sale) => sum + sale.qty, 0),
        adena: sales.reduce((sum, sale) => sum + sale.adena, 0)
    };
}

// The town of the buy ads a bot chose to answer that pay it most: where its
// sale trip goes (the side that acts travels, E45). { town, value } or null.
// The sale decision runs only when the board has a buy ad for something in
// the bag (O(bag) index reads); the visit makes its own decision on arrival.
function bestTownFor(state, options = {}) {
    const board = options.board ?? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (!board || !Object.keys(state?.inventory || {}).some((selfId) => board.list(Number(selfId), BUY).length)) return null;
    const value = new Map();
    for (const answer of answers(state, options)) {
        const town = answer.line.town;
        if (town) value.set(town, (value.get(town) || 0) + answer.line.price * answer.count);
    }
    let best = null;
    for (const [town, total] of value) {
        if (!best || total > best.value || (total === best.value && town.localeCompare(best.town) < 0)) best = { town, value: total };
    }
    return best;
}

module.exports = {
    closeSoldOutStore,
    bestTownFor,
    bidFor,
    open,
    sellToBestBuyer
};

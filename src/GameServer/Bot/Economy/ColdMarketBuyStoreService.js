const ServerResponse = invoke('GameServer/Network/Response');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function bidFor(state, goal) {
    const selfId = Number(goal?.target?.itemId || 0);
    const template = templateFor(selfId);
    const basePrice = Number(template?.template?.price || 0);
    const adena = Math.max(0, Number(state?.adena || 0));
    if (!selfId || !template || basePrice <= 0 || adena <= 0) return null;
    if (goal.type === 'upgrade_gear' && Number(template.etc?.slot || 0) > 0
        && Number(state?.inventory?.[String(selfId)]?.amount || 0) > 0) return null;

    // `state.adena` already holds the order's escrow (callers add it).
    const reserve = Math.max(Number(goal.plan?.reserve || 0), PurchaseFunding.operatingReserve(state));
    const spendable = Math.max(0, adena - reserve);
    const pricingItem = { selfId, basePrice };
    const fairPrice = BotMarketPricing.priceAt(pricingItem, 0.85);
    // Older generic equipment goals stored the unscaled template value as
    // their budget. Revalue those estimates; keep concrete offer limits.
    const legacyEstimate = goal.type === 'upgrade_gear' && !goal.plan?.priceSource
        && !goal.plan?.marketTown && Number(goal.target.adena) === basePrice
        && Number(goal.plan?.estimatedCost) === basePrice;
    const referenceEstimate = goal.plan?.priceSource === 'reference' || legacyEstimate;
    const requestedPrice = referenceEstimate ? fairPrice
        : Math.max(0, Number(goal.target.adena || goal.plan?.estimatedCost || 0));
    const reviewedMaterialOffer = goal.type === 'buy_craft_material'
        && goal.plan?.priceSource === 'offer' && requestedPrice > 0
        && ['afk_bot_store', 'afk_player_store'].includes(goal.plan?.sourceType);
    const price = Math.floor(Math.min(reviewedMaterialOffer ? requestedPrice : fairPrice,
        requestedPrice || fairPrice, spendable));
    if (price < BotMarketPricing.listingFloor(pricingItem)) return null;

    const requestedCount = goal.type === 'buy_craft_material'
        ? Math.max(1, Math.floor(Number(goal.target.amount) || 1))
        : 1;
    const count = Math.min(requestedCount, Math.floor(spendable / price));
    if (count <= 0) return null;
    return {
        selfId,
        name: goal.target.itemName || template.template?.name || `Item ${selfId}`,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        price,
        count
    };
}

// A bot in a market town asks for the item it could not find: a buy ad on
// the board (step 3.3) whose escrow leaves its wallet, in the town it stands
// in. The author's budget-backed stall (money left in the wallet, the bot
// waiting in town) is gone; the bot goes back to its hunt and its next save
// brings what the ad bought.
function open(state, goal) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, opened: false, reason: 'not_shopping' });
    }
    const town = state.currentRegion || goal?.plan?.marketTown || 'Giran';
    return invoke('GameServer/Bot/Economy/BotAfkMarketService').openBuyAd(state, goal, town).then((result) => {
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

async function sellToBestBuyer(state, town = state?.currentRegion) {
    let seller = state;
    const sales = [];
    const peerMarketLines = ItemDisposition.saleCandidates(state, { limit: 20 })
        .filter((line) => !ItemDisposition.isNpcOnlyItem(line));
    for (const line of peerMarketLines) {
        const result = await settleLine(seller, line, town);
        seller = result.state || seller;
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

function bestTownFor(state) {
    const candidates = ItemDisposition.saleCandidates(state, { limit: 20 })
        .filter((item) => !ItemDisposition.isNpcOnlyItem(item));
    const towns = [...new Set(candidates.flatMap((item) => MarketOpportunity.findBuyOffers(item.selfId, {
        sellerCharacterId: state.characterId
    }).map((offer) => offer.town)).filter(Boolean))];
    return towns.map((town) => {
        const value = candidates.reduce((sum, item) => {
            const offer = MarketOpportunity.bestBuyOffer(item.selfId, { town, sellerCharacterId: state.characterId });
            return sum + (offer ? Math.min(Number(item.count), Number(offer.count)) * Number(offer.price) : 0);
        }, 0);
        return { town, value };
    }).filter((entry) => entry.value > 0)
        .sort((left, right) => right.value - left.value || left.town.localeCompare(right.town))[0] || null;
}

module.exports = {
    closeSoldOutStore,
    bestTownFor,
    bidFor,
    open,
    sellToBestBuyer
};

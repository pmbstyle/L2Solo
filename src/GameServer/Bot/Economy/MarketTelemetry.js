const RECENT_TRADE_LIMIT = 100;

const counters = {
    listingsOpened: 0,
    speculativeListings: 0,
    purchases: 0,
    itemsSold: 0,
    adenaTraded: 0,
    peerPurchases: 0,
    peerPurchaseItems: 0,
    peerPurchaseAdena: 0,
    npcPurchases: 0,
    npcPurchaseItems: 0,
    npcPurchaseAdena: 0,
    noOffer: 0,
    offerChanged: 0,
    purchaseFailed: 0,
    soldOut: 0,
    expired: 0,
    expiredItems: 0,
    demandClosed: 0,
    demandPrunedItems: 0,
    staticBuyerSales: 0,
    staticBuyerItems: 0,
    staticBuyerAdena: 0,
    buyStoresOpened: 0,
    dynamicBuyerSales: 0,
    dynamicBuyerItems: 0,
    dynamicBuyerAdena: 0
};
let previous = { ...counters };
let tradeSequence = 0;
const recentPeerTrades = [];
const recentPlayerTrades = [];
const recentStaticTrades = [];
const recentNpcTrades = [];
const itemTotals = new Map();
const townTotals = new Map();

function add(key, amount = 1) { counters[key] = Number(counters[key] || 0) + Number(amount || 0); }

function boundedPush(target, value) {
    target.unshift(value);
    if (target.length > RECENT_TRADE_LIMIT) target.length = RECENT_TRADE_LIMIT;
}

function party(characterId, name) {
    const id = Number(characterId || 0);
    return { characterId: id || null, name: name || null };
}

function channelTotals(container, channel) {
    const channels = container.channels || {};
    const current = channels[channel] || { trades: 0, items: 0, adena: 0 };
    channels[channel] = current;
    container.channels = channels;
    return current;
}

function incrementTotals(container, trade) {
    container.trades = Number(container.trades || 0) + 1;
    container.items = Number(container.items || 0) + trade.quantity;
    container.adena = Number(container.adena || 0) + trade.adena;
    const channel = channelTotals(container, trade.channel);
    channel.trades += 1;
    channel.items += trade.quantity;
    channel.adena += trade.adena;
}

function recordTrade(details = {}) {
    const quantity = Math.max(1, Math.floor(Number(details.quantity) || 1));
    const unitPrice = Math.max(0, Math.floor(Number(details.unitPrice ?? details.price) || 0));
    const selfId = Number(details.selfId || 0);
    const channel = details.channel || 'wts';
    const trade = {
        id: ++tradeSequence,
        at: Math.max(1, Number(details.at) || Date.now()),
        channel,
        sourceType: details.sourceType || channel,
        selfId,
        itemName: details.itemName || `Item ${selfId || '?'}`,
        quantity,
        unitPrice,
        adena: unitPrice * quantity,
        town: details.town || null,
        seller: party(details.sellerCharacterId, details.sellerName),
        buyer: party(details.buyerCharacterId, details.buyerName)
    };

    if (channel === 'static_wtb') boundedPush(recentStaticTrades, trade);
    else if (channel === 'npc_buy') boundedPush(recentNpcTrades, trade);
    else if (channel === 'player_wts' || channel === 'fixed_wts') boundedPush(recentPlayerTrades, trade);
    else boundedPush(recentPeerTrades, trade);

    const item = itemTotals.get(selfId) || {
        selfId,
        name: trade.itemName,
        trades: 0,
        items: 0,
        adena: 0,
        channels: {}
    };
    incrementTotals(item, trade);
    itemTotals.set(selfId, item);

    const townName = trade.town || 'Unknown';
    const town = townTotals.get(townName) || { town: townName, trades: 0, items: 0, adena: 0, channels: {} };
    incrementTotals(town, trade);
    townTotals.set(townName, town);
    return trade;
}

function transactions() {
    const byItem = Array.from(itemTotals.values())
        .map((item) => ({ ...item, channels: { ...item.channels } }));
    const peerValue = (entry, key) => Number(entry.channels?.wts?.[key] || 0) + Number(entry.channels?.wtb?.[key] || 0);
    const peerOnly = (entry) => ({
        ...entry,
        trades: peerValue(entry, 'trades'),
        items: peerValue(entry, 'items'),
        adena: peerValue(entry, 'adena'),
        channels: { ...entry.channels }
    });
    const byTown = Array.from(townTotals.entries()).map(([town, value]) => [town, {
        ...value,
        channels: { ...value.channels }
    }]);
    return {
        recentPeerTrades: recentPeerTrades.map((trade) => ({ ...trade })),
        recentPlayerTrades: recentPlayerTrades.map((trade) => ({ ...trade })),
        recentStaticTrades: recentStaticTrades.map((trade) => ({ ...trade })),
        recentNpcTrades: recentNpcTrades.map((trade) => ({ ...trade })),
        byItem: byItem
            .sort((left, right) => right.adena - left.adena || right.items - left.items || left.selfId - right.selfId)
            .slice(0, 50),
        byPeerItem: byItem
            .map(peerOnly)
            .filter((item) => item.trades > 0)
            .sort((left, right) => peerValue(right, 'adena') - peerValue(left, 'adena')
                || peerValue(right, 'items') - peerValue(left, 'items')
                || left.selfId - right.selfId)
            .slice(0, 50),
        byTown: Object.fromEntries(byTown),
        byPeerTown: Object.fromEntries(byTown
            .map(([town, value]) => [town, peerOnly(value)])
            .filter(([, town]) => town.trades > 0))
    };
}

function reset() {
    Object.keys(counters).forEach((key) => { counters[key] = 0; });
    previous = { ...counters };
    tradeSequence = 0;
    recentPeerTrades.length = 0;
    recentPlayerTrades.length = 0;
    recentStaticTrades.length = 0;
    recentNpcTrades.length = 0;
    itemTotals.clear();
    townTotals.clear();
}

module.exports = {
    RECENT_TRADE_LIMIT,
    listingOpened(details = {}) {
        add('listingsOpened');
        if (details.speculative) add('speculativeListings');
    },
    buyStoreOpened() { add('buyStoresOpened'); },
    purchase(offer, quantity = 1, context = {}) {
        const count = Math.max(1, Number(quantity) || 1);
        const adena = Math.max(0, Number(offer?.price || 0)) * count;
        const npc = offer?.sourceType === 'npc';
        const peer = offer?.sourceType === 'cold_store'
            || (offer?.sourceType === 'private_store' && offer?.sellerKind === 'bot');
        const channel = npc
            ? 'npc_buy'
            : peer
                ? 'wts'
                : offer?.sellerKind === 'fixed'
                    ? 'fixed_wts'
                    : 'player_wts';
        add('purchases');
        add('itemsSold', count);
        add('adenaTraded', adena);
        if (npc) {
            add('npcPurchases');
            add('npcPurchaseItems', count);
            add('npcPurchaseAdena', adena);
        } else if (peer) {
            add('peerPurchases');
            add('peerPurchaseItems', count);
            add('peerPurchaseAdena', adena);
        }
        return recordTrade({
            channel,
            sourceType: offer?.sourceType,
            selfId: offer?.selfId,
            itemName: offer?.itemName,
            quantity: count,
            unitPrice: offer?.price,
            town: offer?.town || context.town,
            sellerCharacterId: offer?.sourceType === 'npc' ? null : offer?.sourceId,
            sellerName: offer?.sourceName,
            buyerCharacterId: context.buyerCharacterId,
            buyerName: context.buyerName
        });
    },
    noOffer() { add('noOffer'); },
    offerChanged() { add('offerChanged'); },
    purchaseFailed() { add('purchaseFailed'); },
    closed(reason, items = 0) {
        if (reason === 'sold_out') add('soldOut');
        if (reason === 'expired') { add('expired'); add('expiredItems', Math.max(0, Number(items) || 0)); }
        if (reason === 'no_actionable_demand') add('demandClosed');
    },
    demandPruned(items = 0) { add('demandPrunedItems', Math.max(0, Number(items) || 0)); },
    staticBuyerSale(items = 0, adena = 0, context = {}) {
        const lines = Array.isArray(items) ? items : null;
        const itemCount = lines
            ? lines.reduce((sum, item) => sum + Math.max(0, Number(item.count || 0)), 0)
            : Math.max(0, Number(items) || 0);
        const totalAdena = lines
            ? lines.reduce((sum, item) => sum + Math.max(0, Number(item.count || 0)) * Math.max(0, Number(item.npcPrice || 0)), 0)
            : Math.max(0, Number(adena) || 0);
        add('staticBuyerSales');
        add('staticBuyerItems', itemCount);
        add('staticBuyerAdena', totalAdena);
        (lines || []).forEach((item) => recordTrade({
            channel: 'static_wtb',
            sourceType: 'static_buy_store',
            selfId: item.selfId,
            itemName: item.name,
            quantity: item.count,
            unitPrice: item.npcPrice,
            town: item.buyerTown || context.town,
            sellerCharacterId: context.sellerCharacterId,
            sellerName: context.sellerName,
            buyerName: item.buyerName
        }));
    },
    dynamicBuyerSale(offer, quantity = 1, context = {}) {
        const count = Math.max(1, Number(quantity) || 1);
        const adena = Math.max(0, Number(offer?.price || 0)) * count;
        add('dynamicBuyerSales');
        add('dynamicBuyerItems', count);
        add('dynamicBuyerAdena', adena);
        return recordTrade({
            channel: 'wtb',
            sourceType: offer?.sourceType,
            selfId: offer?.selfId,
            itemName: offer?.itemName,
            quantity: count,
            unitPrice: offer?.price,
            town: offer?.town || context.town,
            sellerCharacterId: context.sellerCharacterId,
            sellerName: context.sellerName,
            buyerCharacterId: offer?.sourceId,
            buyerName: offer?.sourceName
        });
    },
    recordTrade,
    transactions,
    reset,
    current() { return { ...counters }; },
    snapshot() {
        const delta = Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - previous[key]]));
        previous = { ...counters };
        return { total: { ...counters }, delta };
    }
};

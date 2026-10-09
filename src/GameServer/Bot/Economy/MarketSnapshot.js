const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const MarketTradeOverviewReader = invoke('MarketTradeOverviewReader');
const World = invoke('GameServer/World/World');
const MarketEconomyOverview = require('../../../MarketEconomyOverview');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');

function emptyTown() {
    return { dynamicWts: 0, dynamicWtb: 0, fixedWts: 0, fixedWtb: 0, sellLines: 0, buyLines: 0, sellUnits: 0, buyUnits: 0 };
}

function addItem(items, line, side, town) {
    const selfId = Number(line?.selfId || 0);
    const count = Math.max(0, Number(line?.count || 0));
    if (!selfId || count <= 0) return;
    const entry = items.get(selfId) || {
        selfId,
        name: line.name || `Item ${selfId}`,
        wtsUnits: 0,
        wtbUnits: 0,
        activeDemandWtsUnits: 0,
        speculativeWtsUnits: 0,
        minimumWtsPrice: Infinity,
        maximumWtbPrice: 0,
        towns: {}
    };
    entry[side === 'wts' ? 'wtsUnits' : 'wtbUnits'] += count;
    if (side === 'wts') {
        if (line.marketReason === 'speculative_demand') entry.speculativeWtsUnits += count;
        else entry.activeDemandWtsUnits += count;
        if (Number(line.price || 0) > 0) entry.minimumWtsPrice = Math.min(entry.minimumWtsPrice, Number(line.price));
    } else if (Number(line.price || 0) > 0) {
        entry.maximumWtbPrice = Math.max(entry.maximumWtbPrice, Number(line.price));
    }
    if (town) {
        const townEntry = entry.towns[town] || { wtsUnits: 0, wtbUnits: 0 };
        townEntry[side === 'wts' ? 'wtsUnits' : 'wtbUnits'] += count;
        entry.towns[town] = townEntry;
    }
    items.set(selfId, entry);
}

function snapshot() {
    const byTown = {};
    const items = new Map();
    const dynamicStores = AfkTrade.activeShops().filter((shop) => String(shop.ownerAccount || '').startsWith('bot_'))
        .map((shop) => ({ storeType: shop.storeType, side: Number(shop.storeType) === 3 ? 'wtb' : 'wts',
            source: 'afk_bot', kind: shop.kind || 'shop', custodyPolicy: shop.custodyPolicy,
            conditional: Number(shop.custodyPolicy) === 1, town: shop.town, items: shop.lines || [] }));
    const bids = publicBuyOffers(dynamicStores);
    dynamicStores.forEach((store) => {
        const side = Number(store.storeType || 1) === 3 ? 'wtb' : 'wts';
        const town = store.town || 'Unknown';
        const townEntry = byTown[town] || emptyTown();
        townEntry[side === 'wts' ? 'dynamicWts' : 'dynamicWtb'] += 1;
        (store.items || []).forEach((line) => {
            const count = Math.max(0, Number(line.count || 0));
            townEntry[side === 'wts' ? 'sellLines' : 'buyLines'] += count > 0 ? 1 : 0;
            townEntry[side === 'wts' ? 'sellUnits' : 'buyUnits'] += count;
            addItem(items, line, side, town);
        });
        byTown[town] = townEntry;
    });

    Object.values(MerchantStoreConfigs).forEach((store) => {
        if (![1, 3].includes(Number(store?.storeType)) || !store.town) return;
        const townEntry = byTown[store.town] || emptyTown();
        townEntry[Number(store.storeType) === 3 ? 'fixedWtb' : 'fixedWts'] += 1;
        byTown[store.town] = townEntry;
    });

    const rankedItems = Array.from(items.values()).sort((left, right) => (
        (right.wtbUnits + right.wtsUnits) - (left.wtbUnits + left.wtsUnits) || left.selfId - right.selfId
    )).slice(0, 20).map((item) => {
        return {
            ...item,
            minimumWtsPrice: Number.isFinite(item.minimumWtsPrice) ? item.minimumWtsPrice : null,
            maximumWtbPrice: item.maximumWtbPrice || null,
            publicDemand: bids.get(item.selfId) || emptyPublicDemand()
        };
    });
    return {
        dynamic: {
            wts: dynamicStores.filter((store) => Number(store.storeType || 1) === 1).length,
            wtb: dynamicStores.filter((store) => Number(store.storeType) === 3).length
        },
        fixed: {
            wts: Object.values(MerchantStoreConfigs).filter((store) => Number(store?.storeType) === 1).length,
            wtb: Object.values(MerchantStoreConfigs).filter((store) => Number(store?.storeType) === 3).length
        },
        activity: MarketTelemetry.current(),
        transactions: MarketTelemetry.transactions(),
        byTown,
        topItems: rankedItems.slice(0, 20)
    };
}

function cachedItemsById() {
    return new Map((DataCache.items || []).map((item) => [Number(item.selfId), item]));
}

function itemMeta(selfId, itemsById = cachedItemsById()) {
    const item = itemsById.get(Number(selfId));
    return {
        selfId: Number(selfId),
        name: item?.template?.name || `Item ${Number(selfId)}`,
        kind: item?.template?.kind || null
    };
}

function normalizeStoreItems(items = [], itemsById = cachedItemsById(), priceFor = null) {
    return (items || []).map((line) => {
        const selfId = Number(line?.selfId || 0);
        const count = Math.max(0, Math.floor(Number(line?.count || 0)));
        const meta = itemMeta(selfId, itemsById);
        const price = Math.max(0, Math.floor(Number(priceFor ? priceFor(line) : line?.price) || 0));
        return selfId > 0 && count > 0 ? {
            selfId,
            name: line.name || meta.name,
            kind: line.kind || meta.kind,
            count,
            price,
            enchant: Math.max(0, Math.floor(Number(line.enchant || 0))),
            marketReason: line.marketReason || null
        } : null;
    }).filter(Boolean);
}

function storeRow({ id, source, ownerId = null, ownerName, storeType, title = '', town = null, loc = null,
    items = [], conditional = false, kind = 'shop', custodyPolicy = null, expiresAt = null }) {
    const type = Number(storeType) === 3 ? 3 : 1;
    return {
        id: String(id),
        source: String(source), conditional: !!conditional, kind, custodyPolicy, expiresAt,
        ownerId: Number(ownerId) || null,
        ownerName: ownerName || 'Unknown trader',
        storeType: type,
        side: type === 3 ? 'wtb' : 'wts',
        title: String(title || ''),
        town: town || 'Unknown',
        loc: loc && !['sell_ad', 'buy_ad', 'order'].includes(kind) ? {
            locX: Number(loc.locX || 0),
            locY: Number(loc.locY || 0),
            locZ: Number(loc.locZ || 0)
        } : null,
        items
    };
}

function fixedStores(itemsById) {
    return Object.entries(MerchantStoreConfigs).flatMap(([ownerName, store]) => {
        if (![1, 3].includes(Number(store?.storeType))) return [];
        const items = normalizeStoreItems(store.items, itemsById, (line) => (
            StaticMerchantPricing.priceFor(store, line)
        )).filter((line) => line.price > 0);
        if (!items.length) return [];
        return [storeRow({
            id: `fixed:${ownerName}`,
            source: 'fixed',
            ownerName,
            storeType: store.storeType,
            title: store.title,
            town: store.town,
            loc: store,
            items
        })];
    });
}

function playerStores(sessions, itemsById) {
    return (sessions || []).flatMap((session) => {
        const accountId = String(session?.accountId || '');
        const actor = session?.actor;
        const store = actor?.fetchPrivateStore?.();
        if (!actor || accountId.startsWith('bot_') || accountId.startsWith('afk_trade_') || ![1, 3].includes(Number(store?.storeType))) return [];
        const items = normalizeStoreItems(store.items, itemsById);
        if (!items.length) return [];
        const ownerId = Number(actor.fetchId?.() || 0);
        return [storeRow({
            id: `player:${ownerId}`,
            source: 'player',
            ownerId,
            ownerName: actor.fetchName?.() || session.name,
            storeType: store.storeType,
            title: store.title,
            town: store.town,
            loc: {
                locX: actor.fetchLocX?.(),
                locY: actor.fetchLocY?.(),
                locZ: actor.fetchLocZ?.()
            },
            items
        })];
    });
}

function afkStores(shops, itemsById) {
    return (shops || []).flatMap((shop) => {
        if (![1, 3].includes(Number(shop?.storeType))) return [];
        const items = normalizeStoreItems(shop.lines, itemsById);
        if (!items.length) return [];
        return [storeRow({
            id: `afk:${Number(shop.id)}`,
            conditional: shop.custodyPolicy === 1,
            kind: shop.kind || 'shop',
            custodyPolicy: shop.custodyPolicy ?? null,
            expiresAt: shop.expiresAt || null,
            source: String(shop.ownerAccount || '').startsWith('bot_') ? 'afk_bot' : 'afk_player',
            ownerId: shop.ownerId,
            ownerName: shop.ownerName,
            storeType: shop.storeType,
            title: shop.title,
            town: shop.town,
            loc: shop,
            items
        })];
    });
}

function emptyPublicDemand() {
    return { offers: 0, units: 0, reservedUnits: 0, conditionalUnits: 0, towns: {} };
}

// The Observer aggregates the public book once. Private wishes are not bids,
// and a quoted willingness to pay is not an escrow reservation.
function publicBuyOffers(stores) {
    const bids = new Map();
    for (const store of stores) {
        if (store.side !== 'wtb' || store.source === 'fixed') continue;
        for (const line of store.items || []) {
            const id = Number(line.selfId), units = Number(line.count);
            if (!(id > 0 && units > 0 && Number(line.price) > 0)) continue;
            const bid = bids.get(id) || emptyPublicDemand();
            bid.offers++;
            bid.units += units;
            if (store.conditional) bid.conditionalUnits += units;
            else if (store.custodyPolicy === 0) bid.reservedUnits += units;
            if (store.town) bid.towns[store.town] = (bid.towns[store.town] || 0) + units;
            bids.set(id, bid);
        }
    }
    return bids;
}

function buildDetail({ states = [], stores = [], transactions = MarketTelemetry.transactions(), history = null, now = Date.now(), itemsById = cachedItemsById() } = {}) {
    const items = new Map();
    const bids = publicBuyOffers(stores);
    const ensure = (selfId) => {
        const id = Number(selfId);
        if (!items.has(id)) {
            const meta = itemMeta(id, itemsById);
            items.set(id, {
                ...meta,
                wts: { stores: 0, units: 0, organicUnits: 0, fixedUnits: 0, minPrice: null, maxPrice: null },
                wtb: { stores: 0, units: 0, organicUnits: 0, fixedUnits: 0, minPrice: null, maxPrice: null },
                demand: { bots: 0, readyBots: 0, fundedBots: 0, units: 0, readyUnits: 0, fundedUnits: 0 },
                trades: 0,
                tradedUnits: 0,
                tradedAdena: 0,
                lastTradePrice: null,
                towns: [],
                sources: []
            });
        }
        return items.get(id);
    };

    const townSets = new Map();
    const sourceSets = new Map();
    stores.forEach((store) => {
        store.items.forEach((line) => {
            const item = ensure(line.selfId);
            const side = store.side === 'wtb' ? item.wtb : item.wts;
            side.stores += 1;
            side.units += Number(line.count || 0);
            side[store.source === 'fixed' ? 'fixedUnits' : 'organicUnits'] += Number(line.count || 0);
            if (Number(line.price || 0) > 0) {
                side.minPrice = side.minPrice === null ? Number(line.price) : Math.min(side.minPrice, Number(line.price));
                side.maxPrice = side.maxPrice === null ? Number(line.price) : Math.max(side.maxPrice, Number(line.price));
            }
            const towns = townSets.get(item.selfId) || new Set();
            towns.add(store.town || 'Unknown');
            townSets.set(item.selfId, towns);
            const sources = sourceSets.get(item.selfId) || new Set();
            sources.add(store.source);
            sourceSets.set(item.selfId, sources);
        });
    });

    const durableHistory = history?.scope ? history : null;
    const durableItemTotals = durableHistory?.byItem || transactions.byItem || [];
    const tradeTotals = new Map(durableItemTotals.map((entry) => [Number(entry.selfId), entry]));
    const recentTrades = durableHistory?.recent || [
        ...(transactions.recentPeerTrades || []),
        ...(transactions.recentPlayerTrades || []),
        ...(transactions.recentStaticTrades || []),
        ...(transactions.recentNpcTrades || [])
    ].sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
    recentTrades.forEach((trade) => ensure(trade.selfId));
    const lastTradePrices = new Map();
    recentTrades.forEach((trade) => {
        const selfId = Number(trade.selfId);
        if (!lastTradePrices.has(selfId)) lastTradePrices.set(selfId, trade.unitPrice);
    });

    items.forEach((item) => {
        const demand = bids.get(item.selfId) || emptyPublicDemand();
        item.publicDemand = demand;
        // Retain the legacy shape for older clients, without claiming funding.
        item.demand = {
            scope: 'public_buy_offers', bots: 0, readyBots: 0, fundedBots: 0,
            units: demand.units,
            readyUnits: demand.units,
            fundedUnits: 0,
            towns: demand.towns
        };
        const totals = tradeTotals.get(item.selfId);
        if (totals) {
            item.trades = Number(totals.trades || 0);
            item.tradedUnits = Number(totals.items || 0);
            item.tradedAdena = Number(totals.adena || 0);
        }
        item.lastTradePrice = lastTradePrices.get(item.selfId) ?? null;
        item.towns = [...(townSets.get(item.selfId) || [])].sort();
        item.sources = [...(sourceSets.get(item.selfId) || [])].sort();
    });

    const byTown = stores.reduce((summary, store) => {
        const town = summary[store.town] || { wts: 0, wtb: 0, fixedWts: 0, fixedWtb: 0, sellUnits: 0, buyUnits: 0 };
        if (store.source === 'fixed') town[store.side === 'wts' ? 'fixedWts' : 'fixedWtb'] += 1;
        else {
            town[store.side] += 1;
            town[store.side === 'wts' ? 'sellUnits' : 'buyUnits'] += store.items.reduce((sum, item) => sum + Number(item.count || 0), 0);
        }
        summary[store.town] = town;
        return summary;
    }, {});
    const totalTrades = Array.from(tradeTotals.values()).reduce((sum, item) => sum + Number(item.trades || 0), 0);
    const tradedAdena = Array.from(tradeTotals.values()).reduce((sum, item) => sum + Number(item.adena || 0), 0);

    return {
        generatedAt: now,
        historyScope: durableHistory?.scope || 'server_start',
        history: durableHistory ? {
            retentionDays: Number(durableHistory.retentionDays || 0),
            windows: durableHistory.windows || {}
        } : null,
        summary: {
            wtsStores: stores.filter((store) => store.side === 'wts').length,
            wtbStores: stores.filter((store) => store.side === 'wtb').length,
            sellUnits: stores.filter((store) => store.side === 'wts' && store.source !== 'fixed').reduce((sum, store) => sum + store.items.reduce((total, item) => total + Number(item.count || 0), 0), 0),
            buyUnits: stores.filter((store) => store.side === 'wtb' && store.source !== 'fixed').reduce((sum, store) => sum + store.items.reduce((total, item) => total + Number(item.count || 0), 0), 0),
            fixedSellUnits: stores.filter((store) => store.side === 'wts' && store.source === 'fixed').reduce((sum, store) => sum + store.items.reduce((total, item) => total + Number(item.count || 0), 0), 0),
            fixedBuyUnits: stores.filter((store) => store.side === 'wtb' && store.source === 'fixed').reduce((sum, store) => sum + store.items.reduce((total, item) => total + Number(item.count || 0), 0), 0),
            trades: totalTrades,
            tradedAdena
        },
        byTown,
        items: Array.from(items.values()).filter((item) => (
            item.wts.units > 0 || item.wtb.units > 0 || item.demand.units > 0 || item.trades > 0
        )).sort((left, right) => (
            (right.tradedAdena + right.wts.units + right.wtb.units + right.demand.fundedUnits)
            - (left.tradedAdena + left.wts.units + left.wtb.units + left.demand.fundedUnits)
            || left.selfId - right.selfId
        )),
        stores,
        transactions: {
            recent: recentTrades.slice(0, 200),
            byItem: durableItemTotals,
            byTown: durableHistory?.byTown || transactions.byTown || {}
        }
    };
}

async function detail() {
    const itemsById = cachedItemsById();
    const historyPath = Database.stats().historyPath;
    const [afk, history, storeHistory] = await Promise.all([
        Database.fetchAfkTradeShops(null, { activeOnly: true }),
        (historyPath ? MarketTradeOverviewReader.read(historyPath) : Database.fetchMarketTradeOverview())
            .catch(() => null),
        Database.fetchMarketStoreHistory().catch(() => null)
    ]);
    const stores = [
        ...fixedStores(itemsById),
        ...playerStores(World.user?.sessions || [], itemsById),
        ...afkStores(afk, itemsById)
    ];
    return { ...buildDetail({ stores, transactions: MarketTelemetry.transactions(), history, itemsById }), storeHistory,
        economy: { counters: MarketEconomyOverview.counterIndices(MarketCounters),
            adena: history?.economy || null } };
}

function history(selfId, options = {}) {
    return Database.fetchMarketTradeHistory(selfId, options);
}

module.exports = {
    afkStores,
    buildDetail,
    detail,
    fixedStores,
    history,
    playerStores,
    snapshot
};

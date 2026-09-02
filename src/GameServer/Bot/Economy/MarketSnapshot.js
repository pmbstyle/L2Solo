const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const TradeService = invoke('GameServer/Bot/TradeService');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');

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
    const states = LifeState.allStates(5000);
    const active = states.filter((state) => state.activity === 'merchant' && state.stats?.marketStore);
    active.forEach((state) => {
        const store = state.stats.marketStore;
        const side = Number(store.storeType || 1) === 3 ? 'wtb' : 'wts';
        const town = store.town || state.currentRegion || 'Unknown';
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

    const rankedItems = Array.from(items.values()).map((item) => {
        const demand = MarketDemandIndex.demandFor(item.selfId, {
            states,
            unitPrice: Number.isFinite(item.minimumWtsPrice) ? item.minimumWtsPrice : 0
        });
        return {
            ...item,
            minimumWtsPrice: Number.isFinite(item.minimumWtsPrice) ? item.minimumWtsPrice : null,
            maximumWtbPrice: item.maximumWtbPrice || null,
            demand: {
                bots: demand.bots,
                readyBots: demand.readyBots,
                fundedBots: demand.fundedBots,
                units: demand.units,
                readyUnits: demand.readyUnits,
                fundedUnits: demand.fundedUnits
            }
        };
    }).sort((left, right) => (
        (right.wtbUnits + right.wtsUnits) - (left.wtbUnits + left.wtsUnits) || left.selfId - right.selfId
    ));
    return {
        dynamic: {
            wts: active.filter((state) => Number(state.stats.marketStore.storeType || 1) === 1).length,
            wtb: active.filter((state) => Number(state.stats.marketStore.storeType) === 3).length
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

function storeRow({ id, source, ownerId = null, ownerName, storeType, title = '', town = null, loc = null, items = [] }) {
    const type = Number(storeType) === 3 ? 3 : 1;
    return {
        id: String(id),
        source: String(source),
        ownerId: Number(ownerId) || null,
        ownerName: ownerName || 'Unknown trader',
        storeType: type,
        side: type === 3 ? 'wtb' : 'wts',
        title: String(title || ''),
        town: town || 'Unknown',
        loc: loc ? {
            locX: Number(loc.locX || 0),
            locY: Number(loc.locY || 0),
            locZ: Number(loc.locZ || 0)
        } : null,
        items
    };
}

function dynamicStores(states, itemsById) {
    return states.flatMap((state) => {
        const store = state?.stats?.marketStore;
        if (state?.activity !== 'merchant' || !store) return [];
        const items = normalizeStoreItems(store.items, itemsById);
        if (!items.length) return [];
        return [storeRow({
            id: `bot:${Number(state.characterId)}`,
            source: 'bot',
            ownerId: state.characterId,
            ownerName: state.name || store.sellerName || store.buyerName,
            storeType: store.storeType,
            title: store.title,
            town: store.town || state.currentRegion,
            loc: store.loc || state.loc,
            items
        })];
    });
}

function fixedStores(itemsById) {
    return Object.entries(MerchantStoreConfigs).flatMap(([ownerName, store]) => {
        if (![1, 3].includes(Number(store?.storeType))) return [];
        const items = normalizeStoreItems(store.items, itemsById, (line) => (
            line.price ?? TradeService.ratedPrice(line.selfId, line.priceRate ?? 1)
        ));
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
            source: 'afk_player',
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

function demandItemIds(states) {
    const ids = new Set();
    (states || []).forEach((state) => {
        const wanted = Number(state?.stats?.marketWanted?.itemId || 0);
        const target = Number(state?.stats?.equipmentPlan?.target?.selfId || 0);
        if (wanted > 0) ids.add(wanted);
        if (target > 0) ids.add(target);
        (state?.stats?.equipmentPlan?.materials || []).forEach((material) => {
            if (Number(material?.selfId || 0) > 0 && Number(material?.missing || 0) > 0) ids.add(Number(material.selfId));
        });
    });
    return ids;
}

function buildDetail({ states = [], stores = [], transactions = MarketTelemetry.transactions(), history = null, now = Date.now(), itemsById = cachedItemsById() } = {}) {
    const items = new Map();
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

    demandItemIds(states).forEach(ensure);
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

    items.forEach((item) => {
        const demand = MarketDemandIndex.demandFor(item.selfId, {
            states,
            now,
            unitPrice: Number(item.wts.minPrice || 0)
        });
        item.demand = {
            bots: demand.bots,
            readyBots: demand.readyBots,
            fundedBots: demand.fundedBots,
            units: demand.units,
            readyUnits: demand.readyUnits,
            fundedUnits: demand.fundedUnits,
            towns: demand.towns
        };
        const totals = tradeTotals.get(item.selfId);
        if (totals) {
            item.trades = Number(totals.trades || 0);
            item.tradedUnits = Number(totals.items || 0);
            item.tradedAdena = Number(totals.adena || 0);
        }
        item.lastTradePrice = recentTrades.find((trade) => Number(trade.selfId) === item.selfId)?.unitPrice ?? null;
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
    const states = LifeState.allStates(5000);
    const [afk, history] = await Promise.all([
        Database.fetchAfkTradeShops(null, { activeOnly: true }).catch(() => []),
        Database.fetchMarketTradeOverview().catch(() => null)
    ]);
    const stores = [
        ...dynamicStores(states, itemsById),
        ...fixedStores(itemsById),
        ...playerStores(World.user?.sessions || [], itemsById),
        ...afkStores(afk, itemsById)
    ];
    return buildDetail({ states, stores, transactions: MarketTelemetry.transactions(), history, itemsById });
}

function history(selfId, options = {}) {
    return Database.fetchMarketTradeHistory(selfId, options);
}

module.exports = {
    afkStores,
    buildDetail,
    detail,
    dynamicStores,
    fixedStores,
    history,
    playerStores,
    snapshot
};

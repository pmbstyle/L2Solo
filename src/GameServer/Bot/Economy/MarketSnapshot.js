const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');

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
        towns: {}
    };
    entry[side === 'wts' ? 'wtsUnits' : 'wtbUnits'] += count;
    if (side === 'wts') {
        if (line.marketReason === 'speculative_demand') entry.speculativeWtsUnits += count;
        else entry.activeDemandWtsUnits += count;
        if (Number(line.price || 0) > 0) entry.minimumWtsPrice = Math.min(entry.minimumWtsPrice, Number(line.price));
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

module.exports = { snapshot };

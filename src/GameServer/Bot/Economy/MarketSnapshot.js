const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

function emptyTown() {
    return { dynamicWts: 0, dynamicWtb: 0, fixedWts: 0, fixedWtb: 0, sellLines: 0, buyLines: 0, sellUnits: 0, buyUnits: 0 };
}

function addItem(items, line, side, town) {
    const selfId = Number(line?.selfId || 0);
    const count = Math.max(0, Number(line?.count || 0));
    if (!selfId || count <= 0) return;
    const entry = items.get(selfId) || { selfId, name: line.name || `Item ${selfId}`, wtsUnits: 0, wtbUnits: 0, towns: {} };
    entry[side === 'wts' ? 'wtsUnits' : 'wtbUnits'] += count;
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
    const active = LifeState.allStates(5000).filter((state) => state.activity === 'merchant' && state.stats?.marketStore);
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

    const rankedItems = Array.from(items.values()).sort((left, right) => (
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
        byTown,
        topItems: rankedItems.slice(0, 20)
    };
}

module.exports = { snapshot };

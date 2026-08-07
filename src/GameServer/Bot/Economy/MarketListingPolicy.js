const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');

const MARKET_GEAR_MIN_BASE_PRICE = ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE;

let newbieItemSource = null;
let newbieItemIds = new Set();

function starterItemIds() {
    const source = DataCache.newbieItems || [];
    if (newbieItemSource !== source) {
        newbieItemSource = source;
        newbieItemIds = new Set(source.flatMap((row) => (row.items || []).map((item) => Number(item.selfId || 0))).filter(Boolean));
    }
    return newbieItemIds;
}

function isGear(item = {}) {
    return String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
}

function classify(state, item, options = {}) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (starterItemIds().has(Number(item.selfId))) {
        return { action: 'npc', reason: 'starter_kit' };
    }
    if (isGear(item) && Number(item.basePrice || 0) <= MARKET_GEAR_MIN_BASE_PRICE) {
        return { action: 'npc', reason: 'low_value_gear' };
    }

    const market = MarketDemandIndex.snapshot(item.selfId, {
        ...options,
        excludeCharacterId: state.characterId
    });
    if (market.demand.bots <= 0) {
        return { action: 'warehouse', reason: 'no_demand', market };
    }
    const saturationFloor = Math.max(3, market.demand.units * 2);
    if (market.supply.units >= saturationFloor) {
        return { action: 'warehouse', reason: 'saturated', market };
    }
    return { action: 'list', reason: market.demand.readyBots > 0 ? 'active_demand' : 'latent_demand', market };
}

function listingPrice(item, decision) {
    const competition = Number(decision?.market?.supply?.minimumPrice || Infinity);
    if (!Number.isFinite(competition) || competition <= 0) return Number(item.price);
    return Math.max(1, Math.min(Number(item.price), Math.floor(competition * 0.98)));
}

function evaluate(state, options = {}) {
    const candidates = ItemDisposition.saleCandidates(state, options);
    const decisions = candidates.map((item) => {
        const decision = classify(state, item, options);
        return {
            ...decision,
            item: decision.action === 'list' ? { ...item, price: listingPrice(item, decision) } : item
        };
    });
    return {
        candidates,
        decisions,
        listings: decisions.filter((decision) => decision.action === 'list').map((decision) => decision.item),
        npc: decisions.filter((decision) => decision.action === 'npc').map((decision) => ({
            ...decision.item,
            npcPrice: Math.max(1, Math.floor(Number(decision.item.basePrice || 0) * 0.5))
        })),
        warehouse: decisions.filter((decision) => decision.action === 'warehouse').map((decision) => decision.item)
    };
}

module.exports = { MARKET_GEAR_MIN_BASE_PRICE, classify, evaluate, isGear, listingPrice, starterItemIds };

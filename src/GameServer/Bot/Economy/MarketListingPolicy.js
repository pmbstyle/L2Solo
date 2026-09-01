const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const ProgressionRates = invoke('GameServer/ProgressionRates');

const MARKET_GEAR_MIN_BASE_PRICE = ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE;
const SPECULATIVE_GEAR_MIN_BASE_PRICE = 10000;
const SPECULATIVE_SUPPLY_LIMIT = 1;
const MIN_LISTING_BASE_PERCENT = 60;

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

function allowsLowGradeMarket() {
    return ['x1', 'x10'].includes(ProgressionRates.profile().preset);
}

function listOrWarehouse(item, decision) {
    if (listingPrice(item, decision) !== null) return decision;
    return { action: 'warehouse', reason: 'non_competitive_floor', market: decision.market };
}

function classify(state, item, options = {}) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (ItemDisposition.isNpcOnlyItem(item)) {
        return { action: 'npc', reason: 'npc_only_item' };
    }
    if (starterItemIds().has(Number(item.selfId))) {
        return { action: 'npc', reason: 'starter_kit' };
    }
    const lowGradeGear = isGear(item)
        && ItemDisposition.gradeIndex(item.rank) < ItemDisposition.gradeIndex('c');
    if (lowGradeGear && !allowsLowGradeMarket()) {
        return { action: 'npc', reason: 'low_grade_high_rate' };
    }
    if (isGear(item) && !lowGradeGear && Number(item.basePrice || 0) <= MARKET_GEAR_MIN_BASE_PRICE) {
        return { action: 'npc', reason: 'low_value_gear' };
    }

    const market = MarketDemandIndex.snapshot(item.selfId, {
        ...options,
        unitPrice: Number(item.price || 0),
        excludeCharacterId: state.characterId
    });
    if (market.demand.bots <= 0) {
        if (lowGradeGear) return { action: 'npc', reason: 'low_grade_no_funded_demand', market };
        return { action: 'warehouse', reason: 'no_demand', market };
    }
    const actionableUnits = Math.max(0, Number(market.demand.fundedUnits || 0));
    if (actionableUnits > 0) {
        const availableUnits = Math.max(0, actionableUnits - market.supply.units);
        if (availableUnits <= 0) return { action: 'warehouse', reason: 'saturated', market };
        return listOrWarehouse(item, {
            action: 'list',
            reason: 'active_demand',
            listCount: Math.min(Number(item.count), availableUnits),
            market
        });
    }

    if (market.demand.readyBots > 0) {
        if (lowGradeGear) return { action: 'npc', reason: 'low_grade_no_funded_demand', market };
        return { action: 'warehouse', reason: 'unfunded_demand', market };
    }
    if (lowGradeGear) {
        return { action: 'npc', reason: 'low_grade_no_funded_demand', market };
    }
    const speculative = isGear(item)
        && Number(item.basePrice || 0) >= SPECULATIVE_GEAR_MIN_BASE_PRICE
        && market.supply.units < SPECULATIVE_SUPPLY_LIMIT;
    if (speculative) {
        return listOrWarehouse(item, {
            action: 'list',
            reason: 'speculative_demand',
            listCount: Math.min(Number(item.count), SPECULATIVE_SUPPLY_LIMIT - market.supply.units),
            market
        });
    }
    if (market.supply.units >= SPECULATIVE_SUPPLY_LIMIT) {
        return { action: 'warehouse', reason: 'saturated', market };
    }
    return { action: 'warehouse', reason: 'latent_demand', market };
}

function listingFloor(item) {
    const basePrice = Math.max(0, Number(item?.basePrice || 0));
    if (basePrice <= 0) return 1;
    return BotEconomyPricing.scalePrice(basePrice * MIN_LISTING_BASE_PERCENT / 100);
}

function listingPrice(item, decision) {
    const preferred = Math.max(1, Math.floor(Number(item.price || 0)));
    const minimum = listingFloor(item);
    const competition = Number(decision?.market?.supply?.minimumPrice || Infinity);
    if (!Number.isFinite(competition) || competition <= 0) return Math.max(minimum, preferred);
    const competitivePrice = Math.floor(competition * 0.98);
    if (minimum > competitivePrice) return null;
    return Math.max(minimum, Math.min(preferred, competitivePrice));
}

function evaluate(state, options = {}) {
    const marketCandidates = ItemDisposition.saleCandidates(state, options);
    const npcCandidates = ItemDisposition.saleCandidates(state, {
        ...options,
        onlyNpc: true,
        unlimited: true
    });
    const marketIds = new Set(marketCandidates.map((item) => Number(item.selfId)));
    const candidates = [
        ...marketCandidates,
        ...npcCandidates.filter((item) => !marketIds.has(Number(item.selfId)))
    ];
    const decisions = candidates.map((item) => {
        const decision = classify(state, item, options);
        return {
            ...decision,
            item: decision.action === 'list' ? {
                ...item,
                count: Math.max(1, Math.min(Number(item.count), Number(decision.listCount || item.count))),
                price: listingPrice(item, decision),
                marketReason: decision.reason
            } : item
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

module.exports = {
    MARKET_GEAR_MIN_BASE_PRICE,
    MIN_LISTING_BASE_PERCENT,
    SPECULATIVE_GEAR_MIN_BASE_PRICE,
    SPECULATIVE_SUPPLY_LIMIT,
    allowsLowGradeMarket,
    classify,
    evaluate,
    isGear,
    listingFloor,
    listingPrice,
    starterItemIds
};

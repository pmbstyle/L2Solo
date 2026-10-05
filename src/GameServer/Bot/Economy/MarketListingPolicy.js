const LotPolicy = require('./MarketLotPolicy');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const EMPTY_SUPPLY = new Map();
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const MarketBuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ProgressionRates = invoke('GameServer/ProgressionRates');

const MARKET_GEAR_MIN_BASE_PRICE = ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE;
const SPECULATIVE_GEAR_MIN_BASE_PRICE = 10000;
const SPECULATIVE_SUPPLY_LIMIT = 1;
const MIN_LISTING_BASE_PERCENT = 60;
const NPC_SURPLUS_GEAR_MAX_BASE_PRICE = 50000;

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
    const price = listingPrice(item, decision);
    if (price !== null && LotPolicy.viable({ ...item, count: decision.listCount ?? item.count, price })) return decision;
    return surplusGearDecision(item, 'non_competitive_floor', decision.market);
}

function surplusGearDecision(item, reason, market) {
    // The warehouse does not take recipes and NPC liquidation skips market
    // recipes: an unlisted one stays in the bag, where a crafter's recipe
    // request finds its holder.
    if (ItemDisposition.isMarketRecipeItem(item)) return { action: 'keep', reason, market };
    const ordinary = item.npcComparable !== false && Number(item.enchant || 0) <= 0;
    const common = isGear(item) && ordinary
        && Number(item.basePrice || 0) <= NPC_SURPLUS_GEAR_MAX_BASE_PRICE;
    return { action: common ? 'npc' : 'warehouse', reason, market };
}

function classify(state, item, options = {}) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (!LotPolicy.viable(item)) return { action: 'warehouse', reason: 'small_material_lot' };
    if (ItemDisposition.isNpcOnlyItem(item)) {
        return { action: 'npc', reason: 'npc_only_item' };
    }
    if (starterItemIds().has(Number(item.selfId))) {
        return isGear(item) ? surplusGearDecision(item, 'starter_kit')
            : { action: 'npc', reason: 'starter_kit' };
    }
    const lowGradeGear = isGear(item)
        && ItemDisposition.gradeIndex(item.rank) < ItemDisposition.gradeIndex('c');
    if (lowGradeGear && !allowsLowGradeMarket()) {
        return surplusGearDecision(item, 'low_grade_high_rate');
    }
    if (isGear(item) && !lowGradeGear && Number(item.basePrice || 0) <= MARKET_GEAR_MIN_BASE_PRICE) {
        return surplusGearDecision(item, 'low_value_gear');
    }

    const marketOptions = {
        ...options,
        excludeCharacterId: state.characterId
    };
    const supply = MarketDemandIndex.supplyFor(item.selfId, marketOptions);
    const unitPrice = listingPrice(item, { market: { supply } }) ?? listingFloor(item);
    const market = {
        supply,
        demand: MarketDemandIndex.demandFor(item.selfId, { ...marketOptions, unitPrice })
    };
    if (isGear(item)) {
        const buyers = Math.max(0, Number(options.buyerActivity?.get?.(Number(item.selfId))
            ?? options.buyerActivity?.[Number(item.selfId)]
            ?? MarketBuyerActivity.count(item.selfId)) || 0);
        const competitiveUnits = supply.offers.reduce((units, offer) => units + (
            Number(offer.price || 0) <= Math.ceil(unitPrice * 1.05)
                ? Math.max(0, Number(offer.count || 0)) : 0
        ), 0);
        market.recentBuyers = buyers;
        market.competitiveUnits = competitiveUnits;
    }
    const fundedUnits = Math.max(0, Number(market.demand.fundedUnits || 0));
    if (ItemDisposition.isMarketRecipeItem(item) && fundedUnits > market.supply.units) {
        return listOrWarehouse(item, {
            action: 'list', reason: 'active_demand',
            listCount: Math.min(Number(item.count), fundedUnits - market.supply.units), market
        });
    }
    if (ItemDisposition.isMarketRecipeItem(item) && market.supply.units < SPECULATIVE_SUPPLY_LIMIT) {
        return listOrWarehouse(item, {
            action: 'list', reason: 'scarce_recipe',
            listCount: Math.min(Number(item.count), SPECULATIVE_SUPPLY_LIMIT - market.supply.units), market
        });
    }
    if (ItemDisposition.isMarketRecipeItem(item)) return surplusGearDecision(item, 'recipe_supplied', market);
    if (isGear(item) && fundedUnits <= market.supply.units && market.recentBuyers > 0) {
        const available = Math.max(0, market.recentBuyers - market.competitiveUnits);
        if (available > 0) return listOrWarehouse(item, {
            action: 'list', reason: 'recent_buyer_activity',
            listCount: Math.min(Number(item.count), available), market
        });
        return surplusGearDecision(item, 'market_oversupply', market);
    }
    if (LotPolicy.material(item) && fundedUnits <= market.supply.units) {
        // Keep a small useful shelf for players even before explicit bot demand.
        // Existing supply is global; every new seller must share this allowance.
        const recentBuyers = Number(options.buyerActivity?.get?.(Number(item.selfId))
            ?? MarketBuyerActivity.count(item.selfId)) || 0;
        const sellerLimit = Math.max(2, Math.min(4, recentBuyers));
        const units = Math.max(0, 200 - market.supply.units);
        const count = Math.min(Number(item.count), units);
        if (market.supply.sellers < sellerLimit && count > 0
            && LotPolicy.viable({ ...item, count, price: unitPrice })) {
            return listOrWarehouse(item, { action: 'list', reason: 'material_liquidity', listCount: count, market });
        }
        return { action: 'warehouse', reason: 'material_oversupply', market };
    }
    if (market.demand.bots <= 0 && Number(market.demand.afkOrders || 0) <= 0) {
        if (lowGradeGear) return surplusGearDecision(item, 'low_grade_no_funded_demand', market);
        return surplusGearDecision(item, 'no_demand', market);
    }
    const actionableUnits = fundedUnits;
    if (actionableUnits > 0) {
        const availableUnits = Math.max(0, actionableUnits - market.supply.units);
        if (availableUnits <= 0) return surplusGearDecision(item, 'saturated', market);
        return listOrWarehouse(item, {
            action: 'list',
            reason: 'active_demand',
            listCount: Math.min(Number(item.count), availableUnits),
            market
        });
    }

    if (market.demand.readyBots > 0) {
        if (lowGradeGear) return surplusGearDecision(item, 'low_grade_no_funded_demand', market);
        return { action: 'warehouse', reason: 'unfunded_demand', market };
    }
    if (lowGradeGear) {
        return surplusGearDecision(item, 'low_grade_no_funded_demand', market);
    }
    const speculative = isGear(item)
        && Number(item.basePrice || 0) >= SPECULATIVE_GEAR_MIN_BASE_PRICE
        && market.supply.units < SPECULATIVE_SUPPLY_LIMIT;
    if (speculative) {
        const failed = state.stats?.marketPricing?.[Number(item.selfId)];
        if (Number(failed?.speculativeFailedAt || 0) > 0) {
            return { action: 'warehouse', reason: 'speculative_already_tried', market };
        }
        return listOrWarehouse(item, {
            action: 'list',
            reason: 'speculative_demand',
            listCount: Math.min(Number(item.count), SPECULATIVE_SUPPLY_LIMIT - market.supply.units),
            market
        });
    }
    if (market.supply.units >= SPECULATIVE_SUPPLY_LIMIT) {
        return surplusGearDecision(item, 'saturated', market);
    }
    return { action: 'warehouse', reason: 'latent_demand', market };
}

function listingFloor(item) {
    const basePrice = Math.max(0, Number(item?.basePrice || 0));
    if (basePrice <= 0) return 1;
    return BotMarketPricing.listingFloor(item);
}

function listingPrice(item, decision) {
    const preferred = Math.max(1, Math.floor(Number(item.price || 0)));
    const minimum = listingFloor(item);
    const competition = Math.min(Number(decision?.market?.supply?.minimumPrice || Infinity), BotMarketPricing.npcPrice(item));
    if (!Number.isFinite(competition) || competition <= 0) return Math.max(minimum, preferred);
    const competitivePrice = Math.floor(competition * 0.98);
    if (minimum > competitivePrice) {
        // A finite cheap shot remainder cannot satisfy all funded demand.
        // Let other sellers meet the rest at the floor instead of requiring
        // an impossible undercut. Unlimited NPC stock remains a hard cap.
        const market = decision?.market;
        if (String(item.kind || '').startsWith('Other.Shot')
            && decision.reason === 'active_demand'
            && Number(market?.demand?.unitPrice) >= minimum
            && Number(market?.demand?.fundedUnits) > Number(market?.supply?.units || 0)
            && minimum < BotMarketPricing.npcPrice(item)) return minimum;
        return null;
    }
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
    const states = options.states || LifeState.allStates(5000);
    const supplyByItem = options.supplyByItem || EMPTY_SUPPLY;
    const signalsByItem = options.signalsByItem || MarketDemandIndex.indexSignals(states, Number(options.now) || Date.now());
    const decisions = candidates.map((item) => {
        const decision = classify(state, item, { ...options, states, supplyByItem,
            signals: options.signals || signalsByItem.get(Number(item.selfId)) || [] });
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
            npcPrice: NpcSellRules.npcBuyPrice(decision.item.basePrice)
        })),
        warehouse: decisions.filter((decision) => decision.action === 'warehouse').map((decision) => decision.item)
    };
}

// A bot in the world seen by the cold rules: its saved life state with the
// live bag, level and class of the actor.
function actorState(session) {
    const actor = session.actor;
    const inventory = LifeState.inventorySummaryFromItems(actor.backpack.fetchItems());
    return {
        ...(session.coldLifeState || {}),
        characterId: Number(actor.fetchId()),
        level: Number(actor.fetchLevel?.() || session.coldLifeState?.level || 1),
        adena: Number(inventory['57']?.amount || 0),
        inventory,
        stats: { ...(session.coldLifeState?.stats || {}), classId: Number(actor.fetchClassId?.() || 0) }
    };
}

// What a bot in the world sells to the NPC, by selfId and count: the cold
// visit's NPC sale (evaluate().npc) on the actor's own bag. The hot town visit
// sells exactly this and keeps it out of the warehouse, as the cold visit sells
// before it stores.
function npcSaleForActor(session) {
    const sale = new Map();
    if (!session?.actor?.backpack?.fetchItems) return sale;
    const state = actorState(session);
    for (const line of evaluate(state, { unlimited: true, allowPreTradeCleanup: true }).npc) {
        sale.set(Number(line.selfId), Number(sale.get(Number(line.selfId)) || 0) + Number(line.count || 0));
    }
    return sale;
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
    actorState,
    npcSaleForActor,
    starterItemIds
};

const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;
const WAREHOUSE_GEAR_MIN_BASE_PRICE = 1000;
const TRADE_MIN_LEVEL = 10;

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function priceFor(state, item, template) {
    const basePrice = Number(template?.template?.price || 0);
    if (basePrice <= 0) return 0;
    const seed = (Number(state.characterId || 0) * 31) + (Number(item.selfId || 0) * 17);
    const percent = 70 + (Math.abs(seed) % 21);
    const adjustment = Math.max(50, Math.min(100, Number(state?.stats?.marketPricing?.[Number(item.selfId)]?.percent || 100)));
    return BotEconomyPricing.scalePrice(basePrice * percent * adjustment / 10000);
}

function basePrice(item, template = templateFor(item?.selfId)) {
    return Math.max(0, Number(template?.template?.price || 0));
}

function reservedCraftAmounts(state) {
    const plan = state?.stats?.equipmentPlan;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return {};
    return (plan.materials || []).reduce((reserved, material) => {
        const selfId = Number(material.selfId || 0);
        if (!selfId) return reserved;
        reserved[selfId] = Math.max(Number(reserved[selfId] || 0), Math.min(Number(material.owned || 0), Number(material.amount || 0)));
        return reserved;
    }, {});
}

function isTradeEligible(state = {}) {
    // Purpose-built static merchant/craft services are not adventurers and
    // retain their normal storefronts. Generated characters start selling
    // only once their first leveling/gear loop has had time to produce useful
    // surplus.
    if (!state.stats?.generatedCold) return true;
    return Number(state.level || 1) >= TRADE_MIN_LEVEL;
}

function protectedStarterLootAmount(item, kind) {
    // Low-level resources remain sellable once the character reaches the
    // trading phase: they are a legitimate early Adena source. Ordinary gear
    // and drops from level 1-5 mobs are retained instead of becoming instant
    // private-store/NPC-liquidation stock.
    if (String(kind || '').startsWith('Other.Material')) return 0;
    return Math.max(0, Math.min(Number(item?.amount || 0), Number(item?.starterMobLootAmount || 0)));
}

function saleCandidates(state, options = {}) {
    if (!isTradeEligible(state)) return [];
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    const reserved = { ...reservedCraftAmounts(state), ...(options.reserved || {}) };
    return Object.values(state?.inventory || {}).flatMap((item) => {
        const selfId = Number(item?.selfId || 0);
        const amount = Number(item?.amount || 0);
        const sellableAmount = Math.max(0, amount - Number(reserved[selfId] || 0));
        if (!selfId || selfId === 57 || sellableAmount <= 0 || item.equipped) return [];

        const template = templateFor(selfId);
        const kind = item.kind || template?.template?.kind || '';
        if (!SELLABLE_KINDS.some((prefix) => kind.startsWith(prefix))) return [];

        const protectedAmount = protectedStarterLootAmount(item, kind);
        const sellableCount = Math.max(0, sellableAmount - protectedAmount);
        const base = basePrice(item, template);
        const price = priceFor(state, item, template);
        if (price <= 0 || sellableCount <= 0) return [];
        return [{
            selfId,
            name: item.name || template?.template?.name || `Item ${selfId}`,
            kind,
            rank: item.rank || template?.etc?.rank || 'none',
            count: sellableCount,
            price,
            basePrice: base
        }];
    }).sort((a, b) => b.price - a.price || a.selfId - b.selfId).slice(0, limit);
}

function npcLiquidationCandidates(state, options = {}) {
    const maxUnitPrice = Math.max(1, Number(options.maxUnitPrice) || NPC_LIQUIDATION_MAX_UNIT_PRICE);
    return saleCandidates(state, { limit: 20 }).filter((item) => item.basePrice <= maxUnitPrice).map((item) => ({
        ...item,
        npcPrice: Math.max(1, Math.floor(item.basePrice * 0.5))
    }));
}

// Materials remain useful for future crafting/trading regardless of their NPC
// value. Gear is worth retaining only once it has crossed out of the starter
// trash band, leaving cheap no-grade drops for liquidation.
function isWarehouseCandidate(item, template = templateFor(item?.selfId)) {
    const selfId = Number(item?.selfId || 0);
    const amount = Number(item?.amount || 0);
    const kind = item?.kind || template?.template?.kind || '';
    if (!selfId || selfId === 57 || amount <= 0 || item?.equipped) return false;
    if (kind.startsWith('Other.Material')) return true;
    return (kind.startsWith('Weapon.') || kind.startsWith('Armor.'))
        && basePrice(item, template) > WAREHOUSE_GEAR_MIN_BASE_PRICE;
}

function warehouseCandidates(state) {
    return Object.values(state?.inventory || {}).filter((item) => isWarehouseCandidate(item));
}

function saleSummary(state, options = {}) {
    const items = saleCandidates(state, options);
    return {
        items,
        itemCount: items.reduce((sum, item) => sum + Number(item.count || 0), 0),
        marketValue: items.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.price || 0), 0)
    };
}

module.exports = {
    NPC_LIQUIDATION_MAX_UNIT_PRICE,
    TRADE_MIN_LEVEL,
    WAREHOUSE_GEAR_MIN_BASE_PRICE,
    basePrice,
    isTradeEligible,
    isWarehouseCandidate,
    npcLiquidationCandidates,
    priceFor,
    protectedStarterLootAmount,
    reservedCraftAmounts,
    saleCandidates,
    saleSummary,
    warehouseCandidates
};

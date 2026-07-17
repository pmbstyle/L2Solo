const DataCache = invoke('GameServer/DataCache');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;
const WAREHOUSE_GEAR_MIN_BASE_PRICE = 1000;

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function priceFor(state, item, template) {
    const basePrice = Number(template?.template?.price || 0);
    if (basePrice <= 0) return 0;
    const seed = (Number(state.characterId || 0) * 31) + (Number(item.selfId || 0) * 17);
    const percent = 70 + (Math.abs(seed) % 21);
    const adjustment = Math.max(50, Math.min(100, Number(state?.stats?.marketPricing?.[Number(item.selfId)]?.percent || 100)));
    return Math.max(1, Math.floor(basePrice * percent * adjustment / 10000));
}

function basePrice(item, template = templateFor(item?.selfId)) {
    return Math.max(0, Number(template?.template?.price || 0));
}

function saleCandidates(state, options = {}) {
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    return Object.values(state?.inventory || {}).flatMap((item) => {
        const selfId = Number(item?.selfId || 0);
        const amount = Number(item?.amount || 0);
        if (!selfId || selfId === 57 || amount <= 0 || item.equipped) return [];

        const template = templateFor(selfId);
        const kind = item.kind || template?.template?.kind || '';
        if (!SELLABLE_KINDS.some((prefix) => kind.startsWith(prefix))) return [];

        const base = basePrice(item, template);
        const price = priceFor(state, item, template);
        if (price <= 0) return [];
        return [{
            selfId,
            name: item.name || template?.template?.name || `Item ${selfId}`,
            kind,
            rank: item.rank || template?.etc?.rank || 'none',
            count: amount,
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
    WAREHOUSE_GEAR_MIN_BASE_PRICE,
    basePrice,
    isWarehouseCandidate,
    npcLiquidationCandidates,
    priceFor,
    saleCandidates,
    saleSummary,
    warehouseCandidates
};

const DataCache = invoke('GameServer/DataCache');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material'];
const NPC_LIQUIDATION_MAX_UNIT_PRICE = 1000;

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

function saleSummary(state, options = {}) {
    const items = saleCandidates(state, options);
    return {
        items,
        itemCount: items.reduce((sum, item) => sum + Number(item.count || 0), 0),
        marketValue: items.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.price || 0), 0)
    };
}

module.exports = { NPC_LIQUIDATION_MAX_UNIT_PRICE, basePrice, npcLiquidationCandidates, priceFor, saleCandidates, saleSummary };

const DataCache = invoke('GameServer/DataCache');

const SELLABLE_KINDS = ['Weapon.', 'Armor.', 'Other.Material'];

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function priceFor(state, item, template) {
    const basePrice = Number(template?.template?.price || 0);
    if (basePrice <= 0) return 0;
    const seed = (Number(state.characterId || 0) * 31) + (Number(item.selfId || 0) * 17);
    const percent = 70 + (Math.abs(seed) % 21);
    return Math.max(1, Math.floor(basePrice * percent / 100));
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

        const price = priceFor(state, item, template);
        if (price <= 0) return [];
        return [{
            selfId,
            name: item.name || template?.template?.name || `Item ${selfId}`,
            kind,
            rank: item.rank || template?.etc?.rank || 'none',
            count: amount,
            price
        }];
    }).sort((a, b) => b.price - a.price || a.selfId - b.selfId).slice(0, limit);
}

module.exports = { priceFor, saleCandidates };

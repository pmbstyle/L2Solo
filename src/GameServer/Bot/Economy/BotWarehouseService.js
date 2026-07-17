const Database = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

function itemData(item) {
    return {
        id: Number(item.fetchId?.() || item.id),
        selfId: Number(item.fetchSelfId?.() || item.selfId),
        name: item.fetchName?.() || item.name || '',
        amount: Number(item.fetchAmount?.() || item.amount || 0),
        equipped: !!(item.fetchEquipped?.() || item.equipped),
        rank: item.fetchRank?.() || item.rank || 'none',
        kind: item.fetchKind?.() || item.kind || '',
        stackable: !!(item.fetchStackable?.() || item.stackable),
        petData: item.fetchPetData?.() || item.petData
    };
}

async function depositActor(actor) {
    const backpack = actor?.backpack;
    if (!backpack || !actor?.fetchId) return { count: 0, items: [] };

    const stored = [];
    for (const source of backpack.fetchItems().slice()) {
        const item = itemData(source);
        if (!ItemDisposition.isWarehouseCandidate(item)) continue;
        const result = await Database.transferInventoryToWarehouse(actor.fetchId(), item);
        if (Number(result.inventoryAmount) === 0) backpack.items = backpack.items.filter((entry) => entry !== source);
        else source.setAmount(result.inventoryAmount);
        stored.push({ selfId: item.selfId, name: item.name, amount: item.amount });
    }
    return { count: stored.reduce((sum, item) => sum + item.amount, 0), items: stored };
}

async function depositCold(state) {
    const candidates = ItemDisposition.warehouseCandidates(state);
    if (!state || !candidates.length) return { state, count: 0, items: [] };

    const rows = await Database.fetchItems(state.characterId);
    const inventory = { ...(state.inventory || {}) };
    const stored = [];
    for (const candidate of candidates) {
        let remaining = Number(candidate.amount || 0);
        const sources = rows.filter((row) => Number(row.selfId) === Number(candidate.selfId) && !row.equipped);
        // Do not change the cold summary when the physical row changed under us.
        if (sources.reduce((sum, source) => sum + Number(source.amount || 0), 0) < remaining) continue;
        for (const source of sources) {
            if (remaining <= 0) break;
            const amount = Math.min(remaining, Number(source.amount || 0));
            await Database.transferInventoryToWarehouse(state.characterId, {
                id: source.id,
                selfId: candidate.selfId,
                name: candidate.name,
                amount,
                stackable: !!candidate.stackable,
                petData: source.petData
            });
            source.amount = Number(source.amount || 0) - amount;
            remaining -= amount;
        }
        inventory[String(candidate.selfId)] = { ...candidate, amount: 0 };
        stored.push({ selfId: candidate.selfId, name: candidate.name, amount: candidate.amount });
    }
    if (!stored.length) return { state, count: 0, items: [] };
    return {
        state: {
            ...state,
            inventory,
            stats: { ...(state.stats || {}), lastWarehouseDeposit: { items: stored, at: Date.now() } }
        },
        count: stored.reduce((sum, item) => sum + item.amount, 0),
        items: stored
    };
}

module.exports = { depositActor, depositCold, itemData };

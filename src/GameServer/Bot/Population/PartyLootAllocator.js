const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 8, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);

function templateFor(item = {}) {
    return (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId)) || null;
}

function equipmentDrop(item = {}) {
    const kind = item.kind || templateFor(item)?.template?.kind || '';
    return String(kind).startsWith('Weapon.') || String(kind).startsWith('Armor.');
}

function inventoryTemplates(inventory = {}) {
    return Object.values(inventory || {}).flatMap((item) => {
        if (Number(item?.amount || 0) < 1) return [];
        const template = templateFor(item);
        return template ? [template] : [];
    });
}

function slotPriority(item = {}) {
    const slot = Number(item.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return 8;
    if (ARMOR_SLOTS.has(slot)) return 4;
    return JEWEL_SLOTS.has(slot) ? 1 : 0;
}

function projectedInventory(state = {}, projected = new Map()) {
    return projected.get(Number(state.characterId)) || { ...(state.inventory || {}) };
}

function recipientScore(state, item, projected) {
    const template = templateFor(item);
    if (!template || !equipmentDrop(item)) return -Infinity;
    const role = GearAcquisitionPlanner.roleFor(state);
    if (!GearAcquisitionPlanner.suitable(template, state, role)) return -Infinity;

    const inventory = projectedInventory(state, projected);
    const owned = inventoryTemplates(inventory);
    if (!GearAcquisitionPlanner.isSlotUpgrade(template, owned, role)) return -Infinity;

    const targetId = Number(state.stats?.equipmentPlan?.target?.selfId || 0);
    const targetBonus = Number(template.selfId) === targetId ? 100000 : 0;
    const current = owned
        .filter((ownedItem) => (
            (WEAPON_SLOTS.has(Number(ownedItem.etc?.slot || 0)) ? 'weapon' : Number(ownedItem.etc?.slot || 0))
            === (WEAPON_SLOTS.has(Number(template.etc?.slot || 0)) ? 'weapon' : Number(template.etc?.slot || 0))
        ))
        .reduce((best, ownedItem) => Math.max(best, GearAcquisitionPlanner.itemScore(ownedItem, role)), 0);
    const improvement = Math.max(1, GearAcquisitionPlanner.itemScore(template, role) - current + 2);
    const fairness = -Number(state.stats?.partyGearReceived || 0) * 0.01;
    return targetBonus + slotPriority(template) * improvement + fairness;
}

function addProjectedItem(state, item, projected) {
    const inventory = { ...projectedInventory(state, projected) };
    const key = String(item.selfId);
    inventory[key] = {
        ...(inventory[key] || {}),
        selfId: Number(item.selfId),
        name: item.name || inventory[key]?.name || '',
        amount: Number(inventory[key]?.amount || 0) + Number(item.amount || 0),
        kind: item.kind || inventory[key]?.kind || '',
        rank: item.rank || inventory[key]?.rank || 'none'
    };
    projected.set(Number(state.characterId), inventory);
}

function transferGearDrops(memberResults = []) {
    const copies = memberResults.map((entry) => ({
        ...entry,
        result: {
            ...entry.result,
            patch: { ...(entry.result?.patch || {}) },
            materialize: {
                ...(entry.result?.materialize || {}),
                items: [...(entry.result?.materialize?.items || [])]
            }
        }
    }));
    const projected = new Map(copies.map(({ state }) => [Number(state.characterId), { ...(state.inventory || {}) }]));
    const transfers = [];

    const originalDrops = copies.flatMap((source) => (
        source.result.materialize.items.map((item) => ({ source, item }))
    ));
    originalDrops.forEach(({ source, item }) => {
        const sourceItems = source.result.materialize.items;
        if (!equipmentDrop(item)) return;
        const recipient = copies
            .map((entry) => ({ entry, score: recipientScore(entry.state, item, projected) }))
            .filter((candidate) => Number.isFinite(candidate.score))
            .sort((left, right) => right.score - left.score
                || Number(left.entry.state.characterId) - Number(right.entry.state.characterId))[0]?.entry;
        if (!recipient) return;

        addProjectedItem(recipient.state, item, projected);
        if (Number(recipient.state.characterId) === Number(source.state.characterId)) return;
        const index = sourceItems.indexOf(item);
        if (index >= 0) sourceItems.splice(index, 1);
        recipient.result.materialize.items.push(item);
        recipient.result.patch.stats = {
            ...(recipient.result.patch.stats || {}),
            partyGearReceived: Number(recipient.result.patch.stats?.partyGearReceived ?? recipient.state.stats?.partyGearReceived ?? 0) + 1
        };
        transfers.push({
            from: source.state,
            to: recipient.state,
            item
        });
    });

    return { memberResults: copies, transfers };
}

module.exports = { equipmentDrop, recipientScore, transferGearDrops };

const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const BackpackModel = invoke('GameServer/Model/Backpack');
const Upgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
let templateSource = null;
let templateIndex = new Map();

function materialize(row, scored = false) {
    if (templateSource !== DataCache.items) {
        templateSource = DataCache.items;
        templateIndex = new Map((templateSource || []).map((item) => [Number(item.selfId), utils.crushOb(item)]));
    }
    const template = templateIndex.get(Number(row.selfId));
    if (!template) return null;
    const details = template;
    const item = new Item(Number(row.id), {
        ...details, ...row, name: row.name || details.name, kind: row.kind || details.kind, equipped: !!row.equipped,
        slot: row.equipped && Number(row.slot) > 0 ? Number(row.slot) : Number(details.slot || 0)
    });
    if (scored) {
        for (const [method, stat] of [['fetchPAtk', 'pAtk'], ['fetchMAtk', 'mAtk'], ['fetchPDef', 'pDef'], ['fetchMDef', 'mDef']]) {
            const value = Number(item[method]()) + EnchantRules.statBonus(item, stat);
            item[method] = () => value;
        }
    }
    return item;
}

function equipmentSignature(rows) {
    return rows.filter((row) => row.equipped).map((row) => [
        Number(row.id), Number(row.selfId), Number(row.amount), Number(row.enchant || 0), Number(row.slot)
    ].join(':')).sort().join('|');
}

function inventoryMatches(rows, inventory) {
    // An unmaterialized cold copy must not look like an empty paperdoll slot.
    // Wait for normal inventory synchronization rather than consume clan gear
    // which the cold optimizer would immediately discard as surplus.
    return Object.values(inventory).every((entry) => {
        if (!materialize(entry)?.isWearable()) return true;
        const physical = rows.filter((row) => Number(row.selfId) === Number(entry.selfId));
        if (physical.reduce((sum, row) => sum + Number(row.amount), 0) !== Number(entry.amount)) return false;
        const slots = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equippedSlotsFor(entry, entry.slot);
        const actual = physical.filter((row) => row.equipped).map((row) => Number(row.slot)).sort((a, b) => a - b);
        return JSON.stringify(slots) === JSON.stringify(actual);
    });
}

function plan(member, rows, stock) {
    if (Number(stock.amount) - Number(stock.reservedAmount || 0) < 1) return null;
    // Warehouse and inventory object IDs belong to different tables.
    const candidate = materialize({ ...stock, id: -1, amount: 1, equipped: false }, true);
    if (!candidate?.isWearable()) return null;
    const backpack = new BackpackModel(Array.from({ length: 16 }, () => ({})));
    backpack.items = rows.filter((row) => row.equipped).map((row) => materialize(row, true)).filter(Boolean);
    for (const item of backpack.items) backpack.equipPaperdoll(item.fetchSlot(), item.fetchId(), item.fetchSelfId());
    if (candidate.fetchSlot() === 8 && backpack.items.some((item) => item.fetchSlot() === 14)) return null;
    backpack.items.push(candidate);
    const actor = {
        backpack,
        fetchLevel: () => Number(member.level),
        fetchClassId: () => Number(member.classId)
    };
    const upgrade = Upgrade.findBestUpgrades({ actor }).find((entry) => entry.item === candidate);
    if (!upgrade) return null;
    const slot = upgrade.slot;
    const conflicts = new Set([slot]);
    if (slot === 7 || slot === 8) conflicts.add(14);
    if (slot === 14) { conflicts.add(7); conflicts.add(8); }
    if (slot === 15) { conflicts.add(10); conflicts.add(11); }
    if (slot === 10 || slot === 11) conflicts.add(15);
    const returned = rows.filter((row) => row.equipped && conflicts.has(Number(row.slot)));
    // Malformed old equipment must be repaired before exchanging it.
    if (returned.some((row) => Number(row.amount) !== 1)) return null;
    return { slot, returned, score: upgrade.score };
}

module.exports = { plan, materialize, equipmentSignature, inventoryMatches };

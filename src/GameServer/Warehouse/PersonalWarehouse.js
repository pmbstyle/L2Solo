const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const World = invoke('GameServer/World/World');

const MAX_LINES = 100;
const INTERACTION_RADIUS = 300;

function isWarehouseNpc(session) {
    const active = session.activeNpcTalk;
    const actor = session.actor;
    const npc = (World.npc?.spawns || []).find((entry) => Number(entry.fetchId?.()) === Number(active?.objectId));
    if (!npc || !actor || !/^Warehouse (Keeper|Chief|Freightman)$/i.test(npc.fetchTitle?.() || '')) return false;
    if (Number(npc.fetchSelfId?.()) !== Number(active?.selfId)) return false;
    const dx = Number(actor.fetchLocX?.()) - Number(npc.fetchLocX?.());
    const dy = Number(actor.fetchLocY?.()) - Number(npc.fetchLocY?.());
    return Number.isFinite(dx) && Number.isFinite(dy) && ((dx * dx) + (dy * dy)) <= (INTERACTION_RADIUS * INTERACTION_RADIUS);
}

function templateFor(selfId) {
    return DataCache.items?.find((item) => Number(item.selfId) === Number(selfId));
}

function warehouseItem(row) {
    const template = templateFor(row.selfId);
    if (!template) return null;
    return new Item(Number(row.id), {
        ...utils.crushOb(template),
        amount: Number(row.amount),
        petData: row.petData,
        equipped: false,
        slot: 0
    });
}

function list(characterId) {
    return Database.fetchWarehouseItems(characterId)
        .then((rows) => rows.map(warehouseItem).filter(Boolean));
}

function validateLines(lines, items) {
    const seen = new Set();
    return lines.length <= MAX_LINES && lines.every((line) => {
        const id = Number(line.objectId);
        const amount = Number(line.amount);
        return Number.isSafeInteger(id) && Number.isSafeInteger(amount) && amount > 0 &&
            !seen.has(id) && (seen.add(id) || true) &&
            items.some((item) => Number(item.fetchId()) === id && amount <= Number(item.fetchAmount()));
    });
}

async function deposit(session, lines) {
    if (!isWarehouseNpc(session)) throw new Error('warehouse NPC is no longer active');
    const actor = session.actor;
    const backpack = actor.backpack;
    const inventory = backpack.fetchItems();
    if (!validateLines(lines, inventory)) throw new Error('invalid warehouse deposit');

    const stored = await list(actor.fetchId());
    for (const line of lines) {
        const source = inventory.find((item) => Number(item.fetchId()) === Number(line.objectId));
        const amount = Number(line.amount);
        const target = source.fetchStackable?.() && stored.find((item) => (
            item.fetchStackable?.() && Number(item.fetchSelfId()) === Number(source.fetchSelfId())
        ));

        const transferred = await Database.transferInventoryToWarehouse(actor.fetchId(), {
            id: source.fetchId(), selfId: source.fetchSelfId(), name: source.fetchName?.(), amount,
            stackable: source.fetchStackable?.(), petData: source.fetchPetData?.()
        });
        if (target) {
            target.setAmount(transferred.warehouseAmount);
        } else {
            const added = warehouseItem({
                id: transferred.warehouseId, selfId: source.fetchSelfId(), amount,
                petData: source.fetchPetData?.()
            });
            if (added) stored.push(added);
        }

        if (transferred.inventoryAmount === 0) {
            backpack.items = backpack.items.filter((item) => item !== source);
        } else {
            source.setAmount(transferred.inventoryAmount);
        }
    }
    return stored;
}

async function withdraw(session, lines) {
    if (!isWarehouseNpc(session)) throw new Error('warehouse NPC is no longer active');
    const actor = session.actor;
    const backpack = actor.backpack;
    const stored = await list(actor.fetchId());
    if (!validateLines(lines, stored)) throw new Error('invalid warehouse withdrawal');

    for (const line of lines) {
        const source = stored.find((item) => Number(item.fetchId()) === Number(line.objectId));
        const amount = Number(line.amount);
        const target = source.fetchStackable?.() && backpack.fetchItems().find((item) => (
            item.fetchStackable?.() && Number(item.fetchSelfId()) === Number(source.fetchSelfId())
        ));

        const transferred = await Database.transferWarehouseToInventory(actor.fetchId(), {
            id: source.fetchId(), selfId: source.fetchSelfId(), name: source.fetchName?.(), amount,
            stackable: source.fetchStackable?.()
        });
        if (target) {
            target.setAmount(transferred.inventoryAmount);
        } else {
            const added = warehouseItem({
                id: transferred.inventoryId, selfId: source.fetchSelfId(), amount,
                petData: transferred.petData
            });
            if (added) backpack.items.push(added);
        }

        if (transferred.warehouseAmount === 0) {
            stored.splice(stored.indexOf(source), 1);
        } else {
            source.setAmount(transferred.warehouseAmount);
        }
    }
    return stored;
}

module.exports = { isWarehouseNpc, list, deposit, withdraw };

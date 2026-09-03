const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const ItemSlot = invoke('GameServer/Item/ItemSlot');
const PersonalWarehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanRules = invoke('GameServer/Clan/ClanRules');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

const MAX_LINES = 100;
let transferSequence = 0;

function templateFor(selfId) {
    return DataCache.items?.find((item) => Number(item.selfId) === Number(selfId));
}

function warehouseItem(row) {
    const template = templateFor(row.selfId);
    if (!template) return null;
    const details = utils.crushOb(template);
    return new Item(Number(row.id), {
        ...details,
        amount: Number(row.amount),
        enchant: Number(row.enchant || 0),
        petData: row.petData,
        equipped: false,
        slot: ItemSlot.canonicalSlot(row.selfId, details.slot)
    });
}

function clanFor(session) {
    const actor = session?.actor;
    const clan = ClanService.clanForActor(actor);
    if (!actor || !clan || Number(clan.level) < 1) throw new Error('a level 1 clan is required');
    return clan;
}

function assertActive(session, mode) {
    if (!PersonalWarehouse.isWarehouseNpc(session)) throw new Error('warehouse NPC is no longer active');
    const clan = clanFor(session);
    if (session.activeWarehouse?.type !== 'clan'
        || Number(session.activeWarehouse?.clanId) !== Number(clan.id)
        || session.activeWarehouse?.mode !== mode) {
        throw new Error('clan warehouse window is no longer active');
    }
    return clan;
}

function canView(session, clan = clanFor(session)) {
    return ClanRules.hasPrivilege(session.actor, ClanRules.CP_CL_VIEW_WAREHOUSE)
        && Number(session.actor.fetchClanId()) === Number(clan.id);
}

function canWithdraw(session, clan = clanFor(session)) {
    return canView(session, clan) && ClanService.isLeader(session.actor, clan);
}

function list(clanId) {
    return Database.fetchClanWarehouseItems(clanId).then((rows) => rows.map((row) => warehouseItem({
        ...row,
        amount: Math.max(0, Number(row.amount) - Number(row.reservedAmount || 0))
    })).filter((item) => item && item.fetchAmount() > 0));
}

function validateLines(lines, items) {
    const seen = new Set();
    return lines.length <= MAX_LINES && lines.every((line) => {
        const id = Number(line.objectId);
        const amount = Number(line.amount);
        return Number.isSafeInteger(id) && Number.isSafeInteger(amount) && amount > 0
            && !seen.has(id) && (seen.add(id) || true)
            && items.some((item) => Number(item.fetchId()) === id && amount <= Number(item.fetchAmount()));
    });
}

function resolveKey(clanId, characterId, operation) {
    transferSequence = (transferSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `player:${operation}:${clanId}:${characterId}:${Date.now()}:${transferSequence}`;
}

async function deposit(session, lines) {
    const clan = assertActive(session, 'deposit');
    const actor = session.actor;
    const backpack = actor.backpack;
    await CharacterWriteQueue.flushCharacter(actor.fetchId());
    const inventory = backpack.fetchItems();
    if (!validateLines(lines, inventory)) throw new Error('invalid clan warehouse deposit');

    const transfers = lines.map((line) => {
        const source = inventory.find((item) => Number(item.fetchId()) === Number(line.objectId));
        return {
            item: {
                id: source.fetchId(),
                selfId: source.fetchSelfId(),
                name: source.fetchName?.(),
                kind: source.fetchKind?.(),
                stackable: source.fetchStackable?.(),
                petData: source.fetchPetData?.()
            },
            amount: Number(line.amount),
            resolveKey: resolveKey(clan.id, actor.fetchId(), 'deposit')
        };
    });
    const results = await Database.transferPlayerInventoryBatchToClanWarehouse({
        clanId: clan.id,
        characterId: actor.fetchId(),
        transfers
    });
    results.forEach((transferred) => {
        const source = inventory.find((item) => Number(item.fetchId()) === Number(transferred.sourceItemId));
        if (!source) return;
        if (Number(transferred.inventoryAmount) <= 0) {
            backpack.items = backpack.items.filter((item) => item !== source);
        } else {
            source.setAmount(transferred.inventoryAmount);
        }
    });
    return list(clan.id);
}

async function withdraw(session, lines) {
    const clan = assertActive(session, 'withdraw');
    if (!canWithdraw(session, clan)) throw new Error('only the clan leader may withdraw');
    const actor = session.actor;
    const backpack = actor.backpack;
    await CharacterWriteQueue.flushCharacter(actor.fetchId());
    const stored = await list(clan.id);
    if (!validateLines(lines, stored)) throw new Error('invalid clan warehouse withdrawal');

    for (const line of lines) {
        const source = stored.find((item) => Number(item.fetchId()) === Number(line.objectId));
        const amount = Number(line.amount);
        const target = source.fetchStackable?.() && backpack.fetchItems().find((item) => (
            item.fetchStackable?.()
            && Number(item.fetchSelfId()) === Number(source.fetchSelfId())
            && Number(item.fetchEnchantLevel?.() || 0) === Number(source.fetchEnchantLevel?.() || 0)
        ));
        const transferred = await Database.transferClanWarehouseToPlayerInventory({
            clanId: clan.id,
            characterId: actor.fetchId(),
            item: {
                id: source.fetchId(),
                selfId: source.fetchSelfId(),
                name: source.fetchName?.(),
                stackable: source.fetchStackable?.()
            },
            amount,
            resolveKey: resolveKey(clan.id, actor.fetchId(), 'withdraw')
        });
        if (target) {
            target.setAmount(transferred.inventoryAmount);
        } else {
            const added = warehouseItem({
                id: transferred.inventoryId,
                selfId: source.fetchSelfId(),
                amount,
                petData: transferred.petData,
                enchant: transferred.enchant
            });
            if (added) backpack.items.push(added);
        }
    }
    return list(clan.id);
}

module.exports = { clanFor, canView, canWithdraw, list, deposit, withdraw };

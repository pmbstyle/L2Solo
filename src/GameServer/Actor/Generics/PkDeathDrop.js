const Policy = require('../../PkDropPolicy');

function drop(session, actor, rng = Math.random) {
    if (!session || session.arenaEphemeral || actor.fetchKind || !actor.backpack) return [];
    const drops = Policy.rollPlan(actor, rng), backpack = actor.backpack;
    if (!drops.length) return [];
    const World = invoke('GameServer/World/World');
    const Queue = invoke('GameServer/Persistence/CharacterWriteQueue');
    const Response = invoke('GameServer/Network/Response');
    const store = actor.fetchPrivateStore?.();
    const actual = [];
    for (const item of drops) {
        if (backpack.fetchItemRaw(item.fetchId()) !== item) continue;
        actual.push(item);
        if (item.fetchEquipped()) backpack.unequipPaperdoll(item.fetchSlot());
        backpack.items = backpack.items.filter(candidate => candidate !== item);
        backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        if (store?.items) store.items = store.items.filter(line => Number(line.objectId ?? line.id) !== item.fetchId());
        if (session.persistenceMode !== 'ephemeral') Queue.itemAmount(actor.fetchId(), item.fetchId(), 0);
        World.spawnItem(session, item.fetchSelfId(), item.fetchAmount(), {
            locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ(),
            enchant: item.fetchEnchantLevel(), ...(item.fetchPetData?.() ? { petData: item.fetchPetData() } : {})
        });
    }
    invoke('GameServer/Item/Item').bindInventory(backpack);
    session.dataSendToMe(Response.itemsList(backpack.fetchItems()));
    return actual;
}
function spawn(characterId, loc, drops = []) {
    if (!drops.length) return;
    const session = invoke('GameServer/Bot/BotManager').findSessionById(characterId);
    // SpawnItem does not need a materialized actor when explicit coordinates
    // are present; cold victims still leave the actual dropped items on ground.
    for (const item of drops) invoke('GameServer/World/World').spawnItem(session, item.selfId, item.amount,
        { ...loc, enchant: item.enchant || 0, ...(item.petData ? { petData: item.petData } : {}) });
}
module.exports = { drop, spawn };

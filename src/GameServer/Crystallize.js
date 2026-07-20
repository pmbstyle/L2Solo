const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const ServerResponse = invoke('GameServer/Network/Response');
const GRADES = { d: { level: 1, crystalId: 1458 }, c: { level: 2, crystalId: 1459 }, b: { level: 3, crystalId: 1460 }, a: { level: 4, crystalId: 1461 }, s: { level: 5, crystalId: 1462 } };
async function crystallize(session, objectId, count) {
    const actor = session?.actor, item = actor?.backpack?.fetchItemRaw?.(objectId), skill = actor?.skillset?.fetchSkill?.(248);
    const grade = GRADES[String(item?.fetchRank?.() || '').toLowerCase()], amount = Number(item?.fetchCristals?.() || 0);
    if (!actor || actor.isDead?.() || Number(actor.fetchPrivateStoreType?.() || 0) !== 0 || Number(count) !== 1 || !item || item.fetchAmount() !== 1 || item.fetchEquipped() || !grade || amount <= 0 || Number(skill?.fetchLevel?.() || 0) < grade.level) { session?.dataSendToMe?.(ServerResponse.actionFailed()); return false; }
    const crystal = DataCache.items.find((entry) => Number(entry.selfId) === grade.crystalId); if (!crystal) return false;
    try {
        const result = await Database.crystallizeInventoryItem(actor.fetchId(), { sourceId: item.fetchId(), sourceSelfId: item.fetchSelfId(), crystalId: grade.crystalId, crystalName: crystal.template?.name || '', crystalAmount: amount });
        actor.backpack.items = actor.backpack.items.filter((entry) => entry !== item);
        const existing = actor.backpack.fetchItemRaw(result.id); if (existing) existing.setAmount(result.amount); else actor.backpack.items.push(new Item(result.id, { ...utils.crushOb(crystal), amount: result.amount, equipped: false, slot: 0 }));
        session.dataSendToMe(ServerResponse.itemsList(actor.backpack.fetchItems()));
        return true;
    } catch (error) { utils.infoWarn('Crystallize', 'rejected %s: %s', actor.fetchName(), error.message); session.dataSendToMe(ServerResponse.actionFailed()); return false; }
}
module.exports = { crystallize };

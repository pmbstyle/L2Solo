const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

function spawnItem(session, selfId, amount, coords, onSpawn) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const item = new Item(this.items.nextId++, { ...utils.crushOb(itemDetails), ...coords });
        item.setAmount(amount);
        this.items.spawns.push(item);
        const packet = ServerResponse.spawnItem(item);
        if (session) session.dataSendToMeAndOthers(packet, item);
        else this.fetchVisibleUsers(item).forEach(recipient => recipient.dataSendToMe(packet));
        onSpawn?.(item);
    });
}

module.exports = spawnItem;

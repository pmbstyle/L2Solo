const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const GroundItems    = require('../GroundItems');

function spawnItem(session, selfId, amount, coords, onSpawn) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const item = new Item(this.items.nextId++, { ...utils.crushOb(itemDetails), ...coords });
        item.setAmount(amount);
        GroundItems.put(this.items, item);
        const packet = ServerResponse.spawnItem(item);
        if (session) session.dataSendToMeAndOthers(packet, item);
        else this.fetchVisibleUsers(null, item).forEach(recipient => recipient.dataSendToMe(packet));
        onSpawn?.(item);
    });
}

module.exports = spawnItem;

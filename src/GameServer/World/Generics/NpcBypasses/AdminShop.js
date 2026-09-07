const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const { gear } = require('../../../../../data/Pets/c4-gear.json');
const { TYPES } = require('../../../Pets/PetRules');

function itemIdsForSource(source) {
    if (Array.isArray(source)) {
        return source;
    }

    const available = ids => ids.filter(id => DataCache.items.some(item => item.selfId === id));
    if (source === 'pet:food') return available([...new Set(Object.values(TYPES).flatMap(type => type.food))]);
    if (source === 'pet:equipment') return available(Object.keys(gear).map(Number));
    if (source === 'pet:summons') return available(Object.keys(TYPES).map(Number).filter(id => id !== 4425));

    const match = typeof source === 'string' ? source.match(/^(armor|weapon):(none|d|c|b|a|s)$/) : null;
    if (match) {
        const kindPrefix = match[1] === 'armor' ? 'Armor.' : 'Weapon.';
        const rank = match[2];
        return DataCache.items
            .filter((item) => item.template?.kind?.startsWith(kindPrefix))
            .filter((item) => !gear[item.selfId] && !item.template.kind.endsWith('.Pet'))
            .filter((item) => (item.etc?.rank || 'none') === rank)
            .map((item) => item.selfId);
    }

    return null;
}

module.exports = function(session, parts) {
    const itemIds = itemIdsForSource(DataCache.adminShop[parts[1]]);
    if (!itemIds) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.activeMerchantTrade = null;
    session.activeNpcSellShop = null;
    session.activeAdminShop = {
        category: parts[1],
        itemIds: new Set(itemIds)
    };

    let list = [];

    itemIds.forEach((selfId) => {
        DataCache.fetchItemFromSelfId(selfId, (item) => {
            const nextId = invoke('GameServer/World/Generics/NpcTalkResponse').items.nextId++;
            const row = utils.crushOb(item);
            row.amount = 0;
            row.price = 0; // Admin prices :)
            list.push(new Item(nextId, row));
        });
    });

    session.dataSendToMe(
        ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
    );
};

module.exports.itemIdsForSource = itemIdsForSource;

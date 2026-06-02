const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

module.exports = function(session, parts) {
    let list = [];
    let itemIds = [];

    if (parts[1] === 'grocer' || parts[1] === 'orc_grocer') {
        itemIds = [1060, 1061, 1831, 1833, 736, 737, 1835, 2509, 3947, 735, 1062, 1863, 17];
    } else if (parts[1] === 'weapons') {
        itemIds = [
            // Weapons
            1, 3, 66, 67, 68,     // Swords
            4, 5, 1563,           // Blunts
            13, 14,               // Bows
            10, 11, 12,           // Daggers
            6, 7, 8, 9,           // Staffs/Wands
            15,                   // Spears
            // Shields
            18, 19, 20, 102,
            // Shirts / Tops
            21, 22, 23, 24, 25, 26, 27, 390,
            // Pants / Gaiters
            28, 29, 30, 31, 32, 33, 34, 412,
            // Footwear
            35, 36, 37, 38, 39,
            // Headwear
            41, 42, 43, 44,
            // Handwear
            48, 49, 50, 51
        ];
    } else if (parts[1] === 'orc_weapons') {
        itemIds = [
            // Weapons
            1, 3, 66, 67, 68,     // Swords
            4, 5, 1563,           // Blunts
            13, 14,               // Bows
            10, 11, 12,           // Daggers
            6, 7, 8, 9,           // Staffs/Wands
            15, 291, 292, 297,    // Spears/Polearms (Orc starting weapon types!)
            253, 254, 255, 256,   // Fist weapons (Orc specialty!)
            // Shields
            18, 19, 20, 102,
            // Shirts / Tops
            21, 22, 23, 24, 25, 26, 27, 390,
            // Pants / Gaiters
            28, 29, 30, 31, 32, 33, 34, 412,
            // Footwear
            35, 36, 37, 38, 39,
            // Headwear
            41, 42, 43, 44,
            // Handwear
            48, 49, 50, 51
        ];
    } else if (parts[1] === 'jewelry' || parts[1] === 'orc_jewelry') {
        itemIds = [112, 113, 114, 115, 116, 118, 845, 846, 875, 876, 877, 906, 907, 908];
    } else if (parts[1] === 'amulets' || parts[1] === 'orc_amulets') {
        itemIds = [1524, 1525, 1526, 1527, 1529, 1522, 1523, 1856, 1518, 1519, 1520, 1521, 1528, 1530];
    } else {
        itemIds = [1835, 1061, 736];
    }

    itemIds.forEach((selfId) => {
        DataCache.fetchItemFromSelfId(selfId, (item) => {
            // Retrieve item nextId generator from dynamic context
            const nextId = invoke('GameServer/World/Generics/NpcTalkResponse').items.nextId++;
            list.push(new Item(nextId, utils.crushOb(item)));
        });
    });

    session.dataSendToMe(
        ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
    );
};

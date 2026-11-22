'use strict';
// A crafter's conditional sell ads of every graded shot (soulshots, spiritshots and
// blessed spiritshots D..S) at its ask ceiling: the only seller of graded shots a bot
// buys from. The raid tests read their shot supply from these lines.
const { BoardIndex } = require('../../src/GameServer/AfkTrade/BoardIndex');

const GRADED = [1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952];

function crafterShotRecords({ town = 'Giran', ownerId = 7700001, count = 1000000, id = 7700000 } = {}) {
    const CrafterStock = require('../../src/GameServer/Bot/Economy/CrafterStock');
    return GRADED.map((selfId, i) => ({ id: id + i, ownerId, storeType: 1, kind: 'sell_ad', custodyPolicy: 1,
        botOwned: true, town, revision: 1, lines: [{ lineId: id + i, selfId, enchant: 0, count, price: CrafterStock.shotCeiling(selfId) }] }));
}

function crafterShotBoard({ board = new BoardIndex(), ...options } = {}) {
    for (const record of crafterShotRecords(options)) board.put(record);
    return board;
}

// The raid supply's market source (RaidSupplyPolicy.useMarket): these ads and the NPC shops.
function crafterShotMarket(options = {}) {
    const board = crafterShotBoard(options);
    return () => ({ board, npcOffersFor: id => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(id),
        tripFrom: () => () => 0 });
}

module.exports = { crafterShotRecords, crafterShotBoard, crafterShotMarket, GRADED };

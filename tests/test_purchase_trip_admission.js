'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Board = invoke('GameServer/AfkTrade/AfkTradeService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const saved = { npc: Offers.npcOffersAll, fixed: Offers.fixedStoreOffers, board: Board.boardIndex, keptKit: Economy.keptKit };
const state = { characterId: 99971, phase: 'cold', activity: 'hunting', currentRegion: 'Dion',
    adena: 20, inventory: {}, stats: { money: [1000, .001, 0, 0, .01, 20, 1835] } };
try {
    Offers.npcOffersAll = () => [{ town: 'Dion', sourceType: 'npc', price: 10 }];
    Offers.fixedStoreOffers = () => [];
    Board.boardIndex = () => ({ towns: () => [], list: () => [] });
    Economy.keptKit = () => ({ kitCost: (_id, price) => price || 1 });
    const blocked = { ...state, stats: { money: [1000, .001, 0, 999999] } };
    const quoted = Market.planPurchase(blocked, 1835, 1, { currentFunding: true, cost: () => 0, purpose: 'shots', towns: ['Dion'] });
    assert.equal(quoted?.units, 1);
    assert.equal(quoted.money, 10, 'the concrete 10-adena quote funds a whole unit instead of a one-adena belief cap');
    Board.boardIndex = () => ({ towns: () => ['Dion'],
        list: () => [{ ownerId: 12345, price: 2, count: 100 }] });
    const cheaper = Market.planPurchase(blocked, 1835, 10, { currentFunding: true, cost: () => 0, purpose: 'shots', towns: ['Dion'] });
    assert.equal(cheaper?.units, 1, 'cheaper stock cannot spend the mandatory allowance at the dearer NPC quote');
    assert.equal(cheaper.money, 2);
    const capped = Market.planPurchase(blocked, 1835, 1, { currentFunding: true, cost: () => 0, purpose: 'shots', money: 1, towns: ['Dion'] });
    assert.equal(capped, null, 'an explicit authoritative one-adena cap remains protected');
    console.log('PASS purchase quote funds its own units');
} finally {
    Offers.npcOffersAll = saved.npc; Offers.fixedStoreOffers = saved.fixed; Board.boardIndex = saved.board;
    Economy.keptKit = saved.keptKit;
}

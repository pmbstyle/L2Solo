'use strict';
// E314: a cold bot on a sale visit restocks shots in town. The cheapest shots
// are a conditional sell ad, paid through a trade meeting: the purchase comes
// back `pending` and the refusal comes later. The visit must end on that pass
// (no retry this visit), and the next pass must not plan the purchase again.
// The ended visit is saved before the meeting is staged (the meeting pins the
// row revision) and the staging pass ends there: the NPC basket runs on the next
// pass; a busy refusal (no meeting staged) leaves the shortfall to the basket.
// A goal purchase and a visit that did not come to sell keep the author's
// path: a pending meeting returns at once, with no cooldown.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const World = invoke('GameServer/World/World');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const NpcRestock = require('../src/GameServer/Bot/Economy/NpcRestockPlan');

const WEAPON = 2;
let nextRecord = 731400;
function record(ownerId, selfId, price, count) {
    const id = ++nextRecord;
    return AfkTrade.refreshRecord({ id, ownerId, ownerName: `Seller${ownerId}`, ownerAccount: `bot_${ownerId}`,
        kind: 'sell_ad', storeType: 1, status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0,
        locX: 83000, locY: 148000, locZ: -3400,
        lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count, price, enchant: 0 }] });
}
const bot = (reason, stats = {}) => ({ characterId: 731410, name: 'E314Buyer', level: 20, adena: 100000,
    inventory: {}, phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
    stats: { classId: 0, money: [100, 0, 1000, 0], playedHours: 10, visitEvery: [8, 4], ...stats,
        townVisit: { town: 'Giran', startedAt: Date.now() - 60000, reason } } });

(async () => {
    const kept = { user: World.user, buy: AfkTrade.buyFromShop, restock: ShotStock.restockPlan, npc: NpcRestock.purchase,
        upsert: LifeState.upsertState };
    const meetings = [];
    let baskets = 0, busy = false;
    const savedBeforeBuy = [];
    try {
        World.user = { sessions: [] };
        // The conditional deal: the payer's meeting is still being prepared.
        // The real staged reply (TradeMeetingService); a busy seller throws instead.
        // The row store is the edge here: it keeps the row the visit saves.
        let saved = null;
        LifeState.upsertState = async (row) => { saved = row; return row; };
        AfkTrade.buyFromShop = async (id, store, selfId, qty, options) => {
            meetings.push(Number(selfId));
            savedBeforeBuy.push(options.coldState.stats.townVisit.completed === true);
            if (busy) throw Error('trade_meeting_preparation_busy');
            return { pending: true, token: 't314', preparationId: 't314', outcome: 'preparing' };
        };
        NpcRestock.purchase = async (state) => { baskets++; return { state }; };
        const shot = ShotStock.planForState(bot('sell_inventory')).selfId;
        assert(shot > 0, 'the fixture bot uses shots');
        ShotStock.restockPlan = () => ({ needed: true, amount: 100, targetAmount: 100, currentAmount: 0, cost: 100000 });
        record(731401, shot, 1, 500);
        const planned = ColdMarket.planPurchase(bot('sell_inventory'), shot, 100, { towns: ['Giran'], money: 100000, purpose: 'shots' });
        assert(planned?.lines?.length, 'the shot restock plans the board line');

        // A sale visit: the pending shot deal ends the visit on this pass.
        const first = await ColdMarket.finishTownErrands(bot('sell_inventory'), { saleVisit: true });
        assert.equal(meetings.length, 1, 'the sale visit answered the shot ad through a trade meeting');
        assert.equal(first.stats.townVisit.completed, true, 'E314: a pending shot deal ends the sale visit');
        assert.equal(baskets, 0, 'the staging pass ends with the meeting: no NPC basket on it');
        assert.deepEqual(savedBeforeBuy, [true], 'the ended visit is saved before the meeting is staged');
        assert.equal(saved.stats.townVisit.completed, true, 'the saved row is the ended visit');
        assert.deepEqual(first.stats.visitEvery, [10, 3], 'the arrival counts once');
        // The next pass (the meeting refused later) does not plan it again; the basket restocks the shots.
        const later = { ...first, stats: { ...first.stats, playedHours: 10.2 } };
        const second = await ColdMarket.finishTownErrands(later, { saleVisit: false });
        assert.equal(meetings.length, 1, 'E314: the next pass does not plan the shot purchase again');
        assert.equal(baskets, 1, 'the next pass runs the NPC basket');
        assert.equal(second.stats.townVisit.completed, true, 'the visit stays ended');
        assert.deepEqual(second.stats.visitEvery, [10, 3], 'E314: a held pass does not count a second arrival (no halved interval)');
        // A busy seller stages no meeting: the visit ends and the NPC basket buys the shots.
        busy = true;
        const refused = await ColdMarket.finishTownErrands(bot('sell_inventory'), { saleVisit: true });
        busy = false;
        assert.equal(refused.stats.townVisit.completed, true, 'a busy refusal ends the sale visit');
        assert.equal(baskets, 2, 'E314: with no meeting staged the NPC basket runs on the same pass');

        // Another visit reason keeps the author's path: pending returns at once, unfinished.
        const other = await ColdMarket.finishTownErrands(bot('restock'));
        assert.equal(meetings.length, 3, 'the other visit answered the shot ad');
        assert.notEqual(other.stats.townVisit.completed, true, 'a visit that did not come to sell keeps waiting');
        assert.equal(baskets, 2, 'the waiting visit runs no NPC basket on that pass');

        // A goal purchase keeps the author's no-cooldown pending (ColdMarketService :149).
        record(731402, WEAPON, 10, 1);
        const goal = { type: 'upgrade_gear', status: 'active', plan: { expectedBenefit: 'market_search_for_weapon' },
            target: { itemId: WEAPON, amount: 1, adena: 1000, itemSlot: 0 } };
        const offer = Market.bestOffer(WEAPON, { town: 'Giran', buyerCharacterId: 731410 });
        assert(offer && offer.sourceType !== 'npc', 'the goal finds the board offer');
        const bought = await ColdMarket.tryPurchase(bot('sell_inventory'), goal);
        assert.equal(meetings.at(-1), WEAPON, 'the goal purchase answered the ad through a trade meeting');
        assert.equal(bought.pending, true, 'the goal purchase is pending');
        assert.notEqual(bought.state?.stats?.townVisit?.completed, true, 'a pending goal purchase does not end the visit');
        console.log('E314 pending shot deal ends the sale visit: passed');
    } finally {
        World.user = kept.user;
        AfkTrade.buyFromShop = kept.buy;
        ShotStock.restockPlan = kept.restock;
        NpcRestock.purchase = kept.npc;
        LifeState.upsertState = kept.upsert;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

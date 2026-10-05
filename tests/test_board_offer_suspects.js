// Suspects of step 3.3 group B, checked on board records in memory:
// E40 a hot bot's sell trip takes a buy ad, which has no stall to walk to;
// E41 a clan order picks the market for an offer no member may buy;
// E42 a record's second line of the same item is never offered.
const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
World.user = { sessions: [], revision: 0 };

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const ClanOrderService = invoke('GameServer/Clan/ClanOrderService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const STEM = 1864;
const SWORD = 2;
let nextId = 992000;

function record(ownerId, { kind = 'sell_ad', storeType = 1, town = 'Giran', account = `bot_${ownerId}`, lines }) {
    const id = ++nextId;
    return AfkTrade.refreshRecord({
        id, ownerId, ownerName: `Owner${ownerId}`, ownerAccount: account, kind, storeType, status: 'active', town,
        title: '', revision: 1, expiresAt: 0, locX: 83000, locY: 148000, locZ: -3400, appearance: {},
        lines: lines.map((line, index) => ({ id: id * 10 + index, name: `Item ${line.selfId}`, enchant: 0, ...line }))
    });
}

// Each suspect is checked on its own; the failures are listed together.
const failures = [];
function check(name, body) {
    try {
        body();
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
    } finally {
        AfkTrade._resetForTests();
    }
}

function item(selfId, amount) {
    return { fetchSelfId: () => selfId, fetchAmount: () => amount, fetchEquipped: () => false, fetchId: () => selfId * 10,
        fetchPetLocked: () => false };
}

// E40: a hot bot carrying stems looks for a buyer in Giran. A buy ad stands
// nowhere, so the trip may only take a buy shop (a record with a stall).
check('E40', () => {
    record(992101, { kind: 'buy_ad', storeType: 3, lines: [{ selfId: STEM, count: 10, price: 30 }] });
    const actor = { fetchId: () => 992100, backpack: { fetchItems: () => [item(STEM, 5)] } };
    const found = TradeService.findAfkBuyerForActor(actor, { name: 'Giran' });
    // ShoppingState.js and FollowingState.js walk to offer.projection.actor.
    assert(!found || found.offer.projection?.actor, `E40: a sell trip got a buy ad without a stall (${found?.offer.recordKind})`);
    record(992102, { kind: 'shop', storeType: 3, lines: [{ selfId: STEM, count: 10, price: 20 }] });
    const shop = TradeService.findAfkBuyerForActor(actor, { name: 'Giran' });
    assert.strictEqual(Number(shop?.offer.sourceId), 992102, 'E40: the trip walks to the buy shop');
    assert(shop.offer.projection.actor.fetchId() > 0);
});

// E41: the clan order picks the market only when a member can buy the item
// as the executor (ClanMarketService) buys it: in the member's town, never
// from the member's own record.
check('E41', () => {
    const memberId = 992201;
    record(memberId, { town: 'Dion', lines: [{ selfId: STEM, count: 10, price: 30 }] });
    LifeState.acceptLifecycleRow?.({ characterId: memberId, accountName: `bot_${memberId}`, name: 'Member', level: 30,
        phase: 'cold', activity: 'hunting', currentRegion: 'Dion', adena: 100000, inventory: {}, stats: {}, timing: {} });
    const clan = { id: 992200, members: [{ characterId: memberId, phase: 'cold', adena: 100000, level: 30 }],
        state: { memberIds: [memberId] } };
    const order = { itemId: STEM, amount: 5, strategy: 'auto', budget: 0, maxUnitPrice: 0 };
    const executorOffer = MarketOpportunity.bestOffer(STEM, { town: 'Dion', budget: 100000, buyerCharacterId: memberId });
    assert.strictEqual(executorOffer, null, 'the member cannot buy its own stems');
    const plan = ClanOrderService.planFor(order, clan, 0, { source: null });
    assert.notStrictEqual(plan.kind, 'market', `E41: the order picked the market (${plan.reasonCode}) for its own member's record`);
});

// E42: a shop with two lines of one item (+0 and +3) offers both; a buyer
// who takes the +3 line buys that line.
check('E42', () => {
    record(992301, { kind: 'shop', lines: [{ selfId: SWORD, count: 1, price: 100, enchant: 0 },
        { selfId: SWORD, count: 1, price: 500, enchant: 3 }] });
    const offers = AfkTrade.offers(SWORD, AfkTrade.SELL);
    assert.strictEqual(offers.length, 2, `E42: ${offers.length} of the 2 lines offered`);
});

if (failures.length) {
    failures.forEach((failure) => console.error(failure));
    process.exitCode = 1;
} else {
    console.log('Board offer suspects E40-E42: checked');
}

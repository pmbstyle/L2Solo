const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

// Offers of equal price keep their listing order: the sort key is price,
// then a player before a bot, then the NPC last. Bot asks of the same price
// have no further key, so the comparator must call them equal.
const ITEM = 1865;
const seller = (characterId, price) => ({
    characterId,
    name: `Seller${characterId}`,
    activity: 'merchant',
    stats: { marketStore: { storeType: 1, town: 'Giran', items: [{ selfId: ITEM, name: 'Varnish', count: 5, price }] } }
});

MarketOpportunity.resetColdStores();
[seller(990301, 100), seller(990302, 100), seller(990303, 90), seller(990304, 100)]
    .forEach((state) => MarketOpportunity.indexColdStore(state));

const listed = MarketOpportunity.coldOffers(ITEM, null).map((offer) => offer.sourceId);
assert.deepStrictEqual(listed, [990301, 990302, 990303, 990304]);
assert.deepStrictEqual(MarketOpportunity.findOffers(ITEM).map((offer) => offer.sourceId),
    [990303, 990301, 990302, 990304], 'equal-price bot asks must keep their listing order');
MarketOpportunity.resetColdStores();

// Hot bots sort live private stores with the same key.
const World = invoke('GameServer/World/World');
const originalUser = World.user;
const store = (id, price) => ({
    accountId: `bot_${id}`,
    actor: {
        fetchId: () => id,
        fetchName: () => `Store${id}`,
        fetchPrivateStore: () => ({ storeType: 1, town: 'Giran', items: [{ selfId: ITEM, count: 5, price }] })
    }
});
try {
    World.user = { sessions: [store(990311, 100), store(990312, 100), store(990313, 90), store(990314, 100)] };
    assert.deepStrictEqual(MarketOpportunity.hotOffers(ITEM).map((offer) => offer.sourceId),
        [990313, 990311, 990312, 990314], 'a hot bot must see equal-price asks in listing order');
} finally {
    World.user = originalUser;
}

// The clan planning worker orders the same offers as the main thread: a
// private store and a cold store at the same price in the same town.
async function clanWorkerTie() {
    const Runtime = require('../src/GameServer/Clan/ClanPlanningCoordinator');
    const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');
    const worker = new Runtime.ClanPlanningCoordinator();
    try {
        World.user = { sessions: [store(990321, 50)] };
        World.user.sessions[0].actor.fetchPrivateStore = () => ({ storeType: 1, town: 'Giran', items: [{ selfId: 123, count: 1, price: 50 }] });
        MarketOpportunity.indexColdStore({ characterId: 990322, activity: 'merchant', stats: {
            marketStore: { storeType: 1, town: 'Giran', items: [{ selfId: 123, price: 50, count: 1 }] } } });
        const member = { characterId: 990323, level: 20, classId: 4, phase: 'cold', inventory: {}, adena: 100000,
            stats: { classId: 4, equipmentPlan: { status: 'active', strategy: 'market', rateModelVersion: 0,
                target: { selfId: 123, slot: 7 } } } };
        const expected = planForMember(member);
        assert.strictEqual(expected.market.sourceType, 'private_store');
        assert.deepStrictEqual(await worker.plan({ member, spots: [], warehouseRows: [], options: {},
            context: await Runtime.context() }, DataCache), expected,
        'the clan worker must take the same tied offer as the main thread');
    } finally {
        World.user = originalUser;
        MarketOpportunity.resetColdStores();
        await worker.shutdown();
    }
}

clanWorkerTie().then(() => console.log('Bot market offer order checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
DataCache.init();

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const originalUser = World.user;

try {
    const playerStore = {
        storeType: 1,
        town: 'Giran',
        items: [{ selfId: 2, price: 1000, count: 2 }]
    };
    World.user = { sessions: [{
        actor: {
            fetchId: () => 9001,
            fetchName: () => 'PlayerSeller',
            fetchPrivateStore: () => playerStore
        }
    }] };

    // A player's live store trades face to face (E14): a hot bot sees it, a
    // cold buyer does not.
    const offers = MarketOpportunity.findOffers(2, { town: 'Giran' });
    assert(!offers.some((offer) => offer.sourceType === 'private_store'), 'a cold buyer never buys from a live player store');
    assert(offers.some((offer) => offer.sourceType === 'npc'), 'Giran NPC shop should remain a valid source');
    const hot = MarketOpportunity.hotOffers(2, { town: 'Giran' });
    assert(hot.some((offer) => offer.sourceType === 'private_store' && offer.sourceName === 'PlayerSeller'));

    const reserved = hot.find((offer) => offer.sourceType === 'private_store');
    assert.strictEqual(MarketOpportunity.reserve(reserved), true);
    assert.strictEqual(playerStore.items[0].count, 1);
    MarketOpportunity.release(reserved);
    assert.strictEqual(playerStore.items[0].count, 2);

    playerStore.items[0].count = 0;
    assert(!MarketOpportunity.hotOffers(2, { town: 'Giran' }).some((offer) => offer.sourceType === 'private_store'));

    playerStore.items[0].count = 1;
    World.user.sessions[0].accountId = 'bot_islandmats';
    World.user.sessions[0].actor.fetchName = () => 'IslandMats';
    assert.strictEqual(
        MarketOpportunity.findOffers(2, { town: 'Giran' }).find((offer) => offer.sourceType === 'private_store').sellerKind,
        'fixed',
        'configured liquidity merchants must not be counted as peer bots'
    );
    World.user.sessions[0].name = 'IslandMats';
    World.user.sessions[0].actor.fetchName = () => undefined;
    assert.strictEqual(
        MarketOpportunity.findOffers(2, { town: 'Giran' }).find((offer) => offer.sourceType === 'private_store').sellerKind,
        'fixed',
        'session identity must keep configured merchants fixed when the actor name is temporarily unavailable'
    );

    // The budget-backed buy stores are gone (E24): a bot asks on the board
    // with escrow; a live store's budget is no demand.
    const budgetStore = { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 100, count: 3 }] };
    World.user.sessions = [{
        actor: { fetchId: () => 9200, fetchPrivateStore: () => budgetStore },
        coldMarketState: { characterId: 9200, adena: 150, stats: { marketStore: budgetStore } }
    }];
    assert.deepStrictEqual(MarketOpportunity.activeBuyDemandSelfIds(), [],
        'a budget-backed live WTB is not board demand');
    assert.deepStrictEqual(MarketOpportunity.findBuyOffers(1864, { town: 'Giran' }), [],
        'only board buy records are sold into');
    console.log('Bot market opportunity checks passed');
} finally {
    World.user = originalUser;
}

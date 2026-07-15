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

    const offers = MarketOpportunity.findOffers(2, { town: 'Giran' });
    assert(offers.some((offer) => offer.sourceType === 'private_store'));
    assert(offers.some((offer) => offer.sourceType === 'npc'), 'Giran NPC shop should remain a valid source');
    assert.strictEqual(MarketOpportunity.bestOffer(2, { town: 'Giran', budget: 999 }), null);
    assert.strictEqual(MarketOpportunity.bestOffer(2, { town: 'Giran', budget: 1000 }).sourceName, 'PlayerSeller');

    const reserved = MarketOpportunity.bestOffer(2, { town: 'Giran', budget: 1000 });
    assert.strictEqual(MarketOpportunity.reserve(reserved), true);
    assert.strictEqual(playerStore.items[0].count, 1);
    MarketOpportunity.release(reserved);
    assert.strictEqual(playerStore.items[0].count, 2);

    playerStore.items[0].count = 0;
    assert(!MarketOpportunity.findOffers(2, { town: 'Giran' }).some((offer) => offer.sourceType === 'private_store'));
    console.log('Bot market opportunity checks passed');
} finally {
    World.user = originalUser;
}

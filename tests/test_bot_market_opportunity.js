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

    playerStore.items[0].count = 1;
    World.user.sessions[0].accountId = 'bot_mira';
    World.user.sessions[0].actor.fetchName = () => 'Mira';
    assert.strictEqual(
        MarketOpportunity.findOffers(2, { town: 'Giran' }).find((offer) => offer.sourceType === 'private_store').sellerKind,
        'fixed',
        'configured liquidity merchants must not be counted as peer bots'
    );
    World.user.sessions[0].name = 'Mira';
    World.user.sessions[0].actor.fetchName = () => undefined;
    assert.strictEqual(
        MarketOpportunity.findOffers(2, { town: 'Giran' }).find((offer) => offer.sourceType === 'private_store').sellerKind,
        'fixed',
        'session identity must keep configured merchants fixed when the actor name is temporarily unavailable'
    );

    const budgetStore = { storeType: 3, budgetBacked: true, items: [{ selfId: 1864, price: 100, count: 3 }] };
    const budgetBuyer = { characterId: 9200, adena: 150, stats: { marketStore: budgetStore } };
    World.user.sessions = [{
        actor: { fetchId: () => 9200, fetchPrivateStore: () => budgetStore },
        coldMarketState: budgetBuyer
    }];
    assert.deepStrictEqual(MarketOpportunity.activeBuyDemandSelfIds(), [1864],
        'budget-backed live WTB demand must participate in warehouse admission');
    const firstBudgetOffer = { sourceType: 'cold_buy_store', selfId: 1864, price: 100, count: 1, buyerState: budgetBuyer, store: budgetStore, storeItem: budgetStore.items[0] };
    const overlappingBudgetOffer = { ...firstBudgetOffer };
    assert.strictEqual(MarketOpportunity.reserveBuy(firstBudgetOffer, 1), true);
    assert.strictEqual(MarketOpportunity.reserveBuy(overlappingBudgetOffer, 1), false, 'in-flight WTB demand must reserve buyer Adena as well as stock');
    MarketOpportunity.releaseBuy(firstBudgetOffer, 1);
    assert.strictEqual(MarketOpportunity.reserveBuy(overlappingBudgetOffer, 1), true, 'releasing a failed settlement must return its budget reservation');
    const purchasedBuyer = { ...budgetBuyer, adena: 50 };
    MarketOpportunity.commitBuy(overlappingBudgetOffer, 1, purchasedBuyer);
    const exhaustedBudgetOffer = { sourceType: 'cold_buy_store', selfId: 1864, price: 100, count: 1, buyerState: purchasedBuyer, store: budgetStore, storeItem: budgetStore.items[0] };
    assert.strictEqual(MarketOpportunity.reserveBuy(exhaustedBudgetOffer, 1), false, 'a committed purchase must expose the reduced buyer balance');

    playerStore.items[0].count = 0;
    MarketOpportunity.indexColdStore({
        characterId: 9100,
        name: 'ExpiredSeller',
        activity: 'merchant',
        stats: { marketStore: { storeType: 1, town: 'Giran', expiresAt: Date.now() - 1, items: [{ selfId: 2, price: 900, count: 1 }] } }
    });
    assert(!MarketOpportunity.findOffers(2, { town: 'Giran' }).some((offer) => offer.sourceName === 'ExpiredSeller'), 'expired cold WTS listings must not remain buyable');
    console.log('Bot market opportunity checks passed');
} finally {
    World.user = originalUser;
    MarketOpportunity.resetColdStores();
}

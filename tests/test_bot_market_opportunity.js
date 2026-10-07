const assert = require('assert');

require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fixtureFs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fixtureFs.rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
DataCache.init();

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
// Every offer the one query weighs, in the order it meets them (an accept
// that takes none).
const candidates = (selfId, options = {}) => {
    const seen = [];
    MarketOpportunity.bestOffer(selfId, { ...options, accept: (offer) => { seen.push(offer); return false; } });
    return seen;
};
const originalUser = World.user;

async function run() {
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
    const offers = candidates(2, { town: 'Giran' });
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
    // ARCH-NOTE: Group F retires configured non-shot stock; E14 excludes live stores for cold buyers.
    assert(!candidates(2, { town: 'Giran' }).some(offer => offer.sourceType === 'private_store'),
        'a configured Long Sword cannot reenter the cold query through its live store');
    assert(!MarketOpportunity.hotOffers(2, { town: 'Giran' }).some(offer => offer.sourceType === 'private_store'),
        'configured non-shot supply is also rejected on execution-facing hot discovery');
    World.user.sessions[0].name = 'IslandMats';
    World.user.sessions[0].actor.fetchName = () => undefined;
    assert(!candidates(2, { town: 'Giran' }).some(offer => offer.sourceType === 'private_store'),
        'session identity cannot turn a retired non-shot merchant into a peer offer');
    const Database = invoke('Database'), Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const native = require('./helpers/nativeMarketFixture');
    Database.init();
    await native.character(Database, 9001, 'PlayerSeller', 'bot_market_fixture9001');
    const stockId = Number((await Database.setItem(9001, { selfId: 2, name: 'Long Sword', amount: 1 })).insertId);
    const shop = await Afk.publishBot(9001, { kind: 'shop', storeType: 1, town: 'Giran', title: 'Long Sword',
        locX: 83000, locY: 148000, locZ: -3400, appearance: { model: { name: 'PlayerSeller' } },
        lines: [{ objectId: stockId, selfId: 2, name: 'Long Sword', count: 1, price: 1000, stackable: false }] });
    const boardOffer = candidates(2, { town: 'Giran' }).find(offer => offer.recordId === shop.id);
    assert(boardOffer, 'the same Long Sword is a genuine public cold offer');
    assert.deepStrictEqual([boardOffer.selfId, boardOffer.price, boardOffer.count, boardOffer.sourceId], [2, 1000, 1, 9001]);
    assert.equal(native.amount(await Database.fetchItems(9001), 2), 0, 'public stock is physically escrowed');
    await Afk.closeBotRecord(9001, shop.id);
    assert.equal(native.amount(await Database.fetchItems(9001), 2), 1, 'closing returns the exact physical sword');
    console.log('Native public counterpart: one Long Sword escrowed and returned, price1000/owner9001');

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
    invoke('GameServer/AfkTrade/AfkTradeService')._resetForTests();
    await invoke('Database').close();
}
}
run().catch(error => { console.error(error); process.exitCode = 1; });

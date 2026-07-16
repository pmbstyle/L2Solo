const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

DataCache.init();

const originals = {
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    updateCharacterLocation: Database.updateCharacterLocation,
    updateCharacterExperience: Database.updateCharacterExperience,
    updateCharacterVitals: Database.updateCharacterVitals
};
const calls = [];

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.fetchItems = () => Promise.resolve([
        { id: 20, selfId: 57, amount: 500, equipped: false, slot: 0 },
        { id: 21, selfId: 1, amount: 1, equipped: false, slot: 7 },
        { id: 22, selfId: 2, amount: 1, equipped: true, slot: 7 }
    ]);
    Database.updateItemAmount = (characterId, id, amount) => {
        calls.push({ type: 'amount', characterId, id, amount });
        return Promise.resolve();
    };
    Database.updateItemEquipState = () => Promise.resolve();
    Database.updateCharacterLocation = () => Promise.resolve();
    Database.updateCharacterExperience = () => Promise.resolve();
    Database.updateCharacterVitals = () => Promise.resolve();

    const state = {
        characterId: 88,
        accountName: 'seller88',
        name: 'ColdSeller',
        level: 10,
        adena: 500,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        spotId: 'starter_local',
        loc: { locX: 82698, locY: 148638, locZ: -3473 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: {},
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            1: { selfId: 1, name: 'Short Sword', amount: 1, equipped: false, slot: 7, kind: 'Weapon.Sword' },
            2: { selfId: 2, name: 'Long Sword', amount: 1, equipped: true, slot: 7, kind: 'Weapon.Sword' }
        },
        stats: {
            equipment: [{ selfId: 2, slot: 7 }],
            marketReturn: { loc: { locX: 1, locY: 2, locZ: 3 }, regionName: 'Dion', spotId: 'starter_local' }
        }
    };

    const candidates = ItemDisposition.saleCandidates(state);
    assert.deepStrictEqual(candidates.map((item) => item.selfId), [1], 'equipped gear must never be listed');

    const opened = await ListingService.open(state, { now: 1000, durationMs: 60000, random: () => 0.1 });
    assert.strictEqual(opened.listed, true);
    assert.strictEqual(opened.state.activity, 'merchant');
    assert(ListingService.isGiranPlazaStallLocation(opened.state.loc), 'a Giran store must use the captured trading square and avoid its central column');
    assert.deepStrictEqual(opened.state.stats.marketStore.loc, opened.state.loc, 'the stall coordinate must survive hot/cold transitions');

    const ownOffer = MarketOpportunity.bestOffer(1, { town: 'Giran', buyerCharacterId: 88 });
    assert(!ownOffer || ownOffer.sourceType !== 'cold_store', 'seller must not buy its own listing');
    const offer = MarketOpportunity.bestOffer(1, { town: 'Giran', buyerCharacterId: 99 });
    assert.strictEqual(offer.sourceType, 'cold_store');
    assert.strictEqual(MarketOpportunity.reserve(offer), true);
    offer.buyerCharacterId = 99;

    const sold = await ListingService.settle(offer);
    assert.strictEqual(sold.adena, 500 + offer.price);
    assert.strictEqual(sold.inventory['1'].amount, 0);
    assert.strictEqual(sold.stats.marketStore.items[0].count, 0);
    assert(calls.some((call) => call.type === 'amount' && call.id === 21 && call.amount === 0));
    assert(calls.some((call) => call.type === 'amount' && call.id === 20 && call.amount === 500 + offer.price));

    const closedResult = await ListingService.resolve(sold, 2000);
    const closed = closedResult.state;
    assert.strictEqual(closed.activity, 'shopping');
    assert.strictEqual(closed.stats.marketStore, null);

    const expiredState = { ...state, characterId: 89, name: 'ExpiredSeller' };
    const expiredOpened = await ListingService.open(expiredState, { now: 1000, durationMs: 60000 });
    const expiredResult = await ListingService.resolve(expiredOpened.state, 62000);
    assert.strictEqual(expiredResult.closed, true);
    assert.strictEqual(expiredResult.reason, 'expired');
    assert.strictEqual(expiredResult.state.inventory['1'].amount, 0, 'low-value old gear should be liquidated at the NPC');
    assert.strictEqual(expiredResult.state.adena, 884, 'NPC payout should use the normal 50% sale price');
    assert(Number(expiredResult.state.stats.marketSellRetryAfter) > 62000, 'valuable unsold stock needs a later market retry');
    console.log('Bot cold market listing checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originals.execute;
    Database.fetchItems = originals.fetchItems;
    Database.updateItemAmount = originals.updateItemAmount;
    Database.updateItemEquipState = originals.updateItemEquipState;
    Database.updateCharacterLocation = originals.updateCharacterLocation;
    Database.updateCharacterExperience = originals.updateCharacterExperience;
    Database.updateCharacterVitals = originals.updateCharacterVitals;
    LifeState.reset?.();
    MarketOpportunity.resetColdStores();
});

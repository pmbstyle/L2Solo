// Pins what each caller of the offer query sees before the copies become one
// query (step 3.3 group B, U20): the town each caller looks in, which owners
// and source kinds it skips, and the line it takes. Board records live in
// memory only (AfkTrade.refreshRecord); no database.
const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
World.user = { sessions: [], revision: 0 };

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');

const STEM = 1864;
const SOULSHOT = 1835;
const SWORD = 2;
let nextId = 991000;

function record(ownerId, { kind = 'sell_ad', storeType = 1, town = 'Giran', account = `bot_${ownerId}`, lines }) {
    const id = ++nextId;
    return AfkTrade.refreshRecord({
        id, ownerId, ownerName: `Owner${ownerId}`, ownerAccount: account, kind, storeType, status: 'active', town,
        title: '', revision: 1, expiresAt: 0, locX: 83000, locY: 148000, locZ: -3400, appearance: {},
        lines: lines.map((line, index) => ({ id: id * 10 + index, name: `Item ${line.selfId}`, enchant: 0, ...line }))
    });
}

function picked(offer) {
    return offer ? `${offer.sourceType}:${offer.sourceId}:${offer.town}:${offer.price}` : null;
}

// C2 (ClanEquipmentService recheck) and C6/C9: the buyer's own records and
// other towns are skipped; in town an NPC competes.
{
    record(991101, { town: 'Dion', lines: [{ selfId: STEM, count: 3, price: 10 }] });
    record(991102, { town: 'Giran', lines: [{ selfId: STEM, count: 3, price: 12 }] });
    record(991103, { town: 'Giran', lines: [{ selfId: STEM, count: 3, price: 11 }] });
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { town: 'Giran', buyerCharacterId: 991103 })),
        'afk_bot_store:991102:Giran:12', 'C2: own record skipped, other town ignored');
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { town: 'Giran', budget: 11 })),
        'afk_bot_store:991103:Giran:11', 'C6: the budget caps the price');
    assert.strictEqual(MarketOpportunity.bestOffer(STEM, { town: 'Giran', budget: 10 }), null);
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, {})), 'afk_bot_store:991101:Dion:10',
        'C8: no town and no buyer, the cheapest anywhere');
    assert.strictEqual(picked(MarketOpportunity.bestOffer(STEM, { buyerCharacterId: 991101 })),
        'afk_bot_store:991103:Giran:11', 'no town, own record skipped');
    AfkTrade._resetForTests();
}

// C7 (BotAfkMarketService.canTradeRemotely): without a planned market town the
// remote search sees board records in every town and no NPC; with one, a
// cheaper NPC there keeps the bot off the board.
{
    const state = { characterId: 991201, accountName: 'bot_991201', phase: 'cold', level: 20, adena: 1000000,
        inventory: {}, stats: { generatedCold: true } };
    const goal = (marketTown) => ({ type: 'upgrade_gear', status: 'active', target: { itemId: SWORD, adena: 900000 },
        plan: { expectedBenefit: 'market_search_for_weapon', marketTown, estimatedCost: 900000 } });
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal(null)), true, 'C7: no town, no NPC in the way');
    assert.strictEqual(BotAfkMarket.canTradeRemotely(state, goal('Giran')), false, 'C7: an NPC in the planned town');
    record(991202, { town: 'Dion', lines: [{ selfId: SWORD, count: 1, price: 1 }] });
    assert.strictEqual(picked(MarketOpportunity.bestOffer(SWORD, { town: null, budget: 1000000, buyerCharacterId: 991201 })),
        'afk_bot_store:991202:Dion:1', 'C7: a board line in any town');
    AfkTrade._resetForTests();
}

// C11 (ShotStock.restockTarget): a hot shot trip goes to a seller standing in
// the town; an ad has no one to walk to, the bot's own shop and the excluded
// sellers are skipped.
{
    const actor = { fetchId: () => 991301, classId: 0 };
    record(991302, { kind: 'sell_ad', lines: [{ selfId: SOULSHOT, count: 500, price: 5 }] });
    record(991301, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 4 }] });
    record(991303, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 6 }] });
    record(991304, { kind: 'shop', lines: [{ selfId: SOULSHOT, count: 500, price: 6 }] });
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran')?.sourceId, 991303, 'C11: the cheapest stall, not an ad');
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran', [991303])?.sourceId, 991304, 'C11: excluded skipped');
    assert.strictEqual(ShotStock.restockTarget(actor, 'Dion'), null, 'C11: only the town');
    AfkTrade._resetForTests();
}

// C14 (NeedsEvaluator market material): a crafter buys a missing material on
// the board when it saves farming, from the offer that saves most.
{
    record(991402, { town: 'Dion', lines: [{ selfId: STEM, count: 2, price: 40 }] });
    record(991403, { town: 'Giran', lines: [{ selfId: STEM, count: 5, price: 50 }] });
    record(991401, { town: 'Giran', lines: [{ selfId: STEM, count: 9, price: 1 }] });
    const state = { characterId: 991401, accountName: 'bot_991401', name: 'Crafter', phase: 'cold', level: 30,
        classId: 0, adena: 200000, activity: 'hunting', currentRegion: 'Giran', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1,
            materials: [{ selfId: STEM, amount: 5, missing: 5, farmEffort: 50 }] } } };
    const need = NeedsEvaluator.evaluate(state).find((candidate) => candidate.type === 'buy_craft_material');
    assert.strictEqual(need?.plan.marketTown, 'Giran', 'C14: the larger lot saves more');
    assert.strictEqual(need.plan.estimatedCost, 50);
    AfkTrade._resetForTests();
}

console.log('Offer query callers: pinned');

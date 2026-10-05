const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

DataCache.init();

// The bot's sale (group E): the author's hard rules for what never enters
// the board; every other item by one expected-value decision (board at its
// best ask, NPC buy-back now, or keeping it); the board's slots by a roll on
// the gain over the NPC; a line the bot has keeps its slot and price. No
// timed markdown, no listing floor, no recipe rule.
const starterWeapon = (DataCache.newbieItems || [])
    .flatMap((row) => row.items || [])
    .map((item) => DataCache.items.find((entry) => Number(entry.selfId) === Number(item.selfId)))
    .find((item) => item?.template?.kind?.startsWith('Weapon.'));
const lowGradeGear = DataCache.items.find((item) => (
    (item?.template?.kind?.startsWith('Weapon.') || item?.template?.kind?.startsWith('Armor.'))
    && ItemDisposition.gradeIndex(item.etc?.rank) < ItemDisposition.gradeIndex('c')
    && Number(item.template.price || 0) <= 50000
    && !MarketListingPolicy.starterItemIds().has(Number(item.selfId))
));
const spellbook = DataCache.items.find((item) => item?.template?.kind === 'Other.Spellbook');
assert(starterWeapon && lowGradeGear && spellbook, 'datapack fixtures');

function saleItem(item, count = 1, price = 1000) {
    return { selfId: Number(item.selfId), name: item.template.name, kind: item.template.kind,
        rank: item.etc?.rank || 'none', count, price, basePrice: Number(item.template.price || 0) };
}
const seller = { characterId: 10, name: 'Seller', level: 40, stats: {} };
const originalRate = process.env.L2NODE_PROGRESSION_RATE;
function atRate(rate, work) {
    process.env.L2NODE_PROGRESSION_RATE = rate;
    try { return work(); } finally {
        if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = originalRate;
    }
}

// Hard rules.
assert.deepStrictEqual(MarketListingPolicy.classify(seller, saleItem(starterWeapon)), { action: 'npc', reason: 'starter_kit' });
assert.strictEqual(atRate('x50', () => MarketListingPolicy.classify(seller, saleItem(lowGradeGear)).reason), 'low_grade_high_rate');
assert.strictEqual(MarketListingPolicy.classify(seller, saleItem(spellbook)).reason, 'npc_only_item');
assert.strictEqual(MarketListingPolicy.classify(seller, { ...saleItem(DataCache.items.find((item) => Number(item.selfId) === 1865)), count: 2 }).reason,
    'small_material_lot');
assert.strictEqual(atRate('x10', () => MarketListingPolicy.classify(seller, saleItem(lowGradeGear)).action), 'market',
    'anything else is the market\'s, at any demand');
for (const removed of ['listingFloor', 'listingPrice', 'SPECULATIVE_SUPPLY_LIMIT', 'MIN_LISTING_BASE_PERCENT']) {
    assert.strictEqual(MarketListingPolicy[removed], undefined, `${removed} is gone`);
}
assert.strictEqual(BotMarketPricing.listingFloor, undefined, 'no 60% listing floor');

// A small world: an empty board index and counters for the items below.
const items = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873];
const bag = Object.fromEntries(items.map((selfId) => [selfId, { selfId, amount: 100, kind: 'Other.Material' }]));
const state = { characterId: 4242, level: 40, adena: 50000, stats: { generatedCold: true }, inventory: bag };
const now = 1800000000000;
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const options = (extra = {}) => ({ now, board, persona: null, npcOffersFor: () => [], findSpot: () => null, ...extra });
MarketCounters.reset();
// Nobody buys these anywhere: no board line. An item whose buy-back is close
// to its own value goes to the NPC; one worth far more is kept rather than
// sold at a loss (caution is loss aversion), while it has room.
const withoutMarket = MarketListingPolicy.evaluate(state, options());
assert.strictEqual(withoutMarket.listings.length, 0, 'nobody buys these: no board line');
const atLoss = withoutMarket.decisions.filter((decision) => decision.priced.ask.npcValue < 0);
const nearValue = withoutMarket.decisions.filter((decision) => decision.priced.ask.npcValue > 0);
assert(atLoss.length && nearValue.length, 'fixtures of both kinds');
assert(atLoss.filter((decision) => decision.action === 'warehouse').length >= atLoss.length - 1, 'kept rather than sold at a loss');
assert(nearValue.filter((decision) => decision.action === 'npc').length >= nearValue.length - 1, 'sold to the NPC');
// No room to keep (a third copy of a gear piece): the NPC.
const gear = { characterId: 4243, level: 40, adena: 50000, stats: { generatedCold: true },
    inventory: { [lowGradeGear.selfId]: { selfId: Number(lowGradeGear.selfId), amount: 1, kind: lowGradeGear.template.kind } } };
const full = MarketListingPolicy.evaluate(gear, options({ stored: new Map([[Number(lowGradeGear.selfId), 2]]) }));
assert.strictEqual(full.decisions[0].action, 'npc', 'no room to keep it and nobody buys it');

for (let deal = 0; deal < 60; deal++) {
    for (const selfId of items) MarketCounters.deal(selfId, 3000, 20, now - (60 - deal) * 60000, 1);
}
const sale = MarketListingPolicy.evaluate(state, options());
assert.strictEqual(sale.listings.length, MarketListingPolicy.BOARD_SLOTS, 'eight board slots: 3 shop lines + 5 sell ads');
assert.strictEqual(sale.decisions.filter((decision) => decision.reason === 'no_board_slot').length,
    items.length - MarketListingPolicy.BOARD_SLOTS, 'the rest is kept, not dumped');
for (const listing of sale.listings) {
    assert(listing.price > 0 && listing.marketReason === 'expected_value');
    assert.strictEqual(listing.count, 100, 'all units of the lot');
}
const again = MarketListingPolicy.evaluate(state, options());
assert.deepStrictEqual(again.listings.map((item) => [item.selfId, item.price]), sale.listings.map((item) => [item.selfId, item.price]),
    'one decision point, one roll: the same answer when asked again');
const other = MarketListingPolicy.evaluate(state, options({ now: now + 1 }));
assert(other.listings.some((item, at) => item.selfId !== sale.listings[at]?.selfId || item.price !== sale.listings[at].price)
    || other.listings.length !== sale.listings.length, 'another decision point rolls anew');
// The listed items' beliefs are kept, with the ask and the market seen now.
const book = sale.book;
for (const listing of sale.listings) {
    const belief = book.beliefs.get(listing.selfId);
    assert(belief, 'a listed item keeps its belief');
    assert.strictEqual(belief.ask, listing.price);
    assert.strictEqual(belief.seenItem, MarketCounters.itemDeals(listing.selfId).deals);
}
assert.strictEqual(book.beliefs.size, MarketListingPolicy.BOARD_SLOTS, 'only listed items are touched');
assert(PriceBelief.writeBook(book).b.length === book.beliefs.size);

// A line the bot has keeps its slot and its price; the free slots go by the roll.
const kept = new Map([[items[0], 4321], [items[1], 4322]]);
const review = MarketListingPolicy.evaluate(state, options({ kept, slots: 3 }));
assert.deepStrictEqual(review.listings.filter((item) => kept.has(item.selfId)).map((item) => [item.selfId, item.price])
    .sort((a, b) => a[0] - b[0]), [[items[0], 4321], [items[1], 4322]]);
assert.strictEqual(review.listings.length, 3, 'one free slot left');

// A recipe has no first place and no rule of its own: it competes by its gain.
const recipeState = { ...state, inventory: { ...bag, 1804: { selfId: 1804, amount: 1, kind: 'Other.Recipe' } } };
const recipeSale = MarketListingPolicy.evaluate(recipeState, options({ recipeFirst: true }));
const recipeDecision = recipeSale.decisions.find((decision) => decision.item.selfId === 1804);
assert.strictEqual(recipeDecision.reason === 'expected_value' || recipeDecision.reason === 'no_board_slot', true);
MarketCounters.reset();
console.log('Bot market listing policy: hard rules, one expected-value decision, slots by gain, kept lines passed');

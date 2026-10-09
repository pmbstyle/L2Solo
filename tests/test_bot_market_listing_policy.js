const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
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
    && invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId)
));
const spellbook = DataCache.items.find((item) => Number(item.selfId) === 3942); // reachable unmapped C4 book: Party Return
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
assert.deepStrictEqual(MarketListingPolicy.classify(seller, saleItem(starterWeapon)),
    { action: 'market', reason: 'market' }, 'owned creation-origin surplus uses the shared market decision');
for (const rate of ['x1', 'x10', 'x50']) {
    assert.strictEqual(atRate(rate, () => MarketListingPolicy.classify(seller, saleItem(lowGradeGear)).action), 'market',
        'low-grade gear uses the same market decision at every rate');
}
assert.strictEqual(MarketListingPolicy.classify(seller, saleItem(spellbook)).reason, 'npc_only_item');
assert.strictEqual(MarketListingPolicy.classify(seller, { ...saleItem(DataCache.items.find((item) => Number(item.selfId) === 1865)), count: 2 }).reason,
    'market');
assert.strictEqual(atRate('x10', () => MarketListingPolicy.classify(seller, saleItem(lowGradeGear)).action), 'market',
    'anything else is the market\'s, at any demand');
for (const removed of ['listingFloor', 'listingPrice', 'SPECULATIVE_SUPPLY_LIMIT', 'MIN_LISTING_BASE_PERCENT']) {
    assert.strictEqual(MarketListingPolicy[removed], undefined, `${removed} is gone`);
}
assert.strictEqual(BotMarketPricing.listingFloor, undefined, 'no 60% listing floor');

const cheapCPlus = { ...saleItem(lowGradeGear), rank: 'c', basePrice: 1000 };
assert.strictEqual(MarketListingPolicy.classify(seller, cheapCPlus).action, 'market',
    'cheap C+ gear reaches shared valuation');
assert.strictEqual(MarketListingPolicy.classify(seller, { ...saleItem(starterWeapon), enchant: 6 }).action,
    'market', 'enchanted creation-origin surplus retains its legitimate source');
for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(MarketListingPolicy.classify(seller, { ...saleItem(lowGradeGear), count }).action,
        'ignore', 'invalid physical counts never enter valuation');
}

// A small world: an empty board index and counters for the items below.
const items = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873];
const bag = Object.fromEntries(items.map((selfId) => [selfId, { selfId, amount: 100, kind: 'Other.Material' }]));
const state = { characterId: 4242, level: 40, adena: 50000, stats: { generatedCold: true }, inventory: bag };
const now = 1800000000000;
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const options = (extra = {}) => ({ now, board, persona: null, npcOffersFor: () => [], findSpot: () => null, ...extra });
// The native inventory path nominates a spare starter weapon and a one-unit
// material; valuation can still keep or liquidate them when demand is absent.
const spareStarter = { ...state, inventory: {
    [starterWeapon.selfId]: { selfId: Number(starterWeapon.selfId), amount: 2,
        equippedCount: 1, enchant: 6, kind: starterWeapon.template.kind },
    1865: { selfId: 1865, amount: 1, kind: 'Other.Material' }
} };
const admitted = MarketListingPolicy.evaluate(spareStarter, options({ keptAmounts: {}, preparedReservations: {} }));
const starterDecision = admitted.decisions.find(decision => decision.item.selfId === Number(starterWeapon.selfId));
assert.strictEqual(starterDecision?.item.count, 1, 'only the spare creation-origin weapon reaches shared disposition');
assert.strictEqual(starterDecision.priced, null, 'creation origin invents no price for an unobserved enchant');
assert.strictEqual(starterDecision.action, 'warehouse', 'unknown enchanted value retains the physical spare');
assert(admitted.decisions.some(decision => decision.item.selfId === 1865 && decision.item.count === 1
    && decision.priced), 'a single material reaches shared valuation');
assert.strictEqual(spareStarter.inventory[starterWeapon.selfId].amount, 2, 'nomination never moves physical items');

MarketCounters.reset();
// The same tiny physical lot answers a nearby public buyer. Changing only
// the actual trip fees/time makes that answer lose the shared valuation.
const bidBoard = new BoardIndex({ groupOf: MarketCounters.counterOf });
bidBoard.put({ id: 950001, kind: 'buy_ad', storeType: 3, ownerId: 950002,
    town: 'Giran', lines: [{ lineId: 950003, selfId: 1865, count: 2, price: 10000, enchant: 0 }] });
const tinyStock = { ...state, inventory: { 1865: { selfId: 1865, amount: 2, kind: 'Other.Material' } } };
function tinySale(fees, hours) {
    const tripCost = () => fees;
    tripCost.details = () => ({ known: true, fees, hours });
    return MarketListingPolicy.evaluate(tinyStock, options({ board: bidBoard, tripCost,
        keptAmounts: {}, preparedReservations: {} }));
}
const nearbyTinySale = tinySale(0, 0);
assert.strictEqual(nearbyTinySale.answers.length, 1, 'two materials can answer a nearby profitable buyer');
assert.strictEqual(nearbyTinySale.answers[0].count, 2);
const distantTinySale = tinySale(30000, 1);
assert.strictEqual(distantTinySale.answers.length, 0,
    'the same 20000 Adena receipts do not pay a 30000 Adena trip plus an hour of lost activity');
assert.strictEqual(distantTinySale.decisions[0].reason, 'expected_value',
    'the travel loss is decided by shared valuation, not lot admission');
assert.strictEqual(tinyStock.inventory[1865].amount, 2, 'comparing trips never moves the physical lot');

// No supported finite item demand exists. The public first price is not an
// owner-blind recipe willingness or an observed listing lifetime.
const withoutMarket = MarketListingPolicy.evaluate(state, options());
assert.strictEqual(withoutMarket.listings.length, 0, 'nobody buys these: no board line');
assert(withoutMarket.decisions.every(decision => decision.priced.market.known === false
    && decision.priced.ask.known === false), 'unknown forecasts stay explicit for the entire unchanged bag');
assert(withoutMarket.decisions.every(decision => ['npc', 'warehouse'].includes(decision.action)),
    'only immediate NPC liquidation or remaining physical goods have supported outcomes');
// No room to keep (a third copy of a gear piece): the NPC.
const gear = { characterId: 4243, level: 40, adena: 50000, stats: { generatedCold: true },
    inventory: { [lowGradeGear.selfId]: { selfId: Number(lowGradeGear.selfId), amount: 1, kind: lowGradeGear.template.kind } } };
const full = MarketListingPolicy.evaluate(gear, options({ stored: new Map([[Number(lowGradeGear.selfId), 2]]) }));
assert.strictEqual(full.decisions[0].action, 'npc', 'no room to keep it and nobody buys it');

for (let deal = 0; deal < 60; deal++) {
    for (const selfId of items) MarketCounters.deal(selfId, 3000, 20, now - (60 - deal) * 60000, 1);
}
const unsupportedSale = MarketListingPolicy.evaluate(state, options());
assert.strictEqual(unsupportedSale.listings.length, 0, 'sixty kind deals still do not prove finite listing demand');
assert(unsupportedSale.decisions.every(decision => decision.priced.market.known === false));
// Explicit pure conditional segment tests slots and rolls. It never claims
// that the native counter produced arrival, exposure or lifetime evidence.
// Wallet, bag and all recorded deal quotes remain the original values.
const suppliedOptions = (extra = {}) => options({ ...extra, demandFor: selfId => ({
    known: true, origin: 'fixture_finite_demand', authority: { fixture: 'listing_slots' },
    selfId, applicableUnits: 1000, delayHours: 0,
    availability: { from: extra.now ?? now, until: extra.now ?? now }
}) });
const sale = MarketListingPolicy.evaluate(state, suppliedOptions());
assert.strictEqual(sale.listings.length, MarketListingPolicy.BOARD_SLOTS, 'eight board slots: 3 shop lines + 5 sell ads');
assert.strictEqual(sale.decisions.filter((decision) => decision.reason === 'no_board_slot').length,
    items.length - MarketListingPolicy.BOARD_SLOTS, 'the rest is kept, not dumped');
for (const listing of sale.listings) {
    assert(listing.price > 0 && listing.marketReason === 'expected_value');
    assert.strictEqual(listing.count, 100, 'all units of the lot');
}
const again = MarketListingPolicy.evaluate(state, suppliedOptions());
assert.deepStrictEqual(again.listings.map((item) => [item.selfId, item.price]), sale.listings.map((item) => [item.selfId, item.price]),
    'one decision point, one roll: the same answer when asked again');
const other = MarketListingPolicy.evaluate(state, suppliedOptions({ now: now + 1 }));
assert(other.listings.some((item, at) => item.selfId !== sale.listings[at]?.selfId || item.price !== sale.listings[at].price)
    || other.listings.length !== sale.listings.length, 'another decision point rolls anew');
// Only selected lines carry their current quote and public event cursors.
assert.strictEqual('book' in sale, false, 'no personal item book is returned');
for (const listing of sale.listings) {
    assert(listing.pricing, 'a listed item carries line-local pricing');
    assert.strictEqual(listing.pricing.price, listing.price);
    assert.strictEqual(listing.pricing.seenItem, MarketCounters.itemDeals(listing.selfId).deals);
    assert.strictEqual(listing.pricing.seenCounter, MarketCounters.counter(MarketCounters.counterOf(listing.selfId), now).deals);
    assert.strictEqual(listing.pricing.seenFills, 0);
}

// A line the bot has keeps its slot and its price; the free slots go by the roll.
const kept = new Map([[items[0], 4321], [items[1], 4322]]);
const review = MarketListingPolicy.evaluate(state, suppliedOptions({ kept, slots: 3 }));
assert.deepStrictEqual(review.listings.filter((item) => kept.has(item.selfId)).map((item) => [item.selfId, item.price])
    .sort((a, b) => a[0] - b[0]), [[items[0], 4321], [items[1], 4322]]);
assert.strictEqual(review.listings.length, 3, 'one free slot left');

// A recipe has no first place and no rule of its own: it competes by its gain.
const recipeState = { ...state, inventory: { ...bag, 1804: { selfId: 1804, amount: 1, kind: 'Other.Recipe' } } };
const recipeSale = MarketListingPolicy.evaluate(recipeState, suppliedOptions({ recipeFirst: true }));
const recipeDecision = recipeSale.decisions.find((decision) => decision.item.selfId === 1804);
assert.strictEqual(recipeDecision.reason === 'expected_value' || recipeDecision.reason === 'no_board_slot', true);
MarketCounters.reset();
console.log('Bot market listing policy: hard rules, one expected-value decision, slots by gain, kept lines passed');

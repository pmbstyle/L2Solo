const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');

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
const starterIds = new Set((DataCache.newbieItems || []).flatMap((row) => (row.items || []).map((item) => Number(item.selfId))));
const starterGear = DataCache.items.filter(item => starterIds.has(Number(item.selfId))
    && /^(Weapon|Armor)\./.test(item.template?.kind));
const lowGradeGear = DataCache.items.find((item) => (
    (item?.template?.kind?.startsWith('Weapon.') || item?.template?.kind?.startsWith('Armor.'))
    && ItemDisposition.gradeIndex(item.etc?.rank) < ItemDisposition.gradeIndex('c')
    && Number(item.template.price || 0) <= 50000
    && !starterIds.has(Number(item.selfId))
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
    useRate(rate);
    try { return work(); } finally {
        useRate(originalRate);
    }
}

// Hard rules.
assert.deepStrictEqual(MarketListingPolicy.classify(seller, saleItem(starterWeapon)),
    { action: 'npc', reason: 'npc_only_item' }, 'unused starter gear goes directly to the NPC');
for (const rate of ['x1', 'x10', 'x50']) {
    for (const item of starterGear) {
        for (const enchant of [0, 6]) assert.deepStrictEqual(atRate(rate,
            () => MarketListingPolicy.classify(seller, { ...saleItem(item), enchant })),
        { action: 'npc', reason: 'npc_only_item' }, `${item.template.name} stays NPC-only at ${rate} and +${enchant}`);
        assert(ItemDisposition.isNpcOnlyItem({ selfId: item.selfId }), 'canonical starter kind works without a saved kind');
        assert.strictEqual(ItemDisposition.isWarehouseCandidate({ selfId: item.selfId, amount: 1 }), false);
    }
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
    'npc', 'enchanting a starter item does not admit it to the market');
for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(MarketListingPolicy.classify(seller, { ...saleItem(lowGradeGear), count }).action,
        'ignore', 'invalid physical counts never enter valuation');
}

// A small world: an empty board index and counters for the items below.
const items = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873];
const bag = Object.fromEntries(items.map((selfId) => [selfId, { selfId, amount: 100, kind: 'Other.Material' }]));
const state = { characterId: 4242, level: 40, adena: 50000, stats: { generatedCold: true, craftStationId: 1 }, inventory: bag };
const now = 1800000000000;
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const options = (extra = {}) => ({ now, board, persona: null, npcOffersFor: () => [], findSpot: () => null, ...extra });
// Only the spare starter copy is liquidated; normal materials keep valuation.
const spareStarter = { ...state, inventory: {
    [starterWeapon.selfId]: { selfId: Number(starterWeapon.selfId), amount: 2,
        equippedCount: 1, enchant: 6, kind: starterWeapon.template.kind },
    1865: { selfId: 1865, amount: 1, kind: 'Other.Material' }
} };
const admitted = MarketListingPolicy.evaluate(spareStarter, options({ keptAmounts: {}, preparedReservations: {} }));
const starterDecision = admitted.decisions.find(decision => decision.item.selfId === Number(starterWeapon.selfId));
assert.strictEqual(starterDecision?.item.count, 1, 'only the spare creation-origin weapon reaches shared disposition');
assert.strictEqual(starterDecision.priced, undefined, 'starter gear bypasses price valuation');
assert.strictEqual(starterDecision.action, 'npc', 'a spare starter weapon is always NPC stock');
assert.strictEqual(admitted.npc.find(item => item.selfId === Number(starterWeapon.selfId)).count, 1);
assert(admitted.decisions.some(decision => decision.item.selfId === 1865 && decision.item.count === 1
    && decision.priced), 'a single material reaches shared valuation');
assert.strictEqual(spareStarter.inventory[starterWeapon.selfId].amount, 2, 'nomination never moves physical items');

const starterShirt = DataCache.items.find(item => Number(item.selfId) === 1146);
const wornStarter = { ...state, phase: 'cold', activity: 'hunting', currentRegion: 'Cruma Tower',
    loc: { locX: 14500, locY: 114000, locZ: -2400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    inventory: { 1146: {
        selfId: 1146, name: starterShirt.template.name, kind: starterShirt.template.kind,
        stackable: false, amount: 1, equipped: true, equippedCount: 1,
        instances: [{ id: 9060000, amount: 1, equipped: true, slot: starterShirt.etc.slot }]
    } }, stats: { classId: 0, marketSellRetryAfter: now + 60000 } };
assert.strictEqual(ItemDisposition.inventoryCleanupNeed(wornStarter, { now }), null,
    'worn starter equipment does not cause a town trip');
const spareShirt = { ...wornStarter, inventory: { 1146: { ...wornStarter.inventory[1146], amount: 2,
    instances: [...wornStarter.inventory[1146].instances,
        { id: 9060001, amount: 1, equipped: false, slot: 0, enchant: 6 }]
} } };
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
for (const marketSellRetryAfter of [0, now + 60000]) {
    const singleSpare = { ...spareShirt, stats: { ...spareShirt.stats, marketSellRetryAfter } };
    assert.strictEqual(ItemDisposition.inventoryCleanupNeed(singleSpare, { now }), null,
        'one spare starter piece does not interrupt hunting, with or without a market cooldown');
    assert.strictEqual(PopulationService.prepareInventoryCleanupProposal(singleSpare, now), null,
        'the cold resolve keeps hunting instead of starting a trip for one spare starter piece');
}
const accumulatedStarters = { ...spareShirt, inventory: { 1146: { ...spareShirt.inventory[1146],
    amount: ItemDisposition.NPC_ONLY_CLEANUP_MIN_SLOTS + 1,
    instances: [wornStarter.inventory[1146].instances[0],
        ...Array.from({ length: ItemDisposition.NPC_ONLY_CLEANUP_MIN_SLOTS }, (_, index) => (
            { id: 9060001 + index, amount: 1, equipped: false, slot: 0, enchant: 6 }
        ))]
} } };
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(accumulatedStarters, { now }), {
    reason: 'npc_only_inventory', slots: ItemDisposition.NPC_ONLY_CLEANUP_MIN_SLOTS + 1,
    npcOnlySlots: ItemDisposition.NPC_ONLY_CLEANUP_MIN_SLOTS, limit: ItemDisposition.INVENTORY_SLOT_LIMIT
}, 'accumulated unused starter gear still starts NPC cleanup despite the market cooldown');
assert.strictEqual(PopulationService.prepareInventoryCleanupProposal(accumulatedStarters, now)
    ?.stats.forcedMarketCleanup.npcOnlySlots, ItemDisposition.NPC_ONLY_CLEANUP_MIN_SLOTS,
    'the cold resolve schedules a town cleanup with the accumulated NPC-only stock');

const starterBoard = new BoardIndex({ groupOf: MarketCounters.counterOf });
for (const [index, item] of starterGear.entries()) starterBoard.put({ id: 970000 + index,
    kind: 'buy_ad', storeType: 3, ownerId: 980000 + index, town: 'Giran',
    lines: [{ lineId: 990000 + index, selfId: Number(item.selfId), count: 1, price: 1000000, enchant: 0 }] });
const starterBag = { ...state, inventory: Object.fromEntries(starterGear.map(item => [item.selfId,
    { selfId: Number(item.selfId), kind: item.template.kind, amount: 1 }])) };
const starterOptions = options({ board: starterBoard, keptAmounts: {}, preparedReservations: {},
    kept: new Map(starterGear.map(item => [Number(item.selfId), 1000000])) });
const starterSale = MarketListingPolicy.evaluate(starterBag, starterOptions);
assert.strictEqual(starterSale.npc.length, starterGear.length, 'every unused starter item goes to NPC');
assert.deepStrictEqual(starterSale.listings, [], 'old kept lines cannot re-admit starter equipment');
assert.deepStrictEqual(starterSale.answers, [], 'even a profitable buyer cannot acquire starter gear from a bot');
assert.deepStrictEqual(starterSale.warehouse, []);
const starterCtx = MarketListingPolicy.traderContext(starterBag, starterOptions);
const legacyLines = starterGear.map((item, index) => ({ ownerId: state.characterId,
    lineId: 991000 + index, recordId: 992000 + index, selfId: Number(item.selfId), storeType: 1,
    count: 1, price: 1000000, revision: 1, pricing: { seenCounter: 0, seenAt: now } }));
const seenStarters = new (invoke('GameServer/Bot/Economy/BoardLook').SeenLines)();
const withdrawnStarters = new Set();
for (let step = 0; step < 2; step++) {
    const reviewStarters = invoke('GameServer/Bot/Economy/MarketPricing').lookOwn(starterBag, legacyLines,
        starterCtx, seenStarters);
    for (const move of reviewStarters?.withdrawals || []) withdrawnStarters.add(move.selfId);
}
assert.strictEqual(withdrawnStarters.size, starterGear.length,
    'a natural board review withdraws legacy starter sell lines without waiting for deals');

const equippedRows = starterGear.map((item, index) => ({ id: 993000 + index,
    selfId: Number(item.selfId), name: item.template.name, amount: 1,
    equipped: true, slot: item.etc.slot, enchant: 0 }));
const hotRows = [...equippedRows, ...equippedRows.map(row => ({ ...row, id: row.id + 100,
    equipped: false, slot: 0, enchant: 6 }))];
const hotSale = MarketListingPolicy.npcSaleForActor({ actor: {
    fetchId: () => state.characterId, fetchLevel: () => 40, fetchClassId: () => 0,
    backpack: { fetchItems: () => hotRows }
} });
assert.deepStrictEqual([...hotSale].sort((a, b) => a[0] - b[0]),
    starterGear.map(item => [Number(item.selfId), 1]).sort((a, b) => a[0] - b[0]),
    'the hot town visit sells each spare and protects every worn copy');

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
assert.strictEqual(nearbyTinySale.answers[0].receipts, 20000, 'a backed bid is ranked by its whole payment');
const distantTinySale = tinySale(30000, 1);
assert.strictEqual(distantTinySale.answers.length, 0,
    'the same 20000 Adena receipts do not pay a 30000 Adena trip plus an hour of lost activity');
assert.strictEqual(distantTinySale.decisions[0].reason, 'expected_value',
    'the travel loss is decided by shared valuation, not lot admission');
assert.strictEqual(tinyStock.inventory[1865].amount, 2, 'comparing trips never moves the physical lot');

// Skaptis: the same physical stack already has a conditional SELL ad, and
// the planner selected a buyer for it. Consent must see the same held-line
// context and recheck the chosen bid without rolling the choice again.
bidBoard.put({ id: 950010, kind: 'sell_ad', storeType: 1, custodyPolicy: 1, ownerId: tinyStock.characterId,
    town: 'Giran', lines: [{ lineId: 950011, selfId: 1865, count: 2, price: 12000, enchant: 0 }] });
const beforeConsent = tinySale(0, 0);
assert.equal(beforeConsent.answers.length, 0, 'a plain review keeps the standing line rather than answering the bid');
const sameTown = () => 0; sameTown.details = () => ({ known: true, fees: 0, hours: 0 });
const selectedInput = MarketListingPolicy.ownSaleInputs(tinyStock, bidBoard.ownerLines(tinyStock.characterId),
    options({ board: bidBoard, tripCost: sameTown, keptAmounts: {}, preparedReservations: {},
        selectedAnswer: { selfId: 1865, enchant: 0, recordId: 950001 } }));
const PricingDecision = invoke('GameServer/Bot/Economy/PriceDecision'), originalChoice = PricingDecision.chooseByValue;
try {
    PricingDecision.chooseByValue = choices => choices.find(option => option.action === 'keep') || null;
    const consent = MarketListingPolicy.evaluate(selectedInput.state, selectedInput.options);
    assert.equal(consent.answers[0]?.line.recordId, 950001,
        'fresh consent keeps the already selected profitable bid even when another roll would keep the item');
    const expensive = () => 30000; expensive.details = () => ({ known: true, fees: 30000, hours: 1 });
    const changed = MarketListingPolicy.evaluate(selectedInput.state, { ...selectedInput.options, tripCost: expensive });
    assert.equal(changed.answers.length, 0, 'a newly unprofitable route still rejects the selected sale');
    bidBoard.put({ id: 950020, kind: 'buy_ad', storeType: 3, ownerId: 950021,
        town: 'Giran', lines: [{ lineId: 950022, selfId: 1865, count: 2, price: 20000, enchant: 0 }] });
    const better = MarketListingPolicy.evaluate(selectedInput.state, selectedInput.options);
    assert.equal(better.answers.length, 0, 'a different better bid cannot authorize the old selected buyer');
} finally { PricingDecision.chooseByValue = originalChoice; }

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
function observeDisposition(options) {
    const TendencyRoll = require('../src/GameServer/Bot/AI/TendencyRoll');
    const originalRoll = TendencyRoll.roll;
    const calls = [];
    TendencyRoll.roll = function (...key) {
        const value = originalRoll.apply(this, key);
        calls.push({ key: [...key], value });
        return value;
    };
    try { return { result: MarketListingPolicy.evaluate(state, options), calls }; }
    finally { TendencyRoll.roll = originalRoll; }
}
const firstQuote = observeDisposition(suppliedOptions());
const sale = firstQuote.result;
assert.strictEqual(sale.listings.length, MarketListingPolicy.BOARD_SLOTS, 'eight board slots: 3 shop lines + 5 sell ads');
assert.strictEqual(sale.decisions.filter((decision) => decision.reason === 'no_board_slot').length,
    items.length - MarketListingPolicy.BOARD_SLOTS, 'the rest is kept, not dumped');
for (const listing of sale.listings) {
    assert(listing.price > 0 && listing.marketReason === 'expected_value');
    assert.strictEqual(listing.count, 100, 'all units of the lot');
}
const sameQuote = observeDisposition(suppliedOptions());
const again = sameQuote.result;
assert.deepStrictEqual(again.listings.map((item) => [item.selfId, item.price]), sale.listings.map((item) => [item.selfId, item.price]),
    'one decision point, one roll: the same answer when asked again');
const freshQuote = observeDisposition(suppliedOptions({ now: now + 1 }));
const decisionCalls = quote => quote.calls.filter(call => call.key.length === 4 && call.key[0] === 'dispose');
const firstCalls = decisionCalls(firstQuote);
assert.strictEqual(firstCalls.length, items.length);
assert.deepStrictEqual(new Set(firstCalls.map(call => call.key[2])), new Set(items),
    'every original material reaches the actual native disposition roll');
for (const call of firstCalls) assert.deepStrictEqual(call.key, ['dispose', state.characterId, call.key[2], now]);
assert(firstCalls.every(call => call.value >= 0 && call.value < 1));
assert.deepStrictEqual(decisionCalls(sameQuote), firstCalls,
    'the same point uses the same actual key and native roll');
const freshCalls = decisionCalls(freshQuote);
assert.strictEqual(freshCalls.length, items.length);
assert.deepStrictEqual(new Set(freshCalls.map(call => call.key[2])), new Set(items));
for (const call of freshCalls) assert.deepStrictEqual(call.key, ['dispose', state.characterId, call.key[2], now + 1],
    'a new point reaches native selection with a new actual key, even if the same price wins');
assert(freshQuote.result.listings.every(item => item.price > 0));
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

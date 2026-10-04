const assert = require('assert');

require('../src/Global');

invoke('GameServer/DataCache').init();

const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketListingService');

// A hot solo hunter goes to town to sell on the cold rule
// (ItemDisposition.inventoryCleanupNeed) on its live bag (U10, step 1.5).
const now = 1_750_000_000_000;
const materials = (slots) => Array.from({ length: slots }, (_, index) => ({
    id: 8800000 + index, selfId: 1864 + index, amount: 1, equipped: false, slot: 0
}));
function hunter(slots, extra = {}) {
    const items = materials(slots);
    const level = extra.level || 40;
    const bot = {
        backpack: { items, fetchItems() { return this.items; } },
        fetchId: () => 8100, fetchLevel: () => level, fetchClassId: () => 0
    };
    const session = {
        actor: bot, plan: 'hunting',
        coldLifeState: { characterId: 8100, level, stats: { generatedCold: true, ...(extra.stats || {}) } },
        ...(extra.session || {})
    };
    return { bot, session };
}
const due = ({ session, bot }, at = now) => HuntingState.sellTripDue(session, bot, at);

assert.strictEqual(due(hunter(40))?.reason, 'inventory_half_full', 'a half-full solo hunter goes to sell');
assert.strictEqual(due(hunter(3)), null, 'a nearly empty bag never goes');
assert.strictEqual(due(hunter(40, { session: { partyCompanion: true, followPlayerSession: {} } })), null,
    'a party companion never goes');
assert.strictEqual(due(hunter(40, { session: { hotBackgroundPartyId: 'party' } })), null,
    'a party member makes no half-full trip');
assert.strictEqual(due(hunter(40, { level: 9 })), null, 'below level 10 no half-full trip');
const paused = hunter(40, { stats: { marketSellRetryAfter: now + 60000 } });
assert.strictEqual(due(paused), null, 'the sell pause is respected');
assert.strictEqual(due(paused, now + 60000)?.reason, 'inventory_half_full', 'the trip comes when the pause ends');

// The rule is asked again only when something it reads changes.
const original = ItemDisposition.inventoryCleanupNeed;
let calls = 0;
ItemDisposition.inventoryCleanupNeed = (...args) => { calls += 1; return original(...args); };
try {
    const bag = hunter(39);
    assert.strictEqual(due(bag), null);
    for (let tick = 1; tick <= 50; tick++) due(bag, now + tick * 500);
    assert.strictEqual(calls, 1, 'an unchanged bag is not walked every tick');
    bag.bot.backpack.items.push({ id: 8899999, selfId: 1950, amount: 1, equipped: false, slot: 0 });
    assert.strictEqual(due(bag)?.reason, 'inventory_half_full', 'a new stack is seen at once');
    assert.strictEqual(calls, 2);
    bag.bot.backpack.items = bag.bot.backpack.items.slice(0, 10);
    assert.strictEqual(due(bag), null, 'a sold bag is seen at once');
    assert.strictEqual(calls, 3);
    bag.session.coldLifeState = { ...bag.session.coldLifeState };
    due(bag);
    assert.strictEqual(calls, 4, 'a new life state is read again');
} finally {
    ItemDisposition.inventoryCleanupNeed = original;
}

// Starting the trip starts the cold sell pause.
const goer = hunter(40);
HuntingState.pauseSelling(goer.session, now);
assert.strictEqual(goer.session.coldLifeState.stats.marketSellRetryAfter, now + ColdMarket.SELL_RETRY_DELAY_MS);
assert.strictEqual(goer.session.coldLifeState.stats.generatedCold, true);
assert.strictEqual(due(goer), null, 'no second half-full trip during the pause');

console.log('Hot sell trigger checks passed');

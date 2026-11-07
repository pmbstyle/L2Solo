const assert = require('assert');

require('../src/Global');

invoke('GameServer/DataCache').init();

const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

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
assert.strictEqual(due(hunter(40, { level: 9 }))?.reason, 'inventory_half_full', 'young bots use the same stock-based sale trigger');
assert.strictEqual(due(hunter(3, { level: 5 })), null, 'lifting the level gate creates no small-bag town trip');
// The sale retry: the last visit tried these goods and nothing new came since.
const paused = hunter(40, { stats: { marketSellSeen: { items: materials(40).map(item => item.selfId), buyers: null } } });
assert.strictEqual(due(paused), null, 'the sell pause is respected');
assert.strictEqual(due(paused, now + 6 * 3600000), null, 'time alone does not end it');
paused.bot.backpack.items.push({ id: 8899998, selfId: 1950, amount: 1, equipped: false, slot: 0 });
assert.strictEqual(due(paused), null, 'one new kind does not fill the half with the unsold goods');
paused.bot.backpack.items = paused.bot.backpack.items.slice(10);
paused.bot.backpack.items.push(...materials(39).map(item => ({ ...item, id: item.id + 1000, selfId: item.selfId + 100 })));
assert.strictEqual(due(paused)?.reason, 'inventory_half_full', 'the trip comes when goods the last visit did not try fill the half');

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

// Starting the trip starts the cold sell pause on the goods it carries.
const goer = hunter(40);
HuntingState.pauseSelling(goer.session);
assert.deepStrictEqual(goer.session.coldLifeState.stats.marketSellSeen.items, materials(40).map(item => item.selfId));
assert.strictEqual(goer.session.coldLifeState.stats.generatedCold, true);
assert.strictEqual(due(goer), null, 'no second half-full trip during the pause');

const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const originalContext = Economy.forState;
Economy.forState = () => { throw Error('sell_check_rebuilt_economy'); };
try {
    const seller = hunter(3);
    seller.session.coldLifeState.stats.decisionSeq = 12;
    seller.session.heldEconomy = { network: { activity: { activity: 'selling', items: [1864] } } };
    assert.equal(due(seller)?.reason, 'wish_funding');
    seller.bot.backpack.inventoryRevision = 1;
    assert.equal(due(seller)?.reason, 'wish_funding', 'loot reuses the held selling choice without a context build');
    HuntingState.pauseSelling(seller.session);
    assert.equal(due(seller), null, 'a held selling leaf cannot bypass the sale retry after hot activation');
    seller.bot.backpack.items.push({ id: 8899997, selfId: 1950, amount: 1, equipped: false, slot: 0 });
    assert.equal(due(seller)?.reason, 'wish_funding', 'the held sale can resume on goods the last visit did not try');
    // The next decision the body receives (DecisionEvents.receive) replaces the held one.
    seller.session.coldLifeState.stats.decisionSeq = 13;
    seller.session.heldEconomy = { network: { activity: null } };
    assert.equal(due(seller), null, 'the next decision retires the selling choice');
} finally { Economy.forState = originalContext; }

console.log('Hot sell trigger checks passed');

const assert = require('assert');

require('../src/Global');

invoke('GameServer/DataCache').init();

const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');

// A hot solo hunter's own sale trip is its held selling leaf's (the build's sale); a
// full bag's trip is the build's too (stats.cleanupDue on bag_full), so the body never
// weighs its bag by itself.
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
const due = ({ session, bot }) => HuntingState.sellTripDue(session, bot);

assert.strictEqual(due(hunter(40)), null, 'a half-full bag with no held sale starts no trip of the body\'s own');
assert.strictEqual(due(hunter(81)), null, 'nor does a full one: its trip is the build\'s');

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

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

// A full bag the build chose to clear (stats.bagClear on bag_full): the body destroys those
// slots from its live bag as a player destroys items (unworn copies only, up to the count)
// and hunts on: no town trip starts.
{
    const FailureLog = require('../src/FailureLog');
    const Events = invoke('GameServer/Bot/AI/DecisionEvents'), TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    const trips = [], request = TownTravel.request, held = Events.held, huntedOn = Error('hunted_on');
    TownTravel.request = (_session, _bot, _ai, reason) => { trips.push(reason); return 'escape'; };
    Events.held = () => { throw huntedOn; };
    const piece = (id, selfId, extra = {}) => ({ id, selfId, amount: 1, equipped: false, enchant: 0, ...extra });
    const items = [...Array.from({ length: 41 }, (_, index) => piece(8810000 + index, 1864 + index)),
        piece(8820000, 1864, { equipped: true }), piece(8820001, 1865, { enchant: 3 })];
    const deleted = [];
    const bot = { fetchId: () => 8101, fetchLevel: () => 40, fetchClassId: () => 0, fetchHp: () => 100, fetchMaxHp: () => 100,
        fetchMp: () => 100, fetchMaxMp: () => 100, isDead: () => false, automation: { abortAll() {} },
        state: { fetchCasts: () => false, fetchTowards: () => false, fetchHits: () => false },
        backpack: { items: items.map(item => ({ fetchId: () => item.id, fetchSelfId: () => item.selfId, fetchAmount: () => item.amount,
            fetchEquipped: () => item.equipped, fetchEnchantLevel: () => item.enchant })),
        fetchItems() { return this.items; },
        deleteItem(_session, id, amount) { deleted.push([id, amount]); this.items = this.items.filter(item => item.fetchId() !== id); } } };
    const clear = { items: [{ selfId: 1864, enchant: 0, count: 1 }, { selfId: 1865, enchant: 0, count: 1 },
        { selfId: 1866, enchant: 0, count: 1, objectIds: [8810002] }, { selfId: 9999, enchant: 0, count: 1 }], freed: 3, value: 30 };
    const session = { actor: bot, plan: 'hunting', coldLifeState: { characterId: 8101, level: 40,
        stats: { generatedCold: true, bagClear: clear } } };
    try {
        assert.throws(() => HuntingState.tick(session, bot, {}, { say() {}, getStatus: () => ({ available: true }) }),
            error => error === huntedOn, 'the body hunts on past its bag');
    } finally { TownTravel.request = request; Events.held = held; }
    assert.deepStrictEqual(deleted, [[8810000, 1], [8810001, 1], [8810002, 1]],
        'the cleared slots are destroyed: the worn copy and the enchanted one stay, a copy the bag lost is skipped');
    assert.strictEqual(FailureLog.snapshot()?.['ai.bag_clear_missing'], 1, 'the row the bag lost is counted');
    assert.deepStrictEqual(trips, [], 'no town trip starts');
    assert.strictEqual(session.coldLifeState.stats.bagClear, null, 'the clearing is spent');
}

console.log('Hot sell trigger checks passed');

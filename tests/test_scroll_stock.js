const assert = require('assert');

require('../src/Global');

// A bot keeps a few Scrolls of Escape for its town trips (part of H13, step
// 3.2): a town visit buys what is missing up to the target at the local NPC,
// from the Adena above the consumables reserve, as the healing potion
// restock does; the sale keeps the stock and sells a surplus (H12 narrowed).
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const ScrollStock = invoke('GameServer/Bot/Travel/ScrollStock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

const TARGET = ScrollStock.TARGET_AMOUNT;
assert.strictEqual(TARGET, 2, 'a small fixed target: the next trip and one spare');
const price = ScrollStock.localNpcPrice('Dion');
assert.ok(price > 0, 'the Dion grocer sells Scrolls of Escape');
assert.ok(ScrollStock.localNpcPrice('Floran Village') > 0, 'so does Floran\'s');

function cold(scrolls, adena = 100000) {
    return {
        characterId: 9500101, level: 30, adena, phase: 'cold', activity: 'shopping', currentRegion: 'Dion',
        stats: { classId: 0, role: 'dps' },
        inventory: { 57: { selfId: 57, name: 'Adena', amount: adena },
            ...(scrolls ? { 736: { selfId: 736, name: 'Scroll of Escape', amount: scrolls } } : {}) }
    };
}

assert.strictEqual(ScrollStock.restockPlan(cold(0), { unitPrice: price }).amount, TARGET, 'an empty stock buys the target');
assert.strictEqual(ScrollStock.restockPlan(cold(1), { unitPrice: price }).amount, 1, 'only what is missing');
assert.strictEqual(ScrollStock.restockPlan(cold(2), { unitPrice: price }).needed, false, 'a full stock buys nothing');
const reserve = HealingPotionStock.operationalReserve(cold(0, 7600));
const poor = ScrollStock.restockPlan(cold(0, reserve + price), { unitPrice: price });
assert.strictEqual(poor.amount, 1, 'the consumables reserve is kept: one scroll above it');
assert.strictEqual(ScrollStock.restockPlan(cold(0, reserve), { unitPrice: price }).affordable, false,
    'nothing is bought from the reserve');

const patch = ScrollStock.coldPurchasePatch(cold(0), { unitPrice: price });
assert.strictEqual(patch.inventory[736].amount, TARGET);
assert.strictEqual(patch.adena, 100000 - TARGET * price);
assert.strictEqual(patch.inventory[57].amount, 100000 - TARGET * price);
assert.deepStrictEqual({ selfId: patch.purchase.selfId, amount: patch.purchase.amount, cost: patch.purchase.cost },
    { selfId: 736, amount: TARGET, cost: TARGET * price });
assert.strictEqual(ScrollStock.coldPurchasePatch(cold(2), { unitPrice: price }), null);

// The sale keeps the stock and sells the surplus.
assert.deepStrictEqual(ScrollStock.keptAmounts(cold(5)), { 736: TARGET });
const sold = (state) => new Map(MarketListingPolicy.evaluate(state, { unlimited: true, states: [] }).npc
    .map((entry) => [entry.selfId, entry.count])).get(736);
assert.strictEqual(sold(cold(2)), undefined, 'the stock is not NPC junk');
assert.strictEqual(sold(cold(5)), 3, 'a surplus is sold');

// A hot bot buys into its backpack the same way.
(async () => {
    const realUpdate = Database.updateItemAmount;
    const realSet = Database.setItem;
    const rows = new Map([[57, { id: 1, amount: 100000 }]]);
    const row = (selfId) => {
        const item = rows.get(selfId);
        return item ? { fetchId: () => item.id, fetchAmount: () => item.amount, setAmount: (value) => { item.amount = value; } } : null;
    };
    Database.updateItemAmount = async () => ({});
    Database.setItem = async () => ({ insertId: 2 });
    try {
        const actor = {
            fetchId: () => 9500102, fetchLevel: () => 30,
            backpack: {
                fetchItemFromSelfId: (selfId) => row(Number(selfId)),
                insertItem: (id, selfId, data) => rows.set(Number(selfId), { id, amount: data.amount })
            }
        };
        const bought = await ScrollStock.purchaseActorRestock(actor, { unitPrice: price });
        assert.strictEqual(bought.ok, true);
        assert.strictEqual(rows.get(736).amount, TARGET, 'the hot bot holds the target');
        assert.strictEqual(rows.get(57).amount, 100000 - TARGET * price, 'and paid the NPC price');
        const again = await ScrollStock.purchaseActorRestock(actor, { unitPrice: price });
        assert.strictEqual(again.changed, false, 'a full hot stock buys nothing');
    } finally {
        Database.updateItemAmount = realUpdate;
        Database.setItem = realSet;
    }
    console.log('scroll of escape stock checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

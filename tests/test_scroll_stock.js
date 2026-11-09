const assert = require('assert');

require('../src/Global');

// A Scroll of Escape is no survival item: a bot carries one
// per outing when the walk it saves is worth more than the scroll at its hour,
// bought at the local NPC from money its queue does not hold; a broke bot
// walks. The sale keeps every scroll it holds.
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const ScrollStock = invoke('GameServer/Bot/Travel/ScrollStock');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Packet = invoke('GameServer/Bot/Economy/StatsPacket');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

const price = ScrollStock.localNpcPrice('Dion');
assert.ok(price > 0, 'the Dion grocer sells Scrolls of Escape');
assert.ok(ScrollStock.localNpcPrice('Floran Village') > 0, 'so does Floran\'s');

// A cold bot in Dion whose build rated its kit: the scroll's saved hours, its hour; its held answer's
// spot uses no shots or potions (EquipmentIncomeRoute.spotUseOf), so the scroll alone is in question.
function cold(scrolls, { adena = 100000, scrollHours = .5, hour = 10000, karma = 0 } = {}) {
    return {
        characterId: 9500101, level: 30, adena, phase: 'cold', activity: 'shopping', currentRegion: 'Dion',
        stats: { classId: 0, role: 'dps', karma, earning: { shotsPerHour: 0, potionsPerHour: 0 },
            money: Packet.money({ hourAdena: hour, moneyPrice: 1 / hour, refillReserve: 0, firstUnfundedPrice: 0 }),
            kitRates: Packet.kitRates({ shotId: 0, shotUse: 0, shotBenefit: 0, shotsCanRestock: false, potionId: 0, potionUse: 0,
                potionRestUse: 0, potionBenefit: 0, scrollHours, outingHours: 1, gapHorizonHours: 0 }) },
        inventory: { 57: { selfId: 57, name: 'Adena', amount: adena },
            ...(scrolls ? { 736: { selfId: 736, name: 'Scroll of Escape', amount: scrolls } } : {}) }
    };
}

assert(.5 * 10000 > price, 'fixture: half an hour at 10k Adena is worth more than a scroll');
const bought = ScrollStock.restockPlan(cold(0), { unitPrice: price });
assert.strictEqual(bought.amount, 1, 'one scroll for the outing');
assert(bought.funding.side > 0, 'paid from money the queue does not hold, at the hours it saves');
assert.strictEqual(ScrollStock.restockPlan(cold(1), { unitPrice: price }).needed, false, 'one held: none bought');
assert.strictEqual(ScrollStock.restockPlan(cold(0, { scrollHours: .01, hour: 1000 }), { unitPrice: price }).needed, false,
    'a walk worth less than the scroll: the bot walks');
assert.strictEqual(ScrollStock.restockPlan(cold(0, { scrollHours: null }), { unitPrice: price }).needed, false,
    'a build that did not price the walk buys none');
assert.strictEqual(ScrollStock.restockPlan(cold(0, { karma: 100 }), { unitPrice: price }).needed, false,
    'towns closed by karma: no scroll');
const kit = Economy.keptKit(cold(0));
assert.strictEqual(kit.kitCost(736), 0, 'the scroll is no part of the survival reserve');
assert.strictEqual(kit.refillReserve, 0);

const patch = ScrollStock.coldPurchasePatch(cold(0), { unitPrice: price });
assert.strictEqual(patch.inventory[736].amount, 1);
assert.strictEqual(patch.adena, 100000 - price);
assert.strictEqual(patch.inventory[57].amount, 100000 - price);
assert.deepStrictEqual({ selfId: patch.purchase.selfId, amount: patch.purchase.amount, cost: patch.purchase.cost },
    { selfId: 736, amount: 1, cost: price });
assert.strictEqual(ScrollStock.coldPurchasePatch(cold(1), { unitPrice: price }), null);

// The sale keeps every scroll: each saves a walk.
assert.deepStrictEqual(ScrollStock.keptAmounts(cold(13)), { 736: 13 });
const sold = (state) => new Map(MarketListingPolicy.evaluate(state, { unlimited: true, states: [] }).npc
    .map((entry) => [entry.selfId, entry.count])).get(736);
assert.strictEqual(sold(cold(13)), undefined, 'no scroll is NPC junk');

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
        const hot = await ScrollStock.purchaseActorRestock(actor, { unitPrice: price, context: Economy.keptKit(cold(0)) });
        assert.strictEqual(hot.ok, true);
        assert.strictEqual(rows.get(736).amount, 1, 'the hot bot holds its scroll');
        assert.strictEqual(rows.get(57).amount, 100000 - price, 'and paid the NPC price');
        const again = await ScrollStock.purchaseActorRestock(actor, { unitPrice: price, context: Economy.keptKit(cold(0)) });
        assert.strictEqual(again.changed, false, 'a held scroll buys nothing');
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

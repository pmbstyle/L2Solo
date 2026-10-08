const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const Service = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Policy = invoke('GameServer/Bot/Economy/WealthCraftPolicy');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const nativeChoice = require('./helpers/nativeMarketChoice');

// Craft levels and the native packet use the authored catalogue before the
// original synthetic recipe/item calculator overrides are installed.
DataCache.init();
const originals = { items: DataCache.items, fetchCharacterRecipes: Database.fetchCharacterRecipes,
    fetchItems: Database.fetchItems, craftInventoryItems: Database.craftInventoryItems,
    resolveByRecipeId: Recipes.resolveByRecipeId, offers: AfkTrade.offers,
    buyFromShop: AfkTrade.buyFromShop, sellToShop: AfkTrade.sellToShop,
    upsertState: LifeState.upsertState, refreshInventory: LifeState.refreshInventory,
    record: LifeEvents.record };
function boardLine(id, selfId, count, price) {
    AfkTrade.refreshRecord({ id, ownerId: 9003, ownerName: 'Supplier', ownerAccount: 'bot_9003', kind: 'sell_ad',
        storeType: AfkTrade.SELL, status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0,
        locX: 0, locY: 0, locZ: 0, appearance: {}, lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count, price, enchant: 0 }] });
}
async function run() {
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    boardLine(980001, 1864, 2, 10000);
    boardLine(980002, 1865, 1, 5000);
    boardLine(980003, 1867, 6, 500);
    const originalState = { characterId: 9001, accountName: 'bot_pop_test', name: 'Crafter', phase: 'cold',
        activity: 'shopping', currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
        level: 60, adena: 500000, vitals: { mp: 100 }, inventory: {},
        stats: { classId: 57, generatedIndex: 1787947094937 }, persona: { primaryDrive: 'wealth' } };
    const native = await nativeChoice.capture(originalState, {}, 'wealth_original_before_unit_overrides');
    const state = native.state;
    assert.strictEqual(native.read.activity.activity, 'hunting', 'the unchanged original inputs have no funded synthetic craft leaf');
    assert(native.read.activity.funding && native.captured.queue.some(row => row.key === native.read.activity.rootKey
        && !row.funded), 'the selected real native priority is unfunded, including improvements as well as gear');
    assert(native.state.stats.money[3] > 0, 'the genuine unfunded priority remains a money gap');
    const nativePacket = structuredClone(state.stats.money);
    const productId = 999999;
    const recipe = { type: 'dwarven', recipeId: 90001, level: 4, productId,
        productCount: 1, successRate: 100, mpCost: 20,
        materials: [{ selfId: 1864, amount: 2 }, { selfId: 1865, amount: 1 }] };
    const sellStore = { afkTrade: true, storeType: AfkTrade.SELL };
    const buyStore = { afkTrade: true, storeType: AfkTrade.BUY };
    const purchases = [];
    let exitPrice = 50000, crafted = false, sold = false;
    DataCache.items = [{ selfId: productId, template: { name: 'Test Component', kind: 'Other.Material' },
        etc: { stackable: true, slot: 0 } }];
    Database.fetchCharacterRecipes = async () => [{ recipeId: recipe.recipeId }];
    const originalPhysicalMaterials = [{ id: 10, selfId: 1864, amount: 2 }, { id: 11, selfId: 1865, amount: 1 }];
    Database.fetchItems = async () => structuredClone(originalPhysicalMaterials);
    Database.craftInventoryItems = async () => { crafted = true; throw Error('an unfunded craft reached the physical writer'); };
    Recipes.resolveByRecipeId = recipeId => recipeId === recipe.recipeId ? recipe : null;
    AfkTrade.offers = (selfId, storeType) => {
        if (storeType === AfkTrade.BUY && selfId === productId) return [{
            sourceId: 9002, price: exitPrice, count: 1, store: buyStore, town: 'Giran' }];
        if (storeType !== AfkTrade.SELL) return [];
        return selfId === 1864 || selfId === 1865 ? [{ sourceId: 9003,
            price: selfId === 1864 ? 10000 : 5000, count: selfId === 1864 ? 2 : 1, store: sellStore }] : [];
    };
    AfkTrade.buyFromShop = async (...args) => { purchases.push(args); throw Error('unfunded purchase'); };
    AfkTrade.sellToShop = async () => { sold = true; throw Error('unfunded sale'); };
    // These original facades isolate writer non-entry; no SQLite crafting is claimed.
    LifeState.upsertState = async current => current;
    LifeState.refreshInventory = async () => { throw Error('no product inventory without an actual craft'); };
    LifeEvents.record = async () => null;
    assert.strictEqual(Service.eligible(state, 1000000), true,
        'ordinary generated dwarves must not be mistaken for fixed crafting stations');
    for (const [karma, blocked] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
        assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, karma } }), !blocked,
            `wealth craft with karma ${karma}`);
    }
    assert.strictEqual(Service.eligible({ ...state, level: 36, stats: { ...state.stats, classId: 56 } }), true);
    assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, classId: 55 } }), false,
        'a Bounty Hunter has Create Item but does not craft');
    assert.strictEqual(Service.eligible({ ...state, level: 78, stats: { ...state.stats, classId: 118 } }), true,
        'a Maestro crafts for profit like a Warsmith');
    recipe.level = 8;
    assert.strictEqual(CraftShop.canCraft(state, recipe), false, 'recipe8 exceeds level60 craft level7');
    assert.strictEqual(Service.chooseOpportunity(state, [{ recipeId: recipe.recipeId }]), null,
        'a recipe above the craft level is skipped');
    recipe.level = 7;
    assert.strictEqual(CraftShop.canCraft(state, recipe), true, 'recipe7 reaches the unchanged actual skill-tree limit');
    recipe.level = 4;

    // ARCH-NOTE: the original recipe90001/product999999 is an authored unit
    // basket, not a catalogue recipe or native earned-income claim. E1/E3
    // require a paid clock plus the genuine packet before Main may spend.
    const paid = Object.freeze({ hourAdena: 360000, mpPerHour: 3600 });
    const prices = new Map([[1864, 10000], [1865, 5000]]);
    const planFor = (id, amount) => prices.has(id) ? { town: 'Giran', cost: prices.get(id) * amount,
        landed: prices.get(id) * amount, units: amount, whole: true } : null;
    const exit = { type: 'afk', price: 50000, count: 1, trip: 0 };
    const net = (entry, price, inputs, trip = 0) => price * entry.productCount * entry.successRate / 100
        - inputs - entry.mpCost / paid.mpPerHour * paid.hourAdena - trip;
    const labour = recipe.mpCost / paid.mpPerHour * paid.hourAdena;
    assert.strictEqual(labour, 2000, '20MP at 1MP/second priced at 100 Adena/second');
    assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [exit]), null,
        'without a paid clock the original positive is unknown labour');
    const unit = Policy.opportunityFor(state, recipe, planFor, [exit], undefined, paid);
    assert(unit, 'the complete original basket is physically affordable and has positive paid net profit');
    assert.strictEqual(unit.basket.cost, 25000);
    assert.strictEqual(unit.basket.cashCost, 25000);
    assert.deepStrictEqual(unit.basket.purchases.map(p => [p.selfId, p.count, p.town]), [[1864, 2, 'Giran'], [1865, 1, 'Giran']]);
    assert.strictEqual(unit.revenue, 50000);
    assert.strictEqual(unit.expectedProfit, net(recipe, 50000, 25000));
    assert.strictEqual(unit.expectedProfit, 23000);
    assert.strictEqual(Policy.craftMargin(recipe, 50000, 25000), 25000, 'cash margin retains the original 25000 accounting fact');
    const breakEven = 25000 + labour;
    assert.strictEqual(breakEven, 27000);
    assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven }], undefined, paid), null);
    assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven - 1 }], undefined, paid), null);
    assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven + 1 }], undefined, paid).expectedProfit, 1);
    assert.strictEqual(Policy.opportunityFor({ ...state, adena: 24999 }, recipe, planFor, [exit], undefined, paid), null,
        'cash must cover all original inputs before buying');
    assert.strictEqual(Policy.opportunityFor({ ...state, vitals: { mp: 19 } }, recipe, planFor, [exit], undefined, paid), null);
    assert(Policy.opportunityFor({ ...state, vitals: { mp: 20 } }, recipe, planFor, [exit], undefined, paid));
    assert.strictEqual(Policy.opportunityFor(state, { ...recipe, successRate: 50 }, planFor, [exit], undefined, paid), null,
        'the full input cost and paid clock remain payable on a failed roll');
    assert.strictEqual(net({ ...recipe, successRate: 50 }, 50000, 25000), -2000);
    assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, count: 0 }], undefined, paid), null);
    assert.strictEqual(Policy.opportunityFor(state, recipe, id => id === 1865 ? null : planFor(id, 2), [exit], undefined, paid), null);
    assert.strictEqual(Policy.opportunityFor(state, recipe, (id, amount) => ({ ...planFor(id, amount), whole: false }), [exit], undefined, paid), null);
    assert.deepStrictEqual(Profit.materials(originalPhysicalMaterials, recipe), [
        { id: 10, selfId: 1864, amount: 2 }, { id: 11, selfId: 1865, amount: 1 }], 'original complete physical ingredient rows');
    assert.strictEqual(Profit.materials(originalPhysicalMaterials.slice(0, 1), recipe), null, 'missing ore cannot produce the output');
    assert.strictEqual(Profit.succeeds(recipe, () => { throw Error('100% success must not roll'); }), true);
    for (const mp of [100, 80]) {
        const repeatable = Policy.opportunityFor({ ...state, vitals: { mp } }, recipe, planFor, [exit], undefined, paid);
        assert(repeatable && repeatable.expectedProfit === 23000, 'a complete funded unit basket has no arbitrary timer');
        assert.strictEqual(mp - recipe.mpCost, mp === 100 ? 80 : 60, 'original two-round MP accounting is a unit fact, not consumed stock');
    }
    const ratio = unit.expectedProfit / paid.hourAdena / unit.basket.cashCost;
    assert(ratio < nativePacket[1], 'the original synthetic gain is below the actual native money floor');
    assert.strictEqual(Funding.spendable(state, 0, { r: ratio }), 0);
    assert.strictEqual(Service.chooseOpportunity(state, [{ recipeId: recipe.recipeId }], paid), null,
        'a profitable calculator output cannot replace native E3 funding');
    const planning = adena => ({ ...state, adena, stats: { ...state.stats, equipmentPlan: {
        status: 'active', strategy: 'market', target: { selfId: 100, name: 'Planned Gear', slot: 7 },
        market: { town: 'Giran', price: 370000, sourceType: 'npc', reserve: 10000 } } } });
    for (const current of [state, planning(state.adena), planning(state.adena + 380000)]) {
        assert.strictEqual(Funding.spendable(current, 0, { r: ratio }), 0,
            'the original wallet/gear-plan variants do not override the real gain floor');
        assert.strictEqual(Service.chooseOpportunity(current, [{ recipeId: recipe.recipeId }], paid), null);
    }
    const blocked = await Service.execute(state, { ...unit, template: DataCache.items[0], r: ratio });
    assert.strictEqual(blocked.crafted, false);
    assert.strictEqual(blocked.reason, 'purchase_failed');
    assert.strictEqual(blocked.state.adena, 500000);
    assert.deepStrictEqual(blocked.state.inventory, {});
    assert.strictEqual(blocked.state.vitals.mp, 100);
    assert.deepStrictEqual(blocked.state.stats.money, nativePacket);
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(crafted, false);
    assert.strictEqual(sold, false);
    const result = await Service.tryCraft(state, 1000000);
    const repeat = await Service.tryCraft(state, 1000001);
    for (const current of [result, repeat]) {
        assert.strictEqual(current.crafted, false, 'unchanged original service state cannot craft without a funded native gain');
        assert.strictEqual(current.state.adena, 500000);
        assert.deepStrictEqual(current.state.inventory, {});
        assert.strictEqual(current.state.vitals.mp, 100);
    }
    assert.strictEqual(Service.eligible(result.state), true, 'a no-craft result introduces no arbitrary eligibility timer');

    const away = { ...state, characterId: 9006, name: 'AwayCrafter', activity: 'hunting', currentRegion: 'Dion',
        loc: { locX: 17000, locY: 145000, locZ: -3000 } };
    const trip = Profit.tripFor(away, paid)('Giran');
    assert(Number.isFinite(trip) && trip > 0, 'actual native routes price the original Dion/Giran round trip');
    const awayPlanFor = (id, amount) => { const plan = planFor(id, amount); return plan && { ...plan, landed: plan.landed + trip }; };
    assert.strictEqual(Policy.opportunityFor(away, recipe, awayPlanFor, [{ ...exit, trip }], undefined, paid), null,
        'the real trip outweighs the original 23000 net margin');
    exitPrice = 500000;
    const lucrative = Policy.opportunityFor({ ...away, characterId: 9007 }, recipe, awayPlanFor,
        [{ ...exit, price: exitPrice, trip }], undefined, paid);
    assert(lucrative && lucrative.expectedProfit === net(recipe, exitPrice, 25000 + trip, trip));
    assert.strictEqual(lucrative.basket.cashCost, 25000);
    assert.strictEqual(lucrative.basket.cost, 25000 + trip, 'one town trip supplies both original inputs');
    assert.strictEqual(Funding.spendable(away, 0, { r: lucrative.expectedProfit / paid.hourAdena / 25000 }), 0,
        'a remote unit margin still cannot invent native funding or a buying trip');
    exitPrice = 50000;
    assert.strictEqual(purchases.length, 0, 'no goods bought from afar or locally by the unfunded service');

    const leather = { type: 'dwarven', recipeId: 25, level: 1, productId: 1882,
        productCount: 1, successRate: 100, mpCost: 10, materials: [{ selfId: 1867, amount: 6 }] };
    const leatherPlan = (id, count) => id === 1867 ? { town: 'Giran', cost: 500 * count, landed: 500 * count, units: count, whole: true } : null;
    const fixed = Policy.opportunityFor({ ...state, characterId: 9004, name: 'ResourceCrafter' }, leather,
        leatherPlan, [{ type: 'static', price: 10000, count: 1, trip: 0 }], undefined, paid);
    assert(fixed);
    assert.strictEqual(fixed.basket.cost, 3000);
    assert.strictEqual(fixed.expectedProfit, net(leather, 10000, 3000));
    assert.strictEqual(fixed.expectedProfit, 6000);
    assert.strictEqual(Policy.craftMargin(leather, 10000, 3000), 7000, 'original static-exit cash gain, not a native paid craft');
    assert.deepStrictEqual(Profit.materials([{ id: 12, selfId: 1867, amount: 6 }], leather), [{ id: 12, selfId: 1867, amount: 6 }]);

    // Main waits for the exact guarded worker action; it does not rescan a
    // learned recipe catalogue when no published opportunity is available.
    let emptyReads = 0;
    Database.fetchCharacterRecipes = async () => { emptyReads += 1; return []; };
    const idle = { ...state, characterId: 9005, name: 'WaitingCrafter' };
    for (const now of [1000000, 1000001, 1000000 + 5 * 60 * 1000]) {
        assert.strictEqual((await Service.tryCraft(idle, now)).reason, 'no_profit');
    }
    assert.strictEqual(emptyReads, 0, 'unpublished lifecycle does not scan the learned recipe catalogue');
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(crafted, false);
    assert.strictEqual(sold, false);
    assert.deepStrictEqual(Economy.summary().mainColdForState, {});
    console.log(JSON.stringify({ scope: 'declared unit clock plus genuine native unfunded execution',
        recipeId: recipe.recipeId, productId, wallet: originalState.adena, cash: unit.basket.cashCost,
        revenue: unit.revenue, labour, net: unit.expectedProfit, breakEven, ratio, nativePacket,
        resultReasons: [blocked.reason, result.reason, repeat.reason], remoteTripCost: trip,
        physicalCommerceClaim: false, purchases: purchases.length, crafted, sold, emptyReads }));
    console.log('Cold wealth craft checks passed');
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Workshop.remove(9001); Workshop.remove(9005);
    AfkTrade._resetForTests();
    for (const key of ['fetchCharacterRecipes', 'fetchItems', 'craftInventoryItems']) Database[key] = originals[key];
    for (const key of ['offers', 'buyFromShop', 'sellToShop']) AfkTrade[key] = originals[key];
    for (const key of ['upsertState', 'refreshInventory']) LifeState[key] = originals[key];
    LifeEvents.record = originals.record;
    Recipes.resolveByRecipeId = originals.resolveByRecipeId;
    DataCache.items = originals.items;
});

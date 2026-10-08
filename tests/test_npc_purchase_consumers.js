'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('npc-consumers');
require('../src/Global'); fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const DB = invoke('Database'), Data = invoke('GameServer/DataCache'); Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Npc = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const Native = require('./helpers/nativeMarketFixture');
const first = Npc.quoteFor(1785, 'Dion'), second = Npc.quoteFor(3031, 'Dion', null, first);
assert(first && second, 'real one-seller Soul Ore / Spirit Ore assortment');
const captured = [], original = DB.purchaseNpcInventoryBasket;
async function seed(id, wallet, stats = {}, items = [], phase = 'cold') {
    await Native.character(DB, id, `Consumer${id}`, `bot_consumer_${id}`, first);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: wallet });
    for (const item of items) await DB.setItem(id, item);
    return Life.upsertState({ characterId: id, name: `Consumer${id}`, accountName: `bot_consumer_${id}`,
        phase, activity: 'shopping', level: stats.classId === 12 ? 42 : 1,
        exp: stats.classId === 12 ? Data.experience[41] : 0, adena: wallet, currentRegion: 'Dion', loc: first,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        stats: { classId: 0, money: [1, 0, 0, 0], ...stats } }, 'consumer_fixture');
}
const amount = async (id, selfId) => Native.amount(await DB.fetchItems(id), selfId);
async function run() {
    await DB.init();
    assert.equal(invoke('GameServer/Bot/Economy/EconomyContext').basics({
        characterId: 9610, stats: { karma: 100 }, inventory: {}, level: 1 }).kitCost(736, 480), 0,
    'a concrete NPC quote never funds an escape scroll for a criminal refused by towns');
    DB.purchaseNpcInventoryBasket = async (id, details) => {
        captured.push({ id, seller: details.seller, lines: details.lines.map(line => ({ ...line })) });
        const result = await original.call(DB, id, details);
        if (id === 9619 && result.ok) {
            Life.acceptLifecycleRow(result.coldLifeRow);
            const committed = Life.cachedState(id);
            await Life.upsertState({ ...committed, phase: 'hot',
                timing: { ...committed.timing, lastHotAt: Date.now() } }, 'consumer_post_commit_activation');
        }
        return result;
    };
    const at = Date.now(), errands = [
        { selfId: 1785, amount: 6, town: 'Dion', purpose: 'craft_input', r: 1, at },
        { selfId: 3031, amount: 7, town: 'Dion', purpose: 'craft_input', r: 1, at }
    ];
    let state = await seed(9611, 50000, { marketErrands: errands, marketErrand: errands[0] });
    await invoke('GameServer/Bot/Goals/GoalState').set(9611, Market.errandGoal(errands[0]));
    state = await Market.finishTownErrands(state);
    const cold = captured.filter(row => row.id === 9611);
    assert.equal(cold.length, 1, 'actual finishTownErrands uses one real-seller transaction');
    assert(cold[0].lines.some(row => row.selfId === 1785 && row.amount === 6));
    assert(cold[0].lines.some(row => row.selfId === 3031 && row.amount === 7));
    assert.equal(await amount(9611, 1785), 6); assert.equal(await amount(9611, 3031), 7);
    assert.equal(state.stats.marketErrands.length, 0, 'native settlement closes exactly filled errands');
    assert.equal(invoke('GameServer/Bot/Goals/GoalState').snapshot(9611).current.status, 'completed',
        'the matching selected market errand goal progresses in the same native settlement');
    const before = await amount(9611, 57);
    await Market.finishTownErrands(state);
    assert.equal(await amount(9611, 1785), 6); assert.equal(await amount(9611, 3031), 7);
    assert.equal(await amount(9611, 57), before, 'unchanged needs do not buy crafting inputs again');

    state = await seed(9612, 50000);
    const requirements = [{ selfId: 1785, amount: 6, options: { towns: ['Dion'], r: 1, purpose: 'craft_input' } },
        { selfId: 3031, amount: 7, options: { towns: ['Dion'], r: 1, purpose: 'wealth_craft' } }];
    const materials = await Market.acquireMaterials(state, requirements);
    assert(materials.ready); assert.equal(captured.filter(row => row.id === 9612).length, 1);
    assert.equal(materials.spent, 6 * first.price + 7 * second.price);
    const repeated = await Market.acquireMaterials(materials.state, requirements);
    assert(repeated.ready); assert.equal(repeated.spent, 0); assert.equal(repeated.units, 0);
    assert.equal(captured.filter(row => row.id === 9612).length, 1);

    state = await seed(9617, 50000, { clanMaterialDemand: { 1785: 10 } },
        [{ selfId: 1785, name: 'Soul Ore', amount: 10 }]);
    const protectedInput = await Market.acquireMaterials(state, [requirements[0]]);
    assert(protectedInput.ready); assert.equal(await amount(9617, 1785), 16,
        'ten held clan units cannot satisfy six units of the selected personal craft');
    assert.equal(protectedInput.state.stats.clanMaterialDemand[1785], 10);
    assert.equal((await Market.acquireMaterials(protectedInput.state, [requirements[0]])).units, 0,
        'the same six free purchased units satisfy re-entry without another payment');

    const weapon = Npc.quoteFor(24, 'Dion');
    assert(weapon && Npc.sellerKey(weapon) !== Npc.sellerKey(first));
    const separate = [{ selfId: 24, amount: 1, town: 'Dion', purpose: 'craft_input', r: 1, at }, errands[0]];
    state = await seed(9618, 50000, { marketErrands: separate, marketErrand: separate[0] });
    await Market.finishTownErrands(state);
    const separateSellers = captured.filter(row => row.id === 9618);
    assert.equal(separateSellers.length, 2, 'different physical town NPCs settle separately');
    assert.equal(new Set(separateSellers.map(row => Npc.sellerKey(row.seller))).size, 2);
    assert(!separateSellers.some(row => row.lines.some(line => line.selfId === 24)
        && row.lines.some(line => line.selfId === 1785)), 'weapon shop and grocer never become one seller');

    state = await seed(9619, 50000, {}, [{ selfId: 736, name: 'Scroll of Escape', amount: 2 }]);
    const Goals = invoke('GameServer/Bot/Goals/GoalState');
    const goal = (await Goals.set(9619, { type: 'buy_craft_material', status: 'active', target: { itemId: 1785, amount: 6 },
        plan: { expectedBenefit: 'market_buy_craft_material', marketTown: 'Dion', purpose: 'craft_input', r: 1 } })).current;
    const activated = await Market.tryPurchase(state, goal);
    assert.equal(activated.hot, true, 'cold caller propagates activation after the committed NPC await');
    assert.equal(activated.state.phase, 'hot'); assert.equal(await amount(9619, 1785), 6);
    assert.equal(Goals.snapshot(9619).current.status, 'completed');
    assert.equal((await Market.tryPurchase(activated.state, goal)).reason, 'not_shopping');
    assert.equal(captured.filter(row => row.id === 9619).length, 1, 'hot handoff cannot buy the old goal twice');
    assert.equal(await amount(9619, 57), 50000 - 6 * first.price);

    // Same item, two independent bounded craft obligations merge physically;
    // attribution remains separate and all physical units are paid once.
    const duplicateErrands = [{ ...errands[0], purpose: 'craft_input' }, { ...errands[0], purpose: 'wealth_craft', amount: 9 }];
    state = await seed(9613, 50000, { marketErrands: duplicateErrands, marketErrand: duplicateErrands[0] });
    state = await Market.finishTownErrands(state);
    assert.equal(await amount(9613, 1785), 15); assert.equal(state.stats.marketErrands.length, 0);
    const merged = captured.find(row => row.id === 9613).lines.find(row => row.selfId === 1785);
    assert.equal(merged.errands.length, 2); assert.equal(merged.fundingParts.length, 2);

    // Configured graded-shot merchants are legal when enabled, but are not
    // physical NPC sellers and must retain their singleton settlement.
    const Policy = require('../src/GameServer/Bot/Economy/ProductionPolicy');
    const wasDisabled = Policy.shotsDisabled;
    try {
        Policy.shotsDisabled = () => false;
        const configured = invoke('GameServer/Bot/Economy/MarketOpportunity').fixedStoreOffers(1463)
            .find(offer => offer.town === 'Dion');
        assert(configured && !Npc.quoteFor(1463, 'Dion'), 'configured-only current D-shot quote');
        const errand = { selfId: 1463, amount: 250, town: 'Dion', purpose: 'craft_input', r: 1, at };
        state = await seed(9623, 3000000, { marketErrands: [errand], marketErrand: errand });
        await Goals.set(9623, Market.errandGoal(errand));
        state = await Market.finishTownErrands(state);
        assert.equal(await amount(9623, 1463), 250, 'town visit reaches configured singleton');
        assert.equal(state.stats.marketErrands.length, 0);
        assert.equal(Goals.snapshot(9623).current.status, 'completed');
        const receipt = captured.find(row => row.id === 9623 && row.lines.some(line => line.selfId === 1463));
        assert(receipt && !receipt.seller, 'configured store is not presented as a real NPC');
        assert.equal(receipt.lines.length, 1);
        assert.equal(receipt.lines[0].unitPrice, configured.price);
        const wallet = await amount(9623, 57);
        await Market.finishTownErrands(state);
        assert.equal(await amount(9623, 1463), 250);
        assert.equal(await amount(9623, 57), wallet, 'unchanged configured errand never pays twice');

        state = await seed(9624, 3000000);
        const selected = (await Goals.set(9624, { type: 'buy_craft_material', status: 'active',
            target: { itemId: 1463, amount: 125 }, plan: { expectedBenefit: 'market_buy_craft_material',
                marketTown: 'Dion', purpose: 'craft_input', r: 1 } })).current;
        const configuredGoal = await Market.tryPurchase(state, selected);
        assert.equal(configuredGoal.units, 125);
        assert.equal(await amount(9624, 1463), 125);
        assert.equal(await amount(9624, 57), 3000000 - 125 * configured.price);
        assert.equal(Goals.snapshot(9624).current.status, 'completed', 'singleton owns goal progress atomically');

        state = await seed(9626, 3000000);
        const deferred = (await Goals.set(9626, { ...selected, target: { itemId: 1463, amount: 125 } })).current;
        const primeGoal = Goals.prime;
        let paid;
        try {
            Goals.prime = () => { throw Error('fixture_goal_delivery_failed'); };
            paid = await Market.tryPurchase(state, deferred);
        } finally { Goals.prime = primeGoal; }
        assert.equal(paid.purchased, true, 'post-commit goal delivery failure never rejects a paid purchase');
        assert.equal(paid.units, 125);
        assert.equal(await amount(9626, 57), 3000000 - 125 * configured.price);
        assert.equal(await amount(9626, 1463), 125);
        const authoritativeGoal = (await DB.execute(['SELECT goalJson,updatedAt FROM bot_goal_state WHERE characterId=?', [9626]]))[0];
        assert.equal(JSON.parse(authoritativeGoal.goalJson).status, 'completed');
        Goals.prime(9626, authoritativeGoal.goalJson, authoritativeGoal.updatedAt);
    } finally { Policy.shotsDisabled = wasDisabled; }

    // Explicit selected native recipe/batches, without inventing a profitable
    // network choice. Its actual consumer buys only the five missing ore units.
    const Recipes = invoke('GameServer/Items/C4RecipeItems'), recipe = Recipes.resolveByRecipeId(20);
    const output = Data.items.find(row => row.selfId === recipe.productId);
    const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
    const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
    async function crafter(id) {
        let current = await seed(id, 50000, { classId: 57 }, [
            { selfId: 1458, name: 'Crystal: D-Grade', amount: 2 },
            { selfId: 1785, name: 'Soul Ore', amount: 1 }]);
        current = await Life.upsertState({ ...current, level: 60 }, 'native_craft_consumer');
        await DB.setCharacterRecipe(id, 20, 'dwarven');
        await DB.setSkill({ selfId: 172, name: 'Create Item', level: 2, passive: false }, id);
        return current;
    }
    const source = { selfId: 1785, town: 'Dion', npc: 5, npcPrice: first.price,
        cost: 5 * first.price, landed: 5 * first.price, lines: [], whole: true };
    const opportunity = { recipe, batches: 2, template: output, r: 1, expectedProfit: 1,
        basket: { cost: 5 * first.price, owned: [{ selfId: 1458, count: 2 }, { selfId: 1785, count: 1 }],
            purchases: [source] }, exit: { type: 'afk', offer: { town: 'Giran' }, town: 'Giran', price: 1, count: 312 } };
    state = await crafter(9621);
    const craftOwner = DB.craftInventoryItems;
    try {
        DB.craftInventoryItems = async () => { throw Error('fixture_selected_craft_waits'); };
        const waiting = await Wealth.execute(state, opportunity);
        assert.equal(waiting.reason, 'craft_rejected');
        assert.equal(await amount(9621, 1785), 6);
        assert.equal(captured.filter(row => row.id === 9621).length, 1);
        const again = await Wealth.execute(waiting.state, opportunity);
        assert.equal(again.reason, 'craft_rejected');
        assert.equal(captured.filter(row => row.id === 9621).length, 1,
            'selected unchanged two-batch wealth craft re-entry uses already purchased free inputs');
        state = again.state;
    } finally { DB.craftInventoryItems = craftOwner; }
    const wealthCraft = await Wealth.execute(state, opportunity);
    assert(wealthCraft.crafted, JSON.stringify(wealthCraft.state.stats.wealthCraft));
    assert.equal(await amount(9621, 1785), 0); assert.equal(await amount(9621, 1458), 0);
    assert.equal(await amount(9621, recipe.productId), 2 * recipe.productCount);

    state = await crafter(9622);
    const candidate = { recipe, batches: 2, maxBatches: 2, requiredCrystals: 1, crystalId: 1458,
        ore: recipe.materials.find(row => row.selfId === 1785), orePrice: first.price, r: 1,
        basket: { purchases: [source] }, output, profit: 1, salePrice: 1 };
    try {
        DB.craftInventoryItems = async () => { throw Error('fixture_selected_shot_waits'); };
        await assert.rejects(Shots.craft(state, candidate, {}, at), /fixture_selected_shot_waits/);
        assert.equal(await amount(9622, 1785), 6);
        await assert.rejects(Shots.craft(Life.cachedState(9622), candidate, {}, at), /fixture_selected_shot_waits/);
        assert.equal(captured.filter(row => row.id === 9622).length, 1,
            'selected unchanged two-batch shot craft cannot pay for the same inputs twice');
    } finally { DB.craftInventoryItems = craftOwner; }
    const shotCraft = await Shots.craft(Life.cachedState(9622), candidate, {}, at);
    assert.equal(shotCraft.stats.shotCraft.amount, 2 * recipe.productCount);
    assert.equal(await amount(9622, 1785), 0); assert.equal(await amount(9622, 1458), 0);
    assert.equal(await amount(9622, recipe.productId), 2 * recipe.productCount);

    // A real hot ShoppingState callback, actual actor/bag/SQL delivery. Capture
    // only its existing four-second work callback; no sleeping or server.
    const seller = Npc.quoteFor(2509, 'Dion');
    state = await seed(9614, 10000000, { classId: 12, exp: Data.experience[41], visitEvery: [10, 2] },
        [{ selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 }], 'hot');
    const Actor = invoke('GameServer/Model/Actor'), Backpack = invoke('GameServer/Actor/Backpack');
    const actor = new Actor({ id: 9614, name: 'Consumer9614', classId: 12, race: 0, level: 42,
        exp: Data.experience[41], hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000,
        locX: seller.locX, locY: seller.locY, locZ: seller.locZ });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    for (const item of await DB.fetchItems(9614)) {
        actor.backpack.insertItem(item.id, item.selfId, { ...item });
        if (item.equipped) actor.backpack.equipPaperdoll(item.slot, item.id, item.selfId);
    }
    const session = { actor, coldLifeState: state, plan: 'shopping', botSession: true,
        shoppingTarget: { town: 'Dion' }, dataSendToOthers() {}, dataSendToMe() {} };
    actor.session = session;
    const timeouts = [], timer = global.setTimeout;
    try {
        global.setTimeout = (callback, delay, ...args) => {
            if (delay === 4000 || delay === 5000) { timeouts.push({ callback, delay }); return {}; }
            return timer(callback, delay, ...args);
        };
        invoke('GameServer/Bot/AI/States/ShoppingState').scheduleRestock(session, actor, {}, { getClosestTown: () => ({ name: 'Dion' }) });
    } finally { global.setTimeout = timer; }
    await timeouts.find(row => row.delay === 4000).callback();
    const hot = captured.filter(row => row.id === 9614);
    assert.equal(hot.length, 1, 'scheduled visible-bot restock reaches one SQL basket');
    assert(hot[0].lines.length >= 2, 'current consumable needs of the same NPC coalesce');
    for (const line of hot[0].lines) {
        assert.equal(await amount(9614, line.selfId), line.amount);
        assert.equal(actor.backpack.fetchItemFromSelfId(line.selfId).fetchAmount(), line.amount);
        assert.equal(Npc.sellerKey(Npc.quoteFor(line.selfId, 'Dion', line.unitPrice, hot[0].seller)), Npc.sellerKey(hot[0].seller));
    }
    console.log('PASS actual cold town errands / craft input basket / unchanged need / merged attribution / hot ShoppingState SQL bag');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    DB.purchaseNpcInventoryBasket = original; await DB.close();
});

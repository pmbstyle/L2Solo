'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('dual-sword-wish-execution');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
Data.init();
const Recipes = invoke('GameServer/Items/C4DualSwordCombinations');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const timestamp = 1791896800000;

function buyer(classId, productId) {
    const recipe = Recipes.resolveByProductId(productId), inventory = {};
    for (const row of Gear.planFor({ classId, level: 20 }).items) {
        if ([7, 14].includes(row.slot)) continue;
        const previous = inventory[row.selfId] || { selfId: row.selfId, amount: 0, equippedSlots: [] };
        const slots = [...previous.equippedSlots, row.slot];
        inventory[row.selfId] = { ...previous, amount: slots.length, equipped: true,
            equippedCount: slots.length, equippedSlots: slots, slot: row.slot };
    }
    inventory[168] = { selfId: 168, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7 };
    for (const material of recipe.materials) inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    for (const id of [1463, 1061, 736]) inventory[id] = { selfId: id, amount: 100000 };
    return { characterId: 990510 + classId, name: `DualBuyer${classId}`, level: 53,
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 10000000,
        loc: { locX: 81100, locY: 148000, locZ: -3466 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory,
        stats: { classId, exp: Data.experience[52] + 1, wishFocus: [`power:${productId}:14`, 0, 0],
            equipmentPlan: { status: 'deferred', strategy: 'none', reason: 'wish_focus',
                recipeId: recipe.recipeId, target: { selfId: productId, slot: 14 },
                combine: { type: 'dual_sword', resultId: productId, stationId: recipe.station.id,
                    npcId: recipe.station.npcId, requirements: recipe.materials.map(row => ({ ...row })) } } } };
}

function review(state) {
    return Economy.forState(state, { timestamp, board: new BoardIndex(), spots: [],
        npcOffersFor: () => [], knownRecipes: [], withNodes: true,
        knowledgeEnabled: false, routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: () => [], caller: 'meeting_prepare' });
}

async function seed(state) {
    const account = `bot_dual_wish_${state.name}`;
    await Database.createAccount(account, 'fixture');
    const race = Data.classTemplates.find(row => row.classId === state.stats.classId).template.race;
    const characterId = Number((await Database.createCharacter(account, { name: state.name,
        classId: state.stats.classId, race, maxHp: 1000, maxMp: 1000,
        sex: 0, face: 0, hair: 0, hairColor: 0, ...state.loc })).insertId);
    await Database.execute(['UPDATE characters SET level=?,exp=?,hp=1000,mp=1000 WHERE id=?',
        [state.level, state.stats.exp, characterId]]);
    const inventory = { ...state.inventory, 57: { selfId: 57, amount: state.adena } };
    for (const row of Object.values(inventory)) {
        const template = Data.items.find(item => item.selfId === row.selfId);
        const slots = row.equippedSlots || [];
        for (const slot of slots) await Database.setItem(characterId,
            { selfId: row.selfId, name: template.template.name, amount: 1, equipped: true, slot });
        const unequipped = row.amount - slots.length;
        if (unequipped > 0) {
            // Source swords are non-stackable physical objects, even for Saber*Saber.
            const amounts = template.template.kind === 'Weapon.Sword' ? Array(unequipped).fill(1) : [unequipped];
            for (const amount of amounts) await Database.setItem(characterId,
                { selfId: row.selfId, name: template.template.name, amount, equipped: false, slot: 0 });
        }
    }
    return { ...state, characterId, accountName: account,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)) };
}

async function run() {
    await Database.init();
    await Life.init();
    for (const classId of [2, 34]) {
        const source = buyer(classId, 2561), recipe = Recipes.resolveByProductId(2561);
        delete source.inventory[72];
        source.inventory[1458] = { selfId: 1458, amount: 5730 };
        let state = await seed({ ...source, name: `LuxuryDualBuyer${classId}`, activity: 'shopping',
            loc: { locX: 83396, locY: 147904, locZ: -3400 } });
        const blade = Luxury.recipes().get(72);
        assert(!Planner.suitable(Data.items.find(row => row.selfId === 72), state, Planner.roleFor(state), 'c'),
            'a source sword remains unsuitable for wearing by a dual-sword class');
        assert(Luxury.eligible(state, blade), 'a native combination admits its compatible dual-sword input');
        assert(!Luxury.eligible(state, Luxury.recipes().get(233)), 'an unrelated dagger is not a dual-sword input');
        assert(!Luxury.eligible(state, Luxury.recipes().get(76)),
            'a blade for B duals cannot bypass the unfinished C equipment milestone');
        assert(!Luxury.eligible({ ...state, stats: { ...state.stats, classId: 12 } }, blade),
            'a caster cannot admit a sword through an incompatible dual-sword result');
        for (let count = 1; count <= 2; count++) {
            Economy.reset();
            const context = review(state), leaf = context.network.activity;
            assert.equal(leaf.rootKey, 'power:2561:14');
            assert.equal(leaf.kind, 'luxury_exchange');
            assert.equal(leaf.improvement.itemId, 72);
            const plan = Selection.selectAcquisitionPlan(state, state.stats.equipmentPlan,
                { spots: [], timestamp, preparedEconomy: context }).acquisitionPlan;
            state = await Life.upsertState({ ...state, stats: { ...state.stats, ...context.statsPacket,
                equipmentPlan: plan } }, 'luxury_dual_input_fixture');
            const result = await Improvements.reviewCold(state, { decide: () => Decision.capture(context, state) });
            assert.equal(result.changed, true, 'the native improvement command buys the selected blade');
            state = result.state;
            assert.equal(state.inventory[72].amount, count);
            assert.equal(state.inventory[72].equipped, false, 'the component is kept for the smith, never worn');
            assert.equal(Number(state.inventory[1458]?.amount || 0), 5730 - count * 2865);
        }
        const physical = await Database.fetchItems(state.characterId);
        assert.equal(physical.filter(row => row.selfId === 72).length, 2, 'two separate source swords are delivered');
        await assert.rejects(Database.applyBotImprovement(state.characterId,
            { kind: 'luxury_exchange', ...blade }, { coldState: state }), /already_owned/,
            'the native input capacity still rejects a third sword');
        Economy.reset();
        const context = review(state), plan = Providers.personalCraftPlan(state, context);
        assert.equal(context.network.activity.kind, 'craft');
        assert.equal(plan.recipeId, recipe.recipeId);
        const travel = Craft.beginTravel({ ...state, stats: { ...state.stats, equipmentPlan: plan } }, timestamp);
        const result = await Craft.craft({ ...travel, activity: 'crafting', loc: recipe.station.loc,
            stats: { ...travel.stats, travel: null } });
        assert.equal(result.reason, 'dual_sword_combined');
        assert.equal(result.state.inventory[2561].equipped, true);
        assert(!result.state.inventory[72], 'the smith consumes both Luxury swords');
    }
    console.log('Luxury source swords reach native Gladiator and Bladedancer dual assembly');

    const refusedSource = buyer(2, 2561);
    delete refusedSource.inventory[72];
    refusedSource.inventory[1458] = { selfId: 1458, amount: 5730 };
    let refused = await seed({ ...refusedSource, name: 'LuxuryRefusal', activity: 'shopping',
        loc: { locX: 83396, locY: 147904, locZ: -3400 } });
    refused = await Life.upsertState({ ...refused, stats: { ...refused.stats, decisionSeq: 7,
        activityLeaf: 12345, wishDirty: 0 } }, 'luxury_refusal_fixture');
    const beforeRefusal = await Database.fetchItems(refused.characterId);
    const result = await Improvements.reviewCold(refused, { decide: () => ({ riskWeight: 1, activity: {
        activity: 'improving', improvement: { kind: 'luxury_exchange', ...Luxury.recipes().get(72), npcId: 7098 }
    } }) });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'invalid_bot_luxury_exchange', 'a refused exchange returns an ordinary outcome');
    assert.equal(result.state.stats.activityLeaf, 0, 'the impossible selected action is invalidated');
    assert(invoke('GameServer/Bot/Situations').woken(result.state.stats, 'build'),
        'the refusal wakes the build instead of a fault backoff');
    assert.deepEqual(await Database.fetchItems(refused.characterId), beforeRefusal, 'refusal preserves the physical bag');

    for (const [classId, productId] of [[2, 2516], [34, 2523]]) {
        const state = await seed(buyer(classId, productId)), recipe = Recipes.resolveByProductId(productId);
        const context = review(state), leaf = context.network.activity;
        assert.equal(leaf?.rootKey, `power:${productId}:14`, 'the native wish engine chooses the held-blade dual');
        assert.equal(leaf.activity, 'crafting');
        assert.equal(leaf.recipeId, recipe.recipeId);
        assert(!context.network.queue.some(row => row.key === leaf.rootKey),
            'a ready zero-price wish is absent from the spending queue');
        const personal = Providers.personalCraftPlan(state, context);
        assert.equal(personal?.recipeId, recipe.recipeId,
            'a selected native blacksmith exchange reaches the personal equipment craft owner');
        assert.equal(personal.status, 'ready_to_craft');
        assert.equal(personal.combine.resultId, productId);
        const selected = Selection.selectAcquisitionPlan(state, state.stats.equipmentPlan,
            { spots: [], timestamp, preparedEconomy: context }).acquisitionPlan;
        assert.equal(selected.status, 'ready_to_craft', 'the empty spending queue must not defer selected ready duals');
        assert.equal(selected.recipeId, recipe.recipeId);
        const native = await require('./helpers/workerEconomyDecision')(state, { timestamp, townVisit: true });
        assert.equal(native.plan.acquisitionPlan.status, 'ready_to_craft', 'the real cold worker publishes a command-ready exchange');
        assert.equal(native.plan.acquisitionPlan.recipeId, recipe.recipeId);
        const travel = Craft.beginTravel({ ...state, stats: { ...state.stats, equipmentPlan: selected } }, timestamp);
        assert.equal(travel?.stats.travel.reason, 'dual_sword_combine');
        assert.equal(travel.stats.travel.stationId, recipe.station.id);
        assert.equal(travel.stats.travel.arrivalActivity, 'crafting');
        const atSmith = { ...travel, activity: 'crafting', loc: recipe.station.loc,
            stats: { ...travel.stats, travel: null } };
        const result = await Craft.craft(atSmith);
        assert.equal(result.reason, 'dual_sword_combined');
        assert.equal(result.productId, productId);
        const physical = await Database.fetchItems(state.characterId);
        assert(physical.some(row => row.selfId === productId && row.equipped && row.slot === 14),
            'native physical inventory reconciliation equips the new dual');
        for (const material of recipe.materials) assert(!physical.some(row => row.selfId === material.selfId),
            'both physical blade inputs were consumed');
        assert.equal(physical.find(row => row.selfId === 57).amount, state.adena);
        assert.equal(result.state.inventory[productId].equipped, true);
        assert(!physical.some(row => row.selfId === 168 && row.equipped), 'the interim hammer is unequipped');
        assert(!Craft.beginTravel(result.state, timestamp + 1), 'completed assembly cannot start a second craft trip');
        const stocks = { ...context, network: { ...context.network,
            activity: { kind: 'buy', activity: 'shopping', rootKey: 'stock:shots', itemId: 1463 } } };
        assert.equal(Providers.personalCraftPlan(state, stocks), null, 'held blades do not replace the selected stock errand');
        assert.equal(Selection.selectAcquisitionPlan(state, state.stats.equipmentPlan,
            { spots: [], timestamp, preparedEconomy: stocks }).acquisitionPlan.status, 'deferred');
        const missing = { ...state, inventory: { ...state.inventory,
            [recipe.materials[0].selfId]: { selfId: recipe.materials[0].selfId, amount: recipe.materials[0].amount - 1 } } };
        assert.equal(Providers.personalCraftPlan(missing, context), null,
            'a stale chosen craft cannot route to the smith with a missing blade');
    }
    console.log('Dual-sword native wish, worker, blacksmith and physical equip checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await Database.close(); require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }); });

'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
require('./helpers/databaseIsolation');
const fixture = isMainThread ? require('./helpers/isolatedSocialDatabase')('b-grade-craft-progression') : null;
if (isMainThread) require('../src/Global');
else require(workerData.workerPath);
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const Data = invoke('GameServer/DataCache');
if (isMainThread) Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const timestamp = 1791813240000;
const readyFixtures = new Map();

function equipped(inventory, selfId, slot) {
    const previous = inventory[selfId], slots = [...(previous?.equippedSlots || []), slot];
    inventory[selfId] = { selfId, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot };
}

function verify(recipeId, missing = false, slot = 14, classId = 3, targetId = null, finishedOffer = false) {
    const recipe = Recipes.resolveByRecipeId(recipeId);
    targetId ||= recipe.productId;
    const variants = Recipes.resolveVariantsByProductId(recipe.productId);
    assert(variants.some(row => row.successRate < 100));
    assert(variants.includes(recipe) && recipe.successRate === 100);
    assert.equal(Recipes.resolveByProductId(recipe.productId), variants[0], 'existing callers keep their canonical recipe');
    assert(Object.isFrozen(variants), 'the shared native variant catalogue cannot be changed by a review');
    const station = Shops.publishedStationRecipes().stationByRecipeId.get(recipeId);
    assert(station, 'the exact native recipe is published');
    const state = { characterId: 990410, name: 'CraftBuyer', level: 55, classId,
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 100000000,
        loc: { locX: 81100, locY: 148000, locZ: -3466 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {},
        stats: { classId, exp: Data.experience[54] + 1,
            wishFocus: [`power:${targetId}:${slot}`, 0, 0],
            persona: { primaryDrive: 'progression', understanding: 1,
                traits: { ambition: 0, commitment: 0, caution: 0, empathy: 0, sociability: 0 } } } };
    for (const row of Gear.planFor({ classId, level: 40 }).items) equipped(state.inventory, row.selfId, row.slot);
    assert.equal(Progression.assess(state).required, false, 'the C milestone is closed');
    // Other slots are already top B; the selected equipment improvement remains a
    // choice of sources, with only this published recipe's complete stock.
    const conflicts = [7, 14].includes(slot) ? [7, 14]
        : [10, 11, 15].includes(slot) ? [slot, 15, ...(slot === 15 ? [10, 11] : [])] : [slot];
    for (const [otherSlot, rows] of Providers.gearCandidates(state)) {
        if (conflicts.includes(otherSlot)) continue;
        for (const row of Object.values(state.inventory)) if (row.equippedSlots?.includes(otherSlot)) {
            row.equippedSlots = row.equippedSlots.filter(side => side !== otherSlot);
            row.equippedCount = row.equippedSlots.length; row.equipped = row.equippedCount > 0;
        }
        equipped(state.inventory, rows[0].selfId, otherSlot);
    }
    for (const material of recipe.materials) if (material.selfId !== recipe.recipeItemId)
        state.inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    for (const id of [invoke('GameServer/Inventory/ShotStock').planForState(state).selfId, 1061, 736])
        state.inventory[id] = { selfId: id, amount: 100000 };
    const fragment = recipe.materials[1];
    assert(fragment && fragment.selfId !== recipe.recipeItemId, 'native B equipment requires its key material');
    const board = new BoardIndex();
    if (missing) {
        state.inventory[fragment.selfId].amount--;
        board.put({ id: 77, ownerId: 990411, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 78, selfId: fragment.selfId, count: 1, price: 1, enchant: 0 }] });
    }
    if (finishedOffer) board.put({ id: 79, ownerId: 990413, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 80, selfId: targetId, count: 1, price: finishedOffer === true ? 1 : finishedOffer, enchant: 0 }] });
    const fee = Shops.productPrice(recipe);
    const service = { characterId: 990412, recipeId, price: fee, entryPrice: fee,
        capacityBatches: 1, townName: 'Giran', loc: station.loc, publicStation: true };
    const context = Economy.forState(state, { timestamp, board, spots: [], npcOffersFor: () => [],
        workshop: null, knownRecipes: [], withNodes: true, knowledgeEnabled: false,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: id => id === recipeId ? [service] : [], rememberContext: false });
    const productNode = context.projection.nodes.find(row => row.key === `item:${recipe.productId}`);
    assert(productNode?.paths.some(row => row.kind === 'craft' && row.recipeId === recipeId),
        'the published 100% variant survives the earlier unavailable lower-success variant');
    if (targetId !== recipe.productId) {
        const final = context.projection.nodes.find(row => row.key === `item:${targetId}`);
        assert(final?.paths.some(row => row.kind === 'mammon_unseal'
            && row.grossRequirements.some(input => input.key === `item:${recipe.productId}`)),
        'the final worn variant is connected to the native base craft');
    }
    const leaf = context.network.activity;
    assert.equal(leaf?.rootKey, `power:${targetId}:${slot}`, 'native network accepts the B equipment goal');
    if (finishedOffer === true) {
        assert.equal(leaf.activity, 'shopping');
        assert.equal(leaf.itemId, targetId, 'an affordable finished item wins over acquiring another ingredient');
        const prior = readyFixtures.get(recipeId)?.plan;
        if (prior) {
            const previous = { ...prior, status: 'active', strategy: 'craft' };
            const resumed = { ...state, stats: { ...state.stats, equipmentPlan: previous } };
            const chosen = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(resumed, previous, {
                preparedEconomy: context, spots: [], timestamp,
                planningOptions: { findMarketOffer: item => Number(item.selfId) === targetId
                    ? { price: 1, count: 1, town: 'Giran', sourceType: 'afk_bot_store' } : null }
            }).acquisitionPlan;
            assert.equal(chosen.strategy, 'market', 'an in-progress craft switches to the real finished-item offer');
            assert(chosen.inputPreparation, 'the pending purchase retains the unfinished craft inputs');
        }
        return { recipeId, targetId, finishedOffer };
    }
    assert.equal(leaf.activity, missing ? 'shopping' : 'crafting');
    assert.equal(missing ? leaf.itemId : leaf.recipeId, missing ? fragment.selfId : recipeId);
    const plan = Providers.personalCraftPlan(state, context);
    assert.equal(plan?.recipeId, recipeId);
    assert.equal(plan.craftProviders[recipeId].characterId, service.characterId);
    assert.equal(plan.craftProviders[recipeId].publicStation, true);
    assert(!plan.materials.some(row => row.selfId === recipe.recipeItemId), 'station plans do not require the recipe scroll');
    assert.equal(plan.target.selfId, targetId);
    if (targetId !== recipe.productId) {
        assert.deepEqual(plan.unseal, { sourceId: recipe.productId, productId: targetId });
        assert.notEqual(leaf.kind, 'mammon_unseal', 'Mammon must wait for the base craft or missing input');
        const command = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(context, state);
        assert(command.data.byteLength + 48 + Buffer.byteLength(JSON.stringify(command.echo)) <= 800,
            'the conversion chain fits the bounded cold-worker decision');
    }
    assert.equal(plan.target.slot, slot, 'the selected paperdoll slot reaches the equipment receipt');
    if (!missing) readyFixtures.set(recipeId, { state: { ...state,
        stats: { ...state.stats, ...context.statsPacket } }, plan, station });
    return { recipeId, productId: recipe.productId, targetId, missing, activity: leaf.activity };
}

async function verifyNativeCrafts() {
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const owners = new Map();
    fixture.assertConfigured(options.default);
    async function seed(accountName, name, classId, level, inventory, loc, stats) {
        await Database.createAccount(accountName, 'fixture');
        const race = Data.classTemplates.find(row => row.classId === classId).template.race;
        const characterId = Number((await Database.createCharacter(accountName, { name, classId, race,
            maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0, ...loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Data.experience[level - 1], characterId]]);
        for (const row of Object.values(inventory)) {
            const name = Data.items.find(item => item.selfId === row.selfId)?.template.name;
            const slots = row.equippedSlots || [];
            for (const slot of slots) await Database.setItem(characterId, { selfId: row.selfId, name,
                amount: 1, equipped: true, slot, enchant: 0 });
            const spare = row.amount - slots.length;
            const stackable = Data.items.find(item => item.selfId === row.selfId)?.etc?.stackable === true;
            for (let left = spare; left > 0; left -= stackable ? spare : 1)
                await Database.setItem(characterId, { selfId: row.selfId, name,
                    amount: stackable ? spare : 1, equipped: false, slot: 0, enchant: 0 });
        }
        return Life.upsertState({ characterId, accountName, name, level, phase: 'cold', activity: 'crafting',
            currentRegion: 'Giran', loc, adena: inventory[57].amount,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { ...stats, classId }, timing: {} }, 'b_craft_fixture');
    }
    try {
        await Database.init(); await Life.init();
        for (const [recipeId, { state, plan, station }] of readyFixtures) {
            const recipe = Recipes.resolveByRecipeId(recipeId);
            let owner = owners.has(station.id) ? Life.cachedState(owners.get(station.id))
                : await seed(Craft.crafterAccount(station), `Forge${recipeId}`, 57, 70,
                    { 57: { selfId: 57, amount: 1000 } }, station.loc, { craftStationId: station.id });
            owners.set(station.id, owner.characterId);
            await Shops.ensureRecipes(owner.characterId, Shops.profileFor(owner));
            owner = await Workshops.review(Life.cachedState(owner.characterId));
            const provider = { ...plan.craftProviders[recipeId], characterId: owner.characterId };
            let buyer = await seed(`bot_b_craft_${recipeId}`, `Buyer${recipeId}`, state.classId, 55,
                { ...state.inventory, 57: { selfId: 57, amount: state.adena } }, station.loc,
                { ...state.stats, equipmentPlan: { ...plan, craftProviders: { ...plan.craftProviders, [recipeId]: provider } } });
            const before = buyer.adena, ownerBefore = (await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount;
            const committedPlan = buyer.stats.equipmentPlan;
            buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats, equipmentPlan: {
                ...committedPlan, recipeId: Recipes.resolveByProductId(recipe.productId).recipeId } } }, 'b_other_recipe');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'another recipe variant cannot consume the personal goal reservation');
            const reservedId = recipe.materials[1].selfId;
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId),
                stats: { ...Life.cachedState(buyer.characterId).stats, equipmentPlan: committedPlan },
                inventory: { ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 1 } } }, 'b_explicit_protection');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'explicitly protected units stay protected even for the selected recipe');
            const unchanged = await Database.fetchItems(buyer.characterId);
            assert.equal(unchanged.find(row => row.selfId === 57).amount, before, 'refusals spend no fee');
            assert(!unchanged.some(row => row.selfId === recipe.productId), 'refusals produce no weapon');
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId), inventory: {
                ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 0 } } }, 'b_selected_recipe');
            const returnTo = { loc: { locX: 90000, locY: 148000, locZ: -3400 }, spotId: null, regionName: 'Giran' };
            if (plan.unseal) buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats,
                craftReturn: returnTo, marketReturn: returnTo,
                partyMarketReturn: { partyId: 'fixture_party_return', until: Date.now() + 900000 } } }, 'b_unseal_return_ticket');
            const result = await Craft.craft(buyer, () => 0);
            assert.equal(result.crafted, true, `${recipeId}: ${result.reason} ${result.error || ''}`);
            buyer = await Life.upsertState(result.state, 'b_craft_receipt');
            const physical = await Database.fetchItems(buyer.characterId);
            const product = physical.filter(row => row.selfId === recipe.productId);
            assert.equal(product.length, 1, 'one native B equipment receipt');
            if (!plan.unseal) {
                assert.equal(Number(product[0].equipped), 1, 'the B equipment is physically worn');
                assert.equal(Number(product[0].slot), plan.target.slot, 'paired jewelry and full body armor keep their selected paperdoll slot');
                assert.equal(buyer.inventory[recipe.productId].equippedCount, 1);
                assert.equal(buyer.stats.equipmentPlan, undefined, 'the accepted craft plan closes after equipment receipt');
            }
            else assert.equal(buyer.stats.equipmentPlan.target.selfId, plan.unseal.productId,
                'the base receipt must retain the final unsealed goal');
            for (const material of recipe.materials.filter(row => row.selfId !== recipe.recipeItemId))
                assert.equal(physical.filter(row => row.selfId === material.selfId).reduce((n, row) => n + row.amount, 0), 0);
            assert(!physical.some(row => row.selfId === recipe.recipeItemId), 'station completed the craft without a scroll');
            assert.equal(buyer.adena, before - provider.price, 'the buyer pays exactly the quoted service fee');
            assert.equal((await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount,
                ownerBefore + provider.price, 'the station receives the paid fee in its physical wallet');
            assert.equal((await Craft.craft({ ...buyer, activity: 'crafting' }, () => 0)).crafted, false,
                'a completed equipment receipt never crafts the equipment again');
            if (plan.unseal) {
                const Mammon = invoke('GameServer/Bot/AI/BotMammonUnseal');
                assert.equal(invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(buyer)[recipe.productId], 1,
                    'the base remains protected until its unseal receipt');
                const held = Economy.forState({ ...buyer, activity: 'hunting' }, { timestamp, board: new BoardIndex(), spots: [],
                    npcOffersFor: () => [], workshop: null, workshops: () => [], knownRecipes: [], rememberContext: false,
                    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) });
                assert.equal(held.network.activity?.kind, 'mammon_unseal', 'owned base needs no remaining workshop');
                const resumed = Providers.personalCraftPlan(buyer, held);
                assert.deepEqual(resumed.unseal, plan.unseal, 'the compact network keeps the conversion after base receipt');
                assert.equal(resumed.target.selfId, plan.target.selfId);
                assert.equal(resumed.recipeId, null, 'the held base is not nominated for another craft');
                buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats,
                    ...held.statsPacket, equipmentPlan: resumed } }, 'unseal_chain_resumed');
                const trip = buyer.stats.mammonReturn ? buyer : Mammon.beginTravel({ ...buyer, activity: 'hunting' }, timestamp);
                assert(trip, 'the native base receipt starts the Mammon trip');
                assert.equal(trip.stats.travel.reason, 'mammon_unseal', 'the craft continues to Mammon before returning to the field');
                assert.deepEqual(trip.stats.mammonReturn, returnTo, 'the continuation preserves its original return destination');
                assert.equal(trip.stats.partyMarketReturn.partyId, 'fixture_party_return', 'the same party ticket survives the continuation');
                const arrival = invoke('GameServer/Bot/Population/BackgroundResolver').resolveSolo({ state: trip,
                    timestamp: trip.stats.travel.arrivalAt, elapsedMs: trip.stats.travel.arrivalAt - timestamp });
                let arrived = await Life.upsertState({ ...trip, ...arrival.patch }, 'unseal_chain_arrival');
                const returned = await Mammon.finish(arrived, trip.stats.travel.arrivalAt + 1);
                buyer = await Life.upsertState(returned, 'unseal_chain_receipt');
                const after = await Database.fetchItems(buyer.characterId);
                const worn = after.find(row => row.id === product[0].id);
                assert.equal(worn.selfId, plan.unseal.productId, 'the same physical instance becomes the selected variant');
                assert.equal(Number(worn.equipped), 1, 'the final B gloves or boots are physically equipped');
                assert.equal(Number(worn.slot), plan.target.slot);
                assert(!after.some(row => row.selfId === recipe.productId), 'the base is converted, never duplicated');
                assert.equal(buyer.stats.equipmentPlan, undefined, 'only the equipped final variant closes the goal');
                assert(!Mammon.candidate(buyer), 'the accepted variant cannot loop through Mammon');
            }
            if ([457, 424].includes(recipeId)) {
                const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources'); Sources.initialise();
                const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
                const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
                const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
                const bag = structuredClone(state.inventory); delete bag[1459];
                for (const [id, row] of Object.entries(bag)) if (!row.equipped
                    && ['d', 'c'].includes(Data.items.find(item => item.selfId === row.selfId)?.etc?.rank)) delete bag[id];
                let customer = await seed(`bot_crystal_chain_${recipeId}`, `CrystalChain${recipeId}`, state.classId, 55,
                    { ...bag, 57: { selfId: 57, amount: state.adena } }, station.loc, state.stats);
                const operations = [];
                for (let step = 0; step < 12; step++) {
                    const economy = Economy.forState(customer, { timestamp: Date.now(), board: new BoardIndex(), spots: [],
                        npcOffersFor: Sources.npcOffersFor, workshop: null, knownRecipes: [], rememberContext: false,
                        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
                        workshops: id => id === recipeId ? [{ ...provider, recipeId, entryPrice: provider.price,
                            capacityBatches: 1, townName: 'Giran', loc: station.loc }] : [] });
                    const leaf = economy.network.activity;
                    const selected = Providers.personalCraftPlan(customer, economy);
                    assert([`power:${plan.target.selfId}:${plan.target.slot}`,
                        `crystal_input:${plan.target.selfId}:${plan.target.slot}`].includes(leaf?.rootKey), JSON.stringify(leaf));
                    assert.equal(selected?.recipeId, recipeId, 'crystal preparation retains its B recipe owner');
                    customer = await Life.upsertState({ ...customer, activity: 'shopping', stats: {
                        ...customer.stats, ...economy.statsPacket, equipmentPlan: selected } }, 'crystal_chain_step');
                    if (leaf.activity === 'shopping') {
                        const purchase = Market.planPurchase(customer, leaf.itemId, leaf.amount, { npcOnly: true,
                            towns: ['Giran'], money: customer.adena,
                            r: invoke('GameServer/Bot/Economy/PurchaseFunding').leafRatio(leaf,
                                economy.network.queue.find(row => row.key === leaf.rootKey)) });
                        assert(purchase, JSON.stringify(leaf));
                        const bought = await Market.buyHere(customer, purchase);
                        assert.equal(bought.units, leaf.amount);
                        customer = bought.state; operations.push('npc_buy');
                    } else if (leaf.activity === 'improving') {
                        const before = customer;
                        if (leaf.kind === 'crystallize' && leaf.itemId === 1459) {
                            const physicalBefore = await Database.fetchItems(customer.characterId);
                            await Database.setSkill({ selfId: 248, name: 'Crystallize', level: 1, passive: true }, customer.characterId);
                            await assert.rejects(Database.applyBotImprovement(customer.characterId,
                                { ...leaf.improvement, mode: 'self' }, { coldState: customer }), /improvement_source_changed/,
                            'D crystallization skill cannot break C equipment');
                            await assert.rejects(Database.applyBotImprovement(customer.characterId,
                                { ...leaf.improvement, items: [{ selfId: leaf.improvement.sourceSelfId, amount: 1 },
                                    { selfId: 626, amount: 1 }] }, { coldState: customer }), /improvement_source_changed/,
                            'mixed crystal grades cannot share a native operation');
                            assert.deepEqual(await Database.fetchItems(customer.characterId), physicalBefore,
                                'refused crystallization changes no physical item or crystal stack');
                        }
                        const result = await Improvements.reviewCold(customer, { decide: () => Decision.capture(economy, customer) });
                        assert(result.changed, JSON.stringify(leaf)); customer = result.state;
                        if (leaf.kind === 'luxury_exchange') {
                            assert(leaf.improvement.forCrystals);
                            assert.equal(customer.inventory[leaf.itemId].equippedCount, 0, 'Luxury scrap is never worn');
                            operations.push('luxury_input');
                        } else operations.push(Number(customer.inventory[1459]?.amount || 0) > Number(before.inventory[1459]?.amount || 0)
                            ? 'crystallize_c' : 'crystallize_d');
                    } else {
                        assert.equal(leaf.activity, 'crafting');
                        customer = await Life.upsertState({ ...customer, activity: 'crafting' }, 'b_chain_ready');
                        const crafted = await Craft.craft(customer, () => 0);
                        assert(crafted.crafted, `${crafted.reason}: ${crafted.error}`);
                        customer = crafted.state; operations.push('craft'); break;
                    }
                }
                assert.deepEqual(operations, ['npc_buy', 'crystallize_d', 'luxury_input', 'crystallize_c', 'craft']);
                assert((await Database.fetchItems(customer.characterId)).some(row => row.selfId === recipe.productId
                    && (plan.unseal || row.equipped)),
                'NPC D -> D crystals -> Luxury C -> C crystals -> native B craft produces the physical receipt');
            }
        }
        console.log('PASS native B craft receipts, eight glove/boot base crafts -> Mammon -> same physical instance equipped -> closed plan');
    } finally { await Database.close(); }
}

const cases = [[461], [457], [329, 2], [331, 5], [333, 3], [342, 10],
    [362, 10, 8], [368, 10, 12], [358, 10], [366, 15, 8], [479, 8, 5]];
const Unseal = invoke('GameServer/Items/C4Unseal');
const unsealCases = Unseal.recipes.filter(row => {
    const item = Data.items.find(item => item.selfId === row.productId);
    return item?.etc?.rank === 'b' && [9, 12].includes(item.etc.slot);
}).map(row => {
    const recipe = Recipes.resolveVariantsByProductId(row.sourceId).find(recipe => recipe.successRate === 100);
    const slot = Data.items.find(item => item.selfId === row.productId).etc.slot;
    return [recipe.recipeId, slot, { heavy: 2, light: 9, robe: 12 }[row.style], row.productId];
});
assert.equal(unsealCases.length, 24, 'four B sets have gloves/boots for all three armour styles');
const results = [...cases, ...unsealCases].flatMap(([recipeId, slot = 14, classId = 3, targetId = null]) =>
    [verify(recipeId, false, slot, classId, targetId), verify(recipeId, true, slot, classId, targetId)]);
// A chosen paperdoll variant is authoritative even when another armour style
// would be the default for an incidental, unplanned Mammon visit.
results.push(verify(430, false, 9, 9, 5710));
results.push(verify(457, true, 14, 3, null, true));
results.push(verify(457, true, 14, 3, null, 200000000));
if (isMainThread) {
    const { state: original, plan } = readyFixtures.get(457);
    const state = structuredClone(original), recipe = Recipes.resolveByRecipeId(plan.recipeId);
    const part = recipe.materials.find(row => row.selfId !== recipe.recipeItemId);
    const template = Data.items.find(item => item.selfId === part.selfId);
    const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
    const Trade = invoke('GameServer/Bot/Economy/TradeIntent');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const paused = { ...plan, status: 'deferred', strategy: 'none', reason: 'wish_focus', heldInputs: {} };
    state.stats.equipmentPlan = { status: 'active', strategy: 'direct_drop', target: { selfId: 76, slot: 7 }, inputPreparation: paused };
    delete state.inventory[part.selfId];
    let stored = 0;
    Index.useRowSource(() => Index.prepareRow([state.characterId, 1, stored ? [[part.selfId, stored, 0]] : []]), () => true);
    try {
        const network = { quantityPrepared: true, queue: [], moneyPrice: 0.001 };
        const bids = () => Trade.project(state, network, null, () => 100, 8);
        assert.equal(bids().find(row => row.itemId === part.selfId)?.amount, part.amount,
            'an alternative goal retains the exact missing key-part purchase');
        assert(!bids().some(row => row.itemId === recipe.recipeItemId), 'a public station never bids for a scroll');
        stored = 2; state.acceptedIncoming = { [part.selfId]: 1 };
        assert.equal(bids().find(row => row.itemId === part.selfId)?.amount, part.amount - 3,
            'stored and already incoming units are not ordered twice');
        assert(Trade.meetingPurchase(network, bids(), { selfId: part.selfId, count: 1, price: 100, town: 'Giran' }),
            'a fresh meeting accepts the retained project need');
        stored = 0; delete state.acceptedIncoming;
        state.inventory[part.selfId] = { selfId: part.selfId, amount: 3, kind: template.template.kind,
            name: template.template.name, stackable: template.etc.stackable };
        paused.heldInputs[part.selfId] = 3;
        assert.equal(Disposition.warehouseCandidates(state).find(row => row.selfId === part.selfId)?.amount, 3,
            'a paused kit may deposit its reserved pieces during a town visit');
        stored = 3;
        assert(!Disposition.warehouseCandidates(state).some(row => row.selfId === part.selfId),
            'the same retained allocation is never deposited twice');
        delete state.inventory[part.selfId];
        state.stats.equipmentPlan = { ...plan, status: 'active', strategy: 'craft' };
        const deferred = invoke('GameServer/Bot/AI/GearPlanSelection').deferredWishPlan(state.stats.equipmentPlan, {}, state);
        assert.equal(deferred.heldInputs[part.selfId], 3, 'deferral retains the pieces already in the warehouse');
        const deferredState = { ...state, stats: { ...state.stats, equipmentPlan: deferred } };
        assert(invoke('GameServer/Bot/Economy/CraftWarehousePolicy').planFor(deferredState),
            'a paused equipment wish keeps its warehouse ownership and can resume');
        state.stats.craftWarehouseDepositTarget = plan.target.selfId;
        const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
        const returnTrip = Warehouse.beginCraftReturn(state, timestamp);
        assert.equal(returnTrip?.stats.travel.reason, 'craft_warehouse', 'the resumed kit returns for its stored inputs');
        assert.equal(returnTrip.stats.travel.arrivalActivity, 'shopping');
        assert(!Warehouse.beginCraftReturn({ ...state, stats: { ...state.stats,
            craftWarehouseVisit: returnTrip.stats.craftWarehouseVisit } }, timestamp), 'a failed visit does not loop with unchanged warehouse stock');
        delete state.stats.equipmentPlan.inputPreparation;
        assert(bids().some(row => row.itemId === part.selfId), 'an active B craft retains its own missing-piece need');
        state.stats.equipmentPlan = { ...state.stats.equipmentPlan, status: 'cancelled' };
        assert.equal(bids().length, 0, 'an abandoned project has no purchase consent');
    } finally { Index.useRowSource(); }
}
{
    const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources'); Sources.initialise();
    const { state: original, plan, station } = readyFixtures.get(457);
    const state = structuredClone(original);
    delete state.inventory[1459];
    for (const [id, row] of Object.entries(state.inventory)) if (!row.equipped
        && ['d', 'c'].includes(Data.items.find(item => item.selfId === row.selfId)?.etc?.rank)) delete state.inventory[id];
    const provider = plan.craftProviders[457];
    const context = Economy.forState(state, { timestamp, board: new BoardIndex(), spots: [],
        npcOffersFor: Sources.npcOffersFor, workshop: null, knownRecipes: [], rememberContext: false,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: id => id === 457 ? [{ ...provider, recipeId: id, entryPrice: provider.price,
            capacityBatches: 1, townName: 'Giran', loc: station.loc }] : [] });
    const leaf = context.network.activity, selected = Providers.personalCraftPlan(state, context);
    assert.equal(leaf.activity, 'shopping');
    assert.equal(Data.items.find(item => item.selfId === leaf.itemId)?.etc?.rank, 'd');
    assert.equal(selected.recipeId, 457);
    assert(selected.crystalPreparation.exchange);
    const command = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(context, state);
    assert(command.data.byteLength + 48 + Buffer.byteLength(JSON.stringify(command.echo)) <= 800,
        'the crystal chain fits the bounded worker decision');
    assert.equal(command.activity.itemId, leaf.itemId);
    const native = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').planFor(state, {
        recipeId: 457, spots: [], allowedRecipeIds: new Set([457]),
        findNpcOffer: item => Sources.npcOffersFor(item.selfId).find(row => row.town === 'Giran'),
        findMarketOffer: item => Sources.npcOffersFor(item.selfId).find(row => row.town === 'Giran') });
    assert.equal(native.strategy, 'craft'); assert.equal(native.status, 'active');
    assert.equal(native.next.kind, 'crystal_supply', 'the clan route recognizes renewable C crystals');
    const interrupted = structuredClone(state);
    interrupted.stats.equipmentPlan = selected;
    const inputId = selected.crystalPreparation.exchange.itemId;
    interrupted.inventory[inputId] = { selfId: inputId, amount: 1, equipped: false };
    const resumed = Economy.forState(interrupted, { timestamp, board: new BoardIndex(), spots: [],
        npcOffersFor: Sources.npcOffersFor, workshop: null, workshops: () => [], knownRecipes: [],
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]) });
    assert.equal(resumed.network.activity.rootKey, `crystal_input:${plan.target.selfId}:${plan.target.slot}`);
    assert.equal(resumed.network.activity.kind, 'crystallize');
    assert.equal(resumed.network.activity.itemId, 1459, 'a paid C input is crystallized even when the B workshop disappears');
    const retained = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(interrupted, selected,
        { preparedEconomy: resumed }).acquisitionPlan;
    assert.equal(retained.recipeId, selected.recipeId);
    assert(retained.crystalPreparation, 'a temporary missing final route cannot release the conversion inputs for sale');
    const stocked = structuredClone(interrupted);
    delete stocked.inventory[inputId];
    stocked.inventory[1459] = { selfId: 1459, amount: 1462 };
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), originalPlan = Planner.planFor;
    try {
        Planner.planFor = () => ({ status: 'complete', reason: 'no_missing_craftable_upgrade' });
        const rootKey = `power:${selected.target.selfId}:${selected.target.slot}`;
        const interruptedEconomy = { ...resumed, network: { ...resumed.network,
            queue: [{ key: rootKey, object: { itemId: selected.target.selfId, slot: selected.target.slot } }],
            activity: { rootKey, activity: 'hunting' } } };
        const waiting = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(stocked, selected,
            { preparedEconomy: interruptedEconomy }).acquisitionPlan;
        assert.equal(waiting.status, 'deferred'); assert.equal(waiting.recipeId, selected.recipeId);
        const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts({ ...stocked,
            stats: { ...stocked.stats, equipmentPlan: waiting } });
        assert(reserved[1459] >= 353, 'a missing final route cannot sell the C crystals reserved for the unfinished B craft');
    } finally { Planner.planFor = originalPlan; }
    if (isMainThread) {
        const clan = invoke('GameServer/Clan/ClanEquipmentPlanner').planForMember({ ...state, stats: {
            ...state.stats, equipmentPlan: { ...native, strategy: 'direct_drop', status: 'active' } } }, [], [], {
            throwOnError: true, craftRecipes: [Recipes.resolveByRecipeId(457)], allowedRecipeIds: [457] });
        assert.equal(clan.strategy, 'craft', 'an old clan drop goal switches to the now available craft');
    }
    results.push({ crystalSupply: true, leaf, selected, command: { ...command.activity }, native,
        resumed: { rootKey: resumed.network.activity.rootKey, kind: resumed.network.activity.kind, itemId: resumed.network.activity.itemId } });
}
console.log(`PASS B recipe variants and native craft/material goals (${isMainThread ? 'main' : 'worker'})`);
if (isMainThread) {
    const workerCheck = new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: {
            workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
            sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: 'b-grade-craft-test' } });
        const timer = setTimeout(() => { worker.terminate(); reject(Error('B craft worker timed out')); }, 60000);
        worker.on('message', message => {
            if (message.type !== 'b_grade_craft_result') return;
            clearTimeout(timer);
            try { assert.deepEqual(message.results, results, 'real cold worker and main select the same B steps'); resolve(); }
            catch (error) { reject(error); }
            worker.terminate();
        });
        worker.on('error', error => { clearTimeout(timer); reject(error); });
    });
    Promise.all([workerCheck, verifyNativeCrafts()])
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }));
} else parentPort.postMessage({ type: 'b_grade_craft_result', results });

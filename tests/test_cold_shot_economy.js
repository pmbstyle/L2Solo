'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-shot-economy');
require('../src/Global');
fixture.assertConfigured(options.default);
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const fs = require('node:fs');
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const GLUDIO = { locX: -12736, locY: 122816, locZ: -3112 };
const held = (items, id) => items.filter(item => Number(item.selfId) === id).reduce((sum, item) => sum + Number(item.amount), 0);
const cash = amount => ({ selfId: 57, name: 'Adena', amount });
let serial = 0;
async function seed(items, { classId = 0, level = 30, name = 'Fixture', town = 'Giran', loc = GIRAN } = {}) {
    const account = `bot_cold_shots_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const race = Number(Data.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
    const exp = Number(Data.experience[level - 1]);
    const id = Number((await Database.createCharacter(account, { name: `${name}${serial}`, classId, race,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...loc })).insertId);
    await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?', [level, exp, id]]);
    for (const item of items) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    if ([56, 57, 118].includes(classId)) await Database.setSkill({ selfId: 172, name: 'Create Item',
        level: invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor({ level, stats: { classId } }), passive: false }, id);
    return Life.upsertState({ characterId: id, accountName: account, name: `${name}${serial}`, level, exp,
        phase: 'cold', activity: 'shopping', adena: held(items, 57), currentRegion: town, loc: { ...loc },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId, generatedCold: true }, timing: {} }, 'cold_shot_fixture');
}
async function measuredEconomy(state, now) {
    for (let i = 0;i < 3;i++) state = { ...state, stats: { ...state.stats,
        huntEfficiency: Hunt.record(state, { spotId: 'native_craft_hunt', cycleMs: 3600000, adena: 77000,
            exp: 100000, kills: 1, timestamp: now }) } };
    const context = Economy.forState(state, { timestamp: now });
    return Life.upsertState({ ...state, stats: { ...state.stats, ...context.statsPacket } }, 'native_craft_money');
}
async function nativeEconomy(state, now) {
    return Life.upsertState({ ...state, stats: { ...state.stats, ...Economy.forState(state, { timestamp: now }).statsPacket } },
        'native_stock_money');
}
async function sell(state, id, price) {
    // These production cases require executable backed supply, not future WTS interest.
    const previous = Afk.ownerRecords(state.characterId).find(row => row.kind === 'shop');
    const lines = new Map((previous?.lines || []).map(line => [line.selfId, { ...line }]));
    if (previous) await Afk.closeBotRecord(state.characterId, previous.id);
    const item = (await Database.fetchItems(state.characterId)).find(row => Number(row.selfId) === id);
    lines.set(id, { objectId: item.id, selfId: id, name: item.name, count: 1, price,
        enchant: 0, stackable: !!item.stackable, slot: Number(item.slot || 0) });
    const bag = await Database.fetchItems(state.characterId);
    await Afk.publishBot(state.characterId, { kind: 'shop', storeType: Afk.SELL, town: 'Giran',
        title: 'Physical craft inputs', lines: [...lines.values()].map(line => ({ ...line, objectId: bag.find(item => item.selfId === line.selfId && !item.equipped).id })) });
}

async function images(ids) {
    return Promise.all(ids.map(async id => ({ items: await Database.fetchItems(id),
        character: (await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]))[0],
        life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0] })));
}
(async() => {
    let originals;
    try {
        fixture.assertConfigured(options.default); await Database.init(); Data.init(); await Life.init(); await Afk.init(); Workshop.init();
        const now = Date.now();
        let crafter = await seed([cash(1000000),
            { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }], { classId: 56, level: 20, name: 'Crafter' });
        const supplier = await seed([cash(1000000), { selfId: 45, name: 'Bone Helmet', amount: 1 }], { name: 'Supplier' });
        let buyer = await seed([cash(1000000), { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }], { name: 'Buyer' });
        // Publish the same funded native shots signal the retained lifecycle
        // publishes in production. An allStates mock cannot populate the index.
        const buyerContext = Economy.forState(buyer, { timestamp: now });
        const packet = buyerContext.statsPacket;
        buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats, ...packet, shotDemand: { itemId: 1463, amount: 1000,
            maxSpend: Funding.spendable({ ...buyer, stats: { ...buyer.stats, ...packet } }, 0,
                { itemId: 1463, survivalCost: buyerContext.kitCost(1463) }), at: now } } }, 'native_funded_shots');
        const hiddenSignal = Shots.marketSnapshot(now).shotDemand.get(1463).find(row => row.characterId === buyer.characterId);
        assert.equal(hiddenSignal, undefined, 'private wishes and wallet are unavailable to the seller');
        // The backed buy shop provides a concrete quote of 100 per shot.
        // Its owner clears the transient signal so the indexed ad is the source.
        buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats, shotDemand: null } }, 'native_ad_demand');
        await Afk.publishBot(buyer.characterId, { kind: 'shop',  storeType: Afk.BUY, town: 'Giran', title: 'Funded D shots',
            lines: [{ selfId: 1463, name: 'Soulshot: D-grade', count: 1000, price: 100, enchant: 0, stackable: true, slot: 0 }] });
        const signal = Shots.marketSnapshot(now).shotDemand.get(1463).find(row => row.characterId === buyer.characterId);
        assert.equal(signal.amount, 1000); assert.equal(signal.origin, 'public_bid');
        assert.equal(held(await Database.fetchItems(buyer.characterId), 57), 900000, 'the demand is paid into escrow');
        await Database.setCharacterRecipe(crafter.characterId, 20, 'dwarven');
        await Database.setSkill({ selfId: 248, name: 'Crystallize', passive: false, level: 1 }, crafter.characterId);
        crafter = await measuredEconomy(crafter, now);
        const recipe = Recipes.resolveByRecipeId(20);
        assert.equal(crafter.stats.money[0], 77000, 'labour uses three measured native hunting rounds');
        assert(crafter.stats.money[1] >= 1 / crafter.stats.money[0]);
        // NEXT-E2 evaluates the complete finite batch action: the old 22324
        // quote can repay its gear cost over seven batches. A 250000 quote
        // remains unprofitable for the whole finite 1000-unit bid.
        await sell(supplier, 45, 250000);
        const refusedBefore = await images([crafter.characterId, supplier.characterId]);
        assert.equal(Shots.craftCandidate(crafter, recipe, Shots.marketSnapshot(now)), null);
        await Shots.execute(crafter, { craft: { recipeId: 20, batches: 7 } }, now);
        assert.deepEqual(await images([crafter.characterId, supplier.characterId]), refusedBefore,
            'below-floor production cannot debit, crystallize or consume materials');

        const oldOffer = Afk.offers(45, Afk.SELL).find(row => Number(row.sourceId) === supplier.characterId);
        assert(oldOffer, 'the expensive physical helmet remains in its seller escrow');
        await Afk.repriceBot(supplier.characterId, oldOffer.lineId, 1000, oldOffer.expectedRevision);
        const index = Shots.marketSnapshot(now), step = Policy.decide(crafter, index, [20]);
        assert.equal(step.craft.recipeId, 20); assert.equal(step.craft.batches, 7);
        assert.equal(step.craft.gear[0], 45, 'the selected physical crystal source crosses the compact seam');
        assert.equal(step.craft.exit[0], index.offersFor(1463, Afk.BUY).find(row => row.sourceId === buyer.characterId).recordId);
        const walletBeforeInterest = held(await Database.fetchItems(buyer.characterId), 57);
        const interest = await Afk.publishBot(buyer.characterId, { kind: 'buy_ad', storeType: Afk.BUY,
            town: 'Giran', title: 'Conditional shot interest', lines: [{ selfId: 1463, name: 'Soulshot: D-grade',
                count: 1000, price: 100, enchant: 0, stackable: true, slot: 0 }] });
        assert.equal(interest.escrowAdena, 0);
        assert.equal(held(await Database.fetchItems(buyer.characterId), 57), walletBeforeInterest);
        const conditional = Afk.offers(1463, Afk.BUY).find(offer => offer.recordId === interest.id);
        assert(conditional?.conditional);
        const interestOnly = { ...index, offersFor: (id, type, excluded) => Number(id) === 1463 && type === Afk.BUY
            ? [conditional] : index.offersFor(id, type, excluded) };
        assert.equal(Shots.craftCandidate(crafter, recipe, interestOnly), null,
            'conditional interest cannot finance production that a backed shop can finance');
        await Afk.closeBotRecord(buyer.characterId, interest.id);
        assert.equal(held(await Database.fetchItems(buyer.characterId), 57), walletBeforeInterest);
        const nativeStep = Policy.unpackStep(Policy.packStep(step));
        assert(Buffer.byteLength(JSON.stringify(Policy.packStep(step))) <= 69);
        assert.equal(Shots.recheck(crafter, { ...nativeStep.craft,
            gear: nativeStep.craft.gear.map((value, at) => at === 5 ? Number(value) + 1 : value) }), null,
        'a source revision mismatch refuses the sparse identity before physical spending');
        const candidate = Shots.craftCandidate(crafter, recipe, index);
        assert(candidate.r >= crafter.stats.money[1]);
        assert(Funding.spendable(crafter, 0, { r: candidate.r }) >= candidate.gear.cash + candidate.orePrice * 21);
        const history = [];
        originals = { buy: Afk.buyFromShop, npc: Database.purchaseNpcInventoryItem,
            basket: Database.purchaseNpcInventoryBasket,
            crystal: Database.crystallizeInventoryItem, craft: Database.craftInventoryItems };
        Afk.buyFromShop = async(...args) => {const receipt = await originals.buy(...args);history.push('gear');return receipt;};
        Database.purchaseNpcInventoryBasket = async(...args) => {const receipt = await originals.basket(...args);history.push('ore');return receipt;};
        Database.crystallizeInventoryItem = async(...args) => {const receipt = await originals.crystal(...args);history.push('crystal');return receipt;};
        Database.craftInventoryItems = async(...args) => {const receipt = await originals.craft(...args);history.push('craft');return receipt;};
        const result = await Shots.execute(crafter, nativeStep, now);
        assert.deepEqual(history, ['gear', 'crystal', 'ore', 'craft']);
        const actual = await Database.fetchItems(crafter.characterId);
        assert.equal(result.stats.shotCraft.productId, 1463);
        assert.equal(held(actual, 1463), 1092); assert.equal(result.inventory[1463].amount, 1092);
        assert.equal(held(actual, 1458), 49); assert.equal(result.inventory[1458].amount, 49);
        assert.equal(held(actual, 45), 0); assert.equal(held(actual, 1785), 0);
        assert.equal(Number(result.inventory[45]?.amount || 0), 0); assert.equal(Number(result.inventory[1785]?.amount || 0), 0);
        assert.equal(result.adena, 1000000 - 1000 - 21 * 550); assert.equal(held(actual, 57), result.adena);
        assert.equal(held(await Database.fetchItems(supplier.characterId), 57), 1001000);
        assert.equal(Number((await images([crafter.characterId]))[0].character.mp), 1000 - 7 * recipe.mpCost);
        console.log('PASS native funded demand, strict original quote refusal and physical four-step conservation');

        await Database.setItem(supplier.characterId, { selfId: 45, name: 'Bone Helmet', amount: 1 });
        await Database.setItem(supplier.characterId, { selfId: 1804, name: 'Recipe: Soulshot: D-Grade', amount: 1 });
        await Life.syncExternalInventory(supplier.characterId, 'native_recipe_stock', Life.cachedState(supplier.characterId));
        await sell(supplier, 45, 1000); await sell(supplier, 1804, 480000);
        const buying = Afk.offers(1463, Afk.BUY).find(row => Number(row.sourceId) === buyer.characterId);
        await Afk.closeBotRecord(buyer.characterId, buying.recordId);
        await Afk.publishBot(buyer.characterId, { kind: 'shop',  storeType: Afk.BUY, town: 'Giran', title: 'Funded new recipe route',
            lines: [{ selfId: 1463, name: 'Soulshot: D-grade', count: 3000, price: 100, enchant: 0, stackable: true, slot: 0 }] });
        assert.equal(held(await Database.fetchItems(buyer.characterId), 57), 700000,
            'the added recipe-route demand is physically funded above existing crafted supply');
        let recipeBuyer = await seed([cash(1000000), { selfId: 1463, name: 'Soulshot: D-grade', amount: 1000 },
            { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }], { classId: 56, level: 20, name: 'Learner' });
        recipeBuyer = await measuredEconomy(recipeBuyer, now);
        const recipeIndex = Shots.marketSnapshot(now), recipeStep = Policy.decide(recipeBuyer, recipeIndex, []);
        assert.equal(recipeStep, null, 'a recipe scroll cannot be valued above its finite supported route');
        assert(Shots.craftCandidate(recipeBuyer, recipe, recipeIndex), 'the requested recipe has a profitable native route');
        // An expensive scroll is refused before acquisition. A later cheap
        // public quote creates a positive finite acquisition route.
        const beforeRecipe = await images([recipeBuyer.characterId, supplier.characterId]);
        const waiting = await Shots.execute(recipeBuyer, { recipeTarget: 20 }, now + 31000);
        const afterRecipe = await images([recipeBuyer.characterId, supplier.characterId]);
        assert.deepEqual(afterRecipe.map(row => row.items), beforeRecipe.map(row => row.items));
        assert.deepEqual(afterRecipe.map(row => row.character), beforeRecipe.map(row => row.character));
        assert.equal((await Database.fetchCharacterRecipes(recipeBuyer.characterId)).length, 0);
        assert.equal(waiting.stats.shotRecipeDemand, undefined);
        const bookOffer = Afk.offers(1804, Afk.SELL).find(row => Number(row.sourceId) === supplier.characterId);
        await Afk.repriceBot(supplier.characterId, bookOffer.lineId, 1, bookOffer.expectedRevision);
        const acceptedRecipe = Policy.decide(waiting, Shots.marketSnapshot(now + 62000), []);
        assert.equal(acceptedRecipe.recipeTarget, 20); assert(acceptedRecipe.recipeRoute);
        const learned = await Shots.execute(waiting, Policy.unpackStep(Policy.packStep(acceptedRecipe)), now + 62000);
        assert((await Database.fetchCharacterRecipes(recipeBuyer.characterId)).some(row => Number(row.recipeId) === 20));
        assert.equal(learned.adena, 999999); assert.equal(held(await Database.fetchItems(recipeBuyer.characterId), 57), 999999);
        assert.equal(held(await Database.fetchItems(recipeBuyer.characterId), 1804), 0);
        assert.equal(held(await Database.fetchItems(supplier.characterId), 1804), 0);
        assert.equal(held(await Database.fetchItems(supplier.characterId), 57), 1001001);
        assert.equal(learned.stats.shotRecipeDemand, null);
        console.log('PASS finite recipe price refusal, physical paid delivery and scroll consumption');

        await Database.setItem(supplier.characterId, { selfId: 1463, name: 'Soulshot: D-grade', amount: 300 });
        await Life.syncExternalInventory(supplier.characterId, 'native_shot_lot', Life.cachedState(supplier.characterId));
        const lot = (await Database.fetchItems(supplier.characterId)).find(row => Number(row.selfId) === 1463);
        await Afk.publishBot(supplier.characterId, { kind: 'shop',  storeType: Afk.SELL, town: 'Gludio', title: 'Cheaper shots',
            lines: [{ objectId: lot.id, selfId: 1463, name: lot.name, count: 300, price: 60, enchant: 0, stackable: true, slot: 0 }] });
        const fighterItems = [cash(51000), { selfId: 1463, name: 'Soulshot: D-grade', amount: 200 },
            { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }];
        const fighter = await nativeEconomy(await seed(fighterItems, { classId: 1, name: 'Fighter', town: 'Gludio', loc: GLUDIO }), now);
        const purchases = [];
        Afk.buyFromShop = async(...args) => {const receipt = await originals.buy(...args);
            purchases.push(['shop', args[3], args[4].expectedPrice]);return receipt;};
        Database.purchaseNpcInventoryItem = async(...args) => {const receipt = await originals.npc.apply(Database, args);
            purchases.push(['npc', args[1].amount, args[1].unitPrice]);return receipt;};
        // ARCH-NOTE: E1/E5 replace the old level reserve and fixed 1000-shot
        // target. Keep the actual cheaper-line/NPC order and physical wallet
        // conservation; native stock and the queue determine the amount today.
        const stocked = await Shots.reviewDemand(fighter, now + 70000);
        assert.deepEqual(purchases[0], ['shop', 300, 60]);
        assert.equal(purchases.length, 2);assert.equal(purchases[1][0], 'npc');assert.equal(purchases[1][2], 100);
        assert(purchases[1][1] > 0);
        assert.equal(stocked.adena, 51000 - 18000 - purchases[1][1] * 100);assert(stocked.adena >= 0);
        const stockedItems = await Database.fetchItems(fighter.characterId);
        assert.equal(held(stockedItems, 57), stocked.adena);
        assert.equal(held(stockedItems, 1463), 500 + purchases[1][1]);assert.equal(stocked.stats.shotDemand, null);

        await Database.setItem(supplier.characterId, { selfId: 1463, name: 'Soulshot: D-grade', amount: 300 });
        await Life.syncExternalInventory(supplier.characterId, 'native_restock_lot', Life.cachedState(supplier.characterId));
        const replacement = (await Database.fetchItems(supplier.characterId)).find(row => Number(row.selfId) === 1463);
        await Afk.publishBot(supplier.characterId, { kind: 'shop',  storeType: Afk.SELL, town: 'Gludio', title: 'Changed shots',
            lines: [{ objectId: replacement.id, selfId: 1463, name: replacement.name, count: 300, price: 60, enchant: 0, stackable: true, slot: 0 }] });
        const failedBuyer = await nativeEconomy(await seed(fighterItems, { classId: 1, name: 'ChangedShop', town: 'Gludio', loc: GLUDIO }), now);
        purchases.length = 0;
        Afk.buyFromShop = async() => {throw Error('afk_trade_stock_changed');};
        const failed = await Shots.reviewDemand(failedBuyer, now + 71000);
        assert.equal(purchases.length, 1);assert.equal(purchases[0][0], 'npc');assert.equal(purchases[0][2], 100);
        assert(purchases[0][1] > 0);assert.equal(failed.adena, 51000 - purchases[0][1] * 100);
        assert.equal(held(await Database.fetchItems(failedBuyer.characterId), 1463), 200 + purchases[0][1]);

        const fieldLoc = { locX: -14000, locY: 130000, locZ: -3000 };
        let hunter = await nativeEconomy(await seed(fighterItems, { classId: 1, name: 'Field', town: 'Gludio', loc: fieldLoc }), now);
        hunter = await Life.upsertState({ ...hunter, activity: 'hunting' }, 'native_field_restock');
        const fieldBefore = await images([hunter.characterId]);purchases.length = 0;
        const traveling = await Shots.reviewDemand(hunter, now + 72000);
        assert.deepEqual(purchases, [], 'no remote field inventory purchase');
        const market = invoke('GameServer/Bot/Economy/ColdMarketService');
        const stock = Economy.basics(hunter).stock('shots');
        const quote = market.planPurchase(hunter, stock.itemId, stock.survivalMissing + stock.missing,
            { purpose: 'shots', currentFunding: true, timestamp: now + 72000 });
        assert(quote?.units > 0, 'a payable batch alone is not a reason to leave the field');
        const route = invoke('GameServer/Bot/Economy/EconomicTrip').read(hunter, quote.town, { origin: fieldLoc });
        assert.equal(route.known, true);
        const context = invoke('GameServer/Bot/Population/ColdEconomyDecision').economyFor(hunter);
        const value = invoke('GameServer/Bot/Economy/EconomicValuation').acquisition(
            { ...context, itemUsefulness: () => stock.benefitPerUnit }, quote, route);
        assert(value.valueHours <= 0, 'the actual native batch cannot pay for this known journey');
        assert.equal(traveling.activity, 'hunting');
        assert(!traveling.stats.marketErrand, 'an unprofitable restock never creates a journey');
        const fieldAfter = await images([hunter.characterId]);
        assert.deepEqual(fieldAfter.map(row => row.items), fieldBefore.map(row => row.items));
        assert.deepEqual(fieldAfter.map(row => row.character), fieldBefore.map(row => row.character));
        console.log('PASS native cheaper-shot/NPC refill, changed-line fallback and unprofitable field-trip conservation');

        // The scan/candidate timer was retired by C2a/C2c. Eligibility remains
        // the native class/recipe rule; named worker plans perform the work.
        assert.equal(Shots.candidates, undefined);
        assert(Policy.eligible({ ...result, level: 78, stats: { ...result.stats, classId: 118 } }, now));
        assert(Policy.eligible({ ...result, level: 60, stats: { ...result.stats, classId: 57 } }, now));
        assert(!Policy.eligible({ ...result, party: { partyId: 9 } }, now));
        console.log('PASS native Maestro/Warsmith eligibility and no retired population scan');
    } finally {
        if (originals) {Afk.buyFromShop = originals.buy;Database.purchaseNpcInventoryItem = originals.npc;
            Database.purchaseNpcInventoryBasket = originals.basket;
            Database.crystallizeInventoryItem = originals.crystal;Database.craftInventoryItems = originals.craft;}
        await Database.close();fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => {console.error(error.stack);process.exitCode = 1;});

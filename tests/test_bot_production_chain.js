'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-chain-'));
const priorConfig = process.env.L2NODE_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'test.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Policy = invoke('GameServer/Bot/Economy/ProductionPolicy');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Buyers = invoke('GameServer/Bot/Economy/StaticBuyerService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const location = { locX: 83396, locY: 147904, locZ: -3400 };
const previous = { buyers: Config.staticBuyersDisabled, shots: Config.staticShotsDisabled };
let serial = 0;
async function seed(items, { crafter = false, nativePlayer = false, activity = 'shopping' } = {}) {
    const account = `${nativePlayer ? 'player' : 'bot'}_production_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Producer${serial}`, race: 4, classId: crafter ? 57 : 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 3000, ...location })).insertId);
    await Database.execute(['UPDATE characters SET level = 70, hp = 1000, mp = 3000 WHERE id = ?', [id]]);
    for (const item of items) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    if (nativePlayer) return { characterId: id };
    return Life.upsertState({ characterId: id, accountName: account, name: `Producer${serial}`, level: 70,
        phase: 'cold', activity, loc: location, currentRegion: 'Giran',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        adena: Number(items.find(item => item.selfId === 57)?.amount || 0),
        vitals: { hp: 1000, maxHp: 1000, mp: 3000, maxMp: 3000 },
        stats: { classId: crafter ? 57 : 0, generatedCold: true }, timing: {} }, 'production_seed');
}
const cash = amount => ({ selfId: 57, name: 'Adena', amount });
const ore = (selfId, amount) => ({ selfId, name: `Material ${selfId}`, amount });
const held = (items, id) => items.filter(item => Number(item.selfId) === id).reduce((n, item) => n + Number(item.amount), 0);
async function images(ids) {
    return Promise.all(ids.map(async id => ({ items: await Database.fetchItems(id),
        character: (await Database.execute(['SELECT * FROM characters WHERE id = ?', [id]]))[0],
        life: (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]))[0] })));
}
async function run() {
    Database.init(); assert(Database.isReady()); Data.init(); Workshop.init(); await Life.init(); await Afk.init();
    if (!process.argv.includes('--native') && !process.argv.includes('--chain') && !process.argv.includes('--workshop-current')) {
    Config.staticBuyersDisabled = false; Config.staticShotsDisabled = false;
    assert.equal(Policy.buyersDisabled(), false); assert.equal(Policy.shotsDisabled(), false);
    const playerDPrice = Pricing.cheapestPurchase(1463);
    assert(Number.isFinite(playerDPrice)); assert(Buyers.buyersInTown('Giran').length > 0);
    Config.staticBuyersDisabled = true; Config.staticShotsDisabled = true;
    assert.equal(Buyers.buyersInTown('Giran').length, 0);
    assert.equal(Policy.allowsFixedShot(1463), false);
    assert.equal(Pricing.botPurchasePrice(1463), Infinity);
    assert.equal(Pricing.cheapestPurchase(1463), playerDPrice, 'player authored price unchanged');
    assert(Opportunity.npcOffersAll(1835).length > 0); assert.equal(Opportunity.npcOffersAll(1463).length, 0);
    console.log('PASS two default-off switches, NG grocers, D+ no bot fallback and player pricing');

    const recipe = Recipes.resolveByRecipeId(1);
    assert.equal(Profit.margin(recipe, 10, 100, { hourAdena: null, mpPerHour: 3000 }), null);
    const margin = Profit.margin({ ...recipe, successRate: 60 }, 10, 100, { hourAdena: 10000, mpPerHour: 3000 });
    assert.equal(margin.expectedRevenue, recipe.productCount * 10 * 0.6);
    assert.equal(margin.labour, recipe.mpCost / 3000 * 10000);
    assert.equal(Profit.materials([ore(1458, 1)], { materials: [ore(1458, 1), ore(1458, 1)] }), null);
    assert.equal(Craft.hasMaterials({ inventory: {} }, { materials: [ore(1458, 1)] }), false);
    const empty = await Craft.supplementMaterials(999999, [], { materials: [ore(1458, 1)] });
    assert.deepEqual(empty, { items: [], supplemented: [] });
    console.log('PASS shared labour/success profit and every material required');
    }
    Config.staticBuyersDisabled = true; Config.staticShotsDisabled = true;
    const recipe = Recipes.resolveByRecipeId(1);

    let crafter = await seed([cash(1000000)], { crafter: true });
    await Database.setCharacterRecipe(crafter.characterId, 1, 'dwarven');
    await Database.setCharacterRecipe(crafter.characterId, 20, 'dwarven');
    await Database.setSkill({ selfId: 248, name: 'Crystallize', passive: false, level: 1 }, crafter.characterId);
    crafter = await Workshop.review(crafter);
    assert(Workshop.boardRecords().some(row => row.ownerId === crafter.characterId && row.entries.some(entry => entry.recipeId === 1)));
    assert.equal(Workshop.lookup(crafter.characterId, 1, { characterId: 800001, stats: {} }).entryPrice,
        invoke('GameServer/Bot/Economy/CraftShopService').productPrice(recipe));
    if (process.argv.includes('--workshop-current')) {
        const customer = await seed([cash(100000), ore(1864, 4), ore(1869, 2)]);
        await Workshop.craft(crafter.characterId, 1, customer.characterId);
        crafter = Life.cachedState(crafter.characterId);
        assert.equal(Workshop.lookup(crafter.characterId, 1, customer).state, crafter);
        const token = await invoke('GameServer/Bot/Population/ColdSimulationOwner').claim(crafter,
            { allowLifecycle: true }); assert(token.ok);
        assert.equal(Workshop.lookup(crafter.characterId, 1, customer), null);
        await invoke('GameServer/Bot/Population/ColdSimulationOwner').release(token);
        assert.equal(Workshop.lookup(crafter.characterId, 1, customer).state, Life.cachedState(crafter.characterId));
        console.log('PASS workshop actual receipt/current lease ownership refreshes canonical references');
        return;
    }
    if (!process.argv.includes('--chain')) {
    const customer = await seed([cash(100000), ore(1864, 4), ore(1869, 2)]);
    const quote = Workshop.quote(crafter, customer, 1);
    const before = await images([crafter.characterId, customer.characterId]);
    const crafted = await Workshop.craft(crafter.characterId, 1, customer.characterId, { expectedPrice: quote.price });
    assert(crafted.product);
    const after = await images([crafter.characterId, customer.characterId]);
    assert.equal(held(after[1].items, 17), 500);
    assert.equal(held(after[1].items, 1864), 0); assert.equal(held(after[1].items, 1869), 0);
    assert.equal(held(before[1].items, 57) - held(after[1].items, 57), quote.price);
    assert.equal(held(after[0].items, 57) - held(before[0].items, 57), quote.price);
    assert.equal(Number(after[0].character.mp), Number(before[0].character.mp) - recipe.mpCost);
    assert.equal(Life.cachedState(crafter.characterId).stats.production.customers, 1);
    console.log('PASS native workshop material/fee/MP transaction and producer status');

    const refused = await seed([cash(100000), ore(1864, 4)]);
    const unchanged = await images([crafter.characterId, refused.characterId]);
    await assert.rejects(Workshop.craft(crafter.characterId, 1, refused.characterId), /materials missing/);
    assert.deepEqual(await images([crafter.characterId, refused.characterId]), unchanged);
    const player = await seed([cash(100000), ore(1864, 4), ore(1869, 2)], { nativePlayer: true });
    const playerCraft = await Workshop.craft(crafter.characterId, 1, player.characterId);
    assert(playerCraft.product); assert.equal(held(await Database.fetchItems(player.characterId), 17), 500);
    assert.equal(Life.cachedState(player.characterId), null);
    assert(Workshop.discount({ characterId: 1, clanId: 20, stats: {} }, { clanId: 20 }, 100)
        >= Workshop.discount({ characterId: 1, clanId: 20, stats: {} }, { clanId: 20 }, -100));
    console.log('PASS missing-input conservation, genuine player customer and trait/relation clan discount');

    const late = await seed([cash(100000), ore(1864, 4), ore(1869, 2)]);
    crafter = Life.cachedState(crafter.characterId);
    const liveQuote = Workshop.quote(crafter, late, 1);
    const materialRows = Profit.materials(await Database.fetchItems(late.characterId), recipe);
    const conserved = await images([crafter.characterId, late.characterId]);
    await assert.rejects(Database.craftForCustomer(crafter.characterId, late.characterId, {
        materials: materialRows, product: { selfId: 17, amount: 500, stackable: true }, price: liveQuote.price,
        workshop: { recipeId: 1, batches: 1, entryPrice: liveQuote.entryPrice, fee: liveQuote.price,
            crafterRevision: crafter.simulation.revision - 1, customerRevision: late.simulation.revision }
    }), /ownership changed/);
    assert.deepEqual(await images([crafter.characterId, late.characterId]), conserved);
    console.log('PASS stale native workshop authority rejects before any debit');
    }

    const seller = await seed([cash(100000), { selfId: 45, name: 'Bone Helmet', amount: 1 }]);
    const gear = (await Database.fetchItems(seller.characterId)).find(item => item.selfId === 45);
    await Afk.openBotRecords(seller.characterId, 'sell_ad', [{ storeType: Afk.SELL, town: 'Giran', ...location,
        title: 'Real crystal source', lines: [{ objectId: gear.id, selfId: 45, name: gear.name, count: 1,
            price: 1000, enchant: 0, stackable: false, slot: gear.slot }] }]);
    const buyer = await seed([cash(1000000)]);
    await Afk.openBotRecords(buyer.characterId, 'buy_ad', [{ storeType: Afk.BUY, town: 'Giran', ...location,
        title: 'Funded shots', lines: [{ selfId: 1463, name: 'D Soulshot', count: 1000, price: 1000, enchant: 0, stackable: true, slot: 0 }] }]);
    crafter = Life.cachedState(crafter.characterId);
    const index = await Shots.marketSnapshot();
    const shotRecipe = Recipes.resolveByRecipeId(20);
    const candidate = Shots.craftCandidate(crafter, shotRecipe, index);
    if (!candidate) console.log('CHAIN INPUT', { signals: index.shotDemand.get(1463), gear: index.gear.get('d')?.slice(0, 2),
        hour: Profit.contextFor(crafter).hourAdena, mpPerHour: Profit.contextFor(crafter).mpPerHour, orePrice: index.npcPrice.get(1785) });
    assert(candidate, 'actual funded demand, real gear and NPC ore create a profitable native route');
    assert(candidate.gear, 'crystals are obtained from a real route');
    const craftedState = await Shots.craft(crafter, candidate, index, Date.now());
    const inventory = await Database.fetchItems(crafter.characterId);
    assert(held(inventory, 1463) >= shotRecipe.productCount);
    assert(held(inventory, 1458) > 0, 'real D gear leaves real spare crystals');
    assert.equal(held(inventory, 45), 0);
    assert.equal(held(inventory, 1785), 0, 'purchased native Soul Ore consumed');
    assert(craftedState.adena < crafter.adena, 'the real gear and ore are paid');
    assert(Shots.hasShotSurplus(craftedState));
    const listing = await invoke('GameServer/Bot/Economy/ColdMarketListingService').open(craftedState,
        { town: craftedState.currentRegion });
    const records = Afk.ownerRecords(crafter.characterId);
    const delivered = held(await Database.fetchItems(buyer.characterId), 1463);
    assert(listing.listed || delivered > 0 || records.some(record => record.lines.some(line => line.selfId === 1463)),
        `crafted surplus reaches its real board buyer or sell record: ${listing.reason}`);
    assert(delivered > 0 || records.some(record => record.lines.some(line => line.selfId === 1463)));
    console.log('PASS real gear purchase/crystallize/NPC ore/native D-shot craft/funded board sale');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Config.staticBuyersDisabled = previous.buyers; Config.staticShotsDisabled = previous.shots;
    await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (priorConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = priorConfig;
    console.log('CLEANUP', !fs.existsSync(directory));
});

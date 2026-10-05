const assert = require('assert');

require('../src/Global');

const previousRate = process.env.L2NODE_PROGRESSION_RATE;
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const Service = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const BotAfkMarketService = invoke('GameServer/Bot/Economy/BotAfkMarketService');

const original = {
    fetchCharacterRecipes: Database.fetchCharacterRecipes,
    fetchSkill: Database.fetchSkill,
    fetchItems: Database.fetchItems,
    purchaseNpcInventoryItem: Database.purchaseNpcInventoryItem,
    crystallizeInventoryItem: Database.crystallizeInventoryItem,
    craftInventoryItems: Database.craftInventoryItems,
    activeShops: AfkTrade.activeShops,
    offers: AfkTrade.offers,
    findOwnerProjection: AfkTrade.findOwnerProjection,
    buyFromShop: AfkTrade.buyFromShop,
    allStates: LifeState.allStates,
    snapshot: LifeState.snapshot,
    upsertState: LifeState.upsertState,
    refreshInventory: LifeState.refreshInventory,
    learnCraftableRecipes: LifeState.learnCraftableRecipes,
    applyMarketPurchase: LifeState.applyMarketPurchase,
    record: LifeEvents.record,
    reconcile: BotAfkMarketService.reconcile
};

// A record on the board in memory (its owner is mocked away).
function boardLine(id, ownerId, town, selfId, count, price) {
    AfkTrade.refreshRecord({ id, ownerId, ownerName: `Owner${ownerId}`, ownerAccount: `bot_${ownerId}`, kind: 'sell_ad',
        storeType: AfkTrade.SELL, status: 'active', town, title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0,
        appearance: {}, lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count, price, enchant: 0 }] });
}
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const GLUDIO = { locX: -12736, locY: 122816, locZ: -3112 };

(async () => {
    const now = Date.now();
    const rows = [
        { id: 1, selfId: 57, name: 'Adena', amount: 1000000, equipped: false },
        { id: 2, selfId: 1463, name: 'Soulshot: D-grade', amount: 1000, equipped: false },
        { id: 3, selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }
    ];
    const history = [];
    const gearShop = { ownerId: 200, storeType: AfkTrade.SELL,
        lines: [{ selfId: 45, count: 1, price: 22324 }] };
    const gearOffer = { sourceId: 200, price: 22324, count: 1,
        store: { afkTrade: true, storeType: AfkTrade.SELL } };
    Database.fetchCharacterRecipes = async () => [{ recipeId: 20, type: 'dwarven' }];
    Database.fetchSkill = async () => [{ level: 3 }];
    Database.fetchItems = async () => rows.map((row) => ({ ...row }));
    // Every purchase is made in its seller's town (group C): the crafter
    // stands in Giran, where the helmet is listed and the NPC sells Soul Ore
    // at 550, so it buys both there.
    LifeState.applyMarketPurchase = async (buyer, offer, qty) => {
        assert.strictEqual(offer.selfId, 1785);
        assert.strictEqual(qty, 21);
        assert.strictEqual(offer.price, 550);
        rows[0].amount -= qty * offer.price;
        rows.push({ id: 12, selfId: 1785, name: 'Soul Ore', amount: 21, equipped: false });
        history.push('ore');
        return { ...buyer, adena: rows[0].amount, inventory: { ...buyer.inventory,
            1785: { selfId: 1785, name: 'Soul Ore', amount: 21 } } };
    };
    boardLine(970001, 200, 'Giran', 45, 1, 22324);
    Database.crystallizeInventoryItem = async (_id, item) => {
        assert.strictEqual(item.sourceId, 10);
        assert.strictEqual(item.crystalId, 1458);
        rows.splice(rows.findIndex((row) => row.id === 10), 1);
        rows.push({ id: 11, selfId: 1458, name: 'Crystal: D-Grade', amount: 56, equipped: false });
        history.push('crystal');
    };
    Database.craftInventoryItems = async (_id, result) => {
        assert.deepStrictEqual(result.materials.map((row) => [row.selfId, row.amount]), [[1785, 21], [1458, 7]]);
        assert.strictEqual(result.product.selfId, 1463);
        assert.strictEqual(result.product.amount, 1092);
        rows.find((row) => row.selfId === 1458).amount -= 7;
        rows.splice(rows.findIndex((row) => row.selfId === 1785), 1);
        rows.find((row) => row.selfId === 1463).amount += 1092;
        history.push('craft');
    };
    AfkTrade.activeShops = () => [gearShop];
    AfkTrade.offers = (selfId, type) => selfId === 45 && type === AfkTrade.SELL
        ? [gearOffer] : [];
    AfkTrade.buyFromShop = async (_id, _store, selfId, count, options) => {
        assert.strictEqual(selfId, 45);
        assert.strictEqual(count, 1);
        rows[0].amount -= options.expectedPrice;
        rows.push({ id: 10, selfId: 45, name: 'Bone Helmet', amount: 1, equipped: false });
        history.push('gear');
        return { coldState: { ...options.coldState, adena: rows[0].amount,
            inventory: { ...options.coldState.inventory,
                45: { selfId: 45, amount: 1, name: 'Bone Helmet' } } } };
    };
    LifeState.allStates = () => [{ characterId: 300, adena: 1000000,
        stats: { shotDemand: { itemId: 1463, amount: 1000, maxSpend: 1000000, at: now } } }];
    LifeState.upsertState = async (state) => state;
    LifeState.refreshInventory = async (state) => {
        const inventory = { ...(state.inventory || {}) };
        for (const row of rows.filter((item) => item.amount > 0)) {
            const previous = inventory[String(row.selfId)] || {};
            inventory[String(row.selfId)] = { ...previous, ...row,
                amount: Math.max(Number(previous.amount || 0), Number(row.amount || 0)) };
        }
        return { ...state, adena: Math.max(Number(state.adena || 0), rows[0].amount), inventory };
    };
    LifeEvents.record = async () => null;

    const state = { characterId: 100, name: 'Dwarf', phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        loc: { ...GIRAN }, classId: 57, level: 60, adena: 1000000, vitals: { mp: 1000 },
        inventory: { '1463': { selfId: 1463, amount: 1000, name: 'Soulshot: D-grade' },
            '129': { selfId: 129, amount: 1, name: 'Sword of Revolution', equipped: true, slot: 7 } },
        stats: { classId: 57 } };
    const result = await Service.review(state, now);
    assert.deepStrictEqual(history, ['gear', 'crystal', 'ore', 'craft']);
    assert.strictEqual(result.state.stats.shotCraft.productId, 1463);
    assert.strictEqual(result.state.inventory['1463'].amount, 2092);
    assert.strictEqual(result.state.inventory['1458'].amount, 49);
    assert.strictEqual(result.state.inventory['45'].amount, 0,
        'crystallized gear must not remain in the virtual inventory');
    assert.strictEqual(result.state.inventory['1785'].amount, 0,
        'consumed ore must not remain in the virtual inventory');
    assert.strictEqual(result.state.adena, 966126);

    let recipeListed = false;
    Database.fetchCharacterRecipes = async () => [];
    AfkTrade.activeShops = () => [{ ownerId: 400, storeType: AfkTrade.SELL,
        lines: [{ selfId: 325, count: 1, price: 100000 }] }];
    AfkTrade.offers = (selfId) => selfId === 3033 && recipeListed
        ? [{ sourceId: 200, price: 480000, count: 1,
            store: { afkTrade: true, storeType: AfkTrade.SELL } }] : [];
    AfkTrade.buyFromShop = async (_id, _store, selfId, amount, options) => {
        assert.strictEqual(selfId, 3033);
        assert.strictEqual(amount, 1);
        return { coldState: { ...options.coldState, adena: options.coldState.adena - 480000,
            inventory: { ...options.coldState.inventory, '3033': { selfId: 3033, amount: 1 } } } };
    };
    BotAfkMarketService.reconcile = async (seller, goal) => {
        assert.strictEqual(seller.characterId, 200);
        assert.strictEqual(goal.type, 'sell_inventory');
        recipeListed = true;
        boardLine(970002, 200, 'Giran', 3033, 1, 480000);
        return { state: seller, changed: true };
    };
    LifeState.learnCraftableRecipes = async (buyer) => ({ ...buyer, inventory: {
        ...buyer.inventory, '3033': undefined
    }, stats: { ...buyer.stats,
        lastRecipeBookLearning: { learned: [{ recipeId: 318 }] } }, learnedShotRecipe: true });
    const recipeHolder = { characterId: 200, name: 'RecipeHolder', level: 50,
        phase: 'cold', activity: 'hunting', stats: {}, inventory: {
            '3033': { selfId: 3033, amount: 1, name: 'Recipe: Spiritshot C' }
        } };
    LifeState.snapshot = (id) => id === 200 ? recipeHolder : null;
    LifeState.allStates = () => [recipeHolder, { characterId: 300, adena: 1000000,
        stats: { shotDemand: { itemId: 2511, amount: 1000, maxSpend: 1000000, at: now + 31000 } } }];
    const recipeBuyer = { ...state, characterId: 101, adena: 20000000,
        inventory: { '1463': { selfId: 1463, amount: 1000 },
            '129': { selfId: 129, amount: 1, equipped: true, slot: 7 } } };
    const recipeResult = await Service.review(recipeBuyer, now + 31000);
    assert(recipeListed, 'a funded recipe request should prompt its holder to open a remote shop');
    assert.strictEqual(recipeResult.state.learnedShotRecipe, true,
        'the buyer should purchase and learn the recipe from that shop');
    assert.strictEqual(recipeResult.state.stats.shotRecipeDemand, null,
        'a learned recipe must stop advertising further demand');

    // Missing recipes create a request, never a fabricated NPC purchase.
    AfkTrade.activeShops = () => [];
    AfkTrade.offers = () => [];
    LifeState.upsertState = async state => state;
    LifeState.refreshInventory = original.refreshInventory;
    Database.purchaseNpcInventoryItem = async () => { throw new Error('recipes must not be manufactured by procurement'); };
    const procurementAt = now + 70000;
    const ordinaryCrafter = { ...state, characterId: 410 };
    const newRecipeCrafter = { ...state, characterId: 411, stats: {
        ...state.stats, lastRecipeBookLearning: {
            at: procurementAt, learned: [{ recipeId: 317, recipeItemId: 3032 }]
        }
    } };
    LifeState.allStates = () => [ordinaryCrafter, newRecipeCrafter];
    assert.strictEqual((await Service.candidates(2, procurementAt + 1000))[0]?.characterId, 411,
        'a crafter who just bought a shot recipe should be reviewed before routine scans');
    // A crafter class is reviewed before other classes; a Maestro is one, so input order decides.
    const maestro = { ...state, characterId: 420, classId: 118, level: 78, inventory: {}, stats: { classId: 118 } };
    const warsmith = { ...state, characterId: 421, inventory: {}, stats: { classId: 57 } };
    LifeState.allStates = () => [maestro, warsmith];
    assert.deepStrictEqual((await Service.candidates(2, procurementAt + 1000)).map((entry) => entry.characterId), [420, 421],
        'a Maestro has the priority of a Warsmith');

    // A cold bot below 1000 shots restocks by the rule hot bots use (ShotStock.restockPlan,
    // S3): the shop cheaper than the NPC first, the NPC for the rest, keeping its reserve
    // max(500, 30 x 250, 10%) = 7,500 of 51,000 and the cost of its potion restock
    // (survival first): 8 Healing Potions at 660 = 5,280. D shots cost 100 at the NPC at x10.
    // It restocks in one trip to the town where the whole amount costs the
    // least with the trip (group C, user Q1 A): standing in Gludio, where a
    // line sells 300 at 60 and the merchant sells the rest at 100, it buys there.
    const fighter = { characterId: 430, name: 'Fighter', phase: 'cold', activity: 'shopping', currentRegion: 'Gludio',
        loc: { ...GLUDIO }, level: 30, adena: 51000,
        inventory: { '1463': { selfId: 1463, amount: 200 }, '129': { selfId: 129, amount: 1, equipped: true, slot: 7 } },
        stats: { classId: 0 } };
    const coldBuys = [];
    boardLine(970003, 500, 'Gludio', 1463, 300, 60);
    AfkTrade.buyFromShop = async (_id, _store, selfId, amount, options) => {
        coldBuys.push(['shop', amount, options.expectedPrice]);
        const before = options.coldState;
        return { coldState: { ...before, adena: before.adena - amount * options.expectedPrice, inventory: { ...before.inventory,
            '1463': { selfId, amount: before.inventory['1463'].amount + amount } } } };
    };
    LifeState.applyMarketPurchase = async (buyer, offer, qty) => {
        coldBuys.push(['npc', qty, offer.price]);
        return { ...buyer, adena: buyer.adena - qty * offer.price, inventory: { ...buyer.inventory,
            '1463': { selfId: 1463, amount: Number(buyer.inventory['1463']?.amount || 0) + qty } } };
    };
    LifeState.refreshInventory = async (refreshed) => refreshed;
    const restocked = (await Service.review(fighter, procurementAt + 2000)).state;
    assert.deepStrictEqual(coldBuys, [['shop', 300, 60], ['npc', 202, 100]],
        'a cold bot below 1000 shots buys from the cheaper line, then the merchant, in its town');
    assert.strictEqual(restocked.adena, 12800, 'the cold restock keeps the consumables reserve and the potions money');
    assert.strictEqual(restocked.stats.shotDemand, null);
    // A shop line that fails at purchase leaves its shots and money to the NPC (E31):
    // 51,000 - 7,500 - 5,280 = 38,220 to spend, 382 D shots at 100.
    coldBuys.length = 0;
    AfkTrade.buyFromShop = async () => { throw new Error('afk_trade_stock_changed'); };
    const afterFailedShop = (await Service.review({ ...fighter, characterId: 431 }, procurementAt + 3000)).state;
    assert.deepStrictEqual(coldBuys, [['npc', 382, 100]], 'a cold bot whose shop failed buys its restock from the NPC');
    assert.strictEqual(afterFailedShop.adena, 51000 - 38200);
    // Out on its spot, it does not buy from afar: it keeps an errand and goes.
    coldBuys.length = 0;
    const hunter = { ...fighter, characterId: 432, activity: 'hunting', currentRegion: 'Gludio',
        loc: { locX: -14000, locY: 130000, locZ: -3000 } };
    const errand = (await Service.review(hunter, procurementAt + 4000)).state;
    assert.deepStrictEqual(coldBuys, [], 'nothing is bought from afar');
    assert.strictEqual(errand.activity, 'traveling', 'it travels to buy');
    assert.strictEqual(errand.stats.marketErrand.purpose, 'shots');
    assert.strictEqual(errand.stats.travel.townName, errand.stats.marketErrand.town);
    assert(['Gludio', 'Gludin', 'Dion'].includes(errand.stats.marketErrand.town), errand.stats.marketErrand.town);
    AfkTrade._resetForTests();
    console.log('Cold shot economy buys scrap, crystallizes and crafts a demanded batch');
})().finally(() => {
    for (const [key, value] of Object.entries(original)) {
        if (Object.hasOwn(Database, key)) Database[key] = value;
        else if (Object.hasOwn(AfkTrade, key)) AfkTrade[key] = value;
        else if (Object.hasOwn(LifeState, key)) LifeState[key] = value;
        else if (Object.hasOwn(BotAfkMarketService, key)) BotAfkMarketService[key] = value;
        else LifeEvents[key] = value;
    }
    if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = previousRate;
});

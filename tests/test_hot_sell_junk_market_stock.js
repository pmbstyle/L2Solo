const assert = require('assert');
const world = require('./fixtures/native_stock_world')();

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Database = invoke('Database');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ServerResponse = invoke('GameServer/Network/Response');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

// A bot's "Sell Unequipped Junk" sells what the cold town visit sells to the
// NPC (one rule for hot and cold bots, MarketListingPolicy.npcSaleForActor):
// it keeps what its class uses (a D-grade dwarven recipe for the market,
// materials for the warehouse, an enchant scroll, its healing stock
// up to the restock target), keeps grade crystals for the market and sells consumables no bot
// uses (arrows, escape scrolls, keys, antidotes) and the potion surplus. A crafter learns a
// recipe it can learn before the sale. A player's junk sale is unchanged.
const D_RECIPE = 3032;
const CRYSTAL_D = 1458;
const ANIMAL_BONE = 1872;
const HEALING_POTION = 1061;
const WOODEN_ARROW = 17;
const ESCAPE_SCROLL = 736;
const THIEF_KEY = 1661;
const ANTIDOTE = 1831;
const ENCHANT_ARMOR_D = 956;
assert(ItemDisposition.isMarketRecipeItem({ selfId: D_RECIPE }), 'the fixture must be a market recipe');
// A no-grade material recipe an Artisan learns. Since b6eac2ed a no-grade
// dwarven recipe is a market item like any other (no NPC-only grade rule).
const ARTISAN = { classId: 56, level: 45 };
const MATERIAL_RECIPE = Number(DataCache.items.find((entry) => String(ItemDisposition.recipeInfo({ selfId: entry.selfId })
    ?.product?.template?.kind || '').startsWith('Other.Material')
    && ItemDisposition.canLearnRecipe(ARTISAN, { selfId: entry.selfId }))?.selfId);
assert(MATERIAL_RECIPE > 0, 'the fixture needs a material recipe an Artisan learns');

function item(id, selfId, amount) {
    const template = DataCache.items.find((entry) => Number(entry.selfId) === selfId);
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        setAmount: (value) => { amount = value; },
        fetchPrice: () => Number(template.template.price),
        fetchName: () => `Item ${selfId}`,
        fetchKind: () => template?.template?.kind || '',
        fetchStackable: () => true,
        fetchEquipped: () => false,
        fetchClass2: () => 0
    };
}

const actor = (backpack, crafter = { classId: 0, level: 30 }) => ({ fetchId: () => 77, fetchLevel: () => crafter.level,
    fetchClassId: () => crafter.classId, fetchName: () => 'HotBot', backpack });

// Since 71143511 a hot crafter learns only the recipe its accepted economy
// decision crafts, through one committed learn transaction.
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const EconomyCommit = invoke('GameServer/Bot/Economy/EconomyCommit');
let learnedRows = null;

const ratesFor = (level, classId) => require('./helpers/ratedKit')({ level, spotId: '-10_30', stats: { classId } }).stats;
async function sellJunk(accountId, crafter, knownRecipeIds = []) {
    const adena = { ...item(1, 57, 0) };
    const learned = [];
    learnedRows = learned;
    // The kit rates the bot's build publishes (stats.kitRates), read by its sale.
    const { kitRates, earning } = ratesFor(crafter?.level || 30, crafter?.classId || 0);
    const potionTarget = HealingPotionStock.targetAmountFor({ level: crafter?.level || 30,
        spotId: '-10_30', stats: { classId: crafter?.classId || 0, kitRates, earning } });
    const backpack = {
        items: [item(2, D_RECIPE, 1), item(3, CRYSTAL_D, 40), item(4, ANIMAL_BONE, 5),
            item(5, HEALING_POTION, potionTarget + 20), item(6, MATERIAL_RECIPE, 1), item(7, WOODEN_ARROW, 500),
            item(8, ESCAPE_SCROLL, 11), item(9, THIEF_KEY, 2), item(10, ANTIDOTE, 4), item(11, ENCHANT_ARMOR_D, 1), adena],
        stackableExists: () => Promise.resolve(adena),
        hasRecipe: (_actor, recipeId) => knownRecipeIds.includes(Number(recipeId)) || learned.includes(Number(recipeId)),
        fetchDwarvenCraftLevel: () => (crafter?.classId === ARTISAN.classId ? 4 : 0),
        registerRecipe: (_actor, recipe) => learned.push(Number(recipe.recipeId)),
        deleteItem(_session, objectId, amount, done) {
            this.items = this.items.filter((entry) => entry.fetchId() !== objectId);
            done();
        },
        fetchItems() { return this.items; }
    };
    // Prepare the same physical seller and native route used by the hot sale.
    const session = { accountId, actor: actor(backpack, crafter), currentSpot: { id: '-10_30' },
        coldLifeState: { characterId: 77, phase: 'hot', spotId: '-10_30', activity: 'shopping',
            currentRegion: 'Giran', loc: world.town(), stats: { kitRates, earning } }, dataSendToMe() {} };
    world.economyFor(MarketListingPolicy.actorState(session));
    await SellJunk(session, ['sell-junk']);
    await new Promise((resolve) => setImmediate(resolve));
    return { left: backpack.items.map((entry) => [entry.fetchSelfId(), entry.fetchAmount()]), actor: session.actor, learned, potionTarget };
}

const originals = {
    deleteItem: Database.deleteItem,
    updateItemAmount: Database.updateItemAmount,
    itemsList: ServerResponse.itemsList,
    userInfo: ServerResponse.userInfo,
    speak: ServerResponse.speak,
    now: Date.now,
    learnColdRecipes: Database.learnColdRecipes,
    decided: Coordinator.economyDecisions.decided,
    admit: EconomyCommit.admit
};

async function run() {
    // A world with a market (group E): materials and D recipes trade on the
    // board, so the bot keeps them for it; with no buyer of its kind at all
    // an item's best outcome would be the NPC.
    // One decision point for each sale: the clock stands still in this test.
    const frozen = 1800000000000;
    Date.now = () => frozen;
    Database.init();
    assert(Database.isReady());
    world.usePotionSpot();
    await world.buyer([[D_RECIPE, 1], [ANIMAL_BONE, 5], [ENCHANT_ARMOR_D, 1], [MATERIAL_RECIPE, 1]], 77);
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = () => Promise.resolve();
    const materialRecipeId = Number(ItemDisposition.recipeInfo({ selfId: MATERIAL_RECIPE }).recipe.recipeId);
    Coordinator.economyDecisions.decided = () => ({ activity: { activity: 'crafting', recipeId: materialRecipeId } });
    EconomyCommit.admit = async () => ({ command: 'test-learn' });
    Database.learnColdRecipes = async (_id, recipes) => {
        learnedRows.push(...recipes.map((recipe) => Number(recipe.recipeId)));
        return { learned: recipes };
    };
    ServerResponse.itemsList = ServerResponse.userInfo = ServerResponse.speak = () => Buffer.alloc(0);

    const botSale = await sellJunk('bot_hot_hunter');
    const keep = HealingPotionStock.targetAmountFor({ level: 30, spotId: '-10_30', stats: { classId: 0, ...ratesFor(30, 0) } });
    // Sell an actual target+20 stack under the native town-visit horizon.
    assert(keep > 0 && botSale.potionTarget === keep, `the native potion stock must match the real sale: ${keep}`);
    assert.deepStrictEqual(botSale.left.filter(([selfId]) => selfId !== 57),
        // Every Scroll of Escape a bot holds saves a walk to town and is kept
        // (situations.md B2). A no-grade recipe is a market item since b6eac2ed.
        [[D_RECIPE, 1], [CRYSTAL_D, 40], [ANIMAL_BONE, 5], [HEALING_POTION, keep], [MATERIAL_RECIPE, 1],
            [ESCAPE_SCROLL, 11], [ENCHANT_ARMOR_D, 1]],
        'a hot bot keeps what its class uses and sells what no bot uses, as when cold');

    const crafterSale = await sellJunk('bot_hot_crafter', ARTISAN);
    const recipeId = Number(ItemDisposition.recipeInfo({ selfId: MATERIAL_RECIPE }).recipe.recipeId);
    assert(crafterSale.learned.includes(recipeId), 'a hot crafter learns the material recipe before the sale');
    assert(!crafterSale.left.some(([selfId]) => selfId === MATERIAL_RECIPE), 'the learned recipe is not sold');
    const knowingSale = await sellJunk('bot_hot_crafter', ARTISAN, [recipeId]);
    // b6eac2ed: a known no-grade recipe is a market item for other crafters,
    // no longer NPC junk (test_bot_recipe_disposition 'recipe_already_known').
    assert(knowingSale.left.some(([selfId]) => selfId === MATERIAL_RECIPE),
        'a spare copy of a recipe the crafter already knows stays for the market, as when cold');

    const playerSale = await sellJunk('player_account');
    assert.deepStrictEqual(playerSale.left.map(([selfId]) => selfId), [57],
        'a player\'s junk sale still sells every unequipped item');
}

run().then(() => console.log('Hot sell-junk market stock checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(async () => {
        Object.assign(Database, { deleteItem: originals.deleteItem, updateItemAmount: originals.updateItemAmount,
            learnColdRecipes: originals.learnColdRecipes });
        Coordinator.economyDecisions.decided = originals.decided;
        EconomyCommit.admit = originals.admit;
        Object.assign(ServerResponse, { itemsList: originals.itemsList, userInfo: originals.userInfo, speak: originals.speak });
        Date.now = originals.now;
        await world.close();
    });

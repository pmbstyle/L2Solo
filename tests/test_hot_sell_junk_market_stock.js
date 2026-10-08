const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Database = invoke('Database');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ServerResponse = invoke('GameServer/Network/Response');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');

// A bot's "Sell Unequipped Junk" sells what the cold town visit sells to the
// NPC (one rule for hot and cold bots, MarketListingPolicy.npcSaleForActor):
// it keeps what its class uses (a D-grade dwarven recipe for the market,
// crystals, materials for the warehouse, an enchant scroll, its healing stock
// up to the restock target) and sells the consumables no bot uses (arrows,
// escape scrolls, keys, antidotes) and the potion surplus. A crafter learns a
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
// A no-grade material recipe: junk for a fighter, learnable for an Artisan.
const ARTISAN = { classId: 56, level: 45 };
const MATERIAL_RECIPE = Number(DataCache.items.find((entry) => !ItemDisposition.isMarketRecipeItem({ selfId: entry.selfId })
    && ItemDisposition.canLearnRecipe(ARTISAN, { selfId: entry.selfId }))?.selfId);
assert(MATERIAL_RECIPE > 0, 'the fixture needs a material recipe an Artisan learns');

function item(id, selfId, amount) {
    const template = DataCache.items.find((entry) => Number(entry.selfId) === selfId);
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        setAmount: (value) => { amount = value; },
        fetchPrice: () => 100,
        fetchName: () => `Item ${selfId}`,
        fetchKind: () => template?.template?.kind || '',
        fetchStackable: () => true,
        fetchEquipped: () => false,
        fetchClass2: () => 0
    };
}

const actor = (backpack, crafter = { classId: 0, level: 30 }) => ({ fetchId: () => 77, fetchLevel: () => crafter.level,
    fetchClassId: () => crafter.classId, fetchName: () => 'HotBot', backpack });

async function sellJunk(accountId, crafter, knownRecipeIds = []) {
    const adena = { ...item(1, 57, 0) };
    const learned = [];
    const potionTarget = HealingPotionStock.targetAmountFor({ level: crafter?.level || 30,
        spotId: '-10_30', stats: { classId: crafter?.classId || 0 } });
    const backpack = {
        items: [item(2, D_RECIPE, 1), item(3, CRYSTAL_D, 40), item(4, ANIMAL_BONE, 5),
            item(5, HEALING_POTION, potionTarget + 20), item(6, MATERIAL_RECIPE, 1), item(7, WOODEN_ARROW, 500),
            item(8, ESCAPE_SCROLL, 3), item(9, THIEF_KEY, 2), item(10, ANTIDOTE, 4), item(11, ENCHANT_ARMOR_D, 1), adena],
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
    // ARCH-NOTE: pin a native potion-consuming spot, since the best-income fallback has zero potion use.
    const session = { accountId, actor: actor(backpack, crafter), currentSpot: { id: '-10_30' }, coldLifeState: { phase: 'hot', spotId: '-10_30', stats: {} }, dataSendToMe() {} };
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
    now: Date.now
};

async function run() {
    // A world with a market (group E): materials and D recipes trade on the
    // board, so the bot keeps them for it; with no buyer of its kind at all
    // an item's best outcome would be the NPC.
    // One decision point for each sale: the clock stands still in this test.
    const frozen = 1800000000000;
    Date.now = () => frozen;
    const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
    MarketCounters.reset();
    for (let deal = 0; deal < 40; deal++) {
        const at = Date.now() - (40 - deal) * 60000;
        MarketCounters.deal(ANIMAL_BONE, 2000, 5, at, 1);
        MarketCounters.deal(D_RECIPE, 60000, 1, at, 1);
        MarketCounters.deal(ENCHANT_ARMOR_D, 150000, 1, at, 1);
    }
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = () => Promise.resolve();
    ServerResponse.itemsList = ServerResponse.userInfo = ServerResponse.speak = () => Buffer.alloc(0);

    const botSale = await sellJunk('bot_hot_hunter');
    const keep = HealingPotionStock.targetAmountFor({ level: 30, spotId: '-10_30', stats: { classId: 0 } });
    // ARCH-NOTE: E9 no-history T=24h at this native spot gives 82 potions,
    // so sell an actual target+20 stack instead of assuming target<30.
    assert(keep > 0 && botSale.potionTarget === keep, `the native potion stock must match the real sale: ${keep}`);
    assert.deepStrictEqual(botSale.left.filter(([selfId]) => selfId !== 57),
        // Step 3.2 (H12 narrowed): the Scrolls of Escape a bot reads for town
        // trips are kept up to their restock target; the surplus is sold.
        [[D_RECIPE, 1], [CRYSTAL_D, 40], [ANIMAL_BONE, 5], [HEALING_POTION, keep], [ESCAPE_SCROLL, 2], [ENCHANT_ARMOR_D, 1]],
        'a hot bot keeps what its class uses and sells what no bot uses, as when cold');

    const crafterSale = await sellJunk('bot_hot_crafter', ARTISAN);
    const recipeId = Number(ItemDisposition.recipeInfo({ selfId: MATERIAL_RECIPE }).recipe.recipeId);
    assert(crafterSale.learned.includes(recipeId), 'a hot crafter learns the material recipe before the sale');
    assert(!crafterSale.left.some(([selfId]) => selfId === MATERIAL_RECIPE), 'the learned recipe is not sold');
    const knowingSale = await sellJunk('bot_hot_crafter', ARTISAN, [recipeId]);
    assert(!knowingSale.left.some(([selfId]) => selfId === MATERIAL_RECIPE),
        'a spare copy of a recipe the crafter already knows is junk, as when cold');

    const playerSale = await sellJunk('player_account');
    assert.deepStrictEqual(playerSale.left.map(([selfId]) => selfId), [57],
        'a player\'s junk sale still sells every unequipped item');
}

run().then(() => console.log('Hot sell-junk market stock checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        Object.assign(Database, { deleteItem: originals.deleteItem, updateItemAmount: originals.updateItemAmount });
        Object.assign(ServerResponse, { itemsList: originals.itemsList, userInfo: originals.userInfo, speak: originals.speak });
        Date.now = originals.now;
    });

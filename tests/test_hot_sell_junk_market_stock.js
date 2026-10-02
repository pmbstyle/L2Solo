const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Database = invoke('Database');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ServerResponse = invoke('GameServer/Network/Response');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');

// A bot's "Sell Unequipped Junk" keeps what the cold disposition never dumps
// at the NPC for crafters (a D-grade dwarven recipe, crystals) and the
// healing potions its restock would buy back; it sells the surplus. A
// player's junk sale is unchanged.
const D_RECIPE = 3032;
const CRYSTAL_D = 1458;
const ANIMAL_BONE = 1872;
const HEALING_POTION = 1061;
assert(ItemDisposition.isMarketRecipeItem({ selfId: D_RECIPE }), 'the fixture must be a market recipe');
// A no-grade material recipe: junk for a fighter, learnable for an Artisan.
const ARTISAN = { classId: 56, level: 45 };
const MATERIAL_RECIPE = Number(DataCache.items.find((entry) => !ItemDisposition.isMarketRecipeItem({ selfId: entry.selfId })
    && ItemDisposition.canLearnRecipe(ARTISAN, { selfId: entry.selfId }))?.selfId);
assert(MATERIAL_RECIPE > 0, 'the fixture needs a material recipe an Artisan learns');

function item(id, selfId, amount) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        setAmount: (value) => { amount = value; },
        fetchPrice: () => 100,
        fetchName: () => `Item ${selfId}`,
        fetchEquipped: () => false,
        fetchClass2: () => 0
    };
}

const actor = (backpack, crafter = { classId: 0, level: 30 }) => ({ fetchId: () => 77, fetchLevel: () => crafter.level,
    fetchClassId: () => crafter.classId, backpack });

async function sellJunk(accountId, crafter) {
    const adena = { ...item(1, 57, 0) };
    const backpack = {
        items: [item(2, D_RECIPE, 1), item(3, CRYSTAL_D, 40), item(4, ANIMAL_BONE, 5),
            item(5, HEALING_POTION, 30), item(6, MATERIAL_RECIPE, 1), adena],
        stackableExists: () => Promise.resolve(adena),
        fetchItems() { return this.items; }
    };
    const session = { accountId, actor: actor(backpack, crafter), dataSendToMe() {} };
    SellJunk(session, ['sell-junk']);
    await new Promise((resolve) => setImmediate(resolve));
    return { left: backpack.items.map((entry) => [entry.fetchSelfId(), entry.fetchAmount()]), actor: session.actor };
}

const originals = {
    deleteItem: Database.deleteItem,
    updateItemAmount: Database.updateItemAmount,
    itemsList: ServerResponse.itemsList,
    userInfo: ServerResponse.userInfo,
    speak: ServerResponse.speak
};

async function run() {
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = () => Promise.resolve();
    ServerResponse.itemsList = ServerResponse.userInfo = ServerResponse.speak = () => Buffer.alloc(0);

    const botSale = await sellJunk('bot_hot_hunter');
    const keep = HealingPotionStock.targetAmountFor(botSale.actor);
    assert.strictEqual(HealingPotionStock.purchasePotionFor(botSale.actor).selfId, HEALING_POTION);
    assert(keep > 0 && keep < 30, `the potion stock must be part of the stack: ${keep}`);
    assert.deepStrictEqual(botSale.left.filter(([selfId]) => selfId !== 57),
        [[D_RECIPE, 1], [CRYSTAL_D, 40], [HEALING_POTION, keep]],
        'a hot bot keeps its D-grade recipe, crystals and potion stock, and sells the rest');

    const crafterSale = await sellJunk('bot_hot_crafter', ARTISAN);
    assert(crafterSale.left.some(([selfId]) => selfId === MATERIAL_RECIPE),
        'a hot crafter keeps the material recipe it learns when cold');

    const playerSale = await sellJunk('player_account');
    assert.deepStrictEqual(playerSale.left.map(([selfId]) => selfId), [57],
        'a player\'s junk sale still sells every unequipped item');
}

run().then(() => console.log('Hot sell-junk market stock checks passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        Object.assign(Database, { deleteItem: originals.deleteItem, updateItemAmount: originals.updateItemAmount });
        Object.assign(ServerResponse, { itemsList: originals.itemsList, userInfo: originals.userInfo, speak: originals.speak });
    });

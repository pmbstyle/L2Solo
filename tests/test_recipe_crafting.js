const assert = require('assert');

require('../src/Global');

const RecipeCrafting = invoke('GameServer/Crafting/RecipeCrafting');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const recipeItemMakeInfo = invoke('GameServer/Network/Request/RecipeItemMakeInfo');
const recipeItemMakeSelf = invoke('GameServer/Network/Request/RecipeItemMakeSelf');

function item(id, selfId, amount, equipped = false) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        fetchEquipped: () => equipped,
        setAmount: (value) => { amount = value; }
    };
}

function session(options = {}) {
    const recipeId = options.recipeId ?? 1;
    const items = options.items || [item(10, 1864, 4), item(11, 1869, 2)];
    const deleted = [];
    const packets = [];
    let mp = options.mp ?? 50;
    const actor = {
        fetchId: () => 99,
        isDead: () => false,
        fetchPrivateStoreType: () => 0,
        fetchMp: () => mp,
        fetchMaxMp: () => 100,
        setMp: (value) => { mp = value; },
        statusUpdateVitals: () => {},
        backpack: {
            items,
            fetchDwarvenCraftLevel: () => options.craftLevel ?? 1,
            fetchCommonCraftLevel: () => 1,
            fetchRecipeBook: (_actor, type) => type === 'dwarven' && options.learned !== false ? [{ recipeId }] : [],
            hasRecipe: (_actor, knownRecipeId) => options.learned !== false && Number(knownRecipeId) === recipeId,
            fetchItems() { return this.items; },
            deleteItem: (_session, id, amount) => {
                const target = actor.backpack.items.find((candidate) => candidate.fetchId() === id);
                assert(target, 'Craft may consume only an existing material stack');
                assert(target.fetchAmount() >= amount, 'Craft may never over-consume a material stack');
                target.setAmount(target.fetchAmount() - amount);
                deleted.push({ id, amount });
            }
        }
    };
    return { actor, items, deleted, packets, fetchMp: () => mp, dataSendToMe: (packet) => packets.push(packet) };
}

DataCache.items = [
    { selfId: 17, template: { name: 'Wooden Arrow' }, etc: { stackable: true } },
    { selfId: 3846, template: { name: 'Craft Test Product' }, etc: { stackable: false } }
];

const originalCraftInventoryItems = Database.craftInventoryItems;
const persisted = [];
Database.craftInventoryItems = (_characterId, exchange) => {
    persisted.push(exchange);
    return Promise.resolve({
        sources: exchange.materials.map((material) => ({ id: material.id, amount: 0 })),
        product: exchange.product ? { id: 1000 + exchange.product.selfId, amount: exchange.product.amount } : null
    });
};

async function run() {
    const successful = session();
    assert.strictEqual(await RecipeCrafting.craftSelf(successful, 1, () => 0), true, 'Known recipe with all materials must craft');
    assert.deepStrictEqual(successful.deleted, [], 'Craft may not mutate inventory before the durable exchange commits');
    assert.strictEqual(successful.fetchMp(), 20, 'Successful craft must consume the recipe MP');
    assert.strictEqual(successful.actor.backpack.items.find((entry) => entry.fetchId() === 1017)?.fetchAmount(), 500, 'Successful craft must award the sourced product and count');
    assert.strictEqual(persisted.at(-1).product.selfId, 17, 'Successful craft must persist its product in the same exchange');
    assert.strictEqual(successful.packets.at(-1)[0], 0xd7, 'Craft must end with C4 RecipeItemMakeInfo');
    assert.strictEqual(successful.packets.at(-1).readInt32LE(17), 1, 'Successful craft result must report status 1');

    const failedRoll = session({ recipeId: 322, craftLevel: 2, mp: 100, items: [item(12, 3845, 1)] });
    assert.strictEqual(await RecipeCrafting.craftSelf(failedRoll, 322, () => 0.999), false, 'A failed chance roll must not create an item');
    assert.strictEqual(failedRoll.fetchMp(), 0, 'Failed craft still consumes MP');
    assert.strictEqual(failedRoll.actor.backpack.items.length, 0, 'Failed craft still consumes its persisted materials');
    assert.strictEqual(failedRoll.actor.backpack.items.some((entry) => entry.fetchId() === 4846), false, 'Failed craft must not create the product');
    assert.strictEqual(failedRoll.packets.at(-1).readInt32LE(17), 0, 'Failed craft result must report status 0');

    const missingMaterial = session({ items: [item(10, 1864, 3), item(11, 1869, 2)] });
    assert.strictEqual(await RecipeCrafting.craftSelf(missingMaterial, 1, () => 0), false, 'Craft without every material must be rejected');
    assert.strictEqual(missingMaterial.deleted.length, 0, 'Rejected craft must not partially consume materials');
    assert.strictEqual(missingMaterial.fetchMp(), 50, 'Rejected craft must not consume MP');

    const unknownRecipe = session({ learned: false });
    assert.strictEqual(await RecipeCrafting.craftSelf(unknownRecipe, 1, () => 0), false, 'Unlearned recipes must be rejected');
    assert.strictEqual(unknownRecipe.deleted.length, 0, 'Unlearned recipe must not change inventory');

    const rejectedCommit = session();
    Database.craftInventoryItems = () => Promise.reject(new Error('database unavailable'));
    assert.strictEqual(await RecipeCrafting.craftSelf(rejectedCommit, 1, () => 0), false, 'A failed durable exchange must reject the craft');
    assert.strictEqual(rejectedCommit.fetchMp(), 50, 'A failed durable exchange must not consume MP in memory');
    assert.strictEqual(rejectedCommit.actor.backpack.items.length, 2, 'A failed durable exchange must not consume materials in memory');
    Database.craftInventoryItems = (_characterId, exchange) => {
        persisted.push(exchange);
        return Promise.resolve({
            sources: exchange.materials.map((material) => ({ id: material.id, amount: 0 })),
            product: exchange.product ? { id: 1000 + exchange.product.selfId, amount: exchange.product.amount } : null
        });
    };

    const packetSession = session();
    const packet = Buffer.alloc(5);
    packet[0] = 0xaf;
    packet.writeInt32LE(1, 1);
    await recipeItemMakeSelf(packetSession, packet);
    assert.strictEqual(packetSession.packets.at(-1)[0], 0xd7, 'Opcode 0xAF must dispatch self-crafting');

    const infoSession = session();
    const infoPacket = Buffer.alloc(5);
    infoPacket[0] = 0xae;
    infoPacket.writeInt32LE(1, 1);
    recipeItemMakeInfo(infoSession, infoPacket);
    assert.strictEqual(infoSession.packets.at(-1)[0], 0xd7, 'Opcode 0xAE must open the native recipe make-info dialog');
    assert.strictEqual(infoSession.packets.at(-1).readInt32LE(17), -1, 'Recipe make-info must use the native pending status');

    console.log('Recipe crafting checks passed');
}

run().finally(() => {
    Database.craftInventoryItems = originalCraftInventoryItems;
}).catch((error) => {
    process.exitCode = 1;
    throw error;
});

process.on('exit', () => {
    if (Database.craftInventoryItems !== originalCraftInventoryItems) {
        Database.craftInventoryItems = originalCraftInventoryItems;
    }
});

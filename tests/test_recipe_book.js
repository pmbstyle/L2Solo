const assert = require('assert');

require('../src/Global');

const recipeBookOpen = invoke('GameServer/Network/Request/RecipeBookOpen');

function request(dwarven) {
    const buffer = Buffer.alloc(5);
    buffer[0] = 0xac;
    buffer.writeInt32LE(dwarven ? 0 : 1, 1);
    return buffer;
}

function session() {
    const packets = [];
    const actor = {
        fetchPrivateStoreType: () => 0,
        fetchMaxMp: () => 432,
        backpack: {
            fetchDwarvenCraftLevel: () => 1,
            fetchCommonCraftLevel: () => 2,
            fetchRecipeBook: (_actor, type) => type === 'dwarven'
                ? [{ recipeId: 101 }, { recipeId: 202 }]
                : [{ recipeId: 303 }]
        }
    };
    return { actor, packets, dataSendToMe: (packet) => packets.push(packet) };
}

const dwarven = session();
recipeBookOpen(dwarven, request(true));
assert.strictEqual(dwarven.packets.length, 1, 'Dwarven craft request must answer with a recipe book packet');
assert.strictEqual(dwarven.packets[0][0], 0xd6, 'RecipeBookItemList must use C4 opcode 0xD6');
assert.strictEqual(dwarven.packets[0].readInt32LE(1), 0, 'Dwarven craft recipe book selector must be 0');
assert.strictEqual(dwarven.packets[0].readInt32LE(5), 432, 'Recipe book must advertise the actor maximum MP');
assert.strictEqual(dwarven.packets[0].readInt32LE(9), 2, 'Recipe book must list learned dwarven recipes');
assert.strictEqual(dwarven.packets[0].readInt32LE(13), 101, 'Recipe book must preserve recipe IDs');

const common = session();
recipeBookOpen(common, request(false));
assert.strictEqual(common.packets[0][0], 0xd6, 'Common craft must use the same recipe book packet');
assert.strictEqual(common.packets[0].readInt32LE(1), 1, 'Common craft recipe book selector must be 1');
assert.strictEqual(common.packets[0].readInt32LE(9), 1, 'Recipe book must use the correct common recipe set');

console.log('Recipe book checks passed');

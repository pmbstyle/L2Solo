'use strict';
const assert = require('node:assert/strict');
const recipes = [
    { type: 'dwarven', recipeId: 1, recipeItemId: 101, productId: 201, level: 2 },
    { type: 'dwarven', recipeId: 2, recipeItemId: 102, productId: 202, level: 5 },
    { type: 'dwarven', recipeId: 3, recipeItemId: 103, productId: 201, level: 3 },
    { type: 'common', recipeId: 4, recipeItemId: 104, productId: 204, level: 1 },
    { type: 'dwarven', recipeId: 5, recipeItemId: 105, productId: 205, level: 10 }
];
global.invoke = name => {
    assert.equal(name, 'GameServer/Items/C4RecipeItems');
    return { loadRecipeItems: () => recipes };
};
// Synthetic recipes have independently supplied origin permission.
const Catalog = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const nativeAdmission = Catalog.allowsRecipe;
Catalog.allowsRecipe = recipe => recipes.includes(recipe);
const { forBoard } = require('../src/GameServer/Bot/Economy/RecipeProductionIndex');
const quotes = new Map();
const board = { list: (id, side) => quotes.get(`${id}:${side}`) || [] };
const ids = (index, level) => [...index.rowsFor(level)].map(recipe => recipe.recipeId).sort();
const index = forBoard(board);
assert.strictEqual(forBoard(board), index, 'one index per board lifetime');
assert.deepEqual(ids(index, 9), []);
quotes.set('101:1', [{ price: 20, count: 1 }]);
assert.deepEqual(index.update(101), [], 'offered recipe alone is not product demand');
quotes.set('201:3', [{ price: 100, count: 1 }]);
assert.deepEqual(index.update(201), Array.from({ length: 8 }, (_, at) => index.scopeFor(at + 2)));
assert.deepEqual(ids(index, 1), []); assert.deepEqual(ids(index, 2), [1]);
assert.deepEqual(ids(index, 3), [1, 3], 'public product demand admits recipes without a scroll SELL');
const revision = index.revision(index.scopeFor(9));
quotes.set('101:1', [{ price: 30, count: 3 }]);
assert.deepEqual(index.update(101), []);
assert.equal(index.revision(index.scopeFor(9)), revision, 'price/count changes are ordinary item dependencies');
assert.deepEqual(index.update(999), []);
quotes.set('103:1', [{ price: 30, count: 1 }]); index.update(103);
assert.deepEqual(ids(index, 2), [1]); assert.deepEqual(ids(index, 3), [1, 3]);
quotes.set('102:1', [{}]); quotes.set('202:3', [{}]); index.update(102);
assert.deepEqual(ids(index, 4), [1, 3]); assert.deepEqual(ids(index, 5), [1, 2, 3]);
quotes.delete('201:3'); index.update(201);
assert.deepEqual(ids(index, 5), [2], 'product disappearance removes every reverse-indexed recipe');
quotes.delete('102:1'); index.update(102); assert.deepEqual(ids(index, 9), [2], 'missing scroll supply preserves preparatory product demand');
quotes.delete('202:3'); index.update(202); assert.deepEqual(ids(index, 9), []);
quotes.set('104:1', [{}]); quotes.set('204:3', [{}]); quotes.set('105:1', [{}]); quotes.set('205:3', [{}]);
index.update(104); index.update(105); assert.deepEqual(ids(index, 9), [], 'common/out-of-skill recipes stay excluded');
const staticBoard = { list: (id, side) => id === 101 && side === 1 ? [{}] : [] };
assert.deepEqual(ids(forBoard(staticBoard, { fixedBuyer: recipe => recipe.productId === 201 }), 2), [1]);
const fixedIndex = forBoard(staticBoard);
fixedIndex.reset();
assert.deepEqual(ids(fixedIndex, 2), [1], 'replacement keeps fixed demand even without any public product row');
const initialRevision = index.revision(index.scopeFor(9));
quotes.set('101:1', [{}]); quotes.set('201:3', [{}]); index.update(101);
assert(index.reset().includes(index.scopeFor(9)));
assert.deepEqual(ids(index, 9), []); assert(index.revision(index.scopeFor(9)) > initialRevision);
index.update(101); assert.deepEqual(ids(index, 2), [1], 'snapshot replacement repopulates incrementally');
console.log('PASS public recipe admission, skill bounds, reverse removal, membership-only revisions and fixed buyer');

Catalog.allowsRecipe = nativeAdmission;

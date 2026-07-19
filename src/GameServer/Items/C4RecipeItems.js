const fs = require('fs');

const RECIPE_DATA_PATH = 'data/Recipes/recipes.csv';

let recipeItems = null;
let recipesById = null;
let recipesByProductId = null;

function parseItemList(value) {
    const items = [];
    String(value || '').replace(/\[(\d+)\((\d+)\)\]/g, (match, selfId, amount) => {
        items.push({
            selfId: Number(selfId),
            amount: Number(amount)
        });
        return match;
    });
    return items;
}

function parseLine(line) {
    const parts = String(line || '').trim().split(';');
    if (parts.length < 11 || !parts[0]) {
        return null;
    }

    const type = parts[0] === 'dwarven' ? 'dwarven' : 'common';
    return {
        type,
        recipeId: Number(parts[2]),
        recipeItemId: Number(parts[3]),
        level: Number(parts[4]),
        materials: parseItemList(parts[5]),
        productId: Number(parts[6]),
        productCount: Number(parts[7]),
        npcFee: parseItemList(parts[8]),
        mpCost: Number(parts[9]),
        successRate: Number(parts[10])
    };
}

function loadRecipeItems() {
    if (recipeItems) {
        return recipeItems;
    }

    recipeItems = {};
    recipesById = {};
    recipesByProductId = {};
    if (!fs.existsSync(RECIPE_DATA_PATH)) {
        return recipeItems;
    }

    fs.readFileSync(RECIPE_DATA_PATH, 'utf8')
        .split(/\r?\n/)
        .map(parseLine)
        .filter(Boolean)
        .forEach((recipe) => {
            if (!recipeItems[recipe.recipeItemId]) {
                recipeItems[recipe.recipeItemId] = recipe;
            }
            if (!recipesById[recipe.recipeId]) {
                recipesById[recipe.recipeId] = recipe;
            }
            if (!recipesByProductId[recipe.productId]) {
                recipesByProductId[recipe.productId] = recipe;
            }
        });

    return recipeItems;
}

function resolve(selfId) {
    return loadRecipeItems()[Number(selfId)] || null;
}

function resolveByRecipeId(recipeId) {
    loadRecipeItems();
    return recipesById[Number(recipeId)] || null;
}

function resolveByProductId(productId) {
    loadRecipeItems();
    return recipesByProductId[Number(productId)] || null;
}

module.exports = {
    RECIPE_DATA_PATH,
    loadRecipeItems,
    resolve,
    resolveByRecipeId,
    resolveByProductId
};

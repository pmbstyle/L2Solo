'use strict';

// Public stations know their recipes. The scroll in the data pack describes
// learning the recipe, not an ingredient paid by the station's customer.
const prepared = new WeakMap();

function forStation(recipe) {
    if (!recipe || !Array.isArray(recipe.materials)) return recipe;
    const scroll = Number(recipe.recipeItemId);
    if (!(scroll > 0) || !recipe.materials.some(row => Number(row.selfId) === scroll)) return recipe;
    const prior = prepared.get(recipe);
    if (prior && prior.scroll === scroll && prior.materials === recipe.materials && prior.length === recipe.materials.length
        && prior.signature === recipe.materials.map(row => `${row.selfId}:${row.amount}`).join(',')) return prior.value;
    const value = { ...recipe, materials: recipe.materials.filter(row => Number(row.selfId) !== scroll) };
    prepared.set(recipe, { scroll, materials: recipe.materials, length: recipe.materials.length,
        signature: recipe.materials.map(row => `${row.selfId}:${row.amount}`).join(','), value });
    return value;
}

module.exports = { forStation };

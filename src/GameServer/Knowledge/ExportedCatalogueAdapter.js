'use strict';

// Wrap the reference service's already-owned Maps, relation lists and item
// source reader. No native require/init or extra payload copy: optional native
// queries are supplied explicitly by a caller that already owns the loaded
// native data.
const { create } = require('./GameDataCatalogue');
const EMPTY = Object.freeze([]);

function createExportedCatalogue(data, { nativeCatalogue = null } = {}) {
    const hasRecipes = () => !!nativeCatalogue?.capabilities().recipes;
    const exportedInfo = () => ({ origin: 'exported', revision: data.manifest?.generatedAt || null });
    return create({ origin: 'exported',
        capabilities: (options = {}) => {
            const native = nativeCatalogue?.capabilities(options);
            return { recipes: !!native?.recipes, sources: true, selectedSpots: !!native?.selectedSpots,
                selectedSources: !!(native?.selectedSources ?? native?.selectedSpots),
                npcShops: !!native?.npcShops, potentialSpawns: true };
        },
        datasetInfo: (options = {}) => {
            const native = nativeCatalogue?.datasetInfo?.(options) || {};
            const borrowed = name => native[name] || { origin: nativeCatalogue?.origin || null, revision: null };
            return { sources: exportedInfo(), potentialSpawns: exportedInfo(), recipes: borrowed('recipes'),
                selectedSources: borrowed('selectedSources'), selectedSpots: borrowed('selectedSpots') };
        },
        item: id => data.itemById.get(id) || null,
        npc: id => data.mobById.get(id) || null,
        spawn: id => data.spawnById.get(id) || null,
        spawnsForNpc: id => (data.mobById.get(id)?.spawnIds || []).map(key => data.spawnById.get(String(key))).filter(Boolean),
        // Exported source records carry the mob id only (the knowledge base keeps no other source field).
        sourcesForItem: (id, { kind } = {}) => {
            const mobIds = data.itemSources.mobIds(id, kind);
            return mobIds.length ? mobIds.map(mobId => ({ mobId })) : EMPTY;
        },
        recipe: id => hasRecipes() ? nativeCatalogue.recipe(id) : null,
        recipesForProduct: id => hasRecipes() ? nativeCatalogue.recipesForProduct(id) : null,
        ingredientsForRecipe: id => hasRecipes() ? nativeCatalogue.ingredientsForRecipe(id) : null,
        recipesUsing: id => hasRecipes() ? nativeCatalogue.recipesUsing(id) : null,
        npcShopRow: (npcId, itemId) => nativeCatalogue?.npcShopRow(npcId, itemId) ?? null,
        sourceIndexFor: spots => nativeCatalogue?.sourceIndexFor?.(spots) ?? null,
        selectedSourcesForItem: (id, spots) => nativeCatalogue?.selectedSourcesForItem(id, spots) ?? null,
        selectedNpcSpots: (id, spots) => nativeCatalogue?.selectedNpcSpots(id, spots) ?? null,
        selectedSpotNpcs: (id, spots) => nativeCatalogue?.selectedSpotNpcs(id, spots) ?? null,
        potentialSpawnData: () => ({ kind: 'potential_definitions', origin: 'exported',
            revision: data.manifest?.generatedAt || null, definitions: data.spawns,
            totalSemantics: 'per_explicit_coordinate_or_random_total_in_bounds',
            periodSemantics: 'day_or_night_otherwise_always', population: 'definition_only' })
    });
}

module.exports = { createExportedCatalogue };

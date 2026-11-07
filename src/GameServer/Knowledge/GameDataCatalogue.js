'use strict';

// Public game-data queries over existing owners; returned rows are borrowed.
// Optional datasets return null when unavailable, rather than a false empty
// result. Native selected counts describe the caller's spot catalogue, never
// alive-now occupancy. Potential spawn definitions have no spot inference:
// total applies at EACH explicit coordinate, or to random placement in bounds.
// Recipe relations use the declared source as first indexed (RecipeCatalog).
// sourcesForItem requires kind 'drops'/'spoils' ('drop'/'spoil' aliases work).
// It returns origin-specific source records, not a normalized schema (native: borrowed
// reward rows; exported: `{ mobId }` per source, in catalogue order).
// Importing this module/factory never loads native data or exported JSON.
// Direct optional queries do not load missing datasets: null = unavailable,
// [] = available but no matching rows. sourceIndexFor is the legacy planner
// Map reader and keeps its empty-selection sentinel for the hot caller.
// Revisions are process-local source labels, not cross-process world versions.
const { revisionOf } = require('./CatalogueRevision');
const EMPTY = Object.freeze([]);

function create(adapter) {
    const api = {
        origin: adapter.origin,
        capabilities: (options = {}) => adapter.capabilities(options),
        datasetInfo: (options = {}) => adapter.datasetInfo?.(options) || {},
        item: id => adapter.item?.(Number(id)) ?? null,
        npc: id => adapter.npc?.(Number(id)) ?? null,
        rewardForNpc: id => adapter.rewardForNpc?.(Number(id)) ?? null,
        spotNpcWeights: (spot, id) => adapter.spotNpcWeights?.(spot, Number(id)) ?? null,
        spawn: id => adapter.spawn?.(String(id)) ?? null,
        spawnsForNpc: id => adapter.spawnsForNpc?.(Number(id)) ?? null,
        raidBossDefinitions: () => adapter.raidBossDefinitions?.() ?? null,
        recipe: id => adapter.recipe?.(Number(id)) ?? null,
        recipesForProduct: id => adapter.recipesForProduct?.(Number(id)) ?? null,
        ingredientsForRecipe: id => adapter.ingredientsForRecipe?.(Number(id)) ?? null,
        recipesUsing: id => adapter.recipesUsing?.(Number(id)) ?? null,
        dwarvenRecipesForItems: () => adapter.dwarvenRecipesForItems?.() ?? null,
        npcShopRow: (npcId, itemId) => adapter.npcShopRow?.(Number(npcId), Number(itemId)) ?? null,
        npcTownOffers: () => adapter.npcTownOffers?.() ?? null,
        npcPriceForItem: id => adapter.npcPriceForItem?.(Number(id)) ?? null,
        npcPrices: () => adapter.npcPrices?.() ?? null,
        sourceIndexFor: spots => adapter.sourceIndexFor?.(spots) ?? null,
        sourcesForItem: (id, options = {}) => {
            const kind = options.kind === 'drop' ? 'drops' : options.kind === 'spoil' ? 'spoils' : options.kind;
            if (kind !== 'drops' && kind !== 'spoils') return null;
            return adapter.sourcesForItem?.(Number(id), kind === options.kind ? options : { ...options, kind }) ?? null;
        },
        selectedSourcesForItem: (id, spots) => adapter.selectedSourcesForItem?.(Number(id), spots) ?? null,
        selectedNpcSpots: (id, spots) => adapter.selectedNpcSpots?.(Number(id), spots) ?? null,
        selectedSpotNpcs: (id, spots) => adapter.selectedSpotNpcs?.(String(id), spots) ?? null,
        potentialSpawnData: () => adapter.potentialSpawnData?.() ?? null
    };
    api.relations = (kind, id, options = {}) => {
        const capabilities = api.capabilities(options);
        const info = api.datasetInfo(options);
        const selectedAvailable = capabilities.selectedSources ?? capabilities.selectedSpots;
        const section = (name, available) => ({ available: !!available,
            origin: info[name] ? info[name].origin : api.origin, revision: info[name]?.revision ?? null });
        if (kind === 'item') return { kind, id: Number(id), origin: api.origin,
            recipes: { ...section('recipes', capabilities.recipes), producedBy: capabilities.recipes ? api.recipesForProduct(id) : null,
                usedBy: capabilities.recipes ? api.recipesUsing(id) : null },
            sources: { ...section('sources', capabilities.sources),
                drops: capabilities.sources ? api.sourcesForItem(id, { kind: 'drops' }) : null,
                spoils: capabilities.sources ? api.sourcesForItem(id, { kind: 'spoils' }) : null },
            selectedSources: { ...section('selectedSources', selectedAvailable),
                ...(selectedAvailable ? { countKind: 'planner_source_weights' } : {}),
                rows: selectedAvailable ? api.selectedSourcesForItem(id, options.spots) : null } };
        if (kind === 'npc') return { kind, id: Number(id), origin: api.origin,
            selectedSpots: { ...section('selectedSpots', capabilities.selectedSpots),
                rows: capabilities.selectedSpots ? api.selectedNpcSpots(id, options.spots) : null },
            potentialSpawns: { ...section('potentialSpawns', capabilities.potentialSpawns),
                population: 'definition_only', rows: capabilities.potentialSpawns ? api.spawnsForNpc(id) : null } };
        return null;
    };
    return Object.freeze(api);
}

let nativeCatalogue;
function native() {
    if (nativeCatalogue) return nativeCatalogue;
    let dataOwner, recipeOwner, sourceOwner, itemOwner, shopOwner, nativeRecipeOwner, spawnOwner;
    const data = () => dataOwner ||= invoke('GameServer/DataCache');
    const recipes = () => recipeOwner ||= require('./RecipeCatalog');
    const sources = () => sourceOwner ||= require('./SourceCatalog');
    const items = () => itemOwner ||= require('../Item/ItemTemplateIndex');
    // Native static data remains available when a worker replaces live-world
    // services in invoke(). The canonical loader is data-only in that process.
    const shops = () => shopOwner ||= require('../World/Generics/NpcShopBuyLists');
    const nativeRecipes = () => nativeRecipeOwner ||= require('../Items/C4RecipeItems');
    const spawns = () => spawnOwner ||= require('./SpawnCatalog');
    const hasRecipes = () => !!nativeRecipes().loadedSource();
    const hasSources = () => Array.isArray(data().npcRewards);
    const hasSelectedSources = spots => Array.isArray(spots) && hasSources() && Array.isArray(data().npcs);
    nativeCatalogue = create({ origin: 'native',
        capabilities: ({ spots } = {}) => ({ recipes: hasRecipes(), sources: hasSources(),
            selectedSpots: Array.isArray(spots), selectedSources: hasSelectedSources(spots),
            npcShops: true, potentialSpawns: Array.isArray(data().npcSpawns) }),
        datasetInfo: ({ spots } = {}) => ({
            recipes: { origin: 'native', revision: revisionOf(nativeRecipes().loadedSource()?.rows) },
            sources: { origin: 'native', revision: revisionOf(data().npcRewards) },
            selectedSources: { origin: 'native', revision: { spots: revisionOf(spots),
                rewards: revisionOf(data().npcRewards), npcs: revisionOf(data().npcs) } },
            selectedSpots: { origin: 'native', revision: revisionOf(spots) },
            potentialSpawns: { origin: 'native', revision: revisionOf(data().npcSpawns) }
        }),
        item: id => items().find(data().items, id) || null,
        npc: id => items().find(data().npcs, id) || null,
        rewardForNpc: id => sources().rewardForNpc(id),
        spotNpcWeights: (spot, id) => require('../Bot/AI/SpotIndex').npcWeights(spot, id),
        spawn: id => spawns().spawn(id),
        spawnsForNpc: id => spawns().spawnsForNpc(id),
        raidBossDefinitions: () => spawns().raidBossDefinitions(),
        recipe: id => hasRecipes() ? nativeRecipes().resolveByRecipeId(id) : null,
        recipesForProduct: id => hasRecipes() ? recipes().recipesForProduct(id) : null,
        ingredientsForRecipe: id => hasRecipes() ? recipes().ingredientsForRecipe(id) : null,
        recipesUsing: id => hasRecipes() ? recipes().recipesUsing(id) : null,
        dwarvenRecipesForItems: () => hasRecipes() && Array.isArray(data().items)
            ? recipes().dwarvenRecipesForItems(data().items) : null,
        npcShopRow: (npcId, itemId) => shops().rowForNpc(npcId, itemId),
        npcTownOffers: () => shops().townOffers(),
        npcPriceForItem: id => shops().townPriceForItem(id),
        npcPrices: () => shops().townPrices(),
        sourceIndexFor: spots => sources().sourcesByItem(spots),
        sourcesForItem: (id, { kind } = {}) => sources().rawSourcesForItem(id, kind),
        selectedSourcesForItem: (id, spots) => hasSelectedSources(spots) ? sources().sourcesByItem(spots).get(id) || EMPTY : null,
        selectedNpcSpots: (id, spots) => Array.isArray(spots) ? sources().selectedNpcSpots(id, spots) : null,
        selectedSpotNpcs: (id, spots) => Array.isArray(spots) ? sources().selectedSpotNpcs(id, spots) : null,
        potentialSpawnData: () => spawns().potentialSpawnData()
    });
    return nativeCatalogue;
}

module.exports = { create, native };

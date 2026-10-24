// Shared, bounded caches for immutable catalog results. No player state here.
const path = require('path');
const { createKnowledgeBaseService } = require('../../../WorldObserver/KnowledgeBaseService');
const { createExportedCatalogue } = require('../../Knowledge/ExportedCatalogueAdapter');
const GameCatalogue = require('../../Knowledge/GameDataCatalogue');
let knowledge;
function cachedService(base, rates) {
    let profile;
    const caches = [new Map(), new Map(), new Map()];
    function cached(index, limit, key, calculate) {
        const current = JSON.stringify(rates.profile());
        if (current !== profile) { caches.forEach((cache) => cache.clear()); profile = current; }
        const cache = caches[index];
        const result = cache.has(key) ? cache.get(key) : calculate();
        cache.delete(key); cache.set(key, result);
        if (cache.size > limit) cache.delete(cache.keys().next().value);
        return result;
    }
    return Object.freeze({ ...base,
        listItems: (query = {}) => cached(0, 64, JSON.stringify(query), () => base.listItems(query)),
        itemDetail: (id) => cached(1, 64, Number(id), () => base.itemDetail(id)),
        npcDetail: (id) => cached(2, 256, Number(id), () => base.npcDetail(id))
    });
}
function service() {
    if (!knowledge) {
        const rates = invoke('GameServer/ProgressionRates');
        const nativeData = invoke('GameServer/DataCache');
        knowledge = cachedService(createKnowledgeBaseService({
            dataDir: path.join(__dirname, '../../../../data/KnowledgeBase'), progressionRates: rates,
            catalogueFactory: createExportedCatalogue,
            nativeSkills: () => nativeData.skills,
            nativeCatalogue: Array.isArray(nativeData.items) && Array.isArray(nativeData.npcs)
                && require('../../Items/C4RecipeItems').loadedSource() ? GameCatalogue.native() : null
        }), rates);
    }
    return knowledge;
}
// Called before listening, so the first hover/search never parses 49 MB of JSON.
service.warmup = () => service().listItems({ q: '', category: 'all', grade: 'all', page: 1, limit: 8, exactFirst: true });
service.cachedService = cachedService;
module.exports = service;

const { parentPort } = require('node:worker_threads');
require('../../Global');
const OfferOrder = require('../Bot/Economy/OfferOrder');
const TableMirror = require('../Bot/Population/TableMirror');

// Only immutable catalogs and per-request snapshots enter this process.
const catalogs = { items: [], npcs: [], npcRewards: [] };
let context = {};
let planner;
let offers = new Map();
let npcOffers = new Map();
// Tables from the main thread's ColdTableChannel; pages are not answered.
const tables = new TableMirror();
const originalInvoke = global.invoke;
const indexOffers = (rows = []) => {
    const index = new Map();
    for (const row of rows) {
        const id = Number(row.selfId);
        if (!index.has(id)) index.set(id, []);
        index.get(id).push(row);
    }
    return index;
};
const market = {
    get TOWN_NPC_SELLERS() { return context.towns || {}; },
    npcOffersAll: (id) => npcOffers.get(Number(id)) || [],
    bestOffer(id, options = {}) {
        const towns = options.town ? [options.town] : options.towns || null;
        return OfferOrder.best([...(offers.get(Number(id)) || []), ...(npcOffers.get(Number(id)) || [])]
            .filter((offer) => offer.available !== false && Number(offer.count ?? 1) > 0
                && Number(offer.price) > 0
                && (!offer.town || !towns || towns.includes(offer.town))
                && (!['afk_player_store', 'afk_bot_store'].includes(offer.sourceType)
                    || Number(offer.sourceId) !== Number(options.buyerCharacterId))
                && (!options.accept || options.accept(offer)))
            .map((offer) => offer.town || towns?.length !== 1 ? offer : { ...offer, town: towns[0] }),
        { budget: Number(options.budget ?? Infinity), cost: options.cost });
    }
};
const stubs = new Map([
    ['GameServer/DataCache', catalogs],
    ['GameServer/Bot/Economy/MarketOpportunity', market],
    ['GameServer/Bot/Economy/CraftShopService', {
        CraftStations: [{}],
        availableRecipes: () => context.recipes || [],
        stationRecipes: (_station, recipes) => recipes,
        publishedStationRecipes: () => {
            const recipes = context.recipes || [];
            return { recipes, ids: new Set(recipes.map((recipe) => Number(recipe.recipeId))), stationByRecipeId: new Map() };
        }
    }],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => context.shopEntries || [] }]
]);
global.invoke = (name) => {
    if (stubs.has(name)) return stubs.get(name);
    if (name === 'Database' || name === 'Server'
        || /GameServer\/(World\/World$|Bot\/BotManager|Network|Persistence)/.test(name)) {
        throw new Error(`clan planning worker forbidden dependency: ${name}`);
    }
    return originalInvoke(name);
};

parentPort.on('message', (message) => {
    try {
        if (message.type === 'table_page') {
            const resync = tables.apply(message.tables);
            if (resync.length) parentPort.postMessage({ type: 'table_resync', names: resync });
            return;
        } else if (message.type === 'table_summary') {
            parentPort.postMessage({ id: message.id, result: tables.summary() });
            return;
        } else if (message.type === 'catalog') {
            if (!Object.hasOwn(catalogs, message.name)) throw new Error('unknown catalog');
            catalogs[message.name].push(...message.rows);
        } else if (message.type === 'plan') {
            context = message.payload.context;
            global.options.default.General = context.general;
            if (context.progressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
            else process.env.L2NODE_PROGRESSION_RATE = context.progressionRate;
            offers = indexOffers(context.offers);
            npcOffers = indexOffers(context.npcOffers);
            invoke('GameServer/Bot/Economy/BotMarketPricing').useNpcOfferSnapshot(context.npcOffers);
            planner ||= require('./ClanEquipmentPlanner');
            const forbidden = Object.keys(require.cache).some((filename) =>
                /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/]Bot[\\/]BotManager\.js$/.test(filename));
            if (forbidden) throw new Error('clan planning worker loaded a live runtime dependency');
            const startedAt = performance.now();
            const { member, spots, warehouseRows, options } = message.payload;
            const plan = planner.planForMember(member, spots, warehouseRows, { ...options, throwOnError: true });
            parentPort.postMessage({ id: message.id, result: { plan, durationMs: performance.now() - startedAt } });
            return;
        } else {
            throw new Error('unknown clan worker message');
        }
        parentPort.postMessage({ id: message.id, result: true });
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});

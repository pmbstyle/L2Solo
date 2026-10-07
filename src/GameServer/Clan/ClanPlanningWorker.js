const { parentPort } = require('node:worker_threads');
require('../../Global');
const OfferQuery = require('../Bot/Economy/OfferQuery');
const TableMirror = require('../Bot/Population/TableMirror');
const { BoardIndex } = require('../AfkTrade/BoardIndex');

// Only immutable catalogs and per-request snapshots enter this process.
const catalogs = { items: [], npcs: [], npcRewards: [], experience: [] };
// ARCH-NOTE: ProgressionCap captured native DataCache before the facade.
// Alias the authored arrays for cap/death reads;80 experience numbers enter
// once per epoch through the existing bounded catalogue page handler.
Object.assign(invoke('GameServer/DataCache'), catalogs);
let context = {};
let planner;
let fixedOffers = new Map();
let npcOffers = new Map();
// Tables from the main thread's ColdTableChannel; pages are not answered.
// The board's offers come from the 'board' table, indexed as it changes.
const tables = new TableMirror();
const boardIndex = new BoardIndex();
tables.watch('board', boardIndex.follower());
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
    // MarketOpportunity.bestOffer over the same sources: the board, the
    // configured merchants (with the plan) and the NPC shops in the towns.
    bestOffer(id, options = {}) {
        const towns = options.town ? [options.town] : options.towns || null;
        return OfferQuery.bestSellOffer(tables.ready('board') ? boardIndex : null, Number(id), {
            towns,
            excludeOwner: options.buyerCharacterId,
            budget: options.budget,
            cost: options.cost,
            accept: options.accept,
            others: OfferQuery.othersIn(towns, fixedOffers.get(Number(id)) || [], npcOffers.get(Number(id)) || [])
        });
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
            global.options.default.Progression = context.progression;
            if (context.progressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
            else process.env.L2NODE_PROGRESSION_RATE = context.progressionRate;
            fixedOffers = indexOffers(context.fixedOffers);
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

const { parentPort, workerData } = require('node:worker_threads');
process.env.BOT_DEVELOPER_DIAGNOSTICS = workerData?.developerDiagnostics === true ? 'true' : 'false';
require('../../Global');
const OfferQuery = require('../Bot/Economy/OfferQuery');
const TableMirror = require('../Bot/Population/TableMirror');
const { BoardIndex } = require('../AfkTrade/BoardIndex');
const { SpotCatalogReader } = require('./ClanSpotCatalog');
const { heapRecord, observe } = require('../Bot/Population/WorkerHeapTelemetry');
if (workerData?.developerDiagnostics) observe(); // major-GC window for the v8Heap record (WorkerHeapTelemetry)
const spotCatalog = new SpotCatalogReader();

// Only immutable catalogs and per-request snapshots enter this process.
const catalogs = { items: [], npcs: [], npcRewards: [], npcSpawns: [], newbieItems: [], experience: [], skillTree: [], skills: [], classTemplates: [], revitalize: {} };
// ARCH-NOTE: native cap, tree and seated recovery readers capture DataCache
// (seated recovery reads the class tree's passives: skills, ColdRest).
// Keep the same authored arrays/objects behind the facade and populate them
// once per epoch; full native planning previously failed at missing craftLevelFor
// and then FirstPrice's eager BackgroundResolver/ChargeLifecycle import.
Object.assign(invoke('GameServer/DataCache'), catalogs);
let context = {};
let planner;
let raidJob = null;
let fixedOffers = new Map();
let npcOffers = new Map();
// Tables from the main thread's ColdTableChannel; pages are not answered.
// The board's offers come from the 'board' table, indexed as it changes.
const tables = new TableMirror();
const ClanSupplies = invoke('GameServer/Clan/ClanSupplyPolicy');
const PersonalWarehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const ProgressionRates = invoke('GameServer/ProgressionRates');
tables.watch('clan_supplies', { reset() {}, remove() {}, put: (_key, row) => ClanSupplies.prepareRow(row) });
tables.watch('personal_warehouse', { reset() {}, remove() {}, put: (_key, row) => PersonalWarehouse.prepareRow(row) });
ClanSupplies.useRowSource(id => tables.rows('clan_supplies').get(id), () => tables.ready('clan_supplies'));
PersonalWarehouse.useRowSource(id => tables.rows('personal_warehouse').get(id), () => tables.ready('personal_warehouse'));
const boardIndex = new BoardIndex();
tables.watch('board', boardIndex.follower());
// The channel sends every table to every worker; this one reads none of the
// cold worker's tables (memory ~one row per bot, parties, goals, pressure,
// raids, meetings, clan halls, recipes),
// so it keeps no rows of them.
for (const name of ['memory', 'parties', 'goals', 'pressure', 'raids', 'meetings', 'clan_halls', 'recipes']) {
    tables.watch(name, { reset() {}, put() {}, remove() {} }, { retain: false });
}
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
// The static planning context, once per worker and revision
// (ClanPlanningCoordinator.ensureContext); each request names its revision.
// Revisions only grow: an older one arriving late is not taken back.
function useContext(next) {
    if (next.revision < context.revision) return;
    // Indexes first: a throw keeps the old revision with its own indexes.
    const nextFixed = indexOffers(next.fixedOffers);
    const nextNpc = indexOffers(next.npcOffers);
    BotMarketPricing.useNpcOfferSnapshot([...(next.npcOffers || []), ...(next.npcPriceRows || [])]);
    global.options.default.General = next.general;
    global.options.default.Progression = next.progression;
    if (next.progressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = next.progressionRate;
    ProgressionRates.reset();
    fixedOffers = nextFixed;
    npcOffers = nextNpc;
    context = next;
}
// Static data: a request made under an older revision plans with the newer
// one the worker holds (two plans in flight across a revision change).
function restore(payload) {
    if (!(context.revision >= payload.contextRevision)) throw new Error('stale clan planning context');
    return spotCatalog.restore(payload);
}
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
        ...require('../Bot/Economy/CraftEligibility'),
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
            if (message.name === 'revitalize') Object.assign(catalogs.revitalize, message.rows[0]);
            else catalogs[message.name].push(...message.rows);
            // Item origins are rebuilt from the complete catalogs, never a partial page.
            require('../Items/ItemAcquisitionCatalog').reset();
        } else if (message.type === 'spot_catalog') {
            spotCatalog.apply(message.page);
        } else if (message.type === 'planning_context') {
            useContext(message.context);
        } else if (message.type === 'end_planning_job') {
            if (raidJob?.key === message.jobKey) raidJob = null;
        } else if (message.type === 'prepare_raids') {
            const payload = restore(message.payload);
            if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw Error('clan planning deadline');
            if (raidJob?.key !== payload.jobKey) raidJob = { key: payload.jobKey, readiness: new Map() };
            raidJob.clan = payload.clan; raidJob.prospects = payload.prospects;
            raidJob.prepared = require('./ClanRosterDemand').prepare(payload.clan,
                payload.spots, payload.prospects, payload.previousGoal, raidJob.readiness);
            raidJob.prepared.economicProspects = require('./ClanRosterDemand').retainedEconomicProspects(payload.prospects,
                payload.economicRequirements, raidJob.prepared.retainedProspects);
            parentPort.postMessage({ id: message.id, result: raidJob.prepared });
            return;
        } else if (message.type === 'plan') {
            const payload = restore(message.payload);
            planner ||= require('./ClanEquipmentPlanner');
            const forbidden = Object.keys(require.cache).some((filename) =>
                /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/]Bot[\\/]BotManager\.js$/.test(filename));
            if (forbidden) throw new Error('clan planning worker loaded a live runtime dependency');
            const startedAt = workerData?.developerDiagnostics ? performance.now() : 0;
            const { member, spots, warehouseRows, options } = payload;
            if (options.economicMode && raidJob?.key !== payload.jobKey) throw Error('economic planning job missing');
            const plan = options.economicMode ? require('./ClanRosterDemand').economicPlan(planner.planForMember, raidJob,
                member, spots, warehouseRows, { ...options, throwOnError: true })
                : planner.planForMember(member, spots, warehouseRows, { ...options, throwOnError: true });
            parentPort.postMessage({ id: message.id, result: { plan, ...(workerData?.developerDiagnostics ? { durationMs: performance.now() - startedAt, v8Heap: heapRecord() } : {}) } });
            return;
        } else {
            throw new Error('unknown clan worker message');
        }
        parentPort.postMessage({ id: message.id, result: true });
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});

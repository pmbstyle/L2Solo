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
// The admitted planning job (ClanPlanningCoordinator.withJob): its readiness
// and own-roster assessments, and the inputs the coordinator sends once per
// job and then names in `held` (ClanPlanningCoordinator.jobInputs mirrors them).
let job = null;
const memberId = member => Number(member?.characterId ?? member?.id);
function jobFor(key) {
    if (job?.key !== key) job = { key, readiness: new Map(), actual: new Map(), inputs: {}, prospectById: new Map() };
    return job;
}
function jobInput(current, payload, held, name) {
    if (!held.has(name)) return payload[name];
    if (!Object.hasOwn(current.inputs, name)) throw new Error('clan planning job input missing');
    return current.inputs[name];
}
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
// The index keeps its own record per row; the mirror keeps only the version.
tables.watch('board', boardIndex.follower(), { retain: false });
// The channel sends every table to every worker; this one reads none of the
// cold worker's tables (memory ~one row per bot, parties, goals,
// raids, meetings, player anchors, clan halls, recipes),
// so it keeps no rows of them.
for (const name of ['memory', 'parties', 'goals', 'raids', 'meetings', 'player_anchors', 'clan_halls', 'recipes']) {
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
invoke('GameServer/Bot/Economy/StaticMerchantPricing').useBoard(() => tables.ready('board') ? boardIndex : null);
invoke('GameServer/Bot/Economy/MarketCounters').useTable(() => tables.rows('market'));

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
            if (job?.key === message.jobKey) job = null;
        } else if (message.type === 'prepare_raids') {
            // A page of the job's recruitment: the clan, spots, previous goal
            // and requirements cross once per job (held), prospects as ids of
            // those already sent plus the new ones.
            const payload = message.payload;
            if (!(context.revision >= payload.contextRevision)) throw new Error('stale clan planning context');
            if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw Error('clan planning deadline');
            const current = jobFor(payload.jobKey), held = new Set(payload.held || []);
            const clan = jobInput(current, payload, held, 'clan');
            const previousGoal = jobInput(current, payload, held, 'previousGoal');
            const economicRequirements = jobInput(current, payload, held, 'economicRequirements');
            const spots = held.has('spots') ? jobInput(current, payload, held, 'spots') : restore(payload).spots;
            const prospects = (payload.prospects || []).map(([sent, value]) => {
                if (sent !== 1) return value;
                if (!current.prospectById.has(value)) throw new Error('clan planning job input missing');
                return current.prospectById.get(value);
            });
            if (!held.has('clan') || !held.has('spots') || !held.has('previousGoal')) current.actual = new Map();
            Object.assign(current.inputs, { clan, previousGoal, economicRequirements, spots });
            current.prospectById = new Map(prospects.map(member => [memberId(member), member]));
            current.clan = clan; current.prospects = prospects;
            const Roster = require('./ClanRosterDemand');
            current.prepared = Roster.prepare(clan, spots, prospects, previousGoal, current.readiness, current.actual);
            current.prepared.economicProspects = Roster.retainedEconomicProspects(prospects,
                economicRequirements, current.prepared.retainedProspects);
            parentPort.postMessage({ id: message.id, result: { ...current.prepared,
                raids: current.prepared.raids.map(Roster.raidDecoration) } });
            return;
        } else if (message.type === 'plan') {
            const payload = restore(message.payload);
            planner ||= require('./ClanEquipmentPlanner');
            const forbidden = Object.keys(require.cache).some((filename) =>
                /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/]Bot[\\/]BotManager\.js$/.test(filename));
            if (forbidden) throw new Error('clan planning worker loaded a live runtime dependency');
            const startedAt = workerData?.developerDiagnostics ? performance.now() : 0;
            const { member, spots } = payload;
            let { warehouseRows, options } = payload;
            if (payload.jobKey) {
                // The job's craft options and warehouse rows: sent with its
                // first plan, then named as held (ClanPlanningCoordinator.plan).
                const current = jobFor(payload.jobKey), held = new Set(payload.held || []);
                const jobOptions = jobInput(current, payload, held, 'jobOptions');
                warehouseRows = jobInput(current, payload, held, 'warehouseRows');
                Object.assign(current.inputs, { jobOptions, warehouseRows });
                options = { ...jobOptions, ...options };
            }
            if (options.economicMode && (job?.key !== payload.jobKey || !job.prepared)) throw Error('economic planning job missing');
            const plan = options.economicMode ? require('./ClanRosterDemand').economicPlan(planner.planForMember, job,
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

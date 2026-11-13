const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const FailureLog = invoke('FailureLog');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const TableChannel = require('../Bot/Population/ColdTableChannel');
const { SpotCatalogWriter } = require('./ClanSpotCatalog');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const DataCache = invoke('GameServer/DataCache');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const EMPTY_SPOTS = [];
const memberId = member => Number(member?.characterId ?? member?.id);
// Plan inputs the same for every member of a job (ClanEquipmentService
// planningForClanAdmitted): the clan's craft options (~780 recipes with
// providers) and warehouse rows, read once per run.
const JOB_PLAN_OPTIONS = ['craftRecipes', 'allowedRecipeIds', 'craftProviders', 'spoilProviders'];
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
// The item-origin catalog (ItemAcquisitionCatalog) reads only which NPCs
// spawn (total > 0) and the creation grants; ship one row per spawned NPC
// instead of the full 3.5 MB spawn table.
function spawnedNpcRows(regions = []) {
    const totals = new Map();
    for (const region of regions) for (const row of region.spawns || []) if (Number(row.total) > 0)
        totals.set(Number(row.selfId), (totals.get(Number(row.selfId)) || 0) + Number(row.total));
    return [...totals].map(([selfId, total]) => ({ spawns: [{ selfId, total }] }));
}
function catalogRows(catalogs, name) {
    if (name === 'revitalize') return [catalogs[name] || {}];
    if (name === 'npcSpawns') return spawnedNpcRows(catalogs.npcSpawns);
    return catalogs[name] || [];
}

class ClanPlanningCoordinator {
    constructor({ workerFile = path.join(__dirname, 'ClanPlanningWorker.js'), timeoutMs = 30000, maxPending = 8, restartDelayMs = 5000,
        tableChannel = TableChannel.shared, planningContext = context } = {}) {
        this.workerFile = workerFile;
        this.tableChannel = tableChannel;
        // The static planning context (context() below) and the worker it
        // was published to; plan and prepare_raids carry only its revision.
        this.planningContext = planningContext;
        // What the current worker holds, per kind ('spots', 'context'):
        // { worker, key, promise } (publishOnce).
        this.publications = new Map();
        // A new worker is a new epoch for the table channel.
        this.epoch = 0;
        this.timeoutMs = timeoutMs;
        this.maxPending = maxPending;
        this.restartDelayMs = restartDelayMs;
        this.worker = null;
        this.pending = new Map();
        this.sequence = 0;
        this.initializing = null;
        this.spotInitializing = null;
        this.spotGeneration = 0;
        this.retryAt = 0;
        this.closed = false;
        // What the worker holds for the admitted job, by identity: the
        // inputs last sent ({ jobKey, worker, values, prospects }). A message
        // names an unchanged input in `held` instead of cloning it again.
        // Updated only on a reply, dropped with the job, the worker or a
        // failed send (the next message then sends everything).
        this.jobInputs = null;
        // Always counted (status line clanRestarts=): workers started after
        // one failed (fail: a crash, an OOM, a timeout ends one worker).
        this.restarts = 0;
        this.stats = { completed: 0, failures: 0, timeouts: 0, rejected: 0, maxRunMs: 0, contextPublishes: 0 };
    }

    // The worker is gone (failed or stopped): nothing published to it
    // counts any more and every request in flight gets the error.
    release(error) {
        this.worker = null;
        this.jobInputs = null;
        this.publications.clear();
        this.tableChannel.detach(this);
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    // A worker ends once: its error (an OOM too), exit or timeout, whichever
    // comes first, counted under `clan.worker.<site>` (FailureLog: the first
    // of a site logged with its stack); the next request after
    // restartDelayMs starts a new one (restarts).
    fail(worker, error, site) {
        if (this.worker !== worker) return;
        this.release(error);
        this.retryAt = Date.now() + this.restartDelayMs;
        FailureLog.note(`clan.worker.${site}`, error);
        DiagnosticConfig.developerDiagnostics && (this.stats.failures++);
        void worker.terminate();
    }

    send(type, payload) {
        const worker = this.worker;
        if (!worker || this.closed) return Promise.reject(new Error('clan planning worker unavailable'));
        if (this.pending.size >= this.maxPending) {
            DiagnosticConfig.developerDiagnostics && (this.stats.rejected++);
            return Promise.reject(new Error('clan planning worker queue full'));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.sequence;
            const timer = setTimeout(() => {
                DiagnosticConfig.developerDiagnostics && (this.stats.timeouts++);
                this.fail(worker, new Error('clan planning worker timed out'), 'timeout');
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            worker.ref();
            try {
                // ARCH-NOTE: the native plan repeated 2,045 immutable spot
                // profiles (3,276,455 serialized B). Publish bounded pages once
                // per worker/catalog generation; preserve dynamic rows in each
                // ordered request by original object identity, never by ID alone.
                worker.postMessage({ id, type, ...payload });
            } catch (error) {
                this.fail(worker, error, 'send');
            }
        });
    }

    async ready(catalogs) {
        if (this.closed) throw new Error('clan planning worker stopped');
        if (this.initializing) return this.initializing;
        if (this.worker) return;
        if (Date.now() < this.retryAt) throw new Error('clan planning worker recovering');
        // An OOM ends the worker with ERR_WORKER_OUT_OF_MEMORY (fail).
        const resourceLimits = DiagnosticConfig.workerResourceLimits('clanWorkerHeapMb', 'clanWorkerYoungMb');
        const worker = new Worker(this.workerFile, { resourceLimits, workerData: { developerDiagnostics: DiagnosticConfig.developerDiagnostics === true,
            spotTable: SpotValueTable.sharedDescriptor() } });
        this.worker = worker;
        // Only a failed worker is replaced (shutdown closes for good).
        if (this.epoch > 0) {
            this.restarts++;
            invoke('GameServer/Bot/DecisionTrace').record({ kind: 'restart', worker: 'clan', reason: 'replaced' });
        }
        const epoch = ++this.epoch;
        // A restarted worker has not reported yet (WorkerHeapTelemetry.heapRecord).
        delete this.stats.v8Heap;
        worker.on('error', (error) => this.fail(worker, error, 'error'));
        worker.on('exit', (code) => this.fail(worker, new Error(`clan planning worker exited: ${code}`), 'exit'));
        worker.on('message', (message) => {
            if (this.worker !== worker) return;
            if (message.type === 'table_resync') {
                this.tableChannel.resync(this, epoch, message.names || []);
                return;
            }
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                DiagnosticConfig.developerDiagnostics && (this.stats.failures++);
                entry.reject(new Error(message.error));
            }
            else entry.resolve(message.result);
            if (!this.pending.size) worker.unref();
        });
        this.initializing = (async () => {
            // Bound serialization work on the game thread, including initial startup.
            for (const name of ['items', 'npcs', 'npcRewards', 'npcSpawns', 'newbieItems', 'experience', 'skillTree', 'skills', 'classTemplates', 'revitalize']) {
                const rows = catalogRows(catalogs, name);
                for (let offset = 0; offset < rows.length; offset += 128) {
                    await this.send('catalog', { name, rows: rows.slice(offset, offset + 128) });
                    await yieldLoop();
                }
            }
        })();
        try { await this.initializing; }
        catch (error) { this.fail(worker, error, 'catalog'); throw error; }
        finally { this.initializing = null; }
        // Every table in full now; changes before each plan (plan()).
        if (this.worker === worker) this.tableChannel.attach(this, epoch, (payload) => this.postTables(worker, payload));
    }

    postTables(worker, payload) {
        if (this.worker !== worker) return false;
        try {
            worker.postMessage({ type: 'table_page', ...payload });
            return true;
        } catch (error) {
            this.fail(worker, error, 'tables');
            return false;
        }
    }

    // Static data crosses once per worker and key: callers with the same
    // key share one publication; a new key, a failed publication or a new
    // worker (release()) publishes again.
    publishOnce(kind, key, publish) {
        const held = this.publications.get(kind);
        if (held?.worker === this.worker && held.key === key) return held.promise;
        const worker = this.worker;
        const promise = (async () => {
            const value = await publish();
            if (this.worker !== worker) throw new Error('clan planning worker unavailable');
            return value;
        })();
        const publication = { worker, key, promise };
        this.publications.set(kind, publication);
        promise.catch(() => { if (this.publications.get(kind) === publication) this.publications.delete(kind); });
        return promise;
    }

    async ensureSpotCatalog(rows) {
        // A refresh and startup share one ordered publication: pages of two
        // generations must not interleave (SpotCatalogReader.apply). A
        // failed or incomplete generation cannot become a planning input.
        while (this.spotInitializing) await this.spotInitializing;
        const publication = this.publishOnce('spots', rows, async () => {
            const writer = new SpotCatalogWriter(++this.spotGeneration, rows);
            for (const page of writer.pages()) {
                await this.send('spot_catalog', { page });
                await yieldLoop();
            }
            return writer;
        });
        this.spotInitializing = publication;
        try { return await publication; }
        finally { if (this.spotInitializing === publication) this.spotInitializing = null; }
    }

    // The static context crosses once per worker and context revision: a
    // restarted worker or a new revision (rate, recipes, configured stores)
    // publishes it before the request. One message, so no wait: revisions
    // only grow and the worker plans with the newest it holds.
    async ensureContext() {
        const current = await this.planningContext();
        return this.publishOnce('context', current.revision, () => {
            DiagnosticConfig.developerDiagnostics && (this.stats.contextPublishes++);
            return this.send('planning_context', { context: current }).then(() => current.revision);
        });
    }

    async plan(payload, catalogs, spotCatalog = catalogs.spots || EMPTY_SPOTS) {
        if (this.activeJob && payload.jobKey !== this.activeJob) throw new Error('clan planning worker job busy');
        await this.ready(catalogs);
        const writer = await this.ensureSpotCatalog(spotCatalog);
        const contextRevision = await this.ensureContext();
        if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw new Error('clan planning deadline');
        this.tableChannel.flush();
        // In an admitted job the craft options and warehouse rows cross with
        // its first plan and are then named as held: `jobOptions` (moved out
        // of options, put back first by the worker) and `warehouseRows`.
        const inputs = payload.jobKey ? this.inputsFor(payload.jobKey) : null;
        let message = payload;
        if (inputs) {
            const options = { ...payload.options }, jobOptions = {}, held = [];
            for (const name of JOB_PLAN_OPTIONS) {
                if (!Object.hasOwn(options, name)) continue;
                jobOptions[name] = options[name];
                delete options[name];
            }
            message = { ...payload, options, held };
            const sent = inputs.values.jobOptions;
            if (sent && Object.keys(sent).length === Object.keys(jobOptions).length
                && Object.keys(jobOptions).every(name => sent[name] === jobOptions[name])) held.push('jobOptions');
            else message.jobOptions = jobOptions;
            if (Object.hasOwn(inputs.values, 'warehouseRows') && inputs.values.warehouseRows === payload.warehouseRows) {
                held.push('warehouseRows');
                delete message.warehouseRows;
            }
        }
        let result;
        try { result = await this.send('plan', { payload: writer.pack({ ...message, contextRevision }) }); }
        catch (error) {
            if (inputs && this.jobInputs === inputs) this.jobInputs = null;
            throw error;
        }
        if (inputs) Object.assign(inputs.values, { jobOptions: message.jobOptions || inputs.values.jobOptions,
            warehouseRows: payload.warehouseRows });
        DiagnosticConfig.developerDiagnostics && (this.stats.completed++);
        DiagnosticConfig.developerDiagnostics && (this.stats.maxRunMs = Math.max(this.stats.maxRunMs, result.durationMs));
        // The worker's heap after this run (WorkerHeapTelemetry.heapRecord).
        DiagnosticConfig.developerDiagnostics && result.v8Heap && (this.stats.v8Heap = result.v8Heap);
        return result.plan;
    }

    async withJob(deadlineAt, catalogs, work) {
        if (this.activeJob || this.pending.size >= this.maxPending) throw new Error('clan planning worker job busy');
        const jobKey = `raid-plan:${++this.sequence}`;
        this.activeJob = jobKey;
        try {
            await this.ready(catalogs);
            if (Date.now() >= deadlineAt) throw new Error('clan planning deadline');
            return await work(jobKey);
        } finally {
            if (this.worker && !this.closed) await this.send('end_planning_job', { jobKey }).catch(() => {});
            if (this.jobInputs?.jobKey === jobKey) this.jobInputs = null;
            if (this.activeJob === jobKey) this.activeJob = null;
        }
    }

    inputsFor(jobKey) {
        if (this.jobInputs?.jobKey !== jobKey || this.jobInputs.worker !== this.worker) {
            this.jobInputs = { jobKey, worker: this.worker, values: {}, prospects: new Map() };
        }
        return this.jobInputs;
    }

    // One recruitment page (ClanEquipmentService.prepareRecruitment): the
    // clan, spots, previous goal and requirements are the same objects on
    // every page of a job and cross once; a prospect already sent crosses as
    // its id. The worker returns each ready raid's decoration, put back on
    // the page's own spot row here.
    async prepareRaids(payload, catalogs, spotCatalog) {
        if (!this.activeJob || payload.jobKey !== this.activeJob) throw new Error('clan planning job not admitted');
        const writer = await this.ensureSpotCatalog(spotCatalog);
        const contextRevision = await this.ensureContext();
        if (Date.now() >= payload.deadlineAt) throw new Error('clan planning deadline');
        this.tableChannel.flush();
        const inputs = this.inputsFor(payload.jobKey);
        let message = { jobKey: payload.jobKey, deadlineAt: payload.deadlineAt, contextRevision, held: [],
            fundRaidSupplies: payload.fundRaidSupplies !== false, coreMemberIds: payload.coreMemberIds || null,
            unchargedHelperIds: payload.unchargedHelperIds || null };
        for (const name of ['clan', 'previousGoal', 'economicRequirements', 'spots']) {
            if (Object.hasOwn(inputs.values, name) && inputs.values[name] === payload[name]) message.held.push(name);
            else if (name === 'spots') message = writer.pack({ ...message, spots: payload.spots });
            else message[name] = payload[name];
        }
        const prospects = payload.prospects || [];
        message.prospects = prospects.map(member => member && inputs.prospects.get(memberId(member)) === member
            ? [1, memberId(member)] : [0, member]);
        let result;
        try { result = await this.send('prepare_raids', { payload: message }); }
        catch (error) {
            if (this.jobInputs === inputs) this.jobInputs = null;
            throw error;
        }
        Object.assign(inputs.values, { clan: payload.clan, previousGoal: payload.previousGoal,
            economicRequirements: payload.economicRequirements, spots: payload.spots });
        inputs.prospects = new Map(prospects.map(member => [memberId(member), member]));
        const spotById = new Map((payload.spots || []).map(spot => [spot.id, spot]));
        const Roster = require('./ClanRosterDemand');
        return { ...result, raids: result.raids.map(raid => Roster.decoratedRaid(spotById.get(raid.id), raid)) };
    }

    async shutdown() {
        this.closed = true;
        const worker = this.worker;
        if (worker) {
            this.release(new Error('clan planning worker stopped'));
            await worker.terminate();
        }
    }

    // restarts always; the rest with developer diagnostics.
    metrics() {
        return { ...(DiagnosticConfig.developerDiagnostics ? this.stats : { enabled: false }), restarts: this.restarts,
            pending: this.pending.size, running: !!this.worker };
    }
}

let coordinator = null;
let enabled = false;
// One static market, for the current rate and published recipes: its NPC
// offers cover the recipes' materials, so a new rate or recipe set (a
// crafter level change) replaces it.
let staticMarket = null;
// The planning context crosses to the worker once per revision. A new
// revision only when one of its owners hands out a new value: the per-rate
// NPC market, the configured stores' rows, the published recipes, the settings.
let planningContext = null;
let planningContextRevision = 0;

function offerRow(offer) {
    // Live sessions, actors and mutable store entries never cross the boundary.
    const { selfId, sourceType, sourceId, town, price, count, available, sellerKind, playerPriority } = offer;
    return { selfId, sourceType, sourceId, town, price, count, available, sellerKind, playerPriority };
}

async function buildStaticMarket(recipes) {
    const items = BotGear.currentWearableRows(DataCache.items);
    const npcOffers = [];
    const supplyIds = [...new Set([...items.map(item => item.selfId),
        ...invoke('GameServer/Inventory/ShotStock').SHOT_IDS,
        ...recipes.flatMap(recipe => recipe.materials.map(row => row.selfId))])];
    for (let i = 0; i < supplyIds.length; i++) {
        npcOffers.push(...MarketOpportunity.npcOffersAll(supplyIds[i]).map(offerRow));
        if (i % 8 === 7) await yieldLoop();
    }
    const shopEntries = NpcShopBuyLists.allEntries().map(({ selfId }) => ({ selfId }));
    // The worker prices with main's whole NPC table (gear, craft inputs,
    // consumables), the one the cold worker gets too. Scalar quotes do not add
    // sources to MarketOpportunity.
    const npcPriceRows = BotMarketPricing.npcPriceRows();
    return { npcOffers, npcPriceRows, towns: MarketOpportunity.TOWN_NPC_SELLERS, shopEntries };
}

// Callers during a build share it; a failed build is not kept.
function staticMarketFor(rate, recipes) {
    const shotsDisabled = require('../Bot/Population/PopulationConfig').staticShotsDisabled;
    if (staticMarket?.rate !== rate || staticMarket.recipes !== recipes || staticMarket.shotsDisabled !== shotsDisabled) {
        const entry = { rate, recipes, shotsDisabled, value: buildStaticMarket(recipes) };
        staticMarket = entry;
        entry.value.catch(() => { if (staticMarket === entry) staticMarket = null; });
    }
    return staticMarket.value;
}

async function context() {
    // The rate or recipes may change during a build: a context is made only
    // from the current ones, so a newer revision never carries older recipes.
    let recipes, rate, built;
    do {
        recipes = CraftShopService.publishedStationRecipes().recipes;
        rate = ProgressionRates.profile().multiplier;
        built = await staticMarketFor(rate, recipes);
    } while (recipes !== CraftShopService.publishedStationRecipes().recipes || rate !== ProgressionRates.profile().multiplier);
    // The board reaches the worker as its 'board' table. The configured
    // stores' rows are frozen per economy rate and store config
    // (FixedShotOffers.offers): the same array until one of them changes.
    const fixed = MarketOpportunity.fixedStoreOffers();
    const general = {};
    for (const key of ['progressionPreset', 'expRate', 'spRate', 'adenaRate', 'dropChanceRate', 'spoilRate', 'maxLevel']) {
        general[key] = global.options.default.General?.[key];
    }
    const progression = { contentCap: global.options.default.Progression?.contentCap };
    const progressionRate = process.env.L2NODE_PROGRESSION_RATE;
    const settings = [...Object.values(general), progression.contentCap, progressionRate].join('|');
    const held = planningContext;
    if (held?.staticMarket !== built || held.fixed !== fixed || held.recipes !== recipes || held.settings !== settings) {
        planningContext = { staticMarket: built, fixed, recipes, settings, value: { revision: ++planningContextRevision, ...built,
            fixedOffers: fixed.map(offerRow), recipes, general, progression, progressionRate } };
    }
    return planningContext.value;
}

module.exports = {
    ClanPlanningCoordinator,
    start() { enabled = true; coordinator ||= new ClanPlanningCoordinator(); },
    enabled: () => enabled,
    context,
    plan: (payload) => coordinator.plan(payload, DataCache, invoke('GameServer/Bot/Population/SpotProfiles').ensure()),
    withJob: (deadlineAt, work) => coordinator.withJob(deadlineAt, DataCache, work),
    prepareRaids: payload => coordinator.prepareRaids(payload, DataCache, invoke('GameServer/Bot/Population/SpotProfiles').ensure()),
    metrics: () => coordinator?.metrics() || { running: false, pending: 0, restarts: 0 },
    shutdown: () => coordinator?.shutdown()
};

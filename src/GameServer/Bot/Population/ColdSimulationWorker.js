const { parentPort, workerData } = require('worker_threads');
const epoch = String(workerData?.workerEpoch || 'cold-worker');
// Resolve the master before loading planning modules; inherited env cannot bypass Main's config.
process.env.BOT_DEVELOPER_DIAGNOSTICS = workerData?.developerDiagnostics === true ? 'true' : 'false';
const CharacterLocationRuntime = require('../../World/CharacterLocationRuntime');
const workerProjectorRole = CharacterLocationRuntime.beginWorkerProjectorRole(epoch);
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
let heapTelemetry = null;

const srcRoot = path.resolve(__dirname, '../../..');
require(path.join(srcRoot, 'Global'));
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
if (workerData?.sharedGeodata) GeodataEngine.attachShared(workerData.sharedGeodata);

const DataCache = invoke('GameServer/DataCache');
// Main checked these files against their schemas at startup; that check was ~3/4 of this boot (L71).
DataCache.init({ validate: false });

const originalInvoke = global.invoke;
const npcShopTables = originalInvoke('GameServer/World/Generics/NpcShopBuyLists');
const forbidden = /^(Database|GameServer\/World(?:\/|$)|GameServer\/Bot\/BotManager|GameServer\/Network(?:\/|$)|Server$)/;
const stubs = new Map([
    ['Database', new Proxy({ isReady: () => false }, {
        get(target, property) {
            if (property in target) return target[property];
            return () => Promise.reject(new Error(`cold worker database call forbidden: ${String(property)}`));
        }
    })],
    ['GameServer/Effects/EffectStore', {
        BUFF_LIMIT: 20,
        DEBUFF_RESERVED_SLOTS: 4,
        includedInBuffCount: (effect) => effect?.type !== 'debuff'
            && effect?.type !== 'item_passive'
            && effect?.toggle !== true
            && !['hp_recover', 'life_force_orc'].includes(effect?.stackFamily),
        list: () => [],
        // A cold actor carries no live effects: nothing impairs it (PetHealRule.choose).
        impairments: () => ({ disabled: false, afraid: false, confused: false, rooted: false, silenced: false,
            physicalMuted: false, magicMuted: false })
    }],
    ['GameServer/Skills/ChargeLifecycle', { EXPIRY_MS: 600000 }],
    ['GameServer/Bot/AI/BotRaidSafety', {
        isRaidBoss: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss',
        isProtectedRaidEntity: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss'
            || Number(target?.minionBossObjectId || target?.minionBossTemplateId || 0) > 0
    }],
    // The board comes from the 'board' table (boardIndex below); NPC rows from
    // the planning catalog (ColdNpcPlanningCatalog).
    ['GameServer/Bot/Economy/MarketOpportunity', {
        TOWN_NPC_SELLERS: {},
        npcOffersAll: () => [],
        bestOffer: (selfId, options = {}) => invoke('GameServer/Bot/Economy/OfferQuery').bestSellOffer(boardReady(), selfId, {
            towns: options.town ? [options.town] : options.towns || null,
            excludeOwner: options.buyerCharacterId,
            budget: options.budget,
            cost: options.cost,
            accept: offer => invoke('GameServer/Bot/Population/PartyAdmission').personalOfferAllowed(offer,
                kernel?.states.get(Number(options.buyerCharacterId))?.state) && (!options.accept || options.accept(offer))
        })
    }],
    // Immutable map boundaries only; no live World, geodata or database access.
    ['GameServer/World/WorldAreaCatalog', { resolve: originalInvoke('GameServer/World/WorldAreaCatalog').resolve }],
    ['GameServer/World/TownRespawn', originalInvoke('GameServer/World/TownRespawn')],
    // Cold bots have no live summon (PartyBuffLoadout.build asks for one); SummonControl loads Network and World.
    ['GameServer/Npc/SummonControl', { activeSummon: () => null }],
    // The game clock is a pure function of the timestamp (cold night bonuses).
    ['GameServer/World/GameTime', originalInvoke('GameServer/World/GameTime')],
    ['GameServer/World/WorldConstants', originalInvoke('GameServer/World/WorldConstants')],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [],
        townOffers: npcShopTables.townOffers }]
]);

// A name passes the boundary check once; hot paths call invoke() per decision.
const allowedModules = new Set();
global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (!allowedModules.has(module)) {
        if (forbidden.test(String(module || ''))) {
            throw new Error(`cold worker forbidden dependency: ${module}`);
        }
        if (typeof module === 'string') allowedModules.add(module);
    }
    return originalInvoke(module);
};

const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
BotMarketPricing.useNpcOfferSnapshot([]);
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const LifeStateProjector = invoke('GameServer/Bot/Population/BotLifeState');
const PartyRequirementRefresh = invoke('GameServer/Bot/Population/PartyRequirementRefresh');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const DecisionEvents = require('../AI/DecisionEvents');
const SavedStats = require('../SavedStats');
const { stateKey } = require('./SpotOccupancyIndex');
const DecisionSections = invoke('GameServer/Bot/Economy/DecisionSections');
const Situations = invoke('GameServer/Bot/Situations');
const GearMarks = require('../AI/GearMarks');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Protocol = require('./ColdSimulationProtocol');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const ColdEconomyPlan = require('./ColdEconomyPlan');
const RecomputeGeneration = require('./RecomputeGeneration');
const PersonalWarehouseIndex = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const ClanSupplyPolicy = invoke('GameServer/Clan/ClanSupplyPolicy');
const ClanMembershipPolicy = require('../../Clan/ClanMembershipPolicy');
const { ColdOccupationPlanner } = require('./ColdOccupationPlanner');
const OccupationSources = require('./ColdOccupationSources');
const EconomicTrip = require('../Economy/EconomicTrip');
const { fnv1a32, textDigest } = require('../Fnv1a');
const WealthCraftPolicy = require('../Economy/WealthCraftPolicy');
const RequiredPartyFormation = require('./RequiredPartyFormation');
const SpotContest = require('./SpotContest');
const EnemyMet = require('./EnemyMet');
const PartyHuntingTarget = require('./PartyHuntingTarget');
const ColdCompetitionEpisode = require('./ColdCompetitionEpisode');
const ColdCompetitionRetreat = require('./ColdCompetitionRetreat');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const { SpotContestOutbox } = require('./SpotContestOutbox');
const FailureLog = require('../../../FailureLog');
const { ColdSimulationKernel } = require('./ColdSimulationKernel');
const PartyGoalCalculation = require('./PartyGoalCalculation');
const { beginHuntingTrip } = require('./HuntingTravel');
const PveEncounter = require('./ColdPveEncounter');
const BotRoute = require('./BotRoute');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableMirror = require('./TableMirror');
const { BoardIndex, recordOf, escrowOf } = require('../../AfkTrade/BoardIndex');
const ColdPvpResolver = invoke('GameServer/Bot/Population/ColdPvpResolver');
const { MarketBuyerWaiters } = require('../Economy/MarketBuyerWaiters');
const SpotIndex = require('../AI/SpotIndex');
const SpotService = require('../AI/SpotService');
const SpotValueTable = require('../AI/SpotValueTable');
// Main's spot table rows (one SharedArrayBuffer per process).
if (workerData?.spotTable) SpotValueTable.attachShared(workerData.spotTable);
const ColdCombatProfile = require('./ColdCombatProfile');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const CraftEligibility = require('../Economy/CraftEligibility');
const RecipeBookCodec = require('../Economy/RecipeBookCodec');
const EconomyCommit = require('../Economy/EconomyCommit');
const VisitNeed = require('../../ClanHall/VisitNeed');
const HallPolicy = require('../../ClanHall/Policy');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
// The scheduler wakes at kernel.nextWakeAt() (one timer on the nearest
// deadline).
// Longest idle sleep: the bound on a wake missed by a path that adds work
// without a re-arm (a resolve finishing between messages).
const LOOP_IDLE_CAP_MS = 250;
let loopTimer = null;
let loopIntervalMs = 20;
let loopArmedAt = 0;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
// The spot aggregate's outcomes on their way to main (SpotContestOutbox), made with the kernel.
let outbox = null;
let safetyStateReady = false;
let safetyStateRepairs = 0;
let safetyOrphanRepairs = 0;
let previousElu = null;
let planningSpots = [];
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(() => planningSpots);
// The sale retry reads the buyers of a bot's unsold goods on this thread's board.
invoke('GameServer/Bot/Economy/ItemDisposition').useBoard(() => boardReady());
let planningNpcOfferRows = [];
const tables = new TableMirror({ actorProjectorRole: workerProjectorRole });
// Planning producers import this same collector; its worker cap is64 rows.
const economyDiagnostics = require('../Economy/EconomyDiagnostics');
// The board's offers, built from the main thread's 'board' table as it changes.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const Trace = require('../DecisionTrace');
const boardIndex = new BoardIndex({ groupOf: MarketCounters.counterOf });
const buyerWaiters = new MarketBuyerWaiters({
    stateFor: id => kernel?.states.get(id)?.state,
    demandsFor: (state, timestamp) => invoke('GameServer/Bot/Economy/MarketDemandIndex').signalsOfState(state, timestamp),
    wake: (id, timestamp, offer) => kernel?.wakeBuyer(id, timestamp, offer) === true
});
const boardFollower = boardIndex.follower();
// A whole 'board' or 'market' table is being replaced: set by its reset, cleared
// by the table_page whose piece ends the full copy (TableMirror ready), which
// then rechecks the occupation slots against the whole new copy once. A gap
// during the copy asks for it again (table_resync); that copy's reset keeps
// the flag and its last piece ends the wait.
let boardReplacing = false, marketReplacing = false;
// A bot's own route preparation in flight (occupationFor mode wish), keyed by
// its id (the cap's count); the finished rows are the bot's wish card.
const routeRequests = new Map();
const publicWorkshopIndex = new (require('../Economy/PublicWorkshopIndex').PublicWorkshopIndex)();
const publicWorkshopKeys = new Map(), workshopRevisions = new Map(), workshopDigests = new Map(), workshopScopeDigests = new Map();
const digestToken = value => value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
function refusalWorkshopDigest(scope) { return digestToken(workshopScopeDigests.get(scope)); }
// A known empty workshop in the one shape the context key and the decision
// packing read; a missing field would key a different planning input.
const { noWorkshop, noCrafterWorkshop } = ColdEconomyDecision;
function workshopsFor(recipeId, state) { return publicWorkshopIndex.candidates(recipeId, Number(state?.characterId || 0)); }
function changeWorkshop(key, row) {
    const previous = publicWorkshopKeys.get(key);
    const recipeId = Number(row?.[1] || previous?.recipeId);
    if (!(recipeId > 0)) return;
    if (previous) { publicWorkshopKeys.delete(key); publicWorkshopIndex.remove(key); }
    if (row) {
        const value = { characterId: row[0], recipeId, price: row[2], entryPrice: row[2], townName: row[3],
            loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7], publicStation: row[8] === 1 };
        publicWorkshopKeys.set(key, value); publicWorkshopIndex.put(key, value);
    }
    const productId = Number(invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId)?.productId || 0);
    if (productId) {
        const digest = workshopDigests.get(productId) || { xor: 0, sum: 0, count: 0 };
        const scalar = value => [value.characterId, value.recipeId, value.entryPrice, value.townName, value.loc.locX, value.loc.locY, value.loc.locZ, value.capacityBatches, value.publicStation ? 1 : 0];
        const change = (values, step) => {
            const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(values));
            digest.xor = (digest.xor ^ hash) >>> 0; digest.sum = (digest.sum + step * hash) >>> 0; digest.count += step;
        };
        if (previous) change(scalar(previous), -1);
        if (row) change(row, 1);
        if (digest.count) workshopDigests.set(productId, digest); else workshopDigests.delete(productId);
        const scope = MarketCounters.counterOf(productId), scoped = workshopScopeDigests.get(scope) || { xor: 0, sum: 0, count: 0 };
        const updateScope = (values, step) => { const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(values));
            scoped.xor = (scoped.xor ^ hash) >>> 0; scoped.sum = (scoped.sum + step * hash) >>> 0; scoped.count += step; };
        if (previous) updateScope(scalar(previous), -1); if (row) updateScope(row, 1);
        if (scoped.count) workshopScopeDigests.set(scope, scoped); else workshopScopeDigests.delete(scope);
        occupationPlanner.groupChanged(scope);
        workshopRevisions.set(productId, (workshopRevisions.get(productId) || 0) + 1); occupationPlanner.sourceChanged(productId); }
}
const EDGE_STEPS = 64;
const WORK_STAGES = Object.freeze(['stock', 'recipe', 'ingredient', 'owned', 'quote', 'trip', 'exit', 'without', 'success', 'utility', 'candidate', 'funding', 'edge']);
// A workshop card's window: the demand forecasts' clock decay has no event
// (debt.md 25); 30 game min (5 real min) is ~8% demand drift.
const WORKSHOP_SERVE_MS = 30 * invoke('GameServer/World/GameTime').GAME_MINUTE_MS;
// A planner job's inputs (ColdOccupationPlanner): a short key of the inputs
// beside the state (inputKey) and, compared only when that one matches, the
// digest of the state values the mode reads (valueKey), one per state object.
// - wish: the route table's inputs (EconomicTrip.key): the rows read nothing else.
// - occupation (a crafter's workshop): beside the state, the recipe book and
//   known shot recipes, the escrow, the route key (the rows), the warehouse
//   and clan supply versions and whether the board and market copies are
//   whole; of the state, its top-level fields but the commit stamps
//   (updatedAt, simulation, timing: the meeting's authority and diagnostics
//   read them), its max MP and its MP as the band its craft checks answer
//   alike on (WealthCraftPolicy.craftMpBand; no workshop rule reads HP or CP),
//   and the stats fields the workshop's modules read (WORKSHOP_STATS:
//   ColdOccupationSources, WealthCraftDecision and the modules they require,
//   traced over the perf save's crafters); the kit's class beside the stats'
//   (InventoryLimits). A cold state with no stored max MP reads its combat
//   profile (ColdOccupationSources.craftLabour): all of it but the stamps.
//   Board and market rows are the job's read tokens (sourceChanged). Not in
//   it: the clock its sale exits read through the demand forecasts
//   (MarketTradeDemand: the trades of an item decay by an e-fold per uptime
//   hour, with no event between two trades): a finished workshop serves for
//   its own window (WORKSHOP_SERVE_MS, servesUntil; limits.md "Occupation planner").
// - action, showcase, craft_market: beside the state, the same with the
//   step's stock target, the step's economy (the object the step built) and
//   the step clock, which the plan reads directly (SurvivalFloor's cooldowns
//   and sale retry, the errands' expiry, price beliefs): a finished one serves
//   its step only. Of the state, all of it but the stamps, with HP and the MP
//   band (the exact MP of a bot that rests for mana: SurvivalFloor's cast
//   costs): the plan reads its kit, bag, goals and combat state. Computed only
//   for an ask on the step's own clock and economy (a second ask of the step,
//   a job in flight across main's resend).
// - near, page, meeting: the asked state object (they build the economy,
//   which reads the bot's memory rows, crowd and goals beside the state: a new
//   state object stands for their moves) and the inputs asked beside it: the
//   warehouse and clan supply versions, the escrow, the recipe book and known
//   shot recipes, whether the board and market copies are whole, the pending
//   page count and a meeting's token. A short string, no state read.
const CLOCK_MODES = new Set(['action', 'showcase', 'craft_market']);
const IDENTITY_MODES = new Set(['near', 'page', 'meeting']);
const STATE_STAMPS = Object.freeze({ updatedAt: undefined, simulation: undefined, timing: undefined });
const WORKSHOP_STATS = Object.freeze(['workshop', 'dwarvenCraftLevel', 'classId', 'race', 'money', 'equipmentPlan',
    'wishFocus', 'craftStationId', 'craftShop', 'clanId', 'travel', 'marketReturn', 'karma', 'clanMaterialDemand',
    'clanMarketDemand', 'marketErrand', 'marketErrands', 'marketSellSeen', 'wealthRefused', 'wealthCraft', 'shotCraft',
    'kitRates', 'dangerPrice', 'tradeMeeting', 'townLook', 'hennas', 'generatedIndex', 'playerPartyTakeover',
    'decisionSeq', 'activityLeaf', 'economyClock', 'playedHours', 'frustration', 'lifelongKills', 'exp', 'earning']);
const objectSerials = new WeakMap();
let nextObjectSerial = 0;
const serialOf = value => value && typeof value === 'object'
    ? objectSerials.get(value) ?? (objectSerials.set(value, ++nextObjectSerial), nextObjectSerial) : 0;
// The digest of a state's values per variant ([workshop, plan]), built once
// per state object: a state is replaced, not edited (the near publish's mind
// merge drops its entry after the jobs asked on it keep theirs).
const stateDigests = new WeakMap();
function stateDigest(state, variant) {
    let digests = stateDigests.get(state);
    if (!digests) stateDigests.set(state, digests = [null, null]);
    return digests[variant] ??= textDigest(variant ? planValues(state) : workshopValues(state));
}
const mpBand = state => WealthCraftPolicy.craftMpBand(CraftEligibility.craftLevelFor(state), state.vitals?.mp);
function workshopValues(state) {
    if (state.phase !== 'hot' && !(Number(state.vitals?.maxMp) > 0)) return JSON.stringify({ ...state, ...STATE_STAMPS });
    const stats = state.stats || {};
    return JSON.stringify([{ ...state, ...STATE_STAMPS, vitals: undefined, stats: undefined }, Number(state.vitals?.maxMp || 0),
        mpBand(state), WORKSHOP_STATS.map(key => stats[key]), stats.coldCombat?.classId]);
}
function planValues(state) {
    const mp = invoke('GameServer/Bot/AI/BotRoles').shouldRestForMana(state) ? state.vitals?.mp : mpBand(state);
    const vitals = state.vitals && { ...state.vitals, mp };
    const stats = state.stats && state.stats.wishAdvisory !== undefined ? { ...state.stats, wishAdvisory: undefined } : state.stats;
    return JSON.stringify({ ...state, ...STATE_STAMPS, vitals, stats });
}
function plannerInputKey(input) {
    const mode = input.mode || 'occupation';
    if (mode === 'wish') return input.routeKey;
    const beside = `${input.assetsKey}|${Number(input.buyOrderEscrow || 0)}|${input.sourceReady ? 1 : 0}|${input.recipeBook ?? ''}|${input.knownShotRecipes ?? ''}`;
    if (IDENTITY_MODES.has(mode)) return `${serialOf(input.state)}|${beside}|${Number(input.pending || 0)}|${input.meeting?.token ?? ''}`;
    return textDigest(JSON.stringify([mode, input.routeKey, beside, CLOCK_MODES.has(mode)
        ? [Number(input.timestamp), serialOf(input.economy), input.stock ?? null] : null]));
}
function plannerValueKey(input) {
    const mode = input.mode || 'occupation';
    return mode === 'wish' || IDENTITY_MODES.has(mode) ? '' : stateDigest(input.state, +CLOCK_MODES.has(mode));
}
const occupationPlanner = new ColdOccupationPlanner({
    onPublishError: (error, characterId, input) => send('fault', {
        reason: 'occupation_publication_failed', characterId, mode: input.mode,
        stack: String(error?.stack || error).slice(0, 4096)
    }),
    sourceToken: (id, mode) => mode === 'meeting'
        ? `${boardIndex.groupFingerprint(MarketCounters.counterOf(id))}|${MarketCounters.meetingRevisionOf(MarketCounters.counterOf(id))}|${digestToken(workshopScopeDigests.get(MarketCounters.counterOf(id)))}`
        : `${boardIndex.itemRevision(id)}:${tables.rows('market').get(`i:${id}`)?.[1] || 0}:${tables.rows('market').get(`h:${id}`)?.[1] || 0}:${MarketCounters.revisionOf(MarketCounters.counterOf(id))}:${workshopRevisions.get(id) || 0}`,
    sourceScope: id => MarketCounters.counterOf(id),
    sourceScopeToken: scope => OccupationSources.recipeIndex(boardIndex).revision(scope),
    // The kernel's state the job was asked on, or a later one it reads the
    // same on (kernel.states.set rebases it).
    ownCurrent: (id, input) => !shuttingDown && kernel?.states.get(id)?.state === input.sourceState,
    inputKey: plannerInputKey,
    valueKey: plannerValueKey,
    servesUntil: input => (input.mode || 'occupation') === 'occupation' ? Number(input.timestamp) + WORKSHOP_SERVE_MS : Infinity,
    capture: (id, input, read, readScope) => {
        const book = RecipeBookCodec.unpack(input.recipeBook);
        const exactReads = input.mode === 'meeting' ? new Map() : null;
        const readItem = exactReads ? itemId => {
            itemId = Number(itemId);
            if (itemId > 0 && !exactReads.has(itemId)) exactReads.set(itemId, boardIndex.itemFingerprint(itemId));
            read(itemId);
        } : read;
        return { source: input, state: input.state, board: boardReady(), timestamp: input.timestamp, read: readItem, readScope, exactReads,
            knownRecipes: book || input.state.stats?.workshop?.entries || [], knownShotRecipes: input.knownShotRecipes || [],
            recipesKnown: book !== null || Array.isArray(input.state.stats?.workshop?.entries), bookKnown: book !== null,
            buyOrderEscrow: input.buyOrderEscrow, stock: input.stock || null, economy: input.economy || null,
            routeRows: input.routeRows || null, routeKey: input.routeKey, mode: input.mode || 'occupation', meeting: input.meeting, pending: input.pending };
    },
    create: input => occupationWork(input, (function* () {
        if (input.mode === 'wish') return yield* EconomicTrip.prepare(input.state);
        if (input.mode === 'showcase' || input.mode === 'craft_market') return { economyPlan:
            yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                showcaseOnly: input.mode === 'showcase', now: input.timestamp, board: input.board, tripCost: input.economy.trip,
                saleHold: saleHold(input.state.characterId),
                buyOrderEscrow: input.buyOrderEscrow,
                npcOffersFor: OccupationSources.npcOffersFor,
                findSpot: id => SpotIndex.spotById(planningSpots, id)
            }) };
        if (input.mode === 'meeting') {
            const request = input.meeting, ownId = Number(input.state.characterId);
            const side = request.actorA === ownId ? 0 : 1, own = request.parties[side];
            if (!EconomyCommit.sameAuthority(own, EconomyCommit.authority(input.state))) throw Error('trade_meeting_authority_changed');
            // Public shot flow can admit another earning recipe before the
            // old graph reads its product. At most five category dependencies
            // cover the craftable grades, including currently absent demand.
            const craftLevel = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(input.state);
            for (const recipeId of invoke('GameServer/Bot/Economy/ShotCraftPolicy').SHOT_RECIPE_IDS) {
                const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId);
                if (recipe && recipe.level <= craftLevel) input.read(Number(recipe.productId));
            }
            const routeRows = yield* EconomicTrip.prepare(input.state);
            const Context = invoke('GameServer/Bot/Economy/EconomyContext');
            // Fresh physical incoming is delivered in the native owner snapshot.
            // Reuse the bounded graph/seed; no price or private plan from another actor.
            const economy = Context.forState(input.state, { board: input.board, routeRows, workshops: workshopsFor,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, workshop: noWorkshop(),
                buyOrderEscrow: input.buyOrderEscrow, npcOffersFor: OccupationSources.npcOffersFor,
                // A meeting review (its own workshop input, maybe the meeting's incoming) never
                // replaces the bot's held plan: its next request still finds it (L133).
                caller: 'meeting_prepare', trigger: request.token, deal: new Set(request.lines.filter(line => line.payer === side).map(line => line.selfId)) });
            yield 'candidate';
            if (economy.intentPending) throw Error('trade_meeting_preparation_pending');
            const intents = invoke('GameServer/Bot/Economy/TradeIntent').project(input.state, economy.network, economy.projection,
                id => economy.worth(id) ?? economy.price(id), 40, economy.board, economy.trip?.details);
            if (!intents) throw Error('trade_meeting_preparation_pending');
            const routePlan = invoke('GameServer/Bot/Population/ColdTrip').meetingTownPlan(input.state, request.point);
            if (!routePlan) throw Error('trade_meeting_route');
            const shared = /^meeting:([1-9][0-9]*)$/.exec(own.route.method);
            if (shared && Number(shared[1]) !== Number(input.state.stats?.tradeMeeting?.[0])) throw Error('trade_meeting_route_changed');
            own.route = shared ? { fee: 0, scroll: false, method: own.route.method, durationMs: 0 }
                : { fee: routePlan.route.fee, scroll: !!routePlan.scroll, method: routePlan.method, durationMs: routePlan.durationMs };
            let total = own.route.fee, valueRate = Infinity, sellerDecision = null;
            let productionReviewed = false, productionOpportunity = null;
            const survival = new Map();
            const required = new Map(), sold = new Map();
            for (const line of request.lines) if (line.payer === side) required.set(line.selfId, (required.get(line.selfId) || 0) + line.count);
            else sold.set(line.selfId, (sold.get(line.selfId) || 0) + line.count);
            for (const line of request.lines) {
                input.read(line.selfId);
                if (line.payer === side) {
                    let intent = invoke('GameServer/Bot/Economy/TradeIntent').meetingPurchase(economy.network, intents,
                        { selfId: line.selfId, count: required.get(line.selfId), price: line.price,
                            town: request.town, enchant: Number(line.enchant || 0) }, input.state);
                    const job = input.state.stats?.wealthCraft;
                    if (!intent && job?.outcome === 'buying') {
                        if (!productionReviewed) {
                            productionReviewed = true;
                            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(job.recipeId));
                            const batches = Number(job.batches);
                            const relevant = recipe && (Number(recipe.recipeItemId) === Number(line.selfId)
                                || recipe.materials.some(row => Number(row.selfId) === Number(line.selfId)));
                            if (relevant && Number.isSafeInteger(batches) && batches > 0 && batches <= 64) {
                                // The production basket prices physical inputs. A separate
                                // accepted delivery may still be cancelled or arrive, so
                                // wait for it rather than buy the same inputs twice.
                                if ([recipe.recipeItemId, ...recipe.materials.map(row => row.selfId)]
                                    .some(id => Number(input.state.acceptedIncoming?.[id] || 0) > 0))
                                    throw Error('trade_meeting_preparation_pending');
                                // Workshop entries are only the public subset; learning
                                // must be priced against the complete native book.
                                if (!input.bookKnown) throw Error('trade_meeting_preparation_pending');
                                const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
                                const remaining = Errands.pending(input.state, input.timestamp).filter(row =>
                                    !(Number(row.selfId) === Number(line.selfId) && row.town === request.town
                                        && ['wealth_craft', 'recipe'].includes(row.purpose)));
                                const state = Errands.withPending(input.state, remaining);
                                const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
                                if (Wealth.eligible(state, { ownLines: input.board.ownerLines(ownId), now: input.timestamp })) {
                                    const prepared = yield* OccupationSources.prepare(state, { ...input, targetRecipe: recipe,
                                        stock: economy.stock('shots'), economy, routeRows, routeKey: EconomicTrip.key(state) });
                                    if (prepared) {
                                        const cursor = Wealth.createAction(state, input.knownRecipes,
                                            { ...prepared.context, fixedBatches: batches },
                                            { ...prepared.options, onlyRecipeId: recipe.recipeId });
                                        while (!Wealth.stepAction(cursor)) yield cursor.stage;
                                        productionOpportunity = Wealth.resultAction(cursor);
                                    }
                                }
                            }
                        }
                        intent = require('../Economy/ProductionMeeting').purchaseIntent(productionOpportunity, line,
                            required.get(line.selfId), request.town);
                    }
                    if (!intent) throw Error('trade_meeting_need_changed');
                    if (economyDiagnostics.active() && !intents.some(row => row.itemId === line.selfId
                        && row.amount >= required.get(line.selfId)
                        && invoke('GameServer/Bot/Economy/TradeIntent').purchaseWorth(row, economy.network.moneyPrice) >= line.price)) {
                        economyDiagnostics.count('meeting', 'purchase_consent', 'selected_quote');
                        if (Trace.detailed(ownId)) Trace.detail({ owner: ownId,
                            trigger: request.token, phase: 'meeting_consent', reason: 'selected_quote',
                            wishKey: intent.key, item: line.selfId, requested: line.count, unitPrice: line.price,
                            quote: intents.find(row => row.itemId === line.selfId)?.worth || 0 });
                    }
                    line.certificate = invoke('GameServer/Bot/Economy/TradeIntent').encode({ ...intent, amount: line.count, price: line.price, valueHours: intent.valueHours * line.count / intent.amount });
                    line.needAdId = line.needAdRevision = 0; own.needRevision = own.revision;
                    // Survival first (each item's kit cost once), the rest by the
                    // wish's rank, as every other restock (PurchaseFunding.stockAllowance).
                    valueRate = Math.min(valueRate, intent.valueRate);
                    survival.set(line.selfId, Math.round(economy.kitCost?.(line.selfId, line.price) || 0));
                    total += line.count * line.price;
                } else {
                    // An old own SELL quote must not bypass personal stock
                    // protection when preparing a new meeting.
                    if (invoke('GameServer/Inventory/ShotStock').isPersonalShot(input.state, line.selfId))
                        throw Error('trade_meeting_protected_stock');
                    const item = input.state.inventory?.[line.selfId];
                    const free = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(input.state, item || {});
                    if (free < sold.get(line.selfId)) throw Error('trade_meeting_protected_stock');
                    const quote = input.board?.records.get(line.adId)?.find(row => row.selfId === line.selfId);
                    if (Number(quote?.ownerId) !== ownId) {
                        if (!sellerDecision) {
                            const listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
                            const saleInput = listing.ownSaleInputs(input.state, input.board?.ownerLines(ownId) || [],
                                { economy, board: input.board, npcOffersFor: OccupationSources.npcOffersFor,
                                    findSpot: id => SpotIndex.spotById(planningSpots, id),
                                    now: input.timestamp, decisionPoint: `meeting:${request.token}`,
                                    selectedAnswer: { selfId: line.selfId, enchant: line.enchant, recordId: line.adId } });
                            sellerDecision = listing.evaluate(saleInput.state, saleInput.options);
                        }
                        const answer = sellerDecision.answers.find(row => row.item.selfId === line.selfId
                            && Number(row.line.recordId) === line.adId && row.count >= line.count);
                        if (!answer) throw Error('trade_meeting_sale_changed');
                    }
                }
                yield 'funding';
            }
            // The native accept checks the same terms (TradeMeeting funding).
            own.survivalCost = [...survival.values()].reduce((a, b) => a + b, 0);
            // The transaction pays only from the physical wallet, not from
            // buy-shop escrow. A seller's fare also uses free money, whose
            // protected goal and survival reserves still apply.
            const fundingState = { adena: input.state.adena, stats: { money: input.state.stats?.money } };
            const spendable = invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(fundingState, 0,
                { r: valueRate, free: survival.size === 0, survivalCost: own.survivalCost });
            if (!Number.isSafeInteger(total) || total > spendable || own.route.fee > Number(input.state.adena || 0))
                throw Error('trade_meeting_funding');
            try {
                invoke('GameServer/Bot/Economy/BidPurchaseAlternative').assertMeetingPurchase(request.lines, side, request.town, {
                    state: input.state, characterId: ownId, adena: Number(input.state.adena || 0), hour: economy.hourAdena,
                    economy, board: input.board, travelDetails: economy.trip.details,
                    proofMoney: Math.min(spendable, Number(input.state.adena || 0)),
                    npcOffersFor: OccupationSources.npcOffersFor
                }, Math.min(spendable, Number(input.state.adena || 0)));
            } catch (error) {
                if (error.message === 'trade_meeting_purchase_price_changed' && error.purchase) {
                    const slot = occupationPlanner.entry(ownId, 'meeting');
                    if (!slot || kernel.states.get(ownId)?.state !== slot.input.sourceState) throw error;
                    const itemId = error.purchase.selfId;
                    const refusals = invoke('GameServer/Bot/Economy/MeetingPriceRefusals');
                    const npcAllowed = invoke('GameServer/Bot/Economy/ProductionPolicy').allowsNpcShot(itemId);
                    if (error.independentPriceProof && refusals.witnessCurrent(input.board, error.priceWitness, error.purchase)) {
                        error.priceEvidence = { purchase: error.purchase, authority: EconomyCommit.authority(input.state),
                            updatedAt: Number(input.state.updatedAt || 0), scopes: [], offers: error.priceWitness, npcAllowed,
                            fundingDominance: true };
                        refusals.remember(slot.input.sourceState, input.board, request, error.purchase,
                            refusals.sourceCheck(input.board, error.priceEvidence, {
                                meetingRevisionOf: MarketCounters.meetingRevisionOf, workshopDigest: refusalWorkshopDigest }),
                            { fundingDominance: true });
                        throw error;
                    }
                    // A thrown preparation bypasses the planner's ordinary
                    // final validation. A changed source cannot prove a
                    // refusal to another seller.
                    if (slot.dirty
                        || slot.admissionScope != null && occupationPlanner.sourceScopeToken(slot.admissionScope) !== slot.admissionToken
                        || [...slot.reads].some(([id, token]) => occupationPlanner.sourceToken(id, slot.mode) !== token)) throw error;
                    const scopes = [...new Set([...slot.reads.keys()].map(id => MarketCounters.counterOf(id)))];
                    const tokens = scopes.map(scope => [scope, boardIndex.groupFingerprint(scope),
                        MarketCounters.meetingRevisionOf(scope), digestToken(workshopScopeDigests.get(scope))]);
                    const admissionScope = slot.admissionScope;
                    const admission = refusals.admissionFingerprint(input.board, admissionScope);
                    if (admissionScope != null && admission === null) throw error;
                    const base = { purchase: error.purchase, authority: EconomyCommit.authority(input.state),
                        updatedAt: Number(input.state.updatedAt || 0), scopes, npcAllowed, admissionScope, admission };
                    const broad = { ...base, source: refusals.fingerprint(tokens) };
                    const items = [...input.exactReads.keys()];
                    const exactTokens = () => [items.map(id => [id, boardIndex.itemFingerprint(id)]),
                        scopes.map(scope => [scope, MarketCounters.meetingRevisionOf(scope), digestToken(workshopScopeDigests.get(scope))])];
                    const exact = items.length > 0 && items.length <= 60
                        && [...input.exactReads].every(([id, token]) => boardIndex.itemFingerprint(id) === token);
                    const source = exact ? refusals.fingerprint(exactTokens()) : broad.source;
                    error.priceEvidence = exact ? { ...base, items, source } : broad;
                    if (exact) error.priceFallback = broad;
                    refusals.remember(input.sourceState || input.state, input.board, request, error.purchase,
                        refusals.sourceCheck(input.board, error.priceEvidence, {
                            meetingRevisionOf: MarketCounters.meetingRevisionOf, workshopDigest: refusalWorkshopDigest }));
                }
                throw error;
            }
            request.dependencies = [...occupationPlanner.entry(ownId, 'meeting').reads.keys()].map(id => {
                const scope = MarketCounters.counterOf(id);
                return [id, `g:${input.board.groupFingerprint(scope)}`, MarketCounters.meetingRevisionOf(scope),
                    `g:${digestToken(workshopScopeDigests.get(scope))}`];
            });
            if (request.dependencies.length > 40) throw Error('trade_meeting_dependency_pressure');
            return request;
        }

        // A far bot's deferred plan page (mode page: its held plan read, a look) and a
        // near bot's decision (mode near) read the economy on the same inputs.
        if (input.mode === 'page' || input.mode === 'near') {
            const routeRows = input.routeRows = input.routeRows || (yield* EconomicTrip.prepare(input.state));
            // A near body's post decides only when a situation woke its build or
            // earning spot (the one gate, situations step 4 C6); else its held
            // decision answers the post. A page reads. A decision its gear plan woke
            // too is the gear plan's full review, as a far step's (gearPlanTaken).
            const stats = input.state.stats || {};
            const decide = input.mode === 'near' && (Situations.woken(stats, 'build') || Situations.woken(stats, 'earning_spot'));
            const gearReview = decide && Situations.woken(stats, 'gear_plan');
            input.economy = EconomyContext.forState(input.state, {
                board: input.board, routeRows, workshops: workshopsFor,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, workshop: noWorkshop(), decide, fullReview: gearReview,
                caller: `economy_${input.mode}`, trigger: 'native_own_action' });
            // The near answer's mind beside the build's packet: the gear plan's review
            // when taken, and the failed errands' marks either way (the body's errand
            // planner reads them: CompanionEquipmentShopping.planErrand).
            if (input.mode === 'near') input.nearMind = gearReview
                ? gearPlanTaken(stats, input.economy.statsPacket, stats.equipmentPlan, input.state.characterId, 'economy_near')
                : { gearMarks: stats.gearMarks ?? null };
            // The shared money packet is derived from this same graph. Use it
            // in preparation only; the native writer owns physical funding.
            input.state = { ...input.state, stats: { ...input.state.stats, ...input.economy.statsPacket } };
            input.stock = input.economy.stock('shots');
            yield 'candidate';
        }
        if (input.mode === 'occupation' || input.mode === 'near') {
            const none = noCrafterWorkshop(input.state, input.board);
            if (none) return none;
            const eligible = invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(input.state);
            if (!eligible || !input.recipesKnown) {
                const mask = input.board?.ownerLines(input.state.characterId)?.length
                    ? yield* OccupationSources.feasibility(input.state, input) : null;
                return eligible && !input.recipesKnown ? { ...ColdEconomyDecision.unknownWorkshop(), feasibility: mask }
                    : { ...noWorkshop(), feasibility: mask };
            }
        }
        const prepared = yield* OccupationSources.prepare(input.state, input);
        if (!prepared && input.mode === 'page') {
            const economyPlan = yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                now: input.timestamp, board: input.board, persona: BotPersona.of(input.state), tripCost: input.economy.trip,
                preparedCraft: null, npcOffersFor: OccupationSources.npcOffersFor, saleHold: saleHold(input.state.characterId),
                buyOrderEscrow: input.buyOrderEscrow, findSpot: id => SpotIndex.spotById(planningSpots, id) });
            return { selected: null, economyPlan, economyDecision: ColdEconomyDecision.capture(input.economy, input.state) };
        }
        if (!prepared) return input.mode === 'action' ? null : ColdEconomyDecision.unknownWorkshop();
        const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
        const action = input.mode === 'action' || input.mode === 'page';
        const options = { ...prepared.options, knownShotRecipes: input.knownShotRecipes, stock: input.stock,
            buyOrderEscrow: input.buyOrderEscrow, now: input.timestamp };
        if (!action) {
            const cursor = Wealth.createOccupation(input.state, input.knownRecipes, prepared.context, options);
            while (!Wealth.stepOccupation(cursor)) yield cursor.stage;
            return { ...Wealth.resultOccupation(cursor), feasibility: prepared.feasibility };
        }
        let selected = null, selectedValue = 0;
        if (Wealth.eligible(input.state, options)) {
            const cursor = Wealth.createAction(input.state, input.knownRecipes, prepared.context, options);
            while (!Wealth.stepAction(cursor)) yield cursor.stage;
            const value = Wealth.resultAction(cursor);
            if (value && cursor.selectedValueHours > 0) {
                const offer = value.exit?.offer;
                const exit = offer ? [Number(offer.recordId), Number(offer.lineId), Number(value.exit.price), Number(offer.revision)]
                    : value.exit?.staticId > 0 ? [0, Number(value.exit.staticId), Number(value.exit.price), 0]
                        : invoke('GameServer/Bot/Economy/ShotCraftPolicy').selectionFor(value)?.exit || null;
                selected = { wealth: { recipeId: Number(value.recipe.recipeId), batches: Number(value.batches || 1),
                    ...(value.learning ? { scroll: (() => {
                        const purchase = value.basket.purchases.find(row => Number(row.selfId) === Number(value.recipe.recipeItemId));
                        const quote = purchase?.lines?.[0]?.line;
                        return quote ? [Number(quote.lineId), Number(quote.revision ?? quote.expectedRevision)] : [-1];
                    })() } : {}),
                    ...(exit?.every(Number.isFinite) ? { exit } : {}),
                    ...(Number(input.stock?.itemId) === Number(value.recipe.productId)
                        ? { ownReserve: Number(input.stock?.target || 0) } : {}) } };
                selectedValue = cursor.selectedValueHours;
            }
        }
        const Shots = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
        if (Shots.eligible(input.state, input.timestamp)) {
            const cursor = Shots.createShot(input.state, input.knownRecipes, prepared.context, options);
            while (!Shots.stepShot(cursor)) yield cursor.stage;
            const value = Shots.resultShot(cursor);
            // Compare both production routes on the same finite value. A
            // profitable shot must not displace a more valuable material lot.
            if (value && cursor.selectedValueHours > selectedValue) selected = value;
        }
        const economyPlan = input.economy ? yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
            ...prepared.options, now: input.timestamp, board: input.board, persona: BotPersona.of(input.state),
            tripCost: prepared.context.trip, preparedCraft: selected,
            npcOffersFor: OccupationSources.npcOffersFor, saleHold: saleHold(input.state.characterId),
            ...(Trace.detailed(input.state.characterId) ? { onTownDecision: decision => Trace.detail({
                owner: input.state.characterId, revision: Number(input.state.simulation?.revision), trigger: 'economy_plan',
                phase: 'town_choice', town: decision.town, reason: decision.reason, candidates: decision.candidates,
                tripHours: decision.tripHours, tripFees: decision.tripFees
            }) } : null),
            findSpot: id => SpotIndex.spotById(planningSpots, id),
            buyOrderEscrow: input.buyOrderEscrow, knownShotRecipes: input.knownShotRecipes
        }) : null;
        return { selected, economyPlan, ...(input.mode === 'page' ? { economyDecision:
            ColdEconomyDecision.capture({ ...input.economy, shot: economyPlan?.shot || null }, input.state) } : {}) };
    })()),
    // An edge (one polygon side, teleport point or material node) costs less
    // than the planner's per-unit checks: up to EDGE_STEPS of them run as one
    // unit. Other yields still end the unit, so the 4 ms slice check is unchanged.
    step: work => {
        let next = work.iterator.next(); work.units++;
        for (let edges = 1; next.value === 'edge' && edges < EDGE_STEPS; edges++) { next = work.iterator.next(); work.units++; }
        work.stage = typeof next.value === 'number' ? next.value
            : WORK_STAGES.indexOf(next.value) + 1;
        if (next.done) { work.done = true; work.value = next.value; work.iterator = null; }
        return work.done;
    },
    result: work => work.value,
    publish: (id, input, workshop, meta = {}) => {
        if (input.mode === 'meeting') {
            occupationPlanner.release(id, 'meeting'); return;
        }
        if (input.mode === 'page') {
            const entry = kernel?.states.get(id);
            // The plan was already sent; a source change does not page again
            // for the same native state (the next state does).
            if (meta.stale && entry?.state === input.sourceState && entry.economyPending) {
                occupationPlanner.release(id, 'page'); return;
            }
            if (!shuttingDown && entry?.state === input.sourceState && !meta.stale && workshop?.economyPlan) {
                const hash = economyPlanHash(workshop.economyPlan);
                // A page that repeats the plan already sent (by the commit or
                // the last page) has nothing more to page.
                if (input.pending && hash === entry.economyPlanHash) { entry.economyPending = 0; input.economy = null; return; }
                entry.economyPlanHash = hash;
                entry.economyPending = workshop.economyPlan.d || 0;
                send('ready', { phase: 'economy_plan_ready', characterId: id,
                    authority: EconomyCommit.authority(input.state), economyPlan: workshop.economyPlan,
                    economyDecision: workshop.economyDecision });
            }
            input.economy = null; return;
        }

        // The rows stay as the bot's wish card while its route key holds.
        if (input.mode === 'wish') {
            if (routeRequests.get(id) === input) routeRequests.delete(id);
            return;
        }
        // The action result is the existing compact native plan. Its derived
        // network is needed while preparing it, never by the completed cache.
        if (input.mode === 'action' || input.mode === 'showcase' || input.mode === 'craft_market') input.economy = null;
        const owner = kernel?.states.get(id);
        if (shuttingDown || owner?.state !== input.sourceState) return;
        if (meta.stale) {
            // Main marks its copy stale (staleWorkshop). A near row's slot
            // recomputes on its next post; main's copy is current by nearSeq.
            if (input.state.phase !== 'hot') send('ready', { phase: 'economy_workshop_stale', characterId: id,
                updatedAt: Number(input.state.updatedAt || 0), echo: ColdEconomyDecision.stateEcho(input.state) });
        } else if (input.mode === 'near' && workshop?.decision) {
            // The near bot's decision on its post: the card, and beside it the
            // mind keys the body takes and the post and raise it answers.
            // The published packet moves the record's mind, as the far step's merge does,
            // so the next post's events compare against it and a raise is taken once.
            // It edits the record's state in place: a job asked on it keeps the
            // values it was asked on (valueKey), the state's digests go.
            for (const held of occupationPlanner.entriesOf(id)) if (held.input.state === owner.state) occupationPlanner.valuesOf(held);
            Object.assign(owner.state.stats ||= {}, workshop.statsPacket);
            stateDigests.delete(owner.state);
            owner.nearRoute = { key: input.routeKey, rows: workshop.routeRows };
            send('ready', { phase: 'economy_decided', characterId: id, economyDecision: workshop.decision,
                near: { statsPacket: workshop.statsPacket, personalCraft: workshop.personalCraft,
                    nearSeq: Number(input.state.nearSeq || 0), raiseSeq: Number(input.raiseSeq || 0),
                    ...(workshop.shots ? { shots: workshop.shots } : {}) } });
            // Sent once: the slot keeps the workshop.
            workshop.decision = null; workshop.statsPacket = null; workshop.personalCraft = null; workshop.routeRows = null; workshop.shots = null;
        }
    }
});
// The planner's work for one request. A near bot's decision (mode near) is the
// occupation's workshop with the card, the fields beside it
// (DecisionEvents.nearFields) and the route rows of the same build (publish
// sends them once).
function occupationWork(input, iterator) {
    return { iterator: input.mode === 'near' ? nearDecision(input, iterator) : iterator, done: false, value: null, stage: 0, units: 0 };
}
function* nearDecision(input, iterator) {
    const workshop = yield* iterator;
    const fields = DecisionEvents.nearFields(input.economy, input.state);
    return { workshop, decision: ColdEconomyDecision.capture({ ...input.economy, workshop }, input.state),
        ...fields, statsPacket: { ...fields.statsPacket, ...input.nearMind }, routeRows: input.routeRows };
}
// The gear plan's full review taken (gear_plan), one rule for a far step and a near
// decision: its bit cleared over the build's packet, and the marks of the errands the bot
// failed dropped (GearMarks.afterReview: the review planned without them). The mind keys it writes.
function gearPlanTaken(stats, packet, plan, subject, caller) {
    return { woken: Situations.decided({ ...stats, ...packet, equipmentPlan: plan }, 'gear_plan', { caller, subject }),
        gearMarks: GearMarks.afterReview() };
}
// options: { economy, stock, routeRows, routeKey } a step already holds, and
// a party goal query's own (main's) buyOrderEscrow and recipeKnowledge;
// caller: the asking site, counted per mode with what answered it (diagnostics:
// a route served from held rows, the cap's refusal, and the planner's own
// answer to the request: a new build, one in flight joined, a finished one unchanged).
function occupationFor(state, timestamp, options = {}, mode = 'occupation') {
    const id = Number(state.characterId), sourceState = kernel?.states.get(id)?.state;
    if (!sourceState || shuttingDown) return Promise.resolve(ColdEconomyDecision.unknownWorkshop());
    const diagnostic = economyDiagnostics.active();
    const ask = outcome => diagnostic && economyDiagnostics.count('occupation', 'ask', `${mode}|${options.caller || 'other'}|${outcome}`);
    const request = input => {
        if (!diagnostic) return occupationPlanner.request(id, input);
        const before = occupationPlanner.entry(id, mode);
        const answer = occupationPlanner.request(id, input);
        const after = occupationPlanner.entry(id, mode);
        ask(!before || after !== before ? 'planner' : before.done ? 'unchanged' : 'joined');
        return answer;
    };
    const routeKey = EconomicTrip.key(state), economy = options.economy || null;
    const directRows = options.routeKey === routeKey && Array.isArray(options.routeRows)
        && options.routeRows.length === EconomicTrip.towns.length ? options.routeRows : null;
    const routeRows = directRows || (economy?.routeKey === routeKey ? economy.routeRows
        : invoke('GameServer/Bot/Economy/EconomyContext').preparedRouteRows?.(state));
    if (mode === 'wish' && Array.isArray(routeRows) && routeRows.length === EconomicTrip.towns.length) {
        ask('held'); return Promise.resolve(routeRows);
    }
    if (mode === 'wish') {
        // The bot's rows on this route key (its card or the preparation in
        // flight) answer; a new preparation counts against the cap.
        if (occupationPlanner.entry(id, 'wish')?.fingerprint !== routeKey && !routeRequests.has(id)
            && routeRequests.size >= 64) { ask('capped'); return Promise.resolve([]); }
        const input = { state: EconomicTrip.frame(state), sourceState, timestamp, mode: 'wish', routeKey };
        const answer = request(input), entry = occupationPlanner.entry(id, 'wish');
        if (entry && !entry.done && entry.input === input) routeRequests.set(id, input);
        return answer;
    }
    const recipes = options.recipeKnowledge || recipeKnowledgeOf(state);
    // The party goal query passes its own (main's) escrow; else the board's sum.
    const buyOrderEscrow = options.buyOrderEscrow ?? escrowFor(state.characterId);
    return request({ state, sourceState, timestamp, assetsKey: assetsKey(state), buyOrderEscrow,
        knownShotRecipes: recipes.knownShotRecipes || [], recipeBook: recipes.recipeBook, stock: options.stock || null, economy,
        sourceReady: tables.ready('board') && tables.ready('market'), mode, routeKey, routeRows });
}
// The bot's held sale dispositions (MarketListingPolicy holdKey) on its worker
// record, which outlives its state updates: at most two per sale candidate.
function saleHold(characterId) {
    const record = kernel?.states.get(Number(characterId));
    return record ? (record.saleHold ||= new Map()) : null;
}
// A step's action ask: the planner's answer (plan) and the facts the ask read
// (ColdEconomyPlan.actionBaseline; null for a cancelled job). The step carries
// the facts of its last ask to its commit (projectResolve's actionBaseline,
// the kernel's onCommitAck): they become the bot's baseline only once main
// committed the step, so a dropped step asks again on the same edge.
async function askAction(state, timestamp, options) {
    const id = Number(state.characterId);
    const baseline = ColdEconomyPlan.actionBaseline(state,
        { buyOrderEscrow: escrowFor(id), ownLines: boardReady()?.ownerLines(id) || [] });
    const plan = await occupationFor(state, timestamp, options, 'action');
    return { plan, baseline: plan === null || plan && Object.hasOwn(plan, 'economyPlan') ? baseline : null };
}
// A clan craft's selected material can be independent of the current wish.
// Review only an executable indexed quote, once per change of its facts
// (CraftMarketReview), on its ordinary lifecycle; no population-wide wake or timer.
function clanMarketReviewDue(state) {
    return require('./CraftMarketReview').clanInputDue(state, kernel.states.get(Number(state.characterId)), boardReady());
}
async function clanMarketPlan(state, economy, timestamp) {
    const due = clanMarketReviewDue(state);
    if (!due) return null;
    const record = kernel.states.get(Number(state.characterId));
    record.clanMarketSeen = due;
    const board = boardReady();
    if (!board || !invoke('GameServer/Bot/Economy/ReadyTradeChoice').clanCraftPurchase(state, economy, board)) return null;
    return occupationFor(state, timestamp, { economy, caller: 'clan_market' }, 'craft_market');
}
// Missing B+ project bids must be published even if the current wish never
// generates a stock/loot edge, including projects retained behind a different
// goal: reviewed when their facts move (CraftMarketReview).
function personalCraftBidReviewDue(state) {
    return require('./CraftMarketReview').personalBidDue(state, kernel.states.get(Number(state.characterId)), boardReady());
}
// A build's workshop (the crafter's best recipe and its income per hour,
// occupationFor mode occupation), counted by the caller that asks: only a
// build reads it, a held card asks none.
function askWorkshop(state, timestamp, routeRows, caller, options = {}) {
    return occupationFor(state, timestamp, { ...options, routeRows, routeKey: EconomicTrip.key(state), caller });
}
// A step's workshop when its held one is not kept: the planner's answer, known
// here for a bot that is no service crafter and has no own board line
// (noCrafterWorkshop: the same answer, no planner job).
function stepWorkshop(state, timestamp, deps, caller) {
    const none = noCrafterWorkshop(state, deps.board);
    if (!none) return askWorkshop(state, timestamp, deps.routeRows, caller);
    economyDiagnostics.count('occupation', 'ask', `occupation|${caller}|no_crafter`);
    return none;
}
// The card's craft (its shot step) is prepared again only when the MP moved
// out of the band its craft checks answer alike on (WealthCraftPolicy
// craftMpBand; exact for a bot that rests for mana, whose plan reads its MP
// through SurvivalFloor's cast costs).
async function refreshCraftPacket(state, timestamp, refreshed) {
    if (!refreshed || !CraftEligibility.isServiceCrafter(state)) return refreshed;
    const mp = Number(state.vitals?.mp), preparedMp = refreshed.advisory.preparedMp ?? refreshed.advisory.mp;
    if (mp === preparedMp || !invoke('GameServer/Bot/AI/BotRoles').shouldRestForMana(state)
        && WealthCraftPolicy.sameCraftMp(CraftEligibility.craftLevelFor(state), preparedMp, mp)) return refreshed;
    const sourceState = kernel.states.get(Number(state.characterId))?.state;
    const { plan: action, baseline } = await askAction(state, timestamp,
        { stock: refreshed.economy.stock('shots'), economy: refreshed.economy, caller: 'craft_mp' });
    if (!action?.economyPlan || kernel.states.get(Number(state.characterId))?.state !== sourceState) return null;
    // Native action preparation has completed on the held graph. Only this
    // physical packet changes; decision clocks and saved original stay put.
    const prepared = ColdEconomyDecision.refreshPreparedCraft(refreshed, action.economyPlan.shot || null, mp);
    return prepared ? { ...prepared, economyPlan: action.economyPlan, actionBaseline: baseline } : null;
}
function cancelRoute(characterId) {
    const id = Number(characterId);
    routeRequests.delete(id);
    occupationPlanner.cancel(id, 'wish');
}
const pagedStates = new WeakSet();
function assetsKey(state) {
    return `${PersonalWarehouseIndex.version(state)}:${ClanSupplyPolicy.version(state)}`;
}
const economyPlanHash = plan => fnv1a32(JSON.stringify(plan));
// A service crafter's recipe book and packed known shot recipes, from main's
// 'recipes' table (CraftWorkshopService); none for any other bot.
const NO_RECIPES = Object.freeze({ knownShotRecipes: Object.freeze([]), recipeBook: undefined });
function recipeKnowledgeOf(state) {
    return state && CraftEligibility.isServiceCrafter(state)
        && tables.rows('recipes').get(Number(state.characterId)) || NO_RECIPES;
}
// The spot a bot stands at, in this worker's spot catalog.
const standingSpot = state => SpotService.standingSpot(state, planningSpots);
// A far bot's next page of a deferred plan (mode page: main moved its row while a
// sent plan waits with pages deferred, entry.economyPending; temporary until step 6,
// when the town plan pages itself), or a near bot's decision on its post (mode
// near): the raise it consumed (raiseSeq) and the route rows of its last decision
// while its route key holds.
function occupationOwnerChanged(id, page = false) {
    const entry = kernel?.states.get(Number(id));
    if (!entry || entry.state.phase !== 'hot' && !page) return;
    // One page per native state object.
    if (page && pagedStates.has(entry.state)) return;
    if (page) {
        pagedStates.add(entry.state); economyDiagnostics.count('occupation', 'page', 'main_state');
    }
    const routeKey = EconomicTrip.key(entry.state);
    occupationPlanner.request(id, { state: entry.state, sourceState: entry.state, assetsKey: assetsKey(entry.state),
        timestamp: Date.now(), mode: page ? 'page' : 'near', pending: entry.economyPending || 0,
        buyOrderEscrow: escrowFor(id),
        ...recipeKnowledgeOf(entry.state),
        routeKey, ...(page ? {} : { raiseSeq: Number(entry.raiseSeq || 0),
            routeRows: entry.nearRoute?.key === routeKey ? entry.nearRoute.rows : null }),
        sourceReady: tables.ready('board') && tables.ready('market') }, { awaitResult: false });
}
function changedItems(previous, next) {
    const ids = new Set();
    for (const row of previous || []) ids.add(Number(row.selfId));
    for (const row of next || []) ids.add(Number(row.selfId));
    for (const id of ids) {
        const admission = OccupationSources.recipeIndex(boardIndex);
        for (const scope of admission.update(id)) occupationPlanner.scopeChanged(scope);
        occupationPlanner.sourceChanged(id); occupationPlanner.groupChanged(MarketCounters.counterOf(id));
    }
}
boardIndex.setOwnerChangeObserver((previous, next, board) => {
    const owner = previous[0]?.ownerId, current = next[0]?.ownerId;
    for (const id of owner === current ? [owner] : [owner, current]) if (id) {
        invoke('GameServer/Bot/Economy/BoardLook').consumeOwnProjection(kernel?.lookSeen.get(id), previous, next, board, id);
    }
});
// A bot's buy-order escrow: the sum of its board records' escrow (row[9]),
// kept as the board rows apply (BotAfkMarketService.buyOrderEscrow on main).
const escrowByRecord = new Map(), escrowByOwner = new Map();
function setRecordEscrow(key, ownerId, amount) {
    const previous = escrowByRecord.get(key);
    if (previous) {
        const left = (escrowByOwner.get(previous[0]) || 0) - previous[1];
        if (left > 0) escrowByOwner.set(previous[0], left); else escrowByOwner.delete(previous[0]);
        escrowByRecord.delete(key);
    }
    if (ownerId > 0 && amount > 0) {
        escrowByRecord.set(key, [ownerId, amount]);
        escrowByOwner.set(ownerId, (escrowByOwner.get(ownerId) || 0) + amount);
    }
}
const escrowFor = characterId => escrowByOwner.get(Number(characterId)) || 0;
// A near bot's post (BotLifeState.notifyNearFacts) against the row before
// it, on the posted row before it is stored: the raises main named and
// detected (once per raise). The decision is then taken on this row (mode near).
// applied: the last raise the record applied.
function nearEvents(id, previous, entry, applied) {
    const row = entry.state, stats = row.stats ||= {};
    // The worker owns the near mind: a post's mind keys are discarded and the
    // record's stand, so a late post cannot roll back a raise.
    for (const key of SavedStats.MIND_KEYS) stats[key] = previous.stats?.[key];
    // Main detected the body's own facts (A1) and named them in the bag.
    entry.raiseSeq = DecisionEvents.takePostedRaise(stats, row.raise, applied, Situations.bodyPlace(row), id);
}
// A near bot's spot post (SpotService.assignSpot's near_spot, leaveSpot's near_left; main
// raises no moved_by_world for it, Situations.detect's body), heard once by its number
// (row.nearSpot { seq, spotId }, BotLifeState.notifyNearFacts), never by comparing the
// rows' spotId (a later post falls back to the physical spot): an arrival at its spot, or
// a leave, for the spot aggregate. Its own hook, apart from nearEvents (whose soft part
// goes in step 4). previous: the record's row before; row: the post, its mind the
// worker's (nearEvents). A solo body's arrival meets the
// spot's standing units (SpotContest; its step: the post's number): a lost contest
// raises contest_lost with its mark in the near mind, which the near decision answers;
// any other outcome is the body's own tactics near the player (no hot contest command,
// HotResourceCompetition): counted. A body in a party arrives with its party's tactics
// (temporary until the party aggregate, step 8): counted.
function nearArrival(id, previous, row) {
    const post = row.nearSpot;
    if (!post || Number(post.seq) === Number(previous?.nearSpot?.seq)) return;
    const to = post.spotId ?? null;
    if (to == null) { Situations.note('spot:left@hot'); return; }
    Situations.note('spot:arrival@hot');
    // Its enemies standing there (enemy_met; its step: the stay, the post's number, as main's B8).
    arrivalEnemies({ arriving: [row], spotId: to, step: Number(post.seq), at: Number(row.updatedAt) || Date.now(), proposalOf: () => null });
    if (row.party?.partyId || row.partyId) { Situations.note('spot:contest:hot_party'); return; }
    const verdict = arrivalContest({ spotId: to, members: [row], principal: row, step: Number(row.nearSeq) || 0,
        at: Number(row.updatedAt) || Date.now() });
    if (!verdict || verdict.action === 'coexist') return;
    if (verdict.action === 'avoid') {
        Situations.raise(row.stats ||= {}, 'contest_lost', { spotId: String(to), reason: 'contest_lost' }, Situations.bodyPlace(row), id);
    } else Situations.note('spot:contest:hot_skipped');
}
// A bot's goal revision (GoalState.revision on main, 0 = no goal) from the
// 'goals' table; undefined while the table loads (the decision skips the compare).
const goalRevision = characterId => tables.ready('goals')
    ? (tables.rows('goals').get(Number(characterId))?.revision ?? 0) : undefined;
tables.watch('board', {
    reset: () => { escrowByRecord.clear(); escrowByOwner.clear(); publicWorkshopIndex.clear(); publicWorkshopKeys.clear(); workshopRevisions.clear(); workshopDigests.clear(); workshopScopeDigests.clear(); boardReplacing = true; boardFollower.reset(); OccupationSources.recipeIndex(boardIndex).reset(); kernel?.lookSeen.clear(); invoke('GameServer/Bot/Economy/MeetingPriceRefusals').clear(); },
    put: (key, row) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, typeof row[0] === 'string' ? row.slice(1) : row); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        boardFollower.put(key, row);
        setRecordEscrow(Number(key), Number(recordOf(row).ownerId), escrowOf(row));
        changedItems(previous, boardIndex.records.get(Number(key)));
        pruneLookSeen(recordOf(row).ownerId);
        if (previous[0]?.ownerId !== recordOf(row).ownerId) pruneLookSeen(previous[0]?.ownerId);
        if (!boardReplacing && tables.ready('board')) buyerWaiters.recordChanged(recordOf(row), previous);
    },
    remove: (key) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, null); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        const ownerId = previous[0]?.ownerId;
        boardFollower.remove(key);
        setRecordEscrow(Number(key), 0, 0);
        changedItems(previous, []);
        if (ownerId) pruneLookSeen(ownerId);
    }
});
// Parties and memory are main's tables the kernel keeps
// (ColdSimulationKernel.partyPut, InteractionMemory.accept).
tables.watch('parties', {
    reset: () => { kernel?.partyReset(); },
    put: (key, row) => { kernel?.partyPut(key, row); },
    remove: key => { kernel?.partyRemove(key); }
});
// The memory rows are kept packed by the kernel's InteractionMemory, not a
// second plain copy in the mirror (retain: false); older revisions are refused.
// Main publishes no removed row: the set is bounded by the owners main
// accepted, and a full copy (reset) re-sends them, kept views refuse equals.
tables.watch('memory', {
    reset() {},
    put: (key, row) => { kernel?.interactionMemory.accept(row); },
    remove() {}
}, { retain: false });
tables.watch('clan_wars', {
    reset: () => kernel?.interactionMemory.clanWars.replace([]),
    put: (_key, row) => kernel?.interactionMemory.clanWars.accept(row),
    remove() {}
}, { retain: false });
// The market counters come from the main thread's 'market' table.
MarketCounters.useTable(() => tables.rows('market'));
MarketCounters.useSpots(() => planningSpots);
tables.watch('market', {
    reset: () => { marketReplacing = true; MarketCounters.movesChanged(); kernel?.lookSeen.clear(); },
    put: key => {
        if (String(key).startsWith('c:')) MarketCounters.movesChanged();
        if (String(key).startsWith('h:')) {
            const id = Number(String(key).slice(2));
            for (const scope of OccupationSources.recipeIndex(boardIndex).update(id)) occupationPlanner.scopeChanged(scope);
            occupationPlanner.sourceChanged(id);
        }
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('f:')) occupationPlanner.groupChanged(String(key).slice(2));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    },
    remove: key => {
        if (String(key).startsWith('c:')) MarketCounters.movesChanged();
        if (String(key).startsWith('h:')) {
            const id = Number(String(key).slice(2));
            for (const scope of OccupationSources.recipeIndex(boardIndex).update(id)) occupationPlanner.scopeChanged(scope);
            occupationPlanner.sourceChanged(id);
        }
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('f:')) occupationPlanner.groupChanged(String(key).slice(2));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    }
});
// The player's meeting waits ('meetings'): the bots a player waits for. A
// row that comes or goes moves the bot's schedule (playerWaitingTransition).
const playerWaits = new Set();
tables.watch('meetings', {
    reset: () => {
        const previous = [...playerWaits];
        playerWaits.clear();
        for (const id of previous) kernel?.ensureScheduled(id);
    },
    put: key => { playerWaits.add(Number(key)); kernel?.ensureScheduled(Number(key)); },
    remove: key => { playerWaits.delete(Number(key)); kernel?.ensureScheduled(Number(key)); }
}, { retain: false });
// A player's meeting anchor ('player_anchors', TradeMeetingService): offer
// admission reads it for a counterparty with no life state (PartyAdmission).
const playerAnchors = new Map();
tables.watch('player_anchors', {
    reset: () => playerAnchors.clear(),
    put: (key, row) => playerAnchors.set(Number(key), row),
    remove: key => playerAnchors.delete(Number(key))
}, { retain: false });
// The clan halls ('clan_halls'), by owner clan: VisitNeed.needed reads the
// row with the hall's catalog definition (bounds, managers).
const hallById = new Map();
const hallByOwner = new Map();
tables.watch('clan_halls', {
    reset: () => { hallById.clear(); hallByOwner.clear(); },
    put: (key, row) => {
        const previous = hallById.get(Number(key));
        if (previous && hallByOwner.get(previous.ownerId) === previous) hallByOwner.delete(previous.ownerId);
        const hall = { ...HallPolicy.definition(row.id), ...row };
        hallById.set(Number(key), hall);
        if (hall.ownerId > 0) hallByOwner.set(hall.ownerId, hall);
    },
    remove: key => {
        const previous = hallById.get(Number(key));
        hallById.delete(Number(key));
        if (previous && hallByOwner.get(previous.ownerId) === previous) hallByOwner.delete(previous.ownerId);
    }
}, { retain: false });
// One hall verdict per state object and hall row until its next time
// crossing (VisitNeed.validUntil): lifecycleKind asks it several times per
// step, and a new state or hall row is a new key.
const hallVerdicts = new WeakMap();
function hallNeeded(state, timestamp) {
    const hall = hallByOwner.get(Number(state?.clanId ?? state?.stats?.clanId)) || null;
    if (!hall && !state?.stats?.clanHallVisit) return false;
    const known = hallVerdicts.get(state);
    if (known && known.hall === hall && timestamp >= known.at && timestamp < known.until) return known.value;
    const value = VisitNeed.needed(state, hall, hall?.managerPresent === true, timestamp);
    hallVerdicts.set(state, { hall, at: timestamp, until: VisitNeed.validUntil(state, hall, timestamp), value });
    return value;
}
tables.watch('personal_warehouse', {
    reset: () => {},
    put: (key, row) => { PersonalWarehouseIndex.prepareRow(row); occupationOwnerChanged(Number(key)); },
    remove: key => occupationOwnerChanged(Number(key))
});
// Only the planner's jobs can carry an obsolete hot card. Cold owners notice
// the version at their next natural resolve.
function clanSupplyMoved(clanId) {
    const owners = new Set();
    for (const entry of [...occupationPlanner.slots.values(), ...occupationPlanner.cards.values()]) {
        const state = entry.input.state;
        if (state.phase === 'hot' && Number(state.clanId ?? state.stats?.clanId) === Number(clanId)) owners.add(entry.id);
    }
    for (const id of owners) occupationOwnerChanged(id);
}
tables.watch('clan_supplies', {
    reset: () => {},
    put: (key, row) => {
        ClanSupplyPolicy.prepareRow(row);
        clanSupplyMoved(key);
    },
    remove: key => clanSupplyMoved(key)
});
function boardReady() {
    return tables.ready('board') ? boardIndex : null;
}

function safetyTotals() {
    return { stateRepairs: safetyStateRepairs,
        coverageRepairs: 0, orphanRepairs: safetyOrphanRepairs };
}

function safetyPresence(checkpoint) {
    const id = checkpoint.characterId, entry = kernel?.states.get(id);
    const result = { characterId: id, checkpoint, observedCheckpoint: Protocol.safetyCheckpoint(entry?.state),
        workerVersion: kernel?.versions.get(id) || 0,
        normal: { status: 'deferred', reason: 'state_catalog_loading' } };
    const gate = (status, reason) => {
        result.normal = { status, reason };
        return result;
    };
    if (!kernel || !safetyStateReady) return result;
    if (shuttingDown || kernel.stopping) return gate('deferred', 'worker_shutdown');
    if (checkpoint.phase !== 'cold') return gate('ineligible', 'not_cold');
    // The committed row can be ahead of the cached state during ACK processing.
    if (kernel.busy(id)) return gate('deferred', 'worker_busy');
    const normalCovered = kernel.hasNormalCoverage(id);
    if (entry && !Protocol.sameSafetyCheckpoint(checkpoint, entry.state)) return gate('deferred', 'checkpoint_changed');
    result.normal = normalCovered ? { status: 'covered', reason: 'normal_schedule' }
        : kernel.paused ? { status: 'deferred', reason: 'worker_paused' }
            : !entry ? { status: 'uncovered', reason: 'missing_state' }
                : kernel.needsNormalSchedule(id) ? { status: 'uncovered', reason: 'local_coverage_missing' }
                    : { status: 'ineligible', reason: 'no_normal_schedule' };

    return result;
}

function safetyRepair(row) {
    const checkpoint = Protocol.safetyCheckpoint(row.checkpoint), id = checkpoint.characterId;
    let presence = safetyPresence(checkpoint);
    const receipt = (status, reason) => ({ edgeId: row.edgeId, characterId: id, kind: row.kind, status, reason,
        checkpoint, observedCheckpoint: presence.observedCheckpoint, workerVersion: presence.workerVersion });
    if (presence.workerVersion !== row.expectedWorkerVersion) return receipt('stale', 'worker_version_changed');
    if (!['state', 'orphan'].includes(row.kind)) return receipt('ineligible', 'unsupported_repair');
    const coverage = presence.normal;
    if (coverage.status !== 'uncovered') return receipt(coverage.status, coverage.reason);
    if (row.kind === 'orphan') {
        if (coverage.reason !== 'local_coverage_missing') return receipt('deferred', coverage.reason);
        if (!kernel.ensureScheduled(id)) return receipt('deferred', 'schedule_not_restored');
        safetyOrphanRepairs++;
        presence = safetyPresence(checkpoint);
        return receipt('accepted', 'orphan_schedule_restored');
    }
    if (row.kind === 'state') {
        if (coverage.reason !== 'missing_state') return receipt('deferred', 'local_safety_owns_schedule');
        const state = row.entry?.state;
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(state)
            || !object(state.inventory) || !object(state.stats) || !object(state.timing) || !object(state.simulation)) {
            return receipt('deferred', 'projection_unavailable');
        }
        if (!Protocol.sameSafetyCheckpoint(checkpoint, state)) return receipt('stale', 'projection_checkpoint_changed');
        if (!kernel.upsert({ state })) return receipt('stale', 'projection_not_accepted');
        presence = safetyPresence(checkpoint);
        if (!Protocol.sameSafetyCheckpoint(presence.observedCheckpoint, checkpoint)) return receipt('stale', 'checkpoint_changed');
        safetyStateRepairs++;
        return receipt('accepted', 'state_delivery_restored');
    }

}
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup([], boardReady);
// Personas come from the main thread's 'personas' table (BotPersona.loadAll).
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
BotPersona.useRowSource((characterId) => tables.rows('personas').get(characterId));
ClanSupplyPolicy.useRowSource(id => tables.rows('clan_supplies').get(id), () => tables.ready('clan_supplies'));
PersonalWarehouseIndex.useRowSource(id => tables.rows('personal_warehouse').get(id), () => tables.ready('personal_warehouse'));
let eventLoopDelay = null;
const LAG_RESOLUTION_MS = 20;

// The owner notices moved counters only during its own natural resolve.
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
// Why the held card did not serve this step, counted and carried into the
// build for its shadow plan join while diagnostics run (L114); the build's
// inputs are the same either way.
// Few counter names (the worker keeps 256): a non-field activity is not a
// lever and the structural segment is named once, not in every join. A bot
// in a party or without a card never had a card to reuse: counted, not joined.
// L120: the build after a basics of the same step takes its income route
// (EconomyContext.incomeRouteFor checks the key and replays its price reads).
// A copy, so the caller's deps (kept beside the advisory) never carry it.
// The card of the step's decision after its round carries the shot of the
// round's action plan, as the post-round build's card did (main's crafters
// read decided().shot): a prepared craft step joins it, an action plan that
// prepared none strips a stale one. No action plan keeps the card.
function stepCard(card, actionPlan) {
    return actionPlan ? ColdEconomyDecision.cardWithShot(card, actionPlan.shot || null) || card : card;
}
// The step's stats packet with the bot's shot demand (EconomyContext.shotDemand),
// merged into the proposed stats by prepareResolve (the step's packet before
// its round). A bot with no demand before or now carries no key.
function stepStatsPacket(state, economy, timestamp) {
    const previous = state.stats?.shotDemand || null;
    const demand = EconomyContext.shotDemand(economy, state, timestamp, previous);
    return demand || previous ? { ...economy.statsPacket, shotDemand: demand } : economy.statsPacket;
}
// The options of a step's projection (BotLifeState.prepareResolve), a window's
// round or the step's own.
function roundProjection(state, timestamp, writtenAt, plan) {
    return { persist: false, timestamp, writtenAt, projectClassProgression: true,
        moneyEscrowFor: () => escrowFor(state.characterId),
        // The step's held leaf: the round's check reads its own trip and
        // arrival as no event (Situations.detect).
        leaf: plan?.economy?.network?.activity ?? null };
}
// The economy edges of a held decision over a stretch of rounds.
function stockEdges(before, after, economy) {
    return ColdEconomyPlan.edges(before, after,
        { buyOrderEscrow: escrowFor(after.characterId), stockFor: (_state, kind) => economy.stock(kind) });
}
// The step's after-round action ask: the facts its plan reads that moved since
// the bot's last action ask (ColdEconomyPlan.edgesSince): this step's own ask
// before the round (asked), else the last committed step's (the record's
// actionBaseline, set at its commit ack); a bot with none yet (a new worker)
// compares against the step's start. stockFor(kind): the kit stock reader.
function actionEdges(start, after, stockFor, asked = null) {
    const id = Number(after.characterId);
    const options = { buyOrderEscrow: escrowFor(id), stockFor: (_state, kind) => stockFor(kind), ownLines: boardReady()?.ownerLines(id) || [] };
    return ColdEconomyPlan.edgesSince(asked || kernel.states.get(id)?.actionBaseline || ColdEconomyPlan.actionBaseline(start, options),
        after, options);
}
// What the step's decision counts its own item's progress from (a material
// hunt's), for a leaf that does not carry it.
function heldAtStep(plan) {
    return ColdEconomyDecision.heldAtDecisionOf(plan.economy.network?.activity, plan.plannedState);
}
// L115: a publication the event proof refuses drops the advice, counted by
// its first failing check.
// owner: the bot's kernel record the step read; the card is a field of it.
function rememberWishAdvisory(owner, advisory, seen = null) {
    const diagnostic = economyDiagnostics.active();
    if (!owner) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', 'remember_no_record');
        return;
    }
    const current = kernel.states.get(Number(owner.state.characterId));
    if (current !== owner) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', owner.wishAdvisory ? 'remember_stale_kept' : 'remember_stale');
        return;
    }
    if (advisory?.eventProof && seen
        && !ColdEconomyDecision.advisoryPublicationHolds(seen, advisory, current.wishAdvisory)) return;
    // The publication names the original build's decision (its proof's identity).
    const why = advisory && seen ? advisory.eventProof ? EconomyContext.proofIdentity(seen, advisory.eventProof, advisory.card?.activity)
        : 'unproved' : '';
    if (why) {
        if (diagnostic) economyDiagnostics.count('card', 'drop', `remember:${why}`);
        advisory = null;
    }
    owner.wishAdvisory = advisory;
}

function reviewMarket(state, timestamp, economy) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return null;
    const lines = board.ownerLines(state.characterId);
    if (!lines.length) { kernel.lookSeen.delete(Number(state.characterId)); return null; }
    const ctx = MarketPricing.traderContext(state, {
        timestamp, board, economy, persona: BotPersona.of(state),
        npcOffersFor: (selfId) => planningNpcCatalog.offersFor(selfId),
        purchaseNpcOffersFor: OccupationSources.npcOffersFor,
        findSpot: (spotId) => SpotIndex.spotById(planningSpots, spotId),
        canSell: OccupationSources.canSell(state, lines)
    });
    const id = Number(state.characterId);
    let seen = kernel.lookSeen.get(id);
    if (!seen) kernel.lookSeen.set(id, seen = new (invoke('GameServer/Bot/Economy/BoardLook').SeenLines)());
    const looked = MarketPricing.lookOwn(state, lines, ctx, seen);
    if (!looked) return null;
    return looked;
}

function pruneLookSeen(ownerId) {
    const seen = kernel?.lookSeen.get(Number(ownerId));
    if (!seen) return;
    const ids = new Set(boardIndex.ownerLines(ownerId).map(line => line.lineId));
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    if (!seen.size) kernel.lookSeen.delete(Number(ownerId));
}

// The step's trip begins, or waits for the engaged fight (PveEncounter.holdsTrip):
// the round then ends that fight with no new one, and the kept route waits on
// the record for the next step.
// A route that asks the decision again (BotRoute.trip: no spot it may take, none
// under it) raises its situation on the step's state, which the step carries.
function stepTrip(state, route, timestamp) {
    if (route?.ask) {
        state = { ...state, stats: Situations.raise({ ...state.stats }, route.ask, null, Situations.place(state), state.characterId) };
        route = null;
    }
    if (PveEncounter.holdsTrip(state, route, timestamp)) return { routedState: state, route: null, lastFight: true };
    return { routedState: beginHuntingTrip(state, route, timestamp) || state, route, lastFight: false };
}
// The step's solo trip and the kept route's drop (BotRoute.trip / drop): the
// route lives in the bot's kernel record. The search skips a spot with no
// room for the bot (SpotProfiles.roomFilterFor over this worker's index).
// currentSpot: the spot the step's input state stands at.
function routeTrip(state, currentSpot, leaf, timestamp) {
    const search = routeSearch(state, timestamp);
    return BotRoute.trip(search.owner, state, leaf, { spots: planningSpots, currentSpot, ...search });
}
// The hunters on a spot in this worker's occupancy (SpotEconomics' crowd
// share, the search's spot values; the fight reads kernel.spotHunters too).
function kernelHunters(spot, state) {
    return kernel.spotHunters(spot, state);
}
// A solo bot's route search inputs here: its kernel record (the kept route),
// this worker's room filter and hunters count (BotRoute.trip, soloGroundMissing).
function routeSearch(state, timestamp) {
    return { owner: kernel.states.get(Number(state.characterId)), timestamp,
        hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, [state]), spotHunters: kernelHunters };
}
function dropRoute(characterId, why) {
    BotRoute.drop(kernel.states.get(Number(characterId)), why);
}

// The spot aggregate at an arrival (SpotContest): the units standing on the spot in
// the one "who stands here" index (kernel.occupancy), the arriving ones left out, as
// SpotContest reads them, grouped by hunting unit (a party, read through its row and
// its leader; a solo bot), each with its target species (PartyHuntingTarget). A bot
// traveling there is indexed at its destination but does not stand there yet; a far
// bot in a competition wait or dead stands aside (a near post carries no vitals).
// untargeted: the standing hunters with no target. A raid boss spot (no room limit)
// holds no contest: null.
const unitKeyOf = state => state.party?.partyId || state.partyId || `solo:${state.characterId}`;
function standingUnits(spot, arriving) {
    if (SpotProfiles.spotRoom(planningSpots, spot.id) === Infinity) return null;
    const units = new Map();
    let untargeted = 0;
    for (const [key, state] of kernel.occupancy.members(spot.id, 'physical')) {
        if (arriving.has(key) || state?.activity === 'traveling' || state?.phase !== 'hot' && !(state?.vitals?.hp > 0)
            || state.stats?.coldCompetition?.wait || !['hunting', 'grouped', 'resting'].includes(state.activity)) continue;
        const unitKey = unitKeyOf(state);
        let unit = units.get(unitKey);
        if (!unit) {
            const party = unitKey.startsWith('solo:') ? null : kernel.partyOf(state.characterId);
            const leader = party ? kernel.states.get(Number(party.leaderId))?.state || state : state;
            const npcId = PartyHuntingTarget.competitionNpcId(party, leader, spot, id => kernel.states.get(Number(id))?.state);
            units.set(unitKey, unit = { key: unitKey, id: Number(leader.characterId), name: leader.name, partyId: party?.partyId || null,
                partyRevision: party?.revision, size: party?.memberIds?.length || 1, level: 0, hunters: 0, members: [], state: leader,
                npcId, hot: false });
        }
        unit.hunters++; unit.members.push(state); unit.level += Number(state.level || 1);
        unit.hot ||= state.phase === 'hot';
        if (!unit.npcId) untargeted++;
    }
    for (const unit of units.values()) unit.level /= unit.members.length;
    return { units: [...units.values()].filter(unit => unit.npcId), untargeted };
}
// One arrival's contest (SpotContest.contest) for an arriving unit: members (the
// arriving states), principal (its leader or the solo bot), party (its row, or null),
// step (the principal's own counter: the roll's key), at (the step's time), evacuating
// (a safety evacuation off unsafe ground: it holds its new ground, never avoids). null: no
// contest (a spot with no limit, no target there).
function arrivalContest({ spotId, members, principal, party = null, step, at, evacuating = false }) {
    const spot = SpotIndex.spotById(planningSpots, spotId);
    if (!spot) return null;
    const standing = standingUnits(spot, new Set(members.map(stateKey)));
    if (!standing) return null;
    const npcId = PartyHuntingTarget.competitionNpcId(party, principal, spot, id => members.find(s => Number(s.characterId) === Number(id))
        || kernel.states.get(Number(id))?.state);
    if (!npcId) return null;
    const arriving = { key: party?.partyId || `solo:${principal.characterId}`, id: Number(principal.characterId), name: principal.name,
        partyId: party?.partyId || null, partyRevision: party?.revision, size: members.length, hunters: members.length, members,
        state: principal, level: members.reduce((sum, s) => sum + Number(s.level || 1), 0) / members.length, npcId,
        holds: !party && EquipmentIncomeRoute.isCommanded(principal.stats?.earning) ? 'commanded' : evacuating ? 'evacuation' : null };
    const verdict = SpotContest.contest({ spot, npcId, arriving, standing: standing.units, untargeted: standing.untargeted, at, step,
        memory: kernel.interactionMemory, personaFor: state => BotPersona.of(state), ownSide: ColdPvpResolver.ownSide,
        capacityForSpot: LevelingRoutes.capacityForSpot });
    return verdict;
}
// An arrival's outcomes that touch other bots wait for the arriving step's commit ack
// and go to main in the competition frame (SpotContestOutbox).
function contestAcked(results) {
    if (outbox?.acked(results)) wakeLoopIfSooner();
}
// enemy_met at an arrival (EnemyMet, situations.md A2/B10/B11): the arriving bots against
// the bots standing on the spot (the occupancy index, those on their way left out), both
// ways. A meeting of far bots goes to the outbox of its arriving one (proposalOf(id): the
// arriving step's proposal); one of two bodies near a player goes to main at once (a
// spot_command, BotRevenge.fromSpot); a mixed pair is counted and traced only.
function arrivalEnemies({ arriving, spotId, step, at, proposalOf }) {
    const keys = new Set(arriving.map(stateKey)), standing = [];
    for (const [key, state] of kernel.occupancy.members(spotId, 'physical')) {
        if (!keys.has(key) && state?.activity !== 'traveling') standing.push(state);
    }
    if (!standing.length) return;
    standing.sort((a, b) => Number(a.characterId) - Number(b.characterId));
    const found = EnemyMet.meet({ arriving, standing, spotId, at, step, memory: kernel.interactionMemory,
        personaFor: state => BotPersona.of(state) });
    if (!found) return;
    if (found.kind === 'hot') {
        send('spot_command', { commands: [EnemyMet.hotCommand({ meeting: found.meeting, spotId, at, step })] });
        return;
    }
    const event = EnemyMet.coldEvent({ meeting: found.meeting, spotId, at, step, partyOf: id => kernel.partyOf(id),
        memoryRevision: id => kernel.interactionMemory.revision(id) });
    const arrived = keys.has(stateKey(found.meeting.holder)) ? found.meeting.holder : found.meeting.peer;
    outbox?.add(arrived.characterId, proposalOf(Number(arrived.characterId)), event);
}
// The arriving unit's own outcome on its states (its step's patch): avoid raises
// contest_lost with the spot as its mark (it wakes the earning spot at once); yield
// waits (ColdCompetitionWait, the resolver deducts the wait from its hunt); coexist
// changes nothing; one touching a standing unit goes to the outbox, keyed by the arriving
// step's proposal (proposalId). stats: a copy the caller owns, written and returned.
function contestOutcome(verdict, stats, principal, at, proposalId = null) {
    if (!verdict || verdict.action === 'coexist') return stats;
    if (verdict.action === 'avoid') {
        return Situations.raise(stats, 'contest_lost', { spotId: verdict.event.spotId, reason: 'contest_lost' }, Situations.OPEN, principal.characterId);
    }
    if (verdict.action === 'yield') {
        stats.coldCompetition = ColdCompetitionEpisode.begin(stats.coldCompetition, { outcome: 'yield', key: verdict.event.key, at,
            action: 'yield', peerId: verdict.peer.id, wait: { start: at, until: at + SpotContest.WAIT_MS } });
        return stats;
    }
    outbox?.add(principal.characterId, proposalId, verdict.event);
    return stats;
}

// A solo trip ends on its spot: the arrival's contest, its outcome in the step's
// patch (the arrival patch carries the whole stats copy, resolveTravel). A party trip
// is checked once, at the party's arrival (partyArrival). Returns the patched result,
// or null when the step is no such arrival or nothing changes.
function soloArrival(state, result, timestamp) {
    const travel = state?.activity === 'traveling' ? state.stats?.travel : null;
    if (!travel?.spotId || travel.reason === 'party_spot_replan' || result?.patch?.activity !== 'hunting'
        || String(result.patch.spotId) !== String(travel.spotId)) return null;
    const arrived = { ...state, ...result.patch, stats: { ...state.stats, ...result.patch.stats } };
    arrivalEnemies({ arriving: [arrived], spotId: travel.spotId, step: SpotRiskPolicy.stepCount(state), at: timestamp,
        proposalOf: id => kernel.proposalIdOf(id) });
    const verdict = arrivalContest({ spotId: travel.spotId, members: [arrived], principal: arrived,
        step: SpotRiskPolicy.stepCount(state), at: timestamp, evacuating: travel.reason === 'unsafe_ground_evacuation' });
    if (!verdict || verdict.action === 'coexist') return null;
    if (verdict.action !== 'avoid' && verdict.action !== 'yield') {
        contestOutcome(verdict, null, arrived, timestamp, kernel.proposalIdOf(state.characterId));
        return null;
    }
    const stats = contestOutcome(verdict, { ...result.patch.stats }, arrived, timestamp);
    return { ...result, patch: { ...result.patch, stats } };
}

// A party trip ends (the kernel's party round, finishPartyRouteTravelState): the
// party arrives as one unit, its contest decided through its leader (temporary until
// the party aggregate, step 8). The party's own objective spot (a clan goal, a
// material party) admits it: no contest, so a full roster does not bounce between its
// objective and a fallback spot. avoid: the party's competition avoid of the spot
// (ColdCompetitionRetreat.partyAvoid, read by its next spot search) and contest_lost on
// the leader; yield: the party waits; one touching a standing unit: the outbox, keyed
// on the leader. proposalOf(id): a member's proposal in this round. Returns { party,
// members } changed, or null.
function partyArrival({ party, members, spotId, timestamp = Date.now(), proposalOf = () => null }) {
    if (!spotId || !(party?.memberIds || []).length || !members.length) return null;
    // Its members meet their enemies standing there (enemy_met), wherever the party goes.
    arrivalEnemies({ arriving: members, spotId, step: PartySpotRiskPolicy.rounds(party), at: timestamp, proposalOf });
    if (String(spotId) === String(party.stats?.objective?.spotId ?? '')) {
        Situations.note('spot:arrival:objective');
        return null;
    }
    const leaderId = Number(party.leaderId || 0);
    const leader = members.find(member => Number(member.characterId) === leaderId);
    if (!leader) return null;
    const verdict = arrivalContest({ spotId, members, principal: leader, party, step: PartySpotRiskPolicy.rounds(party), at: timestamp });
    if (!verdict || verdict.action === 'coexist') return null;
    if (verdict.action === 'avoid') {
        return { party: ColdCompetitionRetreat.partyAvoid(party, spotId, verdict.event, timestamp),
            members: members.map(member => Number(member.characterId) !== leaderId ? member
                : { ...member, stats: contestOutcome(verdict, { ...(member.stats || {}) }, member, timestamp) }) };
    }
    if (verdict.action === 'yield') {
        const stats = contestOutcome(verdict, { ...(party.stats || {}) }, leader, timestamp);
        return { party: { ...party, stats }, members };
    }
    contestOutcome(verdict, null, leader, timestamp, proposalOf(leaderId));
    return null;
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
let partyGoalJobs = 0;
let partyGoalTail = Promise.resolve();
const partyGoalPages = new Map();
const partyGoalSeen = new Map();
function partyMembersAvailable(members) {
    return members.every(member => kernel.commandStartedAt.get(member.characterId)?.kind !== 'meeting'
        && !['meeting', 'page', 'action'].some(mode => {
            const held = occupationPlanner.entry(member.characterId, mode);
            return held && !held.done;
        }));
}

function admitPartyGoalPages(payload, msgId) {
    for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
    let entry = partyGoalPages.get(msgId);
    const fail = reason => {
        if (entry) { clearTimeout(entry.timer); partyGoalPages.delete(msgId); partyGoalJobs--; }
        send('party_goal_result', { ok: false, reason }, msgId);
    };
    if (!entry) {
        if (partyGoalSeen.has(msgId)) return fail('party_goal_duplicate');
        if (payload.pageIndex !== 0) return fail('party_goal_page_order');
        if (partyGoalJobs >= 2) return fail('party_goal_busy');
        if (Date.now() >= payload.replyBy || shuttingDown) return fail('party_goal_expired');
        partyGoalJobs++;
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        entry = { party: payload.party, members: [], escrows: [], recipeKnowledge: [],
            timestamp: payload.timestamp, replyBy: payload.replyBy, pageCount: payload.pageCount, nextPage: 0 };
        partyGoalPages.set(msgId, entry);
        entry.timer = setTimeout(() => fail('party_goal_expired'), Math.max(1, entry.replyBy - Date.now()));
    }
    if (entry.nextPage !== payload.pageIndex || entry.pageCount !== payload.pageCount
        || entry.timestamp !== payload.timestamp || entry.replyBy !== payload.replyBy
        || payload.pageIndex > 0 && entry.party.partyId !== payload.partyId) return fail('party_goal_page_changed');
    entry.members.push(payload.members[0]); entry.escrows.push(payload.escrows[0]); entry.nextPage++;
    entry.recipeKnowledge.push(payload.recipeKnowledge?.[0] || {});
    if (entry.nextPage !== entry.pageCount) return;
    clearTimeout(entry.timer); partyGoalPages.delete(msgId);
    if (!invoke('GameServer/Bot/Population/PartyGoalCalculation').validMembers(entry.party, entry.members)) {
        partyGoalJobs--; send('party_goal_result', { ok: false, reason: 'party_goal_roster_changed' }, msgId); return;
    }
    requestPartyGoals(entry, msgId, true);
}

function requestPartyGoals(payload, msgId, admitted = false) {
    if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) {
        if (admitted) partyGoalJobs--;
        send('party_goal_result', { ok: false, reason: 'worker_not_ready' }, msgId);
        return;
    }
    // ARCH-NOTE: the 2-job cap stays; a busy answer keeps the party's current
    // objective on main (PopulationService.jointPartyGoals) and the next
    // party resolve asks again.
    if (!admitted && partyGoalJobs >= 2) {
        send('party_goal_result', { ok: false, reason: 'party_goal_busy' }, msgId);
        return;
    }
    if (!admitted) {
        for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
        if (partyGoalSeen.has(msgId)) {
            send('party_goal_result', { ok: false, reason: 'party_goal_duplicate' }, msgId); return;
        }
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        partyGoalJobs++;
    }
    let preparedMembers = [];
    partyGoalTail = partyGoalTail.then(async () => {
        if (shuttingDown || kernel.stopping || Date.now() >= payload.replyBy) return;
        const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
        // Equal native snapshots keep their worker-owned identity and caches.
        // A freshly committed main snapshot is complete input, never merged
        // with an older worker wallet, inventory or equipment plan.
        const members = payload.members.map(member => {
            const native = kernel.states.get(member.characterId)?.state;
            return native && Calculation.sameSource(native, member) ? native : member;
        });
        preparedMembers = members;
        if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
        const joint = await Calculation.calculate(payload.party, members, async (member, timestamp) => {
            const at = members.indexOf(member);
            // Main's recipe book feeds only a refusal's ask (askWorkshop); the
            // build and its verdict read the worker's recipes mirror.
            const options = { buyOrderEscrow: payload.escrows[at], recipeKnowledge: payload.recipeKnowledge?.[at] || {} };
            const routeRows = await occupationFor(member, timestamp, { ...options, caller: 'party_goal' }, 'wish');
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            // The lifecycle's order: the held build's verdict on this state
            // (main's escrow in it) keeps its workshop, else the planner is
            // asked. A valid verdict serves the held build when its entry kept
            // the graph nodes (a party member's); a formation candidate's
            // entry kept none, so it is built (withNodes). Never remembered:
            // a query's own snapshot must not displace the bot's held build (L133).
            // A bot that is no service crafter is not asked: the planner
            // answers it with no workshop (its occupation branch), and the
            // feasibility mask that answer carries is not read by the goal.
            const deps = { timestamp, spots: planningSpots, board: boardReady(), routeRows,
                buyOrderEscrow: options.buyOrderEscrow, caller: 'workerPartyGoal' };
            const workshop = EconomyContext.heldWorkshop(member, deps)
                || (CraftEligibility.isServiceCrafter(member)
                    ? await askWorkshop(member, timestamp, deps.routeRows, 'party_goal', options) : noWorkshop());
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            return EconomyContext.forState(member, { ...deps, workshop, withNodes: true });
        }, payload.timestamp, () => !shuttingDown && !kernel.stopping && Date.now() < payload.replyBy
            && partyMembersAvailable(members), { spots: planningSpots });
        if (!shuttingDown && !kernel.stopping && Date.now() < payload.replyBy)
            send('party_goal_result', { ok: true, joint, sources: Calculation.sources(members) }, msgId);
    }).catch(error => {
        send('party_goal_result', { ok: false, reason: error.message || 'party_goal_failed' }, msgId);
    }).finally(() => {
        // Advice on a not-yet-published main snapshot must not retain a second
        // complete actor state in the worker's per-actor context cache.
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        for (const member of preparedMembers) if (kernel?.states.get(member.characterId)?.state !== member) {
            occupationPlanner.cancelState(member.characterId, member);
            Economy.forgetContext(member.characterId, 'party_query_release', member);
        }
        partyGoalJobs--;
    });
}

function send(type, payload = {}, msgId = null, payloadBytes = null, meetingFallback = null) {
    const packed = invoke('GameServer/Bot/Population/ColdStateWire').packPayload(type, payload);
    if (packed !== payload) { payload = packed; payloadBytes = null; }
    let message = Protocol.envelope(type, epoch, payload, msgId);
    if (type === 'command_ack') {
        const fitted = Protocol.fitMeetingAck(message, meetingFallback);
        if (fitted !== message) { message = fitted; payloadBytes = null; }
    }
    const bytes = Number.isFinite(payloadBytes) ? Protocol.envelopeBytes(message, payloadBytes) : null;
    let valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch, bytes });
    if (!valid.ok && economyDiagnostics.omitAggregatesOnOverflow(message, valid.reason)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok && valid.reason === 'message_too_large' && Protocol.omitPlannedStates(message)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok) {
        if (type !== 'fault') {
            parentPort.postMessage(Protocol.envelope('fault', epoch, {
                reason: `out_${type}_${valid.reason}`,
                bytes: Number(valid.bytes || 0)
            }));
        }
        return false;
    }
    if (!['command_request', 'command_ack'].includes(type)
        || !(payload.requests || payload.results || []).some(row => row.kind === 'meeting')) message.bytes = valid.bytes;
    parentPort.postMessage(message);
    return true;
}

function stopTimers() {
    if (loopTimer) clearTimeout(loopTimer);
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    loopTimer = null;
    flushTimer = null;
    heartbeatTimer = null;
}

// When the scheduler should run next, counted from `from` (the start of the
// last tick, as setInterval did): due work keeps the loopIntervalMs cadence (a
// tick that could not take it, held by capacity or a pause, waits for an ack
// the same as before); otherwise 1 ms past the nearest deadline (a timer may
// fire up to 1 ms early), at most LOOP_IDLE_CAP_MS away.
function loopWakeAt(from, next = kernel.nextWakeAt()) {
    return next <= from ? from + loopIntervalMs : from + Math.min(next - from + 1, LOOP_IDLE_CAP_MS);
}

function armLoop(from = Date.now()) {
    const next = kernel.nextWakeAt();
    loopArmedAt = loopWakeAt(from, next);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'armed',
        next <= from ? 'pending' : next - from >= LOOP_IDLE_CAP_MS ? 'cap' : 'due');
    loopTimer = setTimeout(runLoop, Math.max(0, loopArmedAt - Date.now()));
    loopTimer.unref?.();
}

function runLoop() {
    const startedAt = Date.now();
    try {
        kernel.tick();
    } finally {
        if (loopTimer && !shuttingDown) armLoop(startedAt);
    }
}

// Every path that can add earlier work (a message, the heartbeat's competition
// review arming a decision deadline) calls this: the timer moves only sooner.
function wakeLoopIfSooner() {
    if (!loopTimer || shuttingDown || loopWakeAt(Date.now()) >= loopArmedAt) return;
    clearTimeout(loopTimer);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'rearmed', 'sooner');
    armLoop();
}

function startKernel(config = {}) {
    if (kernel) return;
    Config.developerDiagnostics = config.developerDiagnostics === true;
    Config.decisionTrace = config.decisionTrace === true;
    // Busy share and heap after GC are two of the goal's three numbers (read with diagnostics off): always on, one
    // major-GC observer and two clock reads per heartbeat.
    heapTelemetry = invoke('GameServer/Bot/Population/WorkerHeapTelemetry').observe();
    previousElu = performance.eventLoopUtilization();
    // The longest loop delay per heartbeat is the health line's spike number (workerLag): always on,
    // a native histogram on a LAG_RESOLUTION_MS timer.
    eventLoopDelay = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
    eventLoopDelay.enable();
    // The decision trace's records go to main (ColdSimulationCoordinator), which owns the history writer.
    Trace.connect(batch => {
        if (shuttingDown) return false;
        parentPort.postMessage({ type: 'decision_trace', epoch, ...batch, dropped: Trace.stats().dropped });
    });
    // Use the main process's resolved setting, including programmatic overrides.
    Config.pvpAggression = invoke('GameServer/Social/PvpAggression').normalize(config.pvpAggression ?? Config.pvpAggression);
    kernel = new ColdSimulationKernel({
        stateSources: LifeStateProjector.passiveWorkerStateSources(workerProjectorRole),
        shotIndex: invoke('GameServer/Bot/Economy/ShotMarketIndex').native(),
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: { partyMinSize: Config.partyMinSize },
        partyMinSize: Config.partyMinSize,
        buyOrderEscrow: escrowFor,
        hallNeeded,
        playerWaiting: id => playerWaits.has(id),
        raidRow: id => tables.rows('raids').get(id) || null,
        spotOf: standingSpot,
        equipmentBridgeReason: (state) => GearAcquisitionPlanner.equipmentBridgeReason(state, {
            ...planningNpcCatalog.plannerOptions,
            buyOrderEscrow: escrowFor(state.characterId)
        }),
        partyArrival,
        // The party's spot search skips a spot with no room for the whole
        // party (its own members not counted against it).
        partyRoute: ({ leader, party, members, spot, timestamp }) => {
            if (party.stats?.warOperation && !tables.ready('clan_wars')) return null;
            const war = require('./ClanWarMovement').route({ leader, party, members, spot, timestamp,
                spots: planningSpots, wars: kernel.interactionMemory.clanWars });
            return war.active ? war.route : BotRoute.route(leader, spot, party, members,
                { spots: planningSpots, timestamp, spotHunters: kernelHunters,
                    hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, members) });
        },
        // writtenAt: the row's write stamp, the real now (timestamp is the
        // round's time, the bot's due for a step started its lead early).
        // windowStart: the state a hunt window (ColdSoloWindow) started on: `state` is its last round's.
        projectResolve: async (state, result, timestamp, lifecyclePlan = null, writtenAt = timestamp, windowStart = state) => {
            const owner = kernel.states.get(Number(state.characterId));
            // The spot contest at arrival, before the projection: the arriving
            // bot's outcome rides the patch (SpotContest; contest_lost raised there).
            const raidPreparing = require('./RaidSupplyPolicy').held(state, timestamp);
            const contested = !raidPreparing && soloArrival(state, result, timestamp);
            if (contested) result = contested;
            // The step's one decision, taken before the round (planLifecycle):
            // the round's consequences run on it, no second ask. A step
            // without one (a party member, karma) asks after
            // the round below: that is its one decision point.
            const stepEconomy = lifecyclePlan?.economy || null;
            let economy = stepEconomy, seenEcho = null, refreshed = null, observedDeps = null, economyEdges = null;
            // The facts of this step's last action ask (askAction), carried to its commit.
            let actionBaseline = lifecyclePlan?.actionBaseline || null;
            const base = roundProjection(state, timestamp, writtenAt, lifecyclePlan);
            const resolved = await LifeStateProjector.prepareResolve(state, result, raidPreparing
                ? { ...base, statsPacket: {}, statsPacketBeforeResolve: true } : stepEconomy
                // Merged before the event check, whose dirty bits follow it.
                ? { ...base, statsPacket: lifecyclePlan.statsPacket, statsPacketBeforeResolve: true }
                : { ...base,
                    // The workshop is asked by economyFor, only for a build.
                    economyDepsFor: async projected => ({ spots: planningSpots, routeRows: await occupationFor(projected, timestamp, { caller: 'member' }, 'wish'),
                        board: boardReady(), buyOrderEscrow: escrowFor(state.characterId), goalRevision: goalRevision(state.characterId), caller: 'member' }),
                    economyFor: async (projected, deps) => {
                        observedDeps = deps;
                        // The step's one gate (situations step 4 C6), a party member's and
                        // a karma step's alike: the build runs only when a situation woke it
                        // (or the earning spot), or no card names its decision; else the card serves.
                        const woken = Situations.woken(projected.stats, 'build') || Situations.woken(projected.stats, 'earning_spot');
                        refreshed = !woken ? ColdEconomyDecision.refreshAdvisory(projected, owner?.wishAdvisory, deps, { afterResult: true }) : null;
                        // The same edges also drive the action after projection. The line is
                        // the kit rates' (EconomyContext.keptTargets): no basics built for it.
                        const stock = refreshed?.economy || null;
                        let kept = null;
                        economyEdges = actionEdges(state, projected,
                            kind => stock ? stock.stock(kind) : (kept ||= EconomyContext.keptTargets(projected))[kind], actionBaseline);
                        if (refreshed) refreshed = await refreshCraftPacket(projected, timestamp, refreshed);
                        if (refreshed?.actionBaseline) actionBaseline = refreshed.actionBaseline;
                        if (refreshed) { if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'result'); return refreshed.economy; }
                        // The lifecycle's order: the held build's workshop while its
                        // key holds, else the planner's answer (stepWorkshop).
                        const caller = projected.party?.partyId || projected.partyId ? 'party' : 'karma';
                        deps.workshop = EconomyContext.heldWorkshop(projected, deps)
                            || await stepWorkshop(projected, timestamp, deps, caller);
                        return EconomyContext.forState(projected, { ...deps, decide: true });
                    },
                    onEconomy: (built, seen) => {
                        economy = built; seenEcho = ColdEconomyDecision.stateEcho(seen);
                        // The build's route facts moved (a party member, a karma step).
                        if (!refreshed && built?.routeMoved === true) dropRoute(state.characterId, 'sections');
                        const advice = refreshed?.advisory || ColdEconomyDecision.advisory(built, seen, undefined, observedDeps);
                        rememberWishAdvisory(owner, advice, refreshed ? null : seen, observedDeps);
                    }
                });
            // Membership is the row's: a plan, request or objective of another
            // clan leaves the proposal here (the same object when none, one
            // compare). The commit writes the proposal as it is, no merge.
            const projected = ClanMembershipPolicy.reconcileState(resolved);
            if (stepEconomy) {
                seenEcho = ColdEconomyDecision.stateEcho(projected);
                economyEdges = actionEdges(windowStart, projected, kind => stepEconomy.stock(kind), actionBaseline);
            }
            const beforeLevel = Number(state.stats?.classProgressionLevel || 0);
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(projected.stats?.classProgressionClassId ?? projected.stats?.classId ?? beforeClassId);
            const progressionChanged = beforeLevel < Number(projected.level || 1) || beforeClassId !== afterClassId;
            // The worker projects the class, but cannot grant tree ranks.
            // Accepted main-owned commits train against actual SP and books.
            const durable = {
                ...(progressionChanged ? { classId: afterClassId } : {}),
                ...(result.soulCrystals?.length ? { soulCrystals: result.soulCrystals } : {})
            };
            // Accepted custody owns the next physical transition. Resume the
            // original economic plan after the meeting releases the actor.
            const kitMoved = DecisionSections.kitMoved(state, projected);
            if (raidPreparing || state.stats?.tradeMeeting) return { state: projected,
                durable: Object.keys(durable).length ? durable : null, kitMoved, ...(actionBaseline ? { actionBaseline } : {}) };
            const asked = economyEdges && economy ? await askAction(projected, timestamp,
                { stock: economy.stock('shots'), economy, caller: `edges_${economyEdges}` }) : null;
            const preparedAction = asked?.plan || null;
            if (asked?.baseline) actionBaseline = asked.baseline;
            const economyPlan = preparedAction?.economyPlan || (stepEconomy ? lifecyclePlan.economyPlan : refreshed?.economyPlan) || null;
            const record = kernel.states.get(Number(projected.characterId));
            // Every sent plan stamps what is still deferred: a complete plan
            // clears what an earlier one left, so no later state replans it.
            if (economyPlan && record) {
                record.economyPending = economyPlan.d || 0;
                if (economyPlan.d) record.economyPlanHash = economyPlanHash(economyPlan);
            }
            const market = reviewMarket(projected, timestamp, economy);
            // Main reads this instead of building the network again.
            const economyDecision = economy && projected ? stepEconomy || refreshed
                ? { ...(stepEconomy ? stepCard(lifecyclePlan.economyDecision, preparedAction?.economyPlan) : refreshed.decision),
                    updatedAt: Number(projected.updatedAt || 0), echo: seenEcho }
                : { ...ColdEconomyDecision.capture({ ...economy,
                    shot: economyPlan?.shot || null }, projected), echo: seenEcho } : null;
            return {
                state: projected,
                // A member's kit event, read by its party step (worker-local).
                kitMoved,
                economyEdges,
                ...(economyPlan ? { economyPlan } : {}),
                ...(market ? { market } : {}),
                durable: Object.keys(durable).length ? durable : null,
                // Worker-local (the kernel picks posted fields one by one): the
                // party requirement plan reads this build, not a second one. Only a
                // build taken on this step: a served card's view (refreshAdvisory,
                // a lifecycle's reuse) holds the leaf alone, no wish queue or plans.
                ...(economy && !refreshed && (!stepEconomy || lifecyclePlan.buildTaken === true) ? { build: economy } : {}),
                buffOffer: invoke('GameServer/Bot/Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                // Worker-local: the kernel keeps it for the commit ack.
                ...(actionBaseline ? { actionBaseline } : {}),
                ...(economyDecision ? { economyDecision } : {})
            };
        },
        soloWindow: {
            // One round of a window: the step's projection without what follows it
            // (ColdSoloWindow, the window's end has it).
            projectRound: (state, result, timestamp, plan, writtenAt) => LifeStateProjector.prepareResolve(state, result,
                { ...roundProjection(state, timestamp, writtenAt, plan), statsPacket: plan.statsPacket, statsPacketBeforeResolve: true }),
            readers: plan => ({
                edges: (before, after) => stockEdges(before, after, plan.economy),
                // What the held leaf's execution proved (EconomyContext.leafOutcome): the
                // window ends, its step raises it.
                feasible: after => !EconomyContext.leafOutcome(after, plan.economy.network?.activity, {}, heldAtStep(plan)),
            })
        },
        // The member's own build of this step (projectResolve) while the
        // projection after it (class training, equipped upgrades) left its kit
        // (the build's baseline build fact); else one build on the same board
        // the step's build reads.
        planPartyRequirement: ({ state, timestamp, economy }) => PartyRequirementRefresh.plan(state, {
            spots: planningSpots, timestamp,
            preparedEconomy: economy?.statsPacket?.wishSections?.build === DecisionSections.kit(state) ? economy : null,
            planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: escrowFor(state.characterId), board: boardReady() }
        }),
        reviewRecruits: ({ party, members, timestamp }) => PartyGoalCalculation.recruitCheck(party, members,
            { spots: planningSpots, timestamp }),
        planLifecycle: async ({ state, timestamp }) => {
            if (state.stats?.tradeMeeting) return null;
            // The bot's record as the kernel handed the step over (its card).
            const record = kernel.states.get(Number(state.characterId));
            // A karma step executes the held earning answer (the wash's spot, decided
            // when woken: no search here). It carries no stats packet: it keeps the
            // previous shot demand, and its decision point is the ask after its round.
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            if (karmaPlan) return karmaPlan;
            // An old saved plan may hold the same craft project twice: read normalized (every
            // plan built since is: GearPlanSelection finalizePlan), its next review saves it so.
            const originalPlan = state.stats?.equipmentPlan || null;
            const previousPlan = GearPlanSelection.uniqueCraftProjects(originalPlan);
            if (previousPlan !== originalPlan) state = { ...state, stats: { ...state.stats, equipmentPlan: previousPlan } };
            const craftBidReview = personalCraftBidReviewDue(state);
            const spots = planningSpots;
            // GearPlanSelection uses EconomyContext's same prepared occupation
            // reader. No synchronous recipe scan can run through it.
            const routeRows = await occupationFor(state, timestamp, { caller: 'step' }, 'wish');
            const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
            // deps.workshop: asked below, only for a build.
            const deps = { spots, timestamp, board: boardReady(), caller: 'step',
                buyOrderEscrow: escrowFor(state.characterId), goalRevision: goalRevision(state.characterId), routeRows };
            const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
                && previousPlan.next == null && previousPlan.reason === 'wish_focus';
            // A healer or buffer without solo ground plans its party request
            // below (PartyRequestPlanner, decision 10-30), and a bot waiting on its
            // party request, at every step: temporary until step 7 (the request's
            // deadlines), its builds counted unwoken under 'party_request'.
            const solo = !state.party?.partyId && !state.partyId && !state.stats?.partyRequest
                && !PartyRequestPlanner.supportWithoutGround(state, spots, routeSearch(state, timestamp));
            const where = Situations.place(state);
            const card = record?.wishAdvisory || null;
            // The step's own situations, raised on the state it plans (worker-local; the
            // step's commit carries them, its build clears what it decides): the held
            // leaf's execution outcome (EconomyContext.leafOutcome: its goal done or
            // failed, a visit's step ended), a goal main moved (the goal revision, until
            // AI-5), a craft project's or clan market's review due.
            const raise = (name, payload = null) => {
                const stats = Situations.raise({ ...state.stats }, name, payload, where, state.characterId);
                if (stats.situationSeq !== state.stats?.situationSeq) state = { ...state, stats };
            };
            const leaf = card?.card?.activity;
            const outcome = card && solo ? Economy.leafOutcome(state, leaf, deps, leaf?.heldAtDecision) : '';
            if (outcome) raise(outcome);
            if (card && Number.isFinite(deps.goalRevision) && deps.goalRevision !== card.goalRevision
                && Situations.hears('goal_moved', where)) raise('goal_moved');
            const marketReview = craftBidReview ? 'craft_bid' : clanMarketReviewDue(state) ? 'clan_market' : '';
            if (marketReview && Situations.hears(marketReview, where)) raise(marketReview);
            // A clan-owned plan whose card names no leaf takes its native selection in a build:
            // raised once as that comes true (record.clanIdle: the step's last reading, heard),
            // never while it stands.
            const clanIdle = leaf === null && GearAcquisitionPlanner.isClanOwnedPlan(previousPlan);
            if (record && clanIdle !== !!record.clanIdle && (!clanIdle || Situations.hears('clan_market', where))) {
                record.clanIdle = clanIdle;
                if (clanIdle) raise('clan_market');
            }
            // The one gate (situations step 4 C6): the build runs only when a situation woke
            // it or the earning spot (its search runs in the build), or the bot holds no
            // card naming its decision; else the card serves, judging nothing more. The
            // gear plan's full review (every candidate, the native plan afresh) only when
            // woken (gear_plan, F1).
            const woken = Situations.woken(state.stats, 'build') || Situations.woken(state.stats, 'earning_spot');
            deps.fullReview = Situations.woken(state.stats, 'gear_plan');
            // Diagnostics only: why the card did not serve the step (advisory:refused:<reason>
            // or advisory:skip:<why>).
            const advisory = economyDiagnostics.active() ? (outcome, reason) => economyDiagnostics.count('advisory', outcome, reason) : null;
            const why = [];
            let refreshed = solo && !woken ? ColdEconomyDecision.refreshAdvisory(state, card, deps, { why }) : null;
            if (advisory && !refreshed) {
                if (!solo) advisory('skip', 'party');
                else if (woken) advisory('skip', 'woken');
                else advisory('refused', why[0] || 'unknown');
            }
            if (refreshed) {
                refreshed = await refreshCraftPacket(state, timestamp, refreshed);
                if (!refreshed) advisory?.('skip', 'craft_packet');
            }
            const nullReuse = refreshed?.economy.network.activity === null;
            // Failure counters and recovery deadlines are read by the build, which a
            // situation woke (the native plan's own facts wait for it).
            const nativeReplan = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
            // Build the renewed proof against the native live history, so a
            // consumed wake/expiry does not invalidate it again on publication.
            const preparationState = wishFocus && !refreshed ? { ...state, stats: { ...state.stats,
                equipmentPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan, state, timestamp) } } : state;
            // Both reuses (the card's leaf, a null intention) read the card's
            // workshop. A build keeps the held one while its key holds
            // (EconomyContext.heldWorkshop), else it asks.
            if (!refreshed) deps.workshop = EconomyContext.heldWorkshop(preparationState, deps)
                || await stepWorkshop(state, timestamp, deps, 'lifecycle');
            // The card holds the plan: the route is read on the input state.
            if (refreshed && !nullReuse) {
                if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
                const leaf = refreshed.economy.network.activity;
                const { routedState, route, lastFight } = stepTrip(state, routeTrip(state, standingSpot(state), leaf, timestamp), timestamp);
                const asked = routedState.activity === 'hunting' && leaf.activity !== 'hunting'
                    ? await askAction(routedState, timestamp, { economy: refreshed.economy, caller: 'card' }) : null;
                // A town visit's showcase from the card (temporary until step 6: the town plan).
                let occupation = routedState.activity === 'shopping'
                    ? await occupationFor(routedState, timestamp, { economy: refreshed.economy, caller: 'card' }, 'showcase') : asked?.plan || null;
                if (!occupation?.economyPlan && !refreshed.economyPlan)
                    occupation = await clanMarketPlan(routedState, refreshed.economy, timestamp);
                rememberWishAdvisory(kernel.states.get(Number(state.characterId)), refreshed.advisory);
                // economy: worker-local, the step's one decision; the
                // projection after the round reads it (never posted).
                return { statsPacket: stepStatsPacket(state, refreshed.economy, timestamp), economy: refreshed.economy,
                    // The facts of the step's last action ask: the card's own or its craft refresh's.
                    ...(asked?.baseline || refreshed.actionBaseline
                        ? { actionBaseline: asked?.baseline || refreshed.actionBaseline } : {}),
                    ...(occupation?.economyPlan || refreshed.economyPlan
                        ? { economyPlan: occupation?.economyPlan || refreshed.economyPlan } : {}),
                    activityPick: { activity: leaf.activity, spotId: leaf.spotId, npcId: leaf.npcId },
                    economyDecision: refreshed.decision, previousPlan, acquisitionPlan: previousPlan,
                    partyRequest: null, reusablePartyRequest: false, replanFailure: null,
                    targetNpcId: Number(previousPlan?.next?.npcId || leaf.npcId || 0), plannedState: routedState, route, lastFight };
            }
            // A build (woken, or the step's card no longer names its decision: counted
            // unwoken under its caller).
            const buildDeps = { ...deps, decide: true, caller: solo ? 'step' : 'party_request' };
            const preparedEconomy = nullReuse ? refreshed.economy
                : Economy.forState(preparationState, buildDeps);
            const selectedAcquisition = nullReuse ? {
                acquisitionPlan: GearPlanSelection.deferredAcquisitionPlan(state, previousPlan, preparedEconomy, nativeReplan, timestamp),
                replanContext: nativeReplan, reusablePartyRequest: false,
                excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp), economy: preparedEconomy
            } : GearPlanSelection
                .selectAcquisitionPlan(preparationState, previousPlan, {
                    spots, timestamp, preparedEconomy, preparedReplanContext: nativeReplan,
                    planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: escrowFor(state.characterId) }
                });
            const { replanContext, reusablePartyRequest, excludedSpotIds, economy } = selectedAcquisition;
            // Selection already incorporates the prepared wish and preserves
            // the old project's inputs and bids. Replacing its result with a
            // second bare wish plan drops that retained chain on every switch.
            const acquisitionPlan = selectedAcquisition.acquisitionPlan;
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp,
                { spots, economy, memo: kernel.states.get(Number(state.characterId)), search: routeSearch(state, timestamp),
                    planKey: selectedAcquisition.planKey });
            // The build's route facts moved (EconomyContext.forState routeMoved), or a
            // new plan destination the search reads (the gear branch, the party wait):
            // the kept route drops before the trip start, so the search below runs
            // on the planned state.
            const routeDrop = BotRoute.dropReason(!nullReuse && economy.routeMoved === true,
                { plan: previousPlan, request: state.stats?.partyRequest }, { plan: acquisitionPlan, request: partyRequest });
            if (routeDrop) dropRoute(state.characterId, routeDrop);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots,
                    { excludedSpotIds, timestamp, spotHunters: kernelHunters,
                        hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, [state]) })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            // A new packet, never the build's own (stepStatsPacket may return economy.statsPacket,
            // which the card shares). The gear plan's full review taken with the build (gear_plan):
            // it planned without the errands the bot failed, whose marks go (GearMarks).
            let statsPacket = stepStatsPacket(state, economy, timestamp);
            if (deps.fullReview && !nullReuse) statsPacket = { ...statsPacket,
                ...gearPlanTaken(state.stats, statsPacket, acquisitionPlan, state.characterId, 'step') };
            const plannedStats = { ...(state.stats || {}), ...statsPacket, equipmentPlan: acquisitionPlan };
            if (partyRequest) plannedStats.partyRequest = partyRequest;
            else delete plannedStats.partyRequest;
            // A waiter that is resting finishes its rest first.
            const plannedState = {
                ...state,
                activity: fallbackSpot
                    && !['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'resting'].includes(state.activity)
                    ? 'hunting'
                    : state.activity,
                spotId: fallbackSpot ? fallbackSpot.id : state.spotId,
                stats: plannedStats
            };
            const { routedState, route, lastFight } = stepTrip(plannedState, routeTrip(plannedState, standingSpot(state), economy.network.activity, timestamp), timestamp);
            const asked = routedState.activity === 'hunting' && economy.network.activity?.activity && economy.network.activity.activity !== 'hunting'
                ? await askAction(routedState, timestamp, { economy, caller: 'step' }) : null;
            let preparedOccupation = routedState.activity === 'shopping'
                ? await occupationFor(routedState, timestamp, { economy, caller: 'step' }, 'showcase') : asked?.plan || null;
            if (!preparedOccupation?.economyPlan && !(nullReuse && refreshed?.economyPlan))
                preparedOccupation = await clanMarketPlan(routedState, economy, timestamp);
            // The review stands aside for a plan of its own: it counts as done, or
            // the bot would rebuild on every step while that plan waits.
            else if (record) record.clanMarketSeen = clanMarketReviewDue(routedState) || record.clanMarketSeen;
            if (!preparedOccupation?.economyPlan && craftBidReview && routedState.activity === 'hunting')
                preparedOccupation = await occupationFor(routedState, timestamp, { economy, caller: 'craft_bid' }, 'craft_market');
            const seen = { ...routedState, stats: { ...routedState.stats, ...statsPacket } };
            const heldDecision = nullReuse ? ColdEconomyDecision.compact({ data: refreshed.decision.data.slice(0),
                updatedAt: Number(seen.updatedAt || 0), echo: ColdEconomyDecision.stateEcho(seen), flags: 0 }) : null;
            const advice = nullReuse ? { ...refreshed.advisory, card: heldDecision }
                : ColdEconomyDecision.advisory(economy, seen, preparationState.activity, deps);
            rememberWishAdvisory(kernel.states.get(Number(state.characterId)), advice, seen, deps);
            if (nullReuse && economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
            const stepPlan = {
                ...(preparedOccupation?.economyPlan || nullReuse && refreshed?.economyPlan
                    ? { economyPlan: preparedOccupation?.economyPlan || refreshed.economyPlan } : {}),
                // Worker-local: the facts of the step's last action ask, its own or
                // a kept card's craft refresh (projectResolve carries them on).
                ...(asked?.baseline || nullReuse && refreshed?.actionBaseline
                    ? { actionBaseline: asked?.baseline || refreshed.actionBaseline } : {}),
                statsPacket,
                economy,
                // The step took the build (F6): main runs the side errands (a Mammon visit,
                // the warehouse craft return, a moved clan crafter asked again) only then; a
                // failed one waits for the build's next waking situation. Temporary until
                // step 6: real leaves of the town plan.
                ...(!nullReuse ? { buildTaken: true } : {}),
                activityPick: economy.network.activity ? { activity: economy.network.activity.activity,
                    spotId: economy.network.activity.spotId, npcId: economy.network.activity.npcId } : null,
                economyDecision: heldDecision || ColdEconomyDecision.capture({ ...economy, workshop: deps.workshop }, routedState),
                previousPlan,
                acquisitionPlan,
                partyRequest,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : Number(acquisitionPlan?.next?.npcId || 0),
                reusablePartyRequest,
                replanFailure: replanContext.failure || null,
                plannedState: routedState,
                route,
                lastFight
            };
            return stepPlan;
        },
        emit: send,
        maxBatch: config.maxBatch,
        maxInFlight: config.maxInFlight,
        maxAtomicPartySize: config.maxAtomicPartySize,
        flushTargetMs: config.flushTargetMs,
        flushHardMs: config.flushHardMs
    });
    // Every spot value's crowd share without its own count reads this kernel's occupancy (SpotProfiles.spotHunters).
    SpotProfiles.useOccupancy(() => kernel?.occupancy);
    // Keep dependencies tied to the kernel's native lifetime. In-flight
    // scratch is cancelled on a newer canonical owner; it is never LRU-evicted.
    const nativeSet = kernel.states.set.bind(kernel.states), nativeDelete = kernel.states.delete.bind(kernel.states);
    const nativeClear = kernel.states.clear.bind(kernel.states);
    // ownOutput (kernel upsert): the state is the step's own output echoed back
    // by main ('commit' or 'review'); the step already built its economy on it.
    kernel.states.set = (id, entry, ownOutput = null) => {
        const previousEntry = kernel.states.get(Number(id)), previous = previousEntry?.state;
        // A new life starts from no record (activations fence the bot first),
        // so the raises applied are this life's.
        // A bot that leaves the far simulation sends no arrival outcome after it.
        if (entry.state.phase !== 'cold') outbox?.drop(id, 'stale');
        if (previous && previous !== entry.state && entry.state.phase === 'hot') {
            nearEvents(id, previous, entry, Number(previousEntry.raiseSeq || 0));
            nearArrival(id, previous, entry.state);
        }
        // The near bookkeeping ends with the body: a far record keeps no
        // route rows of a near decision, and the next activation's raises
        // count from its session's first.
        else if (entry.state.phase !== 'hot' && (entry.nearRoute || entry.raiseSeq)) { entry.nearRoute = null; entry.raiseSeq = 0; }
        const result = nativeSet(id, entry);
        if (previous !== entry.state) {
            // Each planner job of the bot (one per mode) whose inputs read the
            // same on the new state goes on, finished or in flight (main
            // echoing the bot's own commit, a catalog page resending the row);
            // any other is dropped: a near, page or meeting job (keyed on
            // the state object), a finished one keyed on the step clock.
            const routeKey = EconomicTrip.key(entry.state);
            for (const held of occupationPlanner.entriesOf(id)) {
                const keep = held.mode === 'wish' ? routeKey === held.fingerprint
                    : !IDENTITY_MODES.has(held.mode) && !(held.done && CLOCK_MODES.has(held.mode));
                const incoming = !keep ? null : held.mode === 'wish'
                    ? { ...held.input, state: EconomicTrip.frame(entry.state), sourceState: entry.state, routeKey }
                    : { ...held.input, state: entry.state, sourceState: entry.state, routeKey,
                        routeRows: held.input.routeKey === routeKey ? held.input.routeRows : null };
                if (incoming && (held.mode === 'wish' || plannerInputKey(incoming) === held.fingerprint
                    && occupationPlanner.valuesOf(held) === plannerValueKey(incoming))) {
                    occupationPlanner.rebase(held, incoming);
                } else if (held.mode === 'wish') cancelRoute(id);
                else occupationPlanner.cancel(id, held.mode);
            }
            // Own outputs are not inputs: no page for the own commit or
            // review; economyPending stays for main's next write.
            if (ownOutput && entry.economyPending) economyDiagnostics.count('occupation', 'page',
                ownOutput === 'review' ? 'own_review_skipped' : 'own_commit_skipped');
            occupationOwnerChanged(id, !ownOutput && Boolean(entry.economyPending));
        }
        return result;
    };
    kernel.states.delete = (id, options) => { occupationPlanner.cancel(id); cancelRoute(id); outbox?.drop(id, 'stale'); return nativeDelete(id, options); };
    kernel.states.clear = () => {
        for (const entry of [...occupationPlanner.slots.values(), ...occupationPlanner.cards.values(), ...occupationPlanner.waiting.values()])
            occupationPlanner.cancel(entry.id, entry.mode);
        routeRequests.clear();
        for (const id of [...outbox?.pending.keys() || []]) outbox.drop(id, 'stale');
        return nativeClear();
    };
    invoke('GameServer/Bot/Population/PartyAdmission').configureTradeAdmission(id => kernel.states.get(Number(id))?.state || kernel.states.get(-Number(id))?.state,
        () => null, id => playerAnchors.get(Number(id)) || null);
    kernel.prepareMeeting = (id, meeting) => {
        const entry = kernel.states.get(id);
        const side = meeting.actorA === id ? 0 : 1;
        const state = meeting.incoming ? { ...entry.state, acceptedIncoming: meeting.incoming[side], incomingPending: false } : entry.state;
        return occupationPlanner.request(id, { state, sourceState: entry.state, timestamp: Date.now(), assetsKey: assetsKey(state),
            mode: 'meeting', meeting, recipeBook: recipeKnowledgeOf(entry.state).recipeBook, buyOrderEscrow: escrowFor(id),
            routeKey: EconomicTrip.key(entry.state), sourceReady: tables.ready('board') && tables.ready('market') }).then(result => {
                if (!result?.token) {
                    const error = Error(result?.reason || 'trade_meeting_preparation_pending');
                    if (result?.priceEvidence) error.priceEvidence = result.priceEvidence;
                    if (result?.priceFallback) error.priceFallback = result.priceFallback;
                    throw error;
                }
                return result;
            });
    };
    kernel.meetingResultPages = (result, id, token) => invoke('GameServer/AfkTrade/TradeMeetingCodec').commandPages(result,
        frame => Protocol.envelope('command_request', epoch, { requests: [{ kind: 'meeting', characterId: id, commandId: token, frame }] },
            `meeting-result:${id}:${token}:3`), result.dependencies);
    kernel.buyerEvents = buyerWaiters;
    // Craft input prices read the npc_offers snapshot, as main's table.
    invoke('GameServer/Bot/Economy/ShotMarketIndex').configure({ board: boardReady, stateFor: id => kernel.states.get(Number(id))?.state });
    EconomyContext.configure({
        board: boardReady,
        knownRecipes: id => RecipeBookCodec.unpack(recipeKnowledgeOf(kernel.states.get(Number(id))?.state).recipeBook) ?? undefined,
        producerSource: (state, board) => {
            if (!board) return null;
            const index = OccupationSources.recipeIndex(board);
            const level = invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor(state);
            const scope = index.scopeFor(level);
            return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
        },
        workshops: workshopsFor,
        npcOffersFor: OccupationSources.npcOffersFor,
        buyOrderEscrow: escrowFor,
        spots: () => planningSpots,
        // SpotEconomics' crowd share in a build (deps.spotHunters).
        spotHunters: kernelHunters,
        // The bot's memory rows for its relations fact, bond and threat (read
        // only), without the deep copy snapshot() makes; as main passes them.
        memory: characterId => kernel.interactionMemory.relationRows(Number(characterId)),
        memoryIdentity: characterId => kernel.interactionMemory.contentIdentity(characterId),
        sourceReady: () => tables.ready('board') && tables.ready('market'),
        nativeCraftContinuation: true
    });
    OccupationSources.initialise();
    loopIntervalMs = Math.max(5, Number(config.loopIntervalMs) || 20);
    armLoop();
    outbox = new SpotContestOutbox({ stateOf: id => kernel.states.get(Number(id))?.state, partyOf: id => kernel.partyOf(id),
        memoryRevision: id => kernel.interactionMemory.revision(id),
        // A frame's room in the heartbeat that carries it: the beat's own fields at their
        // largest (numbers as 32 characters), the frame's events counted as they are offered.
        frameSizing: frame => {
            const large = Number.MAX_SAFE_INTEGER;
            const kernelReport = kernel.heartbeatSnapshot(true);
            const message = Protocol.envelope('heartbeat', epoch, {
                ...kernelReport, safety: safetyTotals(),
                queueHead: { ...kernelReport.queueHead, kind: 'normal',
                    dueAt: large, overdue: false, current: false },
                competition: { mode: 'addressed', at: frame.at, events: [], frame: { ...frame, events: [] } },
                tables: tables.summary(), heapUsed: large, rss: large, v8Heap: { used: large, total: large, external: large, limit: large, afterGc: large, afterGcMax: large, late: large },
                eventLoopUtilization: 1, eluActiveMs: large, eluIdleMs: large, eventLoopLagP95Ms: large,
                eventLoopLagMaxMs: large
            }, 'x'.repeat(160));
            return new (invoke('GameServer/Bot/Population/ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, []);
        } });
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        // Read and reset first: the beat's own work (the review, the send) counts in the next beat; a
        // sample counts the whole timer interval, so the resolution comes off (0 = no delay).
        const lagMaxMs = Math.max(0, eventLoopDelay.max / 1e6 - LAG_RESOLUTION_MS) || 0;
        const lagP95Ms = Config.developerDiagnostics ? Number(eventLoopDelay.percentile(95) / 1e6) || 0 : 0;
        eventLoopDelay.reset();
        if (!kernel.paused && !shuttingDown) outbox.reviewBatch(Date.now());
        const elu = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();
        outbox.sweep();
        const heartbeat = {
            ...kernel.heartbeatSnapshot(),
            ...heapTelemetry.snapshot(),
            geodata: GeodataEngine.storageStats(),
            // The beat's busy share and its active / idle ms: main sums the ms into the health line's
            // busy share over its own window (a beat delayed by a long task lasts longer).
            eventLoopUtilization: elu.utilization, eluActiveMs: elu.active, eluIdleMs: elu.idle,
            eventLoopLagMaxMs: lagMaxMs,
            ...(Config.developerDiagnostics ? { occupationPlanning: occupationPlanner.snapshot() } : {}),
            safety: safetyTotals(),
            competition: outbox.snapshot(),
            ...(Config.developerDiagnostics ? {
            tables: tables.summary(),
            developerDiagnostics: economyDiagnostics.delta(),
            links: EconomyContext.linkStats(),
            caches: { spotValue: SpotValueTable.cacheStats(), kitProfiles: ColdCombatProfile.kitStoreSize() },
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopLagP95Ms: lagP95Ms
            } : {})
        };
        // A beat main did not take: its frame stays the outbox's for the next beat;
        // counted (heartbeat:send_failed), a throw also by its site and first stack.
        try {
            if (send('heartbeat', heartbeat)) { if (Config.developerDiagnostics) economyDiagnostics.deltaSent(); }
            else Situations.note('heartbeat:send_failed');
        } catch (error) {
            Situations.note('heartbeat:send_failed');
            FailureLog.note('worker.heartbeat_send', error);
        }
    }, Math.max(250, Number(config.heartbeatMs) || 1000));
    loopTimer.unref?.();
    flushTimer.unref?.();
    heartbeatTimer.unref?.();
}

async function handle(message) {
    const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch, bytes: message?.bytes });
    if (!valid.ok) {
        send('fault', { reason: valid.reason, msgId: message?.msgId || null });
        return;
    }
    let payload;
    try { payload = invoke('GameServer/Bot/Population/ColdStateWire').unpackPayload(message.type, message.payload || {}); }
    catch (error) { send('fault', { reason: error.message, msgId: message.msgId }); return; }
    switch (message.type) {
    case 'catalog_page':
        if (payload.catalog === 'npc_offers') {
            planningNpcOfferRows.push(...(payload.rows || []));
            if (payload.done) {
                BotMarketPricing.useNpcOfferSnapshot(planningNpcOfferRows);
                planningNpcCatalog = ColdNpcPlanningCatalog.createLookup(planningNpcOfferRows, boardReady);
                planningNpcOfferRows = [];
            }
        } else {
            planningSpots.push(...(payload.rows || []));
        }
        break;
    case 'init':
        RecomputeGeneration.configure(payload.recomputeGeneration);
        startKernel(payload.config || {});
        send('ready', {
            phase: 'running',
            pvpAggression: Config.pvpAggression,
            protocolVersion: Protocol.PROTOCOL_VERSION,
            data: {
                items: DataCache.items?.length || 0,
                npcs: DataCache.npcs?.length || 0,
                rewards: DataCache.npcRewards?.length || 0,
                npcEquipmentItems: planningNpcCatalog.itemCount,
                npcEquipmentOffers: planningNpcCatalog.offerCount
            }
        }, message.msgId);
        break;
    case 'table_page': {
        const resync = tables.apply(payload.tables.filter(table => table.name !== 'actors'));
        if (resync.length) send('table_resync', { names: resync });
        // A replaced table rechecks the slots that read it once its copy is
        // whole (both in one page: one recheck).
        let replaced = false;
        if (boardReplacing && tables.ready('board')) { boardReplacing = false; replaced = true; }
        if (marketReplacing && tables.ready('market')) { marketReplacing = false; replaced = true; }
        if (replaced) occupationPlanner.recheckSources();
        break;
    }
    case 'clan_social_page':
        if (!kernel) break;
        for (const snapshot of payload.rows || []) {
            kernel.interactionMemory.clanSocial.accept(snapshot);
        }
        if (payload.memberships) {
            kernel.interactionMemory.clanSocial.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
        }
        break;
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        if (payload.economyOwnerId !== undefined) {
            if (Number.isSafeInteger(payload.economyOwnerId) && payload.economyOwnerId > 0
                && Array.isArray(payload.rows) && !payload.rows.length) occupationOwnerChanged(payload.economyOwnerId);
            break;
        }
        kernel.upsertMany(payload.rows || []);
        if (payload.initial === true && payload.done === true) safetyStateReady = true;
        if (payload.ack) {
            send('ready', {
                phase: 'state_loaded',
                characterId: Number(payload.rows?.[0]?.state?.characterId || 0),
                ...kernel.heartbeatSnapshot()
            }, message.msgId);
        } else if (payload.done) {
            send('ready', { phase: 'snapshots_loaded', ...kernel.heartbeatSnapshot() }, message.msgId);
        }
        break;
    case 'worker_presence_request':
        send('worker_presence_ack', { results: payload.rows.map(row => safetyPresence(Protocol.safetyCheckpoint(row))),
            safety: safetyTotals() }, message.msgId);
        break;
    case 'worker_repair_request':
        send('worker_repair_ack', { results: payload.rows.map(safetyRepair), safety: safetyTotals() }, message.msgId);
        break;
    case 'commit_ack':
        contestAcked(kernel?.onCommitAck(payload));
        break;
    case 'command_request':
        for (const request of payload.requests || []) if (!kernel?.receiveMeetingPage(request))
            send('command_ack', { results: [{ kind: 'meeting', characterId: request.characterId, commandId: request.commandId,
                pageIndex: -1, ok: false, reason: 'trade_meeting_worker_busy' }] });
        break;
    case 'command_ack':
        (payload.results || []).forEach(result => kernel?.completeCommand(result));
        break;
    case 'party_formation_request': {
        const states = kernel
            ? [...kernel.states.values()].map((entry) => entry?.state).filter(Boolean)
            : [];
        send('party_formation_proposal', RequiredPartyFormation.proposalFromStates(states, payload), message.msgId);
        break;
    }
    case 'party_goal_request':
        if (payload.pageIndex !== undefined) admitPartyGoalPages(payload, message.msgId);
        else requestPartyGoals(payload, message.msgId);
        break;
    case 'fence': {
        occupationPlanner.cancel(payload.characterId);
        cancelRoute(payload.characterId);
        send('fence_ack', kernel?.fence(payload.characterId) || { characterId: Number(payload.characterId), proposal: null },
            message.msgId);
        break;
    }
    case 'release':
        kernel?.remove(payload.characterId);
        break;
    case 'pause':
        kernel?.pause();
        break;
    case 'resume':
        kernel?.resume();
        break;
    case 'overdue_trace':
        kernel?.traceBot(payload.characterId, payload.main);
        break;
    case 'throttle':
        kernel?.setMaxInFlight(payload.maxInFlight);
        break;
    case 'diagnostics_resync':
        economyDiagnostics.requestFull();
        break;
    case 'competition_release':
        if (Object.hasOwn(payload, 'receipt')) outbox?.receipt(payload.receipt);
        // Events main skipped for its action budget: not carried out, not resent (their arrival is past).
        for (let i = 0; i < (payload.events || []).length; i++) Situations.note('spot:contest:skipped');
        break;
    case 'shutdown':
        buyerWaiters.clear();
        if (shuttingDown) break;
        shuttingDown = true;
        for (const entry of partyGoalPages.values()) { clearTimeout(entry.timer); partyGoalJobs--; }
        partyGoalPages.clear(); partyGoalSeen.clear();
        routeRequests.clear();
        Trace.stop();
        occupationPlanner.stop();
        outbox?.stop();
        stopTimers();
        eventLoopDelay?.disable();
        heapTelemetry?.close();
        send('drained', await kernel?.shutdown() || {}, message.msgId);
        parentPort.close();
        break;
    default:
        send('fault', { reason: 'unhandled_message', type: message.type }, message.msgId);
        break;
    }
}

parentPort.on('message', (message) => {
    if (message?.type === 'decision_trace_ack' && message.epoch === epoch) {
        Trace.ack(message.id, message.accepted); return;
    }
    Promise.resolve(handle(message)).catch((error) => {
        send('fault', { reason: error?.message || 'worker_message_error', stack: error?.stack || null, msgId: message?.msgId || null });
    }).finally(wakeLoopIfSooner);
    // A message that changed the schedule synchronously (an ack, a snapshot,
    // a buyer wake) moves the loop timer now; an awaited one at its finally.
    wakeLoopIfSooner();
});

send('ready', {
    phase: 'loaded',
    protocolVersion: Protocol.PROTOCOL_VERSION,
    forbiddenDependencies: forbiddenLoaded.length
});

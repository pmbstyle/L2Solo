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
const { ColdCompetitionMonitor } = require('./ColdCompetitionMonitor');
const ColdCompetitionCandidates = require('./ColdCompetitionCandidates');
const { ColdSimulationKernel, lifecycleKind } = require('./ColdSimulationKernel');
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
let competition = null;
let competitionCandidates = null;
let competitionReady = false;
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
// - near, refresh, meeting: the asked state object (they build the economy,
//   which reads the bot's memory rows, crowd and goals beside the state: a new
//   state object stands for their moves) and the inputs asked beside it: the
//   warehouse and clan supply versions, the escrow, the recipe book and known
//   shot recipes, whether the board and market copies are whole, the pending
//   page count and a meeting's token. A short string, no state read.
const CLOCK_MODES = new Set(['action', 'showcase', 'craft_market']);
const IDENTITY_MODES = new Set(['near', 'refresh', 'meeting']);
const STATE_STAMPS = Object.freeze({ updatedAt: undefined, simulation: undefined, timing: undefined });
const WORKSHOP_STATS = Object.freeze(['workshop', 'dwarvenCraftLevel', 'classId', 'race', 'money', 'equipmentPlan',
    'wishFocus', 'craftStationId', 'craftShop', 'clanId', 'travel', 'marketReturn', 'karma', 'clanMaterialDemand',
    'clanMarketDemand', 'marketErrand', 'marketErrands', 'marketSellSeen', 'wealthRefused', 'wealthCraft', 'shotCraft',
    'stockTargets', 'dangerPrice', 'tradeMeeting', 'townLook', 'hennas', 'generatedIndex', 'playerPartyTakeover',
    'decisionSeq', 'activityLeaf', 'economyClock', 'playedHours', 'frustration', 'lifelongKills', 'exp']);
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
    sourceToken: (id, input) => input?.mode === 'meeting'
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
                        if (economyDiagnostics.enabled(ownId)) economyDiagnostics.push({ owner: ownId,
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
                        || [...slot.reads].some(([id, token]) => occupationPlanner.sourceToken(id, slot.input) !== token)) throw error;
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

        // A refresh (a far bot's economy plan) and a near bot's decision
        // (mode near) build the economy on the same inputs.
        if (input.mode === 'refresh' || input.mode === 'near') {
            const routeRows = input.routeRows = input.routeRows || (yield* EconomicTrip.prepare(input.state));
            // A board move restarts a refresh of the same state: its plan reads the board
            // again, its build stands, a bot in the field does not weigh for a price.
            input.economy = input.source.builtRefresh || EconomyContext.forState(input.state, {
                board: input.board, routeRows, workshops: workshopsFor,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, workshop: noWorkshop(),
                caller: `economy_${input.mode}`, trigger: 'native_own_action' });
            // The plan does not stand and the bot is at work: its step decides and answers.
            if (!input.economy) { input.source.leftToStep = true; return noWorkshop(); }
            if (input.mode === 'refresh' && !input.source.builtRefresh) {
                if (DecisionSections.FIELD_ACTIVITIES.has(input.state.activity)) input.source.builtRefresh = input.economy;
            }
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
        if (!prepared && input.mode === 'refresh') {
            const economyPlan = yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                now: input.timestamp, board: input.board, persona: BotPersona.of(input.state), tripCost: input.economy.trip,
                preparedCraft: null, npcOffersFor: OccupationSources.npcOffersFor, saleHold: saleHold(input.state.characterId),
                buyOrderEscrow: input.buyOrderEscrow, findSpot: id => SpotIndex.spotById(planningSpots, id) });
            return { selected: null, economyPlan, economyDecision: ColdEconomyDecision.capture(input.economy, input.state) };
        }
        if (!prepared) return input.mode === 'action' ? null : ColdEconomyDecision.unknownWorkshop();
        const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
        const action = input.mode === 'action' || input.mode === 'refresh';
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
            ...(economyDiagnostics.enabled(input.state.characterId) ? { onTownDecision: decision => economyDiagnostics.push({
                owner: input.state.characterId, revision: Number(input.state.simulation?.revision), trigger: 'economy_plan',
                phase: 'town_choice', town: decision.town, reason: decision.reason, candidates: decision.candidates,
                tripHours: decision.tripHours, tripFees: decision.tripFees
            }) } : null),
            findSpot: id => SpotIndex.spotById(planningSpots, id),
            buyOrderEscrow: input.buyOrderEscrow, knownShotRecipes: input.knownShotRecipes
        }) : null;
        return { selected, economyPlan, ...(input.mode === 'refresh' ? { economyDecision:
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
        if (input.mode === 'refresh') {
            input.builtRefresh = null;
            const entry = kernel?.states.get(id);
            if (input.leftToStep) {
                if (entry?.state === input.sourceState) entry.refreshWaits = true;
                occupationPlanner.release(id, 'refresh'); return;
            }
            // The plan was already sent; a source change does not re-request
            // a refresh for the same native state (the next state does).
            if (meta.stale && entry?.state === input.sourceState && entry.economyPending) {
                occupationPlanner.release(id, 'refresh'); return;
            }
            if (!shuttingDown && entry?.state === input.sourceState && !meta.stale && workshop?.economyPlan) {
                const hash = economyPlanHash(workshop.economyPlan);
                // A paging refresh that repeats the plan already sent (by the
                // commit or the last refresh) has nothing more to page.
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
                near: { statsPacket: workshop.statsPacket, shotRestock: workshop.shotRestock, personalCraft: workshop.personalCraft,
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
    return { workshop, decision: ColdEconomyDecision.capture({ ...input.economy, workshop }, input.state),
        ...DecisionEvents.nearFields(input.economy, input.state), routeRows: input.routeRows };
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
const refreshedStates = new WeakSet();
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
// A far bot's economy refresh, or a near bot's decision on its post (mode
// near): the raise it consumed (raiseSeq) and the route rows of its last
// decision while its route key holds.
function occupationOwnerChanged(id, refresh = false, afterStep = false) {
    const entry = kernel?.states.get(Number(id));
    if (!entry || entry.state.phase !== 'hot' && !refresh) return;
    // A dirty bot's next step builds this same decision: the refresh runs after
    // it, on that step's held build, not as a second build beside it. A bot with
    // no step coming (a shop, a meeting) answers here.
    if (refresh && !afterStep && entry.state.phase === 'cold'
        && Number(entry.state.stats?.wishDirty) && lifecycleKind(entry.state) !== 'event_driven') {
        entry.refreshWaits = true;
        return;
    }
    if (refresh) entry.refreshWaits = false;
    // One economy refresh per native state object.
    if (refresh && refreshedStates.has(entry.state)) return;
    if (refresh) {
        refreshedStates.add(entry.state); economyDiagnostics.count('occupation', 'refresh', 'main_state');
    }
    const routeKey = EconomicTrip.key(entry.state);
    occupationPlanner.request(id, { state: entry.state, sourceState: entry.state, assetsKey: assetsKey(entry.state),
        timestamp: Date.now(), mode: refresh ? 'refresh' : 'near', pending: entry.economyPending || 0,
        buyOrderEscrow: escrowFor(id),
        ...recipeKnowledgeOf(entry.state),
        routeKey, ...(refresh ? {} : { raiseSeq: Number(entry.raiseSeq || 0),
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
// The soft point's inputs (DecisionSections.softEvents: a far bot's step,
// BotLifeState.prepareResolve, and a near bot's post): the board mirror (null
// until ready), the escrow and the bot's memory rows, read only when its bond
// is compared.
const softInputFor = (characterId, timestamp) => ({ board: boardReady(), buyOrderEscrow: escrowFor(characterId), timestamp,
    memory: () => kernel.interactionMemory.relationRows(Number(characterId)) });
// A near bot's post (BotLifeState.notifyNearFacts) against the row before
// it, on the posted row before it is stored: the raises main named and
// detected (once per raise) and the soft point. The decision is then taken on this row (mode near).
// applied: the last raise the record applied.
function nearEvents(id, previous, entry, applied) {
    const row = entry.state, stats = row.stats ||= {};
    // The worker owns the near mind: a post's mind keys are discarded and the
    // record's stand, so a late post cannot roll back a raise.
    for (const key of SavedStats.MIND_KEYS) stats[key] = previous.stats?.[key];
    // Main detected the body's own facts (A1) and named them in the bag.
    entry.raiseSeq = DecisionEvents.takePostedRaise(stats, row.raise, applied, Situations.bodyPlace(row));
    const where = Situations.place(row, previous);
    for (const name of DecisionSections.softEvents(row, stats.wishSections, softInputFor(id, Date.now()))) Situations.raise(stats, name, null, where);
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
// A party's competition side is read through its leader: a row that changes
// leaders moves both the old and the new leader's candidate.
tables.watch('parties', {
    reset: () => { for (const leaderId of kernel?.partyReset() || []) competitionCandidates?.partyChanged(leaderId); },
    put: (key, row) => {
        const previous = kernel?.partyPut(key, row);
        competitionCandidates?.partyChanged(row.leaderId);
        if (previous && Number(previous.leaderId) !== Number(row.leaderId)) competitionCandidates?.partyChanged(previous.leaderId);
    },
    remove: key => {
        const previous = kernel?.partyRemove(key);
        if (previous) competitionCandidates?.partyChanged(previous.leaderId);
    }
});
// The memory rows are kept packed by the kernel's InteractionMemory, not a
// second plain copy in the mirror (retain: false); older revisions are refused.
// Main publishes no removed row: the set is bounded by the owners main
// accepted, and a full copy (reset) re-sends them, kept views refuse equals.
tables.watch('memory', {
    reset() {},
    put: (key, row) => { if (kernel?.interactionMemory.accept(row)) kernel.decisionEvents?.memoryChanged(Number(key)); },
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
function withIncomeRoute(deps, basics) {
    const route = basics?.preparedIncomeRoute;
    return route ? { ...deps, preparedIncomeRoute: route } : deps;
}
// The prepared card's verdict (ColdEconomyDecision.refusal) joins the build's
// mask (EconomyContext.forState, deps.eventVerdict).
function withEventVerdict(deps, prepared) {
    return prepared.eventVerdict ? { ...deps, eventVerdict: prepared.eventVerdict } : deps;
}
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
// Two plan-like stats values hold the same data (undefined reads as null).
function samePlanJson(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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
// The native facts that hold a plan with no planner run: failure counters and
// recovery deadlines, live even while the wish calculation holds.
function nativeFactsHold(replan) {
    return !replan.failure && !replan.invalidSource && !replan.levelingRecovery;
}
// A plan's source is judged when it or the bot's level moves: a kit moves the
// build facts, and that build judges it (GearPlanSelection). A matchup read on
// every step of every hunter answers what already stands.
function planSourceHolds(state, plan, timestamp) {
    if (plan?.status !== 'active') return true;
    const record = kernel?.states.get(Number(state.characterId));
    const source = `${plan.next?.spotId}:${plan.next?.npcId}:${state.level}`;
    if (record?.planSource === source) return true;
    // Read live (the health line): how often a source or a level moved and the matchup was read again.
    EconomyContext.countDoor(`plan_source|${record?.planSource ? 'moved' : 'first'}`);
    if (!GearAcquisitionPlanner.isPlanSourceViableForState(state, plan, { spots: planningSpots, timestamp })) return false;
    if (record) record.planSource = source;
    return true;
}
// The existing native plan verdict. It grants no economy command or social
// interaction.
function nativePlanHolds(state, previousPlan, nativeReplan, timestamp, onFinalize = null) {
    if (!planSourceHolds(state, previousPlan, timestamp)) return false;
    const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
        && previousPlan.next == null && previousPlan.reason === 'wish_focus';
    const wishHolds = (wishFocus || previousPlan?.source === 'wish_network')
        && !previousPlan.levelingRecovery
        && nativeReplan.recoveryTargets.length === (previousPlan.recoveryTargets || []).length;
    if (!previousPlan || DecisionSections.isEmptyWishPlan(previousPlan) || wishHolds) return true;
    if (previousPlan.status !== 'active' || !nativeReplan.routeCurrent
        || nativeReplan.failure || nativeReplan.invalidSource || nativeReplan.levelingRecovery) return false;
    onFinalize?.();
    return samePlanJson(GearAcquisitionPlanner.finalizePlan(state, previousPlan, previousPlan, nativeReplan, timestamp), previousPlan);
}
// L115: a publication the event proof refuses drops the advice, counted by
// its first failing check.
// owner: the bot's kernel record the step read; the card is a field of it.
function rememberWishAdvisory(owner, advisory, seen = null, deps = null) {
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
    // Validate this publication against the original build's proof.
    const why = diagnostic ? [] : undefined;
    const Economy = advisory && seen && deps ? EconomyContext : null;
    const options = advisory && deps ? { baseline: advisory.baseline, activity: advisory.activity,
        leaf: advisory.card?.activity, mp: advisory.mp,
        timestamp: Number(deps.timestamp || Date.now()), why } : null;
    if (advisory && seen && (!Economy || !(advisory.eventProof && Economy.eventProofHolds(seen, advisory.eventProof, deps, options)))) {
        if (diagnostic) economyDiagnostics.count('card', 'drop', `remember:${deps ? why[0] || 'unknown' : 'no_deps'}`);
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

// The cheap check `room` at arrival: the bots that stand on the spot in the
// one "who stands here" index (kernel.occupancy), other than the arriving
// ones, plus the arriving ones, against the spot's capacity. A bot traveling
// there is indexed at its destination but does not stand there yet. Read once
// when a trip ends; no place is held for a bot on its way. A raid boss spot or
// a spot the catalog does not know has room.
function roomAtArrival(spotId, arriving, overflow = 0) {
    const room = SpotProfiles.spotRoom(planningSpots, spotId);
    if (room === Infinity) return true;
    const standing = kernel.occupancy.physicalCount(spotId, { excludeKeys: arriving, standingOnly: true });
    return standing + arriving.size <= room + overflow;
}

// The step's trip begins, or waits for the engaged fight (PveEncounter.holdsTrip):
// the round then ends that fight with no new one, and the kept route waits on
// the record for the next step.
function stepTrip(state, route, timestamp) {
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

// A solo trip ends on a full spot: the bot stands there with a "was full"
// mark (counted from this step's counter before its +1) and the step raises
// spot_crowded (occupation and sources) with its other events, so the next step's decision
// point refuses the hunting leaf there and the spot search takes the next one.
// A safety evacuation may exceed a full spot by one bot. A party trip is
// checked once, at the party's arrival (partyArrival). Returns the marked
// result, or null when the step is no such arrival or the spot has room.
function soloArrival(state, result) {
    const travel = state?.activity === 'traveling' ? state.stats?.travel : null;
    if (!travel?.spotId || travel.reason === 'party_spot_replan' || result?.patch?.activity !== 'hunting'
        || String(result.patch.spotId) !== String(travel.spotId)) return null;
    const room = roomAtArrival(travel.spotId, new Set([stateKey(state)]),
        travel.reason === 'unsafe_ground_evacuation' ? 1 : 0);
    economyDiagnostics.count('roomAtArrival', 'solo', 'checked');
    if (room) return null;
    economyDiagnostics.count('roomAtArrival', 'solo', 'full');
    // Which trips still end on a full spot: the read names their reasons.
    economyDiagnostics.count('roomAtArrival', 'full', travel.reason || 'none');
    // The arrival patch carries the whole stats copy (resolveTravel); the mark
    // reads the same counter and marks from the state the step started on.
    const { capacityBackoffs, lastReason } = SpotRiskPolicy.withCapacityBackoff(state, travel.spotId).stats;
    return { ...result, patch: { ...result.patch, stats: { ...result.patch.stats, capacityBackoffs, lastReason } } };
}

// A party trip ends (the kernel's party round, finishPartyRouteTravelState):
// the spot's standing bots that are not of this party plus the whole party
// against the capacity, no overflow. Full -> the party's "was full" mark
// (PartySpotRiskPolicy, read by its next spot search) and spot_crowded
// raised on the leader; the members arrive and stand. The party's own
// objective spot (a clan goal, a material party) admits it: a pass read from
// the goal the party carries, not a place held for it, so a full roster does
// not bounce between its objective and a fallback spot. cause: the trip's
// (party.stats.travel.cause): position_mismatch or death_pressure (the run's
// search); none: 'route', the
// run's search that picked a new spot.
function partyArrival({ party, members, spotId, cause = null }) {
    const arriving = new Set((party?.memberIds || []).map(String));
    if (!spotId || !arriving.size) return null;
    if (String(spotId) === String(party.stats?.objective?.spotId ?? '')) {
        economyDiagnostics.count('roomAtArrival', 'party', 'pass');
        return null;
    }
    const room = roomAtArrival(spotId, arriving);
    economyDiagnostics.count('roomAtArrival', 'party', 'checked');
    if (room) return null;
    economyDiagnostics.count('roomAtArrival', 'party', 'full');
    economyDiagnostics.count('roomAtArrival', 'party_full', cause || 'route');
    const leaderId = Number(party.leaderId || 0);
    return {
        party: PartySpotRiskPolicy.withCapacityBackoff(party, spotId),
        members: members.map(member => {
            if (Number(member.characterId) !== leaderId) return member;
            const raised = { ...member, stats: { ...(member.stats || {}) } };
            Situations.raise(raised.stats, 'spot_crowded', null, Situations.place(raised));
            return raised;
        })
    };
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
let partyGoalJobs = 0;
let partyGoalTail = Promise.resolve();
const partyGoalPages = new Map();
const partyGoalSeen = new Map();
function partyMembersAvailable(members) {
    return members.every(member => kernel.commandStartedAt.get(member.characterId)?.kind !== 'meeting'
        && !['meeting', 'refresh', 'action'].some(mode => {
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
            const verdict = {};
            const workshop = EconomyContext.heldWorkshop(member, deps, verdict)
                || (CraftEligibility.isServiceCrafter(member)
                    ? await askWorkshop(member, timestamp, deps.routeRows, 'party_goal', options) : noWorkshop());
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            return EconomyContext.forState(member, { ...deps, workshop, eventVerdict: verdict, withNodes: true });
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
    Config.economyDiagnostics = Config.developerDiagnostics && config.economyDiagnostics === true;
    // Busy share and heap after GC are two of the goal's three numbers (read with diagnostics off): always on, one
    // major-GC observer and two clock reads per heartbeat.
    heapTelemetry = invoke('GameServer/Bot/Population/WorkerHeapTelemetry').observe();
    previousElu = performance.eventLoopUtilization();
    // The longest loop delay per heartbeat is the health line's spike number (workerLag): always on,
    // a native histogram on a LAG_RESOLUTION_MS timer.
    eventLoopDelay = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
    eventLoopDelay.enable();
    Config.economyDiagnosticsBotIds = Config.economyDiagnostics ? config.economyDiagnosticsBotIds || '' : '';
    if (Config.economyDiagnostics) economyDiagnostics.connect(batch => {
        if (shuttingDown) return false;
        const message = { type: 'economy_diagnostics', epoch, ...batch, dropped: economyDiagnostics.stats().dropped };
        const wireBytes = Buffer.byteLength(JSON.stringify(message));
        if (wireBytes > 16384) return false;
        parentPort.postMessage(message);
        return wireBytes;
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
            // Room at arrival, before the projection: a full spot's mark rides
            // the patch, its sections join the step's one raise.
            const raidPreparing = require('./RaidSupplyPolicy').held(state, timestamp);
            const crowded = !raidPreparing && soloArrival(state, result);
            if (crowded) result = crowded;
            // The step's one decision, taken before the round (planLifecycle):
            // the round's consequences run on it, no second ask. A step
            // without one (a party member, karma) asks after
            // the round below: that is its one decision point.
            const stepEconomy = lifecyclePlan?.economy || null;
            let economy = stepEconomy, seenEcho = null, refreshed = null, observedDeps = null, economyEdges = null;
            // The facts of this step's last action ask (askAction), carried to its commit.
            let actionBaseline = lifecyclePlan?.actionBaseline || null;
            const base = {
                ...roundProjection(state, timestamp, writtenAt, lifecyclePlan),
                ...(crowded ? { checkSituations: ['spot_crowded'] } : {}),
                // The soft point's inputs (BotLifeState.prepareResolve, every
                // step): the board mirror (null until ready), the escrow and
                // the bot's memory rows, read only when its bond is compared.
                softInputFor: (projected, at) => softInputFor(projected.characterId, at)
            };
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
                        const prepared = {};
                        refreshed = !projected.party?.partyId && !projected.partyId
                            ? ColdEconomyDecision.refreshAdvisory(projected, owner?.wishAdvisory, deps,
                                { afterResult: true, prepared, collect: true }) : null;
                        // Both native stock gates read one prepared foundation;
                        // the same edges also drive the action after projection.
                        // L116: a reuse's own basics, else built at the first
                        // gate read (edges skips resting, travelling and party
                        // bots, which read none).
                        let stock = refreshed?.economy || prepared.basics || null;
                        economyEdges = actionEdges(state, projected,
                            kind => (stock ||= prepared.basics = EconomyContext.basics(projected, deps)).stock(kind), actionBaseline);
                        if (refreshed) refreshed = await refreshCraftPacket(projected, timestamp, refreshed);
                        if (refreshed?.actionBaseline) actionBaseline = refreshed.actionBaseline;
                        if (refreshed) { if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'result'); return refreshed.economy; }
                        // The lifecycle's order: the held build's workshop while its
                        // key holds, else the planner's answer (stepWorkshop).
                        const caller = projected.party?.partyId || projected.partyId ? 'party' : 'karma';
                        deps.workshop = EconomyContext.heldWorkshop(projected, deps, prepared.eventVerdict ||= {})
                            || await stepWorkshop(projected, timestamp, deps, caller);
                        return EconomyContext.forState(projected, withIncomeRoute(withEventVerdict(deps, prepared), prepared.basics));
                    },
                    onEconomy: (built, seen) => {
                        economy = built; seenEcho = ColdEconomyDecision.stateEcho(seen);
                        // This build clears wishDirty too (a party member, a karma step).
                        if (Number(built?.mask) & DecisionSections.COMPUTED.route) dropRoute(state.characterId, 'sections');
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
                // party requirement plan reads this build, not a second one.
                ...(economy ? { economy } : {}),
                buffOffer: invoke('GameServer/Bot/Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                // Worker-local: the kernel keeps it for the commit ack.
                ...(actionBaseline ? { actionBaseline } : {}),
                ...(economyDecision ? { economyDecision } : {})
            };
        },
        soloWindow: {
            // One round of a window: the step's projection without its soft
            // point and what follows it (ColdSoloWindow, the window's end has them).
            projectRound: (state, result, timestamp, plan, writtenAt) => LifeStateProjector.prepareResolve(state, result,
                { ...roundProjection(state, timestamp, writtenAt, plan), statsPacket: plan.statsPacket, statsPacketBeforeResolve: true }),
            readers: plan => ({
                edges: (before, after) => stockEdges(before, after, plan.economy),
                moneyBound: after => DecisionSections.moneyReached(after, after.stats?.wishSections, escrowFor(after.characterId)),
                // The soft point's market watch (heard at work), against the board mirror.
                market: after => {
                    const board = boardReady();
                    return !!board && Situations.hears('market', Situations.place(after))
                        && DecisionSections.marketCrossed(board, after.stats?.wishSections?.marketWatch, Number(after.characterId));
                },
                feasible: after => {
                    const leaf = plan.economy.network?.activity, failed = EconomyContext.leafCheck(after, leaf, {}, { heldUnits: heldAtStep(plan) });
                    return !failed || !Situations.hears(failed.link, Situations.place(after));
                },
                // The native facts planLifecycle reads, on the round's end.
                planHolds: (after, at) => {
                    const held = after.stats?.equipmentPlan || null;
                    const replan = GearAcquisitionPlanner.replanContextFor(after, held, at);
                    return nativeFactsHold(replan) && nativePlanHolds(after, held, replan, at);
                }
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
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            // A karma step carries no stats packet: it keeps the previous shot demand.
            if (karmaPlan) return karmaPlan;
            const originalPlan = state.stats?.equipmentPlan || null;
            const previousPlan = GearPlanSelection.uniqueCraftProjects(originalPlan);
            if (previousPlan !== originalPlan) state = { ...state, stats: { ...state.stats, equipmentPlan: previousPlan } };
            const craftBidReview = personalCraftBidReviewDue(state);
            // Failure counters and recovery deadlines are live native facts,
            // even when the expensive wish calculation still holds.
            const nativeReplan = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
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
            // below (PartyRequestPlanner, decision 10-30): no card reuse.
            const solo = !state.party?.partyId && !state.partyId && !state.stats?.partyRequest
                && !PartyRequestPlanner.supportWithoutGround(state, spots, routeSearch(state, timestamp));
            const nativeHolds = nativeFactsHold(nativeReplan);
            // An active current plan: before, finalizePlan re-finalized it on
            // every such step. Its steps count as plan_holds finalized (paid)
            // + skipped (saved).
            const routeHeld = previousPlan?.status === 'active' && nativeReplan.routeCurrent && nativeHolds;
            // Asked only by the card path of a solo bot whose native facts
            // hold (and by the diagnostics refusal name): finalizePlan is
            // pure, so the re-finalized plan and its JSON compare give the
            // same answer whenever they run. The new skip is a party bot (or
            // one with a pending party request) holding an active current
            // plan, and a plan the clauses before it already hold. A failed
            // route never paid: routeHeld excludes it and routeCurrent
            // implies no leveling recovery, so the diagnostics ask for a solo
            // bot whose native facts fail never reaches the finalize.
            let planHoldsAnswer, finalized = false;
            const planHolds = () => {
                if (planHoldsAnswer !== undefined) return planHoldsAnswer;
                // Native wish_focus retains inactive target/history fields,
                // not a current route/quote. A wish-network route
                // (WishProviders.personalCraftPlan) never passes finalizePlan,
                // so it has no grade/level/rate stamps. Neither is judged by
                // native stamps: the current advisory fence below is (its
                // build holds the level and worn kit). A wake/expiry still
                // goes through the native planner.
                return (planHoldsAnswer = nativePlanHolds(state, previousPlan, nativeReplan, timestamp, () => {
                    finalized = true;
                    if (economyDiagnostics.active()) economyDiagnostics.count('lifecycle', 'plan_holds', 'finalized');
                }));
            };
            // A proved ordinary solo round keeps its accepted native plan.
            // Party waiting, failed targets and excluded grounds still take
            // the existing planner; no new choice is made from a thin card.
            // A refused card's verdict serves the build below, which reads
            // this state, or a copy of it with a wish-focus plan deferred.
            const prepared = {};
            const where = Situations.place(state);
            // A native plan that failed or moved is a real review: every gear candidate.
            deps.fullReview = (previousPlan !== originalPlan || !nativeHolds || solo && !planHolds()) && Situations.hears('native', where);
            // Diagnostics only: why the card did not serve the step, its own
            // refusal (advisory:refused:<reason>) or a skip around it
            // (advisory:skip:<why>; wish_focus: a refused card of a deferred
            // wish-focus plan, whose verdict the build on its copy cannot take).
            const advisory = economyDiagnostics.active() ? (outcome, reason) => economyDiagnostics.count('advisory', outcome, reason) : null;
            const why = advisory ? [] : undefined;
            let refreshed = solo && !deps.fullReview
                ? ColdEconomyDecision.refreshAdvisory(state, record?.wishAdvisory, deps, { prepared, collect: !wishFocus, why }) : null;
            if (advisory && !refreshed) {
                if (!solo) advisory('skip', 'party');
                else if (deps.fullReview) advisory('skip', 'full_review');
                else {
                    advisory('refused', why[0] || 'unknown');
                    if (wishFocus) advisory('skip', 'wish_focus');
                }
            }
            // A compact advisory contains no quantitative project needs.
            // The bounded clan-market review needs the full current graph.
            const marketReview = refreshed && (craftBidReview ? 'craft_bid' : clanMarketReviewDue(state) ? 'clan_market' : '');
            if (marketReview && Situations.woke(marketReview, where)) { refreshed = null; advisory?.('skip', 'market_review'); }
            if (refreshed) {
                refreshed = await refreshCraftPacket(state, timestamp, refreshed);
                if (!refreshed) advisory?.('skip', 'craft_packet');
            }
            // Compact advice has no full money queue for clan acquisition.
            // A null intention takes its ordinary native selection there.
            if (refreshed?.economy.network.activity === null && GearAcquisitionPlanner.isClanOwnedPlan(previousPlan) && Situations.woke('clan_market', where)) {
                refreshed = null; advisory?.('skip', 'clan_market');
            }
            const nullReuse = refreshed?.economy.network.activity === null;
            // Build the renewed proof against the native live history, so a
            // consumed wake/expiry does not invalidate it again on publication.
            const preparationState = wishFocus && !refreshed ? { ...state, stats: { ...state.stats,
                equipmentPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan, state, timestamp) } } : state;
            // Both reuses (the card's leaf, a null intention) read the card's
            // workshop. A build keeps the held one while its verdict, judged
            // here on the state the build reads and handed to it
            // (EconomyContext.heldWorkshop, prepared.eventVerdict), keeps it;
            // else it asks. The kernel replaces a state, never edits it: the
            // copy and its verdict stay the build's across the ask.
            if (!refreshed) deps.workshop = EconomyContext.heldWorkshop(preparationState, deps, prepared.eventVerdict ||= {})
                || await stepWorkshop(state, timestamp, deps, 'lifecycle');
            // No later ask reaches the finalize: a solo bot under routeHeld
            // has its native facts holding, so the card path asked above.
            if (economyDiagnostics.active() && routeHeld && !finalized) economyDiagnostics.count('lifecycle', 'plan_holds', 'skipped');
            // The card passed the verdict's cheap check (its spot not excluded).
            if (refreshed && !nullReuse) {
                if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
                const leaf = refreshed.economy.network.activity;
                // The card holds the plan: the route is read on the input state.
                const { routedState, route, lastFight } = stepTrip(state, routeTrip(state, standingSpot(state), leaf, timestamp), timestamp);
                const asked = routedState.activity === 'hunting' && leaf.activity !== 'hunting'
                    ? await askAction(routedState, timestamp, { economy: refreshed.economy, caller: 'card' }) : null;
                let occupation = asked?.plan || null;
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
            const preparedEconomy = nullReuse ? refreshed.economy
                : Economy.forState(preparationState, withIncomeRoute(withEventVerdict(deps, prepared), prepared.basics));
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
            // The step took its build result, which clears wishDirty: a moved
            // route section, or a new plan destination the search reads (the
            // gear branch, the party wait), drops the kept route before the
            // trip start, so the search below runs on the planned state.
            const routeDrop = BotRoute.dropReason(Number(economy.mask) & DecisionSections.COMPUTED.route,
                { plan: previousPlan, request: state.stats?.partyRequest }, { plan: acquisitionPlan, request: partyRequest });
            if (routeDrop) dropRoute(state.characterId, routeDrop);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots,
                    { excludedSpotIds, timestamp, spotHunters: kernelHunters,
                        hasRoom: SpotProfiles.roomFilterFor(kernel.occupancy, planningSpots, [state]) })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            const statsPacket = stepStatsPacket(state, economy, timestamp);
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
        if (previous && previous !== entry.state && entry.state.phase === 'hot') nearEvents(id, previous, entry, Number(previousEntry.raiseSeq || 0));
        // The near bookkeeping ends with the body: a far record keeps no
        // route rows of a near decision, and the next activation's raises
        // count from its session's first.
        else if (entry.state.phase !== 'hot' && (entry.nearRoute || entry.raiseSeq)) { entry.nearRoute = null; entry.raiseSeq = 0; }
        const result = nativeSet(id, entry);
        if (previous !== entry.state) {
            // Each planner job of the bot (one per mode) whose inputs read the
            // same on the new state goes on, finished or in flight (main
            // echoing the bot's own commit, a catalog page resending the row);
            // any other is dropped: a near, refresh or meeting job (keyed on
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
            // Own outputs are not inputs: no economy refresh for the own
            // commit or review; economyPending stays for main's next refresh.
            if (ownOutput && entry.economyPending) economyDiagnostics.count('occupation', 'refresh',
                ownOutput === 'review' ? 'own_review_skipped' : 'own_commit_skipped');
            // A refresh that waited runs whatever the pending count: main's
            // reconcile asks with none.
            const waits = entry.refreshWaits === true;
            occupationOwnerChanged(id, waits || !ownOutput && Boolean(entry.economyPending), waits && !!ownOutput);
        }
        return result;
    };
    kernel.states.delete = id => { occupationPlanner.cancel(id); cancelRoute(id); return nativeDelete(id); };
    kernel.states.clear = () => {
        for (const entry of [...occupationPlanner.slots.values(), ...occupationPlanner.cards.values(), ...occupationPlanner.waiting.values()])
            occupationPlanner.cancel(entry.id, entry.mode);
        routeRequests.clear();
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
    if (Config.coldCompetitionObserveEnabled) {
        const allowed = new Set((DataCache.npcs || []).filter(npc => npc.template?.kind === 'Monster'
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)).map(npc => Number(npc.selfId)));
        competition = new ColdCompetitionMonitor({
            capacityForSpot: invoke('GameServer/Bot/AI/LevelingRoutes').capacityForSpot,
            personaFor: state => BotPersona.of(state),
            knowledgeFor: (source, persona, key) => persona ? { source, persona, key } : null,
            isTargetAllowed: id => allowed.has(id),
            ownSide: ColdPvpResolver.ownSide,
            leaderParty: id => kernel.leaderParty(id),
            spotOf: standingSpot
        });
        competitionCandidates = new ColdCompetitionCandidates({
            records: id => kernel.states.locationIndex.getSource(id, 'state'),
            packets: id => kernel.states.get(id), memory: kernel.interactionMemory,
            monitor: competition, deadlines: kernel, leaderParty: id => kernel.leaderParty(id), spotOf: standingSpot,
            frameSizing: frame => {
                // ARCH-NOTE: these retained fields determine the existing byte admission.
                // Keep identical conservative capacity on/off; Candidates.snapshot hides
                // their optional publication. Removing this coupling needs a protocol task.
                const report = competition.snapshot();
                const large = Number.MAX_SAFE_INTEGER;
                const outcomes = Object.fromEntries(Object.keys(report.outcomes).map(key => [key, large]));
                const kernelReport = kernel.heartbeatSnapshot(true);
                const message = Protocol.envelope('heartbeat', epoch, {
                    ...kernelReport, safety: safetyTotals(),
                    // Forecast cooldowns can make a decision alarm the new
                    // head. Include both optional shapes before those effects.
                    queueHead: { ...kernelReport.queueHead, kind: 'normal', alarmKind: 'decision',
                        dueAt: large, overdue: false, current: false },
                    competition: { ...report, events: [],
                        recent: [], frame: { ...frame, events: [] }, at: frame.at, outcomes,
                        scans: large, evaluated: large, pvpIntents: large, activeHunters: large, lastSampleMs: large,
                        deliverySendFailures: large, lastScanEvents: 160, consumedSpotKeys: 32, consumedActorKeys: 128,
                        pendingSpotKeys: large, pendingActorKeys: large, deliveryMode: 'addressed',
                        revenge: { evaluated: large, intents: large, at: frame.at, active: 128, sampledActors: 128, overflow: false } },
                    tables: tables.summary(), heapUsed: large, rss: large, v8Heap: { used: large, total: large, external: large, limit: large, afterGc: large, afterGcMax: large, late: large },
                    eventLoopUtilization: 1, eluActiveMs: large, eluIdleMs: large, eventLoopLagP95Ms: large,
                    eventLoopLagMaxMs: large
                }, 'x'.repeat(160));
                return new (invoke('GameServer/Bot/Population/ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, report.recent);
            }
        });
        kernel.decisionEvents = competitionCandidates;
    }
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        // Read and reset first: the beat's own work (the review, the send) counts in the next beat; a
        // sample counts the whole timer interval, so the resolution comes off (0 = no delay).
        const lagMaxMs = Math.max(0, eventLoopDelay.max / 1e6 - LAG_RESOLUTION_MS) || 0;
        const lagP95Ms = Config.developerDiagnostics ? Number(eventLoopDelay.percentile(95) / 1e6) || 0 : 0;
        eventLoopDelay.reset();
        if (competitionCandidates && competitionReady && !kernel.paused && !shuttingDown) {
            const started = Config.developerDiagnostics ? performance.now() : 0;
            competitionCandidates.reviewBatch(Date.now());
            if (Config.developerDiagnostics) competition.report.lastSampleMs = performance.now() - started;
            wakeLoopIfSooner();
        }
        const elu = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();
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
            incomeHold: EconomyContext.incomeHoldStats(),
            competition: competitionCandidates?.snapshot() || null,
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
        try {
            if (send('heartbeat', heartbeat)) {
                if (Config.developerDiagnostics) economyDiagnostics.deltaSent();
            } else if (competition) {
                if (Config.developerDiagnostics) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
            }
        } catch {
            // Main has not admitted this frame. Its exact origin/content stay
            // owned here for the next existing heartbeat, including backpressure.
            if (Config.developerDiagnostics && competition) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
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
            if (kernel.interactionMemory.clanSocial.accept(snapshot)) competitionCandidates?.clanChanged(snapshot.clanId);
        }
        if (payload.memberships) {
            const social = kernel.interactionMemory.clanSocial, previous = social.memberships;
            const active = payload.activeClanIds ? new Set(payload.activeClanIds) : null;
            const removed = active ? [...social.clans.keys()].filter(id => !active.has(id)) : [];
            social.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
            if (social.memberships !== previous) competitionCandidates?.membershipsChanged(previous, social.memberships, removed);
        }
        break;
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        if (payload.economyOwnerId !== undefined) {
            if (Number.isSafeInteger(payload.economyOwnerId) && payload.economyOwnerId > 0
                && Array.isArray(payload.rows) && !payload.rows.length) occupationOwnerChanged(payload.economyOwnerId, payload.reconcile === true);
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
            competitionReady = true;
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
        kernel?.onCommitAck(payload);
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
        if (Object.hasOwn(payload, 'receipt') && !competitionCandidates?.receipt(payload.receipt)) break;
        competitionCandidates?.releaseForecasts(payload.events || []);
        break;
    case 'shutdown':
        buyerWaiters.clear();
        if (shuttingDown) break;
        shuttingDown = true;
        for (const entry of partyGoalPages.values()) { clearTimeout(entry.timer); partyGoalJobs--; }
        partyGoalPages.clear(); partyGoalSeen.clear();
        routeRequests.clear();
        if (Config.economyDiagnostics) economyDiagnostics.stop();
        occupationPlanner.stop();
        competitionCandidates?.stop();
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
    if (message?.type === 'economy_diagnostics_selection') {
        if (Config.developerDiagnostics && Config.economyDiagnostics && message.epoch === epoch)
            economyDiagnostics.useSelection(message.ownerIds);
        return;
    }
    if (message?.type === 'economy_diagnostics_ack' && Config.economyDiagnostics && message.epoch === epoch) {
        economyDiagnostics.ack(message.id, message.accepted); return;
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

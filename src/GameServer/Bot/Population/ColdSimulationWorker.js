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

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const originalInvoke = global.invoke;
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
        list: () => []
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
        bestOffer: (selfId, options = {}) => require('../Economy/OfferQuery').bestSellOffer(boardReady(), selfId, {
            towns: options.town ? [options.town] : options.towns || null,
            excludeOwner: options.buyerCharacterId,
            budget: options.budget,
            cost: options.cost,
            accept: offer => require('./PartyAdmission').personalOfferAllowed(offer,
                kernel?.states.get(Number(options.buyerCharacterId))?.state) && (!options.accept || options.accept(offer))
        })
    }],
    // Immutable map boundaries only; no live World, geodata or database access.
    ['GameServer/World/WorldAreaCatalog', { resolve: originalInvoke('GameServer/World/WorldAreaCatalog').resolve }],
    // The game clock is a pure function of the timestamp (cold night bonuses).
    ['GameServer/World/GameTime', originalInvoke('GameServer/World/GameTime')],
    ['GameServer/World/WorldConstants', originalInvoke('GameServer/World/WorldConstants')],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [] }]
]);

global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (forbidden.test(String(module || ''))) {
        throw new Error(`cold worker forbidden dependency: ${module}`);
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
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Protocol = require('./ColdSimulationProtocol');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const { ColdOccupationPlanner } = require('./ColdOccupationPlanner');
const OccupationSources = require('./ColdOccupationSources');
const EconomicTrip = require('../Economy/EconomicTrip');
const RequiredPartyFormation = require('./RequiredPartyFormation');
const { ColdCompetitionMonitor } = require('./ColdCompetitionMonitor');
const ColdCompetitionCandidates = require('./ColdCompetitionCandidates');
const { ColdSimulationKernel } = require('./ColdSimulationKernel');
const { beginHuntingTrip } = require('./HuntingTravel');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableMirror = require('./TableMirror');
const { BoardIndex, recordOf } = require('../../AfkTrade/BoardIndex');
const { MarketBuyerWaiters } = require('../Economy/MarketBuyerWaiters');
const SpotIndex = require('../AI/SpotIndex');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
let loopTimer = null;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
let competition = null;
let competitionCandidates = null;
let competitionReady = false;
let safetyStateReady = false;
let leaseProbe = null;
let safetyStateRepairs = 0;
let safetyOrphanRepairs = 0;
let previousElu = null;
let planningSpots = [];
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
    wake: (id, timestamp) => kernel?.wakeBuyer(id, timestamp) === true
});
const boardFollower = boardIndex.follower();
let boardReplacing = false;
const routeRequests = new Map();
let nativeRouteSequence = 0;
const publicWorkshopIndex = new (require('../Economy/PublicWorkshopIndex').PublicWorkshopIndex)();
const publicWorkshopKeys = new Map(), workshopRevisions = new Map(), workshopDigests = new Map(), workshopScopeDigests = new Map(), meetingRepresentatives = new Map();
const digestToken = value => value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
function workshopsFor(recipeId, state) { return publicWorkshopIndex.candidates(recipeId, Number(state?.characterId || 0)); }
function changeWorkshop(key, row) {
    const previous = publicWorkshopKeys.get(key);
    const recipeId = Number(row?.[1] || previous?.recipeId);
    if (!(recipeId > 0)) return;
    if (previous) { publicWorkshopKeys.delete(key); publicWorkshopIndex.remove(key); }
    if (row) {
        const value = { characterId: row[0], recipeId, price: row[2], entryPrice: row[2], townName: row[3],
            loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7] };
        publicWorkshopKeys.set(key, value); publicWorkshopIndex.put(key, value);
    }
    const productId = Number(invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId)?.productId || 0);
    if (productId) {
        const digest = workshopDigests.get(productId) || { xor: 0, sum: 0, count: 0 };
        const scalar = value => [value.characterId, value.recipeId, value.entryPrice, value.townName, value.loc.locX, value.loc.locY, value.loc.locZ, value.capacityBatches];
        const change = (values, step) => {
            const hash = require('../Fnv1a').fnv1a32(JSON.stringify(values));
            digest.xor = (digest.xor ^ hash) >>> 0; digest.sum = (digest.sum + step * hash) >>> 0; digest.count += step;
        };
        if (previous) change(scalar(previous), -1);
        if (row) change(row, 1);
        if (digest.count) workshopDigests.set(productId, digest); else workshopDigests.delete(productId);
        const scope = MarketCounters.counterOf(productId), scoped = workshopScopeDigests.get(scope) || { xor: 0, sum: 0, count: 0 };
        const updateScope = (values, step) => { const hash = require('../Fnv1a').fnv1a32(JSON.stringify(values));
            scoped.xor = (scoped.xor ^ hash) >>> 0; scoped.sum = (scoped.sum + step * hash) >>> 0; scoped.count += step; };
        if (previous) updateScope(scalar(previous), -1); if (row) updateScope(row, 1);
        if (scoped.count) workshopScopeDigests.set(scope, scoped); else workshopScopeDigests.delete(scope);
        occupationPlanner.scopeChanged(scope);
        workshopRevisions.set(productId, (workshopRevisions.get(productId) || 0) + 1); occupationPlanner.sourceChanged(productId); }
}
const occupationPlanner = new ColdOccupationPlanner({
    onPublishError: (error, characterId, input) => send('fault', {
        reason: 'occupation_publication_failed', characterId, mode: input.mode,
        stack: String(error?.stack || error).slice(0, 4096)
    }),
    sourceToken: (id, input) => input?.mode === 'meeting'
        ? `${boardIndex.groupFingerprint(MarketCounters.counterOf(id))}|${MarketCounters.revisionOf(MarketCounters.counterOf(id))}|${digestToken(workshopScopeDigests.get(MarketCounters.counterOf(id)))}`
        : `${boardIndex.itemRevision(id)}:${tables.rows('market').get(`i:${id}`)?.[1] || 0}:${MarketCounters.revisionOf(MarketCounters.counterOf(id))}:${workshopRevisions.get(id) || 0}`,
    sourceScope: id => MarketCounters.counterOf(id),
    sourceScopeToken: scope => OccupationSources.recipeIndex(boardIndex).revision(scope),
    ownCurrent: (id, input) => !shuttingDown && (id < 0 ? routeRequests.get(-id) === input
        && (!input.native || kernel?.states.get(-id)?.state === input.sourceState)
        : kernel?.states.get(id)?.state === input.sourceState),
    sameInput: (left, right) => left.mode === 'wish' || right.mode === 'wish'
        ? left.mode === right.mode && left.sourceState === right.sourceState && left.routeKey === right.routeKey
        : left.state.updatedAt === right.state.updatedAt
        && ColdEconomyDecision.stateKey(left.state) === ColdEconomyDecision.stateKey(right.state)
        && left.state.simulation?.revision === right.state.simulation?.revision
        && left.state.simulation?.ownerId === right.state.simulation?.ownerId
        && left.state.simulation?.leaseId === right.state.simulation?.leaseId
        && left.state.inventory === right.state.inventory
        && left.state.stats?.workshop?.entries === right.state.stats?.workshop?.entries
        && left.knownShotRecipes === right.knownShotRecipes && left.recipeBook === right.recipeBook && left.stock === right.stock
        && left.sourceReady === right.sourceReady
        && left.routeKey === right.routeKey
        && left.mode === right.mode && left.buyOrderEscrow === right.buyOrderEscrow,
    onSlots: count => invoke('GameServer/Bot/Economy/EconomyContext').setPlanningContexts?.(count),
    capture: (id, input, read, readScope) => {
        const book = require('../Economy/RecipeBookCodec').unpack(input.recipeBook);
        const observedRead = input.mode === 'meeting' ? itemId => {
            const scope = MarketCounters.counterOf(itemId);
            if (!meetingRepresentatives.has(scope)) meetingRepresentatives.set(scope, itemId);
            read(meetingRepresentatives.get(scope));
        } : read;
        return { state: input.state, board: boardReady(), timestamp: input.timestamp, read: observedRead, readScope,
            knownRecipes: book || input.state.stats?.workshop?.entries || [], knownShotRecipes: input.knownShotRecipes || [],
            recipesKnown: book !== null || Array.isArray(input.state.stats?.workshop?.entries),
            buyOrderEscrow: input.buyOrderEscrow, stock: input.stock || null, economy: input.economy || null,
            routeRows: input.routeRows || null, routeKey: input.routeKey, mode: input.mode || 'occupation', meeting: input.meeting, pending: input.pending };
    },
    create: input => ({ iterator: (function* () {
        if (input.mode === 'wish') return yield* EconomicTrip.prepare(input.state);
        if (input.mode === 'meeting') {
            const request = input.meeting, ownId = Number(input.state.characterId);
            const side = request.actorA === ownId ? 0 : 1, own = request.parties[side];
            const authority = require('../Economy/EconomyCommit').authority(input.state);
            if (!['phase', 'ownerId', 'leaseId', 'hotAt', 'revision'].every(key => own[key] === authority[key]))
                throw Error('trade_meeting_authority_changed');
            const routeRows = yield* EconomicTrip.prepare(input.state);
            const Context = invoke('GameServer/Bot/Economy/EconomyContext');
            // Fresh physical incoming is delivered in the native owner snapshot.
            // Reuse the bounded graph/seed; no price or private plan from another actor.
            const economy = Context.forState(input.state, { board: input.board, routeRows, workshops: workshopsFor, workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, workshop: { known: true, recipeId: 0, incomePerHour: 0 },
                buyOrderEscrow: input.buyOrderEscrow, npcOffersFor: OccupationSources.npcOffersFor,
                caller: 'meeting_prepare', trigger: request.token });
            yield 'candidate';
            if (economy.intentPending || economy.routePending) throw Error('trade_meeting_preparation_pending');
            const intents = require('../Economy/TradeIntent').project(input.state, economy.network, economy.projection,
                id => economy.worth(id) ?? economy.price(id), 40);
            if (!intents) throw Error('trade_meeting_preparation_pending');
            const routePlan = require('./ColdTrip').townPlan(input.state, request.point);
            if (!routePlan) throw Error('trade_meeting_route');
            const shared = /^meeting:([1-9][0-9]*)$/.exec(own.route.method);
            if (shared && Number(shared[1]) !== Number(input.state.stats?.tradeMeeting?.[0])) throw Error('trade_meeting_route_changed');
            own.route = shared ? { fee: 0, scroll: false, method: own.route.method, durationMs: 0 }
                : { fee: routePlan.route.fee, scroll: !!routePlan.scroll, method: routePlan.method, durationMs: routePlan.durationMs };
            let total = own.route.fee, spendable = Infinity, sellerDecision = null;
            const required = new Map(), sold = new Map();
            for (const line of request.lines) if (line.payer === side) required.set(line.selfId, (required.get(line.selfId) || 0) + line.count);
            else sold.set(line.selfId, (sold.get(line.selfId) || 0) + line.count);
            for (const line of request.lines) {
                input.read(line.selfId);
                if (line.payer === side) {
                    const intent = intents.find(row => row.itemId === line.selfId && row.amount >= required.get(line.selfId)
                        && Number(row.worth) >= line.price);
                    if (!intent) throw Error('trade_meeting_need_changed');
                    line.certificate = require('../Economy/TradeIntent').encode({ ...intent, amount: line.count, price: line.price, valueHours: intent.valueHours * line.count / intent.amount });
                    line.needAdId = line.needAdRevision = 0; own.needRevision = own.revision;
                    spendable = Math.min(spendable, require('../Economy/PurchaseFunding').spendable(input.state,
                        input.buyOrderEscrow || 0, { r: intent.valueRate }));
                    total += line.count * line.price;
                } else {
                    const item = input.state.inventory?.[line.selfId];
                    const free = require('../Economy/WealthCraftDecision').freeAmount(input.state, item || {});
                    if (free < sold.get(line.selfId)) throw Error('trade_meeting_protected_stock');
                    const quote = input.board?.records.get(line.adId)?.find(row => row.selfId === line.selfId);
                    if (Number(quote?.ownerId) !== ownId) {
                        sellerDecision ||= require('../Economy/MarketListingPolicy').evaluate(input.state, { economy, board: input.board,
                            npcOffersFor: OccupationSources.npcOffersFor,
                            findSpot: id => SpotIndex.spotById(planningSpots, id),
                            now: input.timestamp, decisionPoint: `meeting:${request.token}`, slots: 5 });
                        const answer = sellerDecision.answers.find(row => row.item.selfId === line.selfId
                            && Number(row.line.recordId) === line.adId && row.count >= line.count);
                        if (!answer) throw Error('trade_meeting_sale_changed');
                    }
                }
                yield 'funding';
            }
            if (!Number.isSafeInteger(total) || total > spendable || own.route.fee > Number(input.state.adena || 0))
                throw Error('trade_meeting_funding');
            request.dependencies = [...occupationPlanner.slots.get(ownId).reads.keys()].map(id => {
                const scope = MarketCounters.counterOf(id);
                return [id, `g:${input.board.groupFingerprint(scope)}`, MarketCounters.revisionOf(scope).split('.').slice(1).join('.'),
                    `g:${digestToken(workshopScopeDigests.get(scope))}`];
            });
            if (request.dependencies.length > 40) throw Error('trade_meeting_dependency_pressure');
            return request;
        }

        if (input.mode === 'refresh') {
            const routeRows = input.routeRows || (yield* EconomicTrip.prepare(input.state));
            input.economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(input.state, {
                board: input.board, routeRows, workshops: workshopsFor, workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, workshop: { known: true, recipeId: 0, incomePerHour: 0 },
                caller: 'economy_refresh', trigger: 'native_own_action' });
            // The shared money packet is derived from this same graph. Use it
            // in preparation only; the native writer owns physical funding.
            input.state = { ...input.state, stats: { ...input.state.stats, ...input.economy.statsPacket } };
            yield 'candidate';
        }
        if (input.mode === 'occupation') {
            const eligible = invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(input.state);
            if (!eligible || !input.recipesKnown) {
                const mask = input.board?.ownerLines(input.state.characterId)?.length
                    ? yield* OccupationSources.feasibility(input.state, input) : null;
                return eligible && !input.recipesKnown ? { ...ColdEconomyDecision.unknownWorkshop(), feasibility: mask }
                    : { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0, feasibility: mask };
            }
        }
        const prepared = yield* OccupationSources.prepare(input.state, input);
        if (!prepared && input.mode === 'refresh') {
            const economyPlan = yield* require('./ColdEconomyPlan').prepare(input.state, input.economy, {
                now: input.timestamp, board: input.board, persona: BotPersona.of(input.state), tripCost: input.economy.trip,
                preparedCraft: null, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, findSpot: id => planningSpots.find(spot => String(spot.id) === String(id)) });
            return { selected: null, economyPlan, economyDecision: ColdEconomyDecision.capture(input.economy, input.state) };
        }
        if (!prepared) return input.mode === 'action' ? null : ColdEconomyDecision.unknownWorkshop();
        const Wealth = require('../Economy/WealthCraftDecision');
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
                    : value.exit?.staticId > 0 ? [0, Number(value.exit.staticId), Number(value.exit.price), 0] : null;
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
        const Shots = require('../Economy/ShotCraftPolicy');
        if (Shots.eligible(input.state, input.timestamp)) {
            const cursor = Shots.createShot(input.state, input.knownRecipes, prepared.context, options);
            while (!Shots.stepShot(cursor)) yield cursor.stage;
            const value = Shots.resultShot(cursor);
            if (value && cursor.selectedValueHours > selectedValue) selected = value;
        }
        const economyPlan = input.economy ? yield* require('./ColdEconomyPlan').prepare(input.state, input.economy, {
            ...prepared.options, now: input.timestamp, board: input.board, persona: BotPersona.of(input.state),
            tripCost: prepared.context.trip, preparedCraft: selected,
            npcOffersFor: OccupationSources.npcOffersFor,
            ...(economyDiagnostics.enabled(input.state.characterId) ? { onTownDecision: decision => economyDiagnostics.push({
                owner: input.state.characterId, revision: Number(input.state.simulation?.revision), trigger: 'economy_plan',
                phase: 'town_choice', town: decision.town, reason: decision.reason, candidates: decision.candidates,
                tripHours: decision.tripHours, tripFees: decision.tripFees
            }) } : null),
            findSpot: id => planningSpots.find(spot => String(spot.id) === String(id)),
            buyOrderEscrow: input.buyOrderEscrow, knownShotRecipes: input.knownShotRecipes
        }) : null;
        return { selected, economyPlan, ...(input.mode === 'refresh' ? { economyDecision:
            ColdEconomyDecision.capture({ ...input.economy, shot: economyPlan?.shot || null }, input.state) } : {}) };
    })(), done: false, value: null, stage: 0, units: 0 }),
    step: work => {
        const next = work.iterator.next(); work.units++;
        work.stage = typeof next.value === 'number' ? next.value
            : ['stock', 'recipe', 'ingredient', 'owned', 'quote', 'trip', 'exit', 'without', 'success', 'utility', 'candidate', 'funding', 'edge'].indexOf(next.value) + 1;
        if (next.done) { work.done = true; work.value = next.value; work.iterator = null; }
        return work.done;
    },
    result: work => work.value,
    publish: (id, input, workshop, meta = {}) => {
        if (input.mode === 'meeting') {
            if (input.state !== input.sourceState) invoke('GameServer/Bot/Economy/EconomyContext').forgetContext(id, 'meeting_preparation_complete');
            occupationPlanner.release(id); return;
        }
        if (input.mode === 'refresh') {
            const entry = kernel?.states.get(id);
            if (meta.stale && entry?.state === input.sourceState && entry.context.economyPending) {
                occupationPlanner.release(id); occupationOwnerChanged(id, true); return;
            }
            if (!shuttingDown && entry?.state === input.sourceState && !meta.stale && workshop?.economyPlan) {
                entry.context.economyPending = workshop.economyPlan.d || 0;
                send('ready', { phase: 'economy_plan_ready', characterId: id,
                    authority: require('../Economy/EconomyCommit').authority(input.state), economyPlan: workshop.economyPlan,
                    economyDecision: workshop.economyDecision });
            }
            input.economy = null; return;
        }

        if (input.mode === 'wish') {
            if (id < 0 && routeRequests.get(-id) === input) {
                if (!shuttingDown && !input.native) send('economy_route_result', { characterId: -id, requestId: input.requestId,
                    key: input.routeKey, rows: Array.isArray(workshop) ? workshop : [] });
                routeRequests.delete(-id);
                occupationPlanner.release(id);
            }
            return;
        }
        // The action result is the existing compact native plan. Its derived
        // network is needed while preparing it, never by the completed cache.
        if (input.mode === 'action') input.economy = null;
        if (shuttingDown || kernel?.states.get(id)?.state !== input.sourceState) return;
        if (meta.stale) {
            send('ready', { phase: 'economy_workshop_stale', characterId: id,
                updatedAt: Number(input.state.updatedAt || 0), key: ColdEconomyDecision.stateKey(input.state) });
        } else if (input.mode !== 'action' && input.state.phase === 'hot') {
            const decision = ColdEconomyDecision.capture({ workshop }, input.state);
            send('ready', { phase: 'economy_decided', characterId: id, economyDecision: decision });
        }
    }
});
function occupationFor(state, timestamp, context = {}, mode = 'occupation') {
    const id = Number(state.characterId), sourceState = kernel?.states.get(id)?.state;
    if (!sourceState || shuttingDown) return Promise.resolve(ColdEconomyDecision.unknownWorkshop());
    const routeKey = EconomicTrip.key(state), economy = context.economy || null;
    const directRows = context.routeKey === routeKey && Array.isArray(context.routeRows)
        && context.routeRows.length === EconomicTrip.towns.length ? context.routeRows : null;
    const routeRows = directRows || (economy?.routeKey === routeKey ? economy.routeRows
        : invoke('GameServer/Bot/Economy/EconomyContext').preparedRouteRows?.(state));
    if (mode === 'wish' && Array.isArray(routeRows) && routeRows.length === EconomicTrip.towns.length)
        return Promise.resolve(routeRows);
    if (mode === 'wish') {
        const previous = routeRequests.get(id);
        if (previous?.native && previous.sourceState === sourceState && previous.routeKey === routeKey)
            return occupationPlanner.request(-id, previous);
        if (!previous && routeRequests.size >= 64) return Promise.resolve([]);
        cancelRoute(id);
        const input = { state: EconomicTrip.frame(state), sourceState, timestamp, mode: 'wish', native: true,
            routeKey, requestId: ++nativeRouteSequence };
        routeRequests.set(id, input);
        return occupationPlanner.request(-id, input);
    }
    return occupationPlanner.request(id, { state, sourceState, timestamp, buyOrderEscrow: context.buyOrderEscrow || 0,
        knownShotRecipes: context.knownShotRecipes || [], recipeBook: context.recipeBook, stock: context.stock || null, economy,
        sourceReady: tables.ready('board') && tables.ready('market'), mode, routeKey, routeRows });
}
function cancelRoute(characterId) {
    const id = Number(characterId);
    routeRequests.delete(id);
    occupationPlanner.cancel(-id);
}
function requestRoute(payload) {
    if (shuttingDown) return;
    const id = payload.characterId, previous = routeRequests.get(id);
    if (previous && !previous.native && previous.requestId === payload.requestId && previous.routeKey === payload.key) return;
    if (payload.key !== EconomicTrip.key(payload.frame)) {
        send('economy_route_result', { characterId: id, requestId: payload.requestId, key: payload.key, rows: [] }); return;
    }
    if (!previous && routeRequests.size >= 64) {
        send('economy_route_result', { characterId: id, requestId: payload.requestId, key: payload.key, rows: [] }); return;
    }
    cancelRoute(id);
    const input = { state: payload.frame, sourceState: null, timestamp: Date.now(), mode: 'wish',
        routeKey: payload.key, requestId: payload.requestId };
    routeRequests.set(id, input);
    occupationPlanner.request(-id, input, { awaitResult: false });
}
function occupationOwnerChanged(id, refresh = false) {
    const entry = kernel?.states.get(Number(id));
    if (!entry || entry.state.phase !== 'hot' && !refresh) return;
    occupationPlanner.request(id, { state: entry.state, sourceState: entry.state,
        timestamp: Date.now(), mode: refresh ? 'refresh' : 'occupation', pending: entry.context.economyPending || 0,
        buyOrderEscrow: entry.context.buyOrderEscrow || 0,
        knownShotRecipes: entry.context.knownShotRecipes || [],
        recipeBook: entry.context.recipeBook,
        routeKey: EconomicTrip.key(entry.state),
        sourceReady: tables.ready('board') && tables.ready('market') }, { awaitResult: false });
}
function changedItems(previous, next) {
    const ids = new Set();
    for (const row of previous || []) ids.add(Number(row.selfId));
    for (const row of next || []) ids.add(Number(row.selfId));
    for (const id of ids) {
        const admission = OccupationSources.recipeIndex(boardIndex);
        for (const scope of admission.update(id)) occupationPlanner.scopeChanged(scope);
        occupationPlanner.sourceChanged(id); occupationPlanner.scopeChanged(MarketCounters.counterOf(id));
    }
}
boardIndex.setOwnerChangeObserver((previous, next, board) => {
    const owner = previous[0]?.ownerId, current = next[0]?.ownerId;
    for (const id of owner === current ? [owner] : [owner, current]) if (id) {
        require('../Economy/BoardLook').consumeOwnProjection(kernel?.lookSeen.get(id), previous, next, board, id);
    }
});
tables.watch('board', {
    reset: () => { publicWorkshopIndex.clear(); publicWorkshopKeys.clear(); workshopRevisions.clear(); workshopDigests.clear(); workshopScopeDigests.clear(); boardReplacing = true; boardFollower.reset(); OccupationSources.recipeIndex(boardIndex).reset(); kernel?.lookSeen.clear(); occupationPlanner.resetSources(); },
    put: (key, row) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, row.length === 9 ? row.slice(1) : row); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        boardFollower.put(key, row);
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
        changedItems(previous, []);
        if (ownerId) pruneLookSeen(ownerId);
    }
});
// The market counters come from the main thread's 'market' table.
MarketCounters.useTable(() => tables.rows('market'));
MarketCounters.useSpots(() => planningSpots);
tables.watch('market', {
    reset: () => { occupationPlanner.resetSources(); kernel?.lookSeen.clear(); },
    put: key => {
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    },
    remove: key => {
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    }
});
function boardReady() {
    return tables.ready('board') ? boardIndex : null;
}

function safetyTotals() {
    return { stateRepairs: safetyStateRepairs,
        coverageRepairs: 0, orphanRepairs: safetyOrphanRepairs };
}

function sendLeasePage() {
    const probe = leaseProbe;
    if (!probe || shuttingDown || !kernel || kernel.stopping || Date.now() >= probe.replyBy) {
        leaseProbe = null; return;
    }
    const page = probe.pages.next();
    const tokens = page.done ? [] : page.value;
    const msgId = Protocol.envelope('lease_renewal_candidates', epoch).msgId;
    // One page remains outstanding. The next page is built only after main
    // acknowledges this one, so native pressure cannot grow a queued inventory.
    probe.waiting = msgId;
    probe.done = page.done;
    probe.tokens = new Map(tokens.map(token => [token.characterId, token]));
    send('lease_renewal_candidates', { requestId: probe.requestId,
        pageIndex: probe.pageIndex++, done: page.done, tokens }, msgId);
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
    if (checkpoint.simulationOwner !== 'legacy_main' || checkpoint.simulationLeaseId !== null
        || checkpoint.simulationLeaseUntil > 0) return gate('deferred', 'native_ownership_active');
    // Native ownership can be ahead of the cached row during ACK processing.
    if (kernel.busy(id)) return gate('deferred', 'worker_busy');
    const normalCovered = kernel.hasNormalCoverage(id);
    if (!normalCovered && kernel.hasAcceptedPartyGrant(id)) return gate('deferred', 'partial_party_accepted');
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
        const entry = row.entry, state = entry?.state, context = entry?.context;
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(state) || !object(context) || !Object.keys(context).length
            || !object(state.inventory) || !object(state.stats) || !object(state.timing) || !object(state.simulation)) {
            return receipt('deferred', 'projection_unavailable');
        }
        if (!Protocol.sameSafetyCheckpoint(checkpoint, state)) return receipt('stale', 'projection_checkpoint_changed');
        if (!kernel.upsert(entry)) return receipt('stale', 'projection_not_accepted');
        presence = safetyPresence(checkpoint);
        if (!Protocol.sameSafetyCheckpoint(presence.observedCheckpoint, checkpoint)) return receipt('stale', 'checkpoint_changed');
        safetyStateRepairs++;
        return receipt('accepted', 'state_delivery_restored');
    }

}
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup([], boardReady);
let planningOccupancyCache = null;
let planningOccupancyCachedAt = 0;
// Personas come from the main thread's 'personas' table (BotPersona.loadAll).
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
BotPersona.useRowSource((characterId) => tables.rows('personas').get(characterId));
let eventLoopDelay = null;

// The owner notices moved counters only during its own natural resolve.
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
function reviewMarket(state, timestamp, economy) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return null;
    const lines = board.ownerLines(state.characterId);
    if (!lines.length) { kernel.lookSeen.delete(Number(state.characterId)); return null; }
    const ctx = MarketPricing.traderContext(state, {
        timestamp, board, economy, persona: BotPersona.of(state),
        npcOffersFor: (selfId) => planningNpcCatalog.offersFor(selfId),
        findSpot: (spotId) => SpotIndex.spotById(planningSpots, spotId),
        canSell: require('../Economy/BoardLook').feasibilityPredicate(state, lines, economy?.workshop?.feasibility)
    });
    const id = Number(state.characterId);
    let seen = kernel.lookSeen.get(id);
    if (!seen) kernel.lookSeen.set(id, seen = new (require('../Economy/BoardLook').SeenLines)());
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

function currentPlanningOccupancy(timestamp = Date.now()) {
    if (planningOccupancyCache && timestamp - planningOccupancyCachedAt < 1000) {
        return planningOccupancyCache;
    }
    planningOccupancyCache = kernel
        ? SpotProfiles.indexedOccupancy(kernel.occupancy, planningSpots)
        : SpotProfiles.occupancySnapshot(planningSpots, []);
    planningOccupancyCachedAt = timestamp;
    return planningOccupancyCache;
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
let partyGoalJobs = 0;
let partyGoalTail = Promise.resolve();
const partyGoalPages = new Map();
const partyGoalSeen = new Map();
function partyMembersAvailable(members) {
    return members.every(member => {
        const held = occupationPlanner.slots.get(member.characterId) || occupationPlanner.waiting.get(member.characterId);
        return kernel.commandStartedAt.get(member.characterId)?.kind !== 'meeting'
            && (!held || held.done || !['meeting', 'refresh', 'action'].includes(held.input.mode));
    });
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
    if (!require('./PartyGoalCalculation').validMembers(entry.party, entry.members)) {
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
        const Calculation = require('./PartyGoalCalculation');
        // Equal native snapshots keep their worker-owned identity and caches.
        // A freshly committed main snapshot is complete input, never merged
        // with an older worker wallet, inventory or equipment plan.
        const members = payload.members.map(member => {
            const native = kernel.states.get(member.characterId)?.state;
            return native && JSON.stringify(native) === JSON.stringify(member) ? native : member;
        });
        preparedMembers = members;
        if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
        const joint = await Calculation.calculate(payload.party, members, async (member, timestamp) => {
            const context = { ...(kernel.states.get(member.characterId)?.context || {}),
                buyOrderEscrow: payload.escrows[members.indexOf(member)] };
            // Recipe authority belongs to this main query, not the older
            // worker mirror. Public workshop entries remain the fallback.
            delete context.recipeBook; delete context.knownShotRecipes;
            Object.assign(context, payload.recipeKnowledge?.[members.indexOf(member)] || {});
            const routeRows = await occupationFor(member, timestamp, context, 'wish');
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            const workshop = await occupationFor(member, timestamp,
                { ...context, routeRows, routeKey: EconomicTrip.key(member) });
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            return invoke('GameServer/Bot/Economy/EconomyContext').forState(member, {
                timestamp, spots: planningSpots, board: boardReady(),
                occupancy: currentPlanningOccupancy(timestamp), workshop, routeRows,
                rememberContext: kernel.states.get(member.characterId)?.state === member,
                buyOrderEscrow: context.buyOrderEscrow, caller: 'workerPartyGoal' });
        }, payload.timestamp, () => !shuttingDown && !kernel.stopping && Date.now() < payload.replyBy && partyMembersAvailable(members));
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

function send(type, payload = {}, msgId = null, payloadBytes = null) {
    const packed = require('./ColdStateWire').packPayload(type, payload);
    if (packed !== payload) { payload = packed; payloadBytes = null; }
    const message = Protocol.envelope(type, epoch, payload, msgId);
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
    if (loopTimer) clearInterval(loopTimer);
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    loopTimer = null;
    flushTimer = null;
    heartbeatTimer = null;
}

function startKernel(config = {}) {
    if (kernel) return;
    if (typeof config.coldHonestTravel === 'boolean') Config.coldHonestTravel = config.coldHonestTravel;
    Config.developerDiagnostics = config.developerDiagnostics === true;
    Config.economyDiagnostics = Config.developerDiagnostics && config.economyDiagnostics === true;
    if (Config.developerDiagnostics) {
        heapTelemetry = require('./WorkerHeapTelemetry').observe();
        if (Config.developerDiagnostics) previousElu = performance.eventLoopUtilization();
        eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
        eventLoopDelay.enable();
    }
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
    Config.pvpAggression = require('../../Social/PvpAggression').normalize(config.pvpAggression ?? Config.pvpAggression);
    kernel = new ColdSimulationKernel({
        stateSources: LifeStateProjector.passiveWorkerStateSources(workerProjectorRole),
        shotIndex: require('../Economy/ShotMarketIndex').native(),
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: {
            partySessionMaxMs: Config.partySessionMaxMs,
            partyReviewIntervalMs: Config.partyReviewIntervalMs,
            partySessionJitterMs: Config.partySessionJitterMs,
            partyMinSize: Config.partyMinSize
        },
        partyMinSize: Config.partyMinSize,
        equipmentBridgeReason: (state) => GearAcquisitionPlanner.equipmentBridgeReason(state, {
            ...planningNpcCatalog.plannerOptions,
            buyOrderEscrow: kernel.states.get(Number(state.characterId))?.context?.buyOrderEscrow
        }),
        projectResolve: async (state, result, timestamp) => {
            let economy = null, seenKey = null;
            const resolved = await LifeStateProjector.prepareResolve(state, result, {
                persist: false,
                timestamp,
                projectClassProgression: true,
                // Spot crowding, as main gave the same leaf before (L25).
                economyDepsFor: async projected => {
                    const context = kernel.states.get(Number(state.characterId))?.context || {};
                    const routeRows = await occupationFor(projected, timestamp, context, 'wish');
                    const workshop = await occupationFor(projected, timestamp,
                        { ...context, routeRows, routeKey: EconomicTrip.key(projected) });
                    return { occupancy: currentPlanningOccupancy(timestamp), workshop, routeRows };
                },
                onEconomy: (built, seen) => { economy = built; seenKey = ColdEconomyDecision.stateKey(seen); }
            });
            const projected = resolved;
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
            const context = kernel.states.get(Number(state.characterId))?.context || {};
            const planner = require('./ColdEconomyPlan');
            const economyEdges = planner.edges(state, projected, context, timestamp);
            const preparedAction = economyEdges && economy ? await occupationFor(projected, timestamp,
                { ...context, stock: economy.stock('shots'), economy }, 'action') : null;
            const economyPlan = preparedAction?.economyPlan || null;
            if (economyPlan?.d) { const owner = kernel.states.get(Number(projected.characterId));
                if (owner) owner.context.economyPending = economyPlan.d; }
            const market = reviewMarket(projected, timestamp, economy);
            return {
                state: projected,
                economyEdges,
                ...(economyPlan ? { economyPlan } : {}),
                ...(market ? { market } : {}),
                durable: Object.keys(durable).length ? durable : null,
                buffOffer: require('../Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                // Main reads this instead of building the network again.
                ...(economy && projected ? { economyDecision: { ...ColdEconomyDecision.capture({ ...economy,
                    shot: economyPlan?.shot || null }, projected), key: seenKey } } : {})
            };
        },
        planPartyRequirement: ({ state, context, timestamp }) => require('./PartyRequirementRefresh').plan(state, {
            spots: planningSpots, occupancy: currentPlanningOccupancy(timestamp), timestamp,
            planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
        }),
        planLifecycle: async ({ state, context, timestamp }) => {
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            if (karmaPlan) return karmaPlan;
            const previousPlan = state.stats?.equipmentPlan || null;
            const spots = planningSpots;
            const occupancy = currentPlanningOccupancy(timestamp);
            // GearPlanSelection uses EconomyContext's same prepared occupation
            // reader. No synchronous recipe scan can run through it.
            const routeRows = await occupationFor(state, timestamp, context, 'wish');
            const workshop = await occupationFor(state, timestamp,
                { ...context, routeRows, routeKey: EconomicTrip.key(state) });
            const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
            const preparedEconomy = Economy.forState(state, { spots, occupancy, timestamp, board: boardReady(),
                buyOrderEscrow: context?.buyOrderEscrow, workshop, routeRows });
            const selectedAcquisition = GearPlanSelection
                .selectAcquisitionPlan(state, previousPlan, {
                    spots, occupancy, timestamp, preparedEconomy,
                    planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
                });
            const { replanContext, reusablePartyRequest, excludedSpotIds, economy } = selectedAcquisition;
            const acquisitionPlan = require('../Economy/WishProviders').personalCraftPlan(state, preparedEconomy)
                || selectedAcquisition.acquisitionPlan;
            const reservedSpot = acquisitionPlan?.next?.spotId
                ? SpotIndex.spotById(spots, acquisitionPlan.next.spotId)
                : null;
            if (reservedSpot) SpotProfiles.reserveCapacity(occupancy, reservedSpot, [state]);
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots, { occupancy, excludedSpotIds, timestamp })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
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
            const routedState = beginHuntingTrip(plannedState, context?.route, timestamp) || plannedState;
            return {
                statsPacket: economy.statsPacket,
                activityPick: economy.network.activity ? { activity: economy.network.activity.activity,
                    spotId: economy.network.activity.spotId, npcId: economy.network.activity.npcId } : null,
                economyDecision: ColdEconomyDecision.capture({ ...economy, workshop }, routedState),
                previousPlan,
                acquisitionPlan,
                partyRequest,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : Number(acquisitionPlan?.next?.npcId || 0),
                reusablePartyRequest,
                replanFailure: replanContext.failure || null,
                plannedState: routedState
            };
        },
        emit: send,
        maxBatch: config.maxBatch,
        maxInFlight: config.maxInFlight,
        maxAtomicPartySize: config.maxAtomicPartySize,
        flushTargetMs: config.flushTargetMs,
        flushHardMs: config.flushHardMs
    });
    // Keep dependencies tied to the kernel's native lifetime. In-flight
    // scratch is cancelled on a newer canonical owner; it is never LRU-evicted.
    const nativeSet = kernel.states.set.bind(kernel.states), nativeDelete = kernel.states.delete.bind(kernel.states);
    const nativeClear = kernel.states.clear.bind(kernel.states);
    kernel.states.set = (id, entry) => {
        const previousEntry = kernel.states.get(Number(id)), previous = previousEntry?.state;
        const result = nativeSet(id, entry);
        if (previous && entry.context.economyPending === undefined) entry.context.economyPending = previousEntry?.context?.economyPending || 0;
        if (previous !== entry.state) {
            const route = routeRequests.get(Number(id));
            if (route?.native && route.sourceState !== entry.state) cancelRoute(id);
            const held = occupationPlanner.slots.get(Number(id));
            const routeKey = EconomicTrip.key(entry.state);
            const incoming = held ? { ...held.input, state: entry.state, sourceState: entry.state, routeKey,
                routeRows: held.input.routeKey === routeKey ? held.input.routeRows : null } : null;
            const acceptedPublication = held?.done && entry.context?.workshop?.known === true
                && held.input.routeKey === routeKey
                && held.input.state.updatedAt === entry.state.updatedAt
                && ColdEconomyDecision.stateKey(held.input.state) === ColdEconomyDecision.stateKey(entry.state)
                && Number(entry.state.simulation?.revision || 0) > Number(held.input.state.simulation?.revision || 0)
                && held.input.state.simulation?.ownerId === entry.state.simulation?.ownerId
                && held.input.state.simulation?.leaseId === entry.state.simulation?.leaseId;
            if (held?.done && (acceptedPublication || held.input.state === entry.state || occupationPlanner.sameInput(held.input, incoming))) {
                held.input = incoming;
            } else {
                occupationPlanner.cancel(id);
                occupationOwnerChanged(id, Boolean(entry.context.economyPending));
            }
        }
        return result;
    };
    kernel.states.delete = id => { occupationPlanner.cancel(id); cancelRoute(id); return nativeDelete(id); };
    kernel.states.clear = () => {
        for (const id of [...occupationPlanner.slots.keys(), ...occupationPlanner.waiting.keys()]) occupationPlanner.cancel(id);
        routeRequests.clear();
        return nativeClear();
    };
    require('./PartyAdmission').configureTradeAdmission(id => kernel.states.get(Number(id))?.state || kernel.states.get(-Number(id))?.state);
    kernel.prepareMeeting = (id, meeting) => {
        const entry = kernel.states.get(id);
        const side = meeting.actorA === id ? 0 : 1;
        const state = meeting.incoming ? { ...entry.state, acceptedIncoming: meeting.incoming[side], incomingPending: false } : entry.state;
        return occupationPlanner.request(id, { state, sourceState: entry.state, timestamp: Date.now(),
            mode: 'meeting', meeting, recipeBook: entry.context.recipeBook, buyOrderEscrow: entry.context.buyOrderEscrow || 0,
            routeKey: EconomicTrip.key(entry.state), sourceReady: tables.ready('board') && tables.ready('market') }).then(result => {
                if (!result?.token) throw Error(result?.reason || 'trade_meeting_preparation_pending');
                return result;
            });
    };
    kernel.meetingResultPages = (result, id, token) => require('../../AfkTrade/TradeMeetingCodec').commandPages(result,
        frame => Protocol.envelope('command_request', epoch, { requests: [{ kind: 'meeting', characterId: id, commandId: token, frame }] },
            `meeting-result:${id}:${token}:3`), result.dependencies);
    kernel.buyerEvents = buyerWaiters;
    // Craft input shops are authored data, separate from gear planning rows.
    // This pure catalogue needs neither World actors nor a new IPC table.
    let craftNpcRows = null, craftNpcRate = null;
    require('../Economy/ShotMarketIndex').configure({ board: boardReady, stateFor: id => kernel.states.get(Number(id))?.state, npcOffers: () => {
        const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
        if (rate !== craftNpcRate) {
            craftNpcRate = rate;
            craftNpcRows = require('../../World/Generics/NpcShopBuyLists').allOffers();
        }
        return craftNpcRows;
    } });
    invoke('GameServer/Bot/Economy/EconomyContext').configure({
        board: boardReady,
        knownRecipes: id => require('../Economy/RecipeBookCodec').unpack(kernel.states.get(Number(id))?.context?.recipeBook) ?? undefined,
        producerSource: (state, board) => {
            if (!board) return null;
            const index = OccupationSources.recipeIndex(board);
            const level = invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor(state);
            const scope = index.scopeFor(level);
            return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
        },
        workshops: workshopsFor,
        workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
        npcOffersFor: OccupationSources.npcOffersFor,
        workshop: id => {
            const entry = kernel.states.get(Number(id));
            const held = occupationPlanner.slots.get(Number(id));
            return (held?.input.mode === 'occupation' ? occupationPlanner.valueFor(id, entry?.state) : null)
                || entry?.context?.workshop || ColdEconomyDecision.unknownWorkshop();
        },
        buyOrderEscrow: id => kernel.states.get(Number(id))?.context?.buyOrderEscrow || 0,
        spots: () => planningSpots,
        memory: (characterId) => kernel.interactionMemory.snapshot(characterId)
    });
    OccupationSources.initialise();
    loopTimer = setInterval(() => {
        if (leaseProbe && (shuttingDown || Date.now() >= leaseProbe.replyBy)) leaseProbe = null;
        kernel.tick();
    }, Math.max(5, Number(config.loopIntervalMs) || 20));
    if (Config.coldCompetitionObserveEnabled) {
        const allowed = new Set((DataCache.npcs || []).filter(npc => npc.template?.kind === 'Monster'
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)).map(npc => Number(npc.selfId)));
        competition = new ColdCompetitionMonitor({
            capacityForSpot: invoke('GameServer/Bot/AI/LevelingRoutes').capacityForSpot,
            personaFor: state => BotPersona.of(state),
            knowledgeFor: (source, persona, key) => persona ? { source, persona, key } : null,
            isTargetAllowed: id => allowed.has(id),
            ownSide: invoke('GameServer/Bot/Population/ColdPvpResolver').ownSide
        });
        competitionCandidates = new ColdCompetitionCandidates({
            records: id => kernel.states.locationIndex.getSource(id, 'state'),
            packets: id => kernel.states.get(id), memory: kernel.interactionMemory,
            monitor: competition, deadlines: kernel,
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
                    queueHead: { ...kernelReport.queueHead, kind: 'normal', alarmKind: 'claim_ack',
                        dueAt: large, overdue: false, current: false },
                    competition: { ...report, events: [],
                        recent: [], frame: { ...frame, events: [] }, at: frame.at, outcomes,
                        scans: large, evaluated: large, pvpIntents: large, activeHunters: large, lastSampleMs: large,
                        deliverySendFailures: large, lastScanEvents: 160, consumedSpotKeys: 32, consumedActorKeys: 128,
                        pendingSpotKeys: large, pendingActorKeys: large, deliveryMode: 'addressed',
                        revenge: { evaluated: large, intents: large, at: frame.at, active: 128, sampledActors: 128, overflow: false } },
                    tables: tables.summary(), heapUsed: large, rss: large,
                    eventLoopUtilization: 1, eventLoopLagP95Ms: large,
                    eventLoopLagMaxMs: large
                }, 'x'.repeat(160));
                return new (require('./ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, report.recent);
            }
        });
        kernel.decisionEvents = competitionCandidates;
    }
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        if (competitionCandidates && competitionReady && !kernel.paused && !shuttingDown) {
            const started = Config.developerDiagnostics ? performance.now() : 0;
            competitionCandidates.reviewBatch(Date.now());
            if (Config.developerDiagnostics) competition.report.lastSampleMs = performance.now() - started;
        }
        const elu = Config.developerDiagnostics ? performance.eventLoopUtilization(previousElu) : null;
        if (Config.developerDiagnostics) previousElu = performance.eventLoopUtilization();
        const heartbeat = {
            ...kernel.heartbeatSnapshot(),
            ...(Config.developerDiagnostics ? { occupationPlanning: occupationPlanner.snapshot() } : {}),
            safety: safetyTotals(),
            competition: competitionCandidates?.snapshot() || null,
            ...(Config.developerDiagnostics ? {
            tables: tables.summary(),
            developerDiagnostics: economyDiagnostics.metrics(),
            ...heapTelemetry.snapshot(),
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopUtilization: elu.utilization,
            eventLoopLagP95Ms: Number(eventLoopDelay.percentile(95) / 1e6) || 0,
            eventLoopLagMaxMs: Number(eventLoopDelay.max / 1e6) || 0
            } : {})
        };
        try {
            if (!send('heartbeat', heartbeat) && competition) {
                if (Config.developerDiagnostics) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
            }
        } catch {
            // Main has not admitted this frame. Its exact origin/content stay
            // owned here for the next existing heartbeat, including backpressure.
            if (Config.developerDiagnostics && competition) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
        }
        eventLoopDelay?.reset();
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
    try { payload = require('./ColdStateWire').unpackPayload(message.type, message.payload || {}); }
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
        if (tables.ready('board')) boardReplacing = false;
        break;
    }
    case 'economy_route_request':
        requestRoute(payload);
        break;
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
    case 'claim_ack':
        kernel?.onClaimAck(payload, message.msgId);
        break;
    case 'lease_renewal_probe':
        if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) break;
        if (leaseProbe && Date.now() < leaseProbe.replyBy) break;
        leaseProbe = { requestId: message.msgId, replyBy: payload.replyBy, pageIndex: 0,
            pages: kernel.leaseRenewalPages({ replyBy: payload.replyBy }) };
        sendLeasePage();
        break;
    case 'lease_renewal':
        if (leaseProbe?.waiting !== message.msgId || Date.now() >= leaseProbe.replyBy || shuttingDown) break;
        if (payload.renewals.some(result => {
            const token = leaseProbe.tokens.get(result.characterId);
            return !token || token.ownerId !== result.ownerId || token.revision !== result.revision || token.leaseId !== result.leaseId;
        })) break;
        kernel?.onLeaseRenewal(payload);
        if (leaseProbe.done) leaseProbe = null;
        else sendLeasePage();
        break;
    case 'commit_ack':
        kernel?.onCommitAck(payload);
        break;
    case 'release_ack':
        kernel?.onReleaseAck(payload);
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
        const result = kernel?.fence(payload.characterId) || { characterId: Number(payload.characterId), proposal: null, token: null };
        send('fence_ack', result, message.msgId);
        break;
    }
    case 'pause':
        kernel?.pause();
        break;
    case 'resume':
        kernel?.resume();
        break;
    case 'throttle':
        kernel?.setMaxInFlight(payload.maxInFlight);
        break;
    case 'competition_release':
        if (Object.hasOwn(payload, 'receipt') && !competitionCandidates?.receipt(payload.receipt)) break;
        competitionCandidates?.releaseForecasts(payload.events || []);
        break;
    case 'shutdown':
        leaseProbe = null;
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
    });
});

send('ready', {
    phase: 'loaded',
    protocolVersion: Protocol.PROTOCOL_VERSION,
    forbiddenDependencies: forbiddenLoaded.length
});

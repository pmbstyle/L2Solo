const FailureLog = require('../../../FailureLog');
const PartyMarketBreak = require('./PartyMarketBreak');
const Situations = require('../Situations');
const { stepElapsedMs } = require('./ColdSoloWindow');
const { WorkerCommandAdmissionRefusal, checkWorkerCommandAdmission } = require('./WorkerCommandAdmission');
const { PartyAdmission, limit: partyLimit, priority: admissionPriority } = require('./PartyAdmission');
// A roster the party bound refuses is counted (situations party:cap:hit): a reservation, a
// competition pair, a formation group once per revision (PartyAssemblyEvents.waitSlot).
const partyAdmission = new PartyAdmission({ onCap: () => Situations.note('party:cap:hit') });
const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const BotAfkMarketService = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const PersistentStateRetention = invoke('GameServer/Bot/Population/PersistentStateRetention');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');
const DecisionEvents = require('../AI/DecisionEvents');
const DecisionSections = require('../Economy/DecisionSections');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ColdShotEconomyService = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const CraftTelemetry = invoke('GameServer/Bot/Economy/CraftTelemetry');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const ActorQueries = require('../../World/ActorSpatialQueries');
const FloorAwareActivationPolicy = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const BackgroundWorkGovernor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const STATE_RETENTION_KEY = Symbol('state-retention');
// The WAL truncate's budget before one was measured: under the governor's 50 ms
// player budget, so the first truncate (and its measurement) can happen in play.
const WAL_TRUNCATE_FIRST_ESTIMATE_MS = 40;
// A player stays online for hours: a truncate estimated over the player budget
// is tried again once per this period (its new measurement replaces the
// estimate), and past this WAL size it runs anyway (one bounded pause is
// better than an unbounded file). The size, not the period, bounds the file:
// at ~55 MB/min (hot run, 1731 bots) 10 min is ~550 MB, the ceiling holds it
// at 512 MB whatever the write rate, about one ~80 ms pause per 9 min there.
const WAL_TRUNCATE_ESTIMATE_RETRY_MS = 10 * 60 * 1000;
const WAL_TRUNCATE_FORCE_WAL_BYTES = 512 * 1024 * 1024;
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const PartyGoalCalculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
const PartyGoalPolicy = invoke('GameServer/Bot/Population/PartyGoalPolicy');
const CraftMaterialParty = invoke('GameServer/Bot/Population/CraftMaterialParty');
const PartyAgreement = invoke('GameServer/Bot/Population/PartyAgreement');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
const ACTIVATION_BUSY_FLAGS = ['supplyErrand'];
const BackgroundPartyLifecycle = invoke('GameServer/Bot/Population/BackgroundPartyLifecycle');
const ClanPartyCapacity = invoke('GameServer/Bot/Population/ClanPartyCapacity');
const ClanEquipmentPartyPolicy = invoke('GameServer/Bot/Population/ClanEquipmentPartyPolicy');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const ClanEconomyService = invoke('GameServer/Clan/ClanEconomyService');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanPartyService = invoke('GameServer/Clan/ClanPartyService');
const ClanMarketService = invoke('GameServer/Clan/ClanMarketService');

const { partyObjectiveForState } = PartyRequestPlanner;

const SurvivalFloor = require('./SurvivalFloor');
const CombinedErrands = require('./CombinedErrandPolicy');
const TradeMeetingService = invoke('GameServer/AfkTrade/TradeMeetingService');
const ClanRaidRoster = require('../../Clan/ClanRaidRoster');
const partyFailureLogAt = new Map();
// The completion key a far bot already waited on in town since its last
// buy or improvement this visit (main only; the visit's end clears it).
const exchangeWaits = new Map();
// Returned by a resolveColdState branch method that did not take its branch.
const COLD_RESOLVE_NEXT = Symbol('cold_resolve_next');
// helpClanParty: a busy main tried no clan plea (no event ends that: a timed retry).
const BUSY_HELP = Symbol('busy_help');

// A party step's refusal (step: 'activation', 'goal' for the worker's party
// goal query), one line per party, step and reason in 30 s: the live read
// with diagnostics off.
function logPartyFailure(partyId, step, result, timestamp = Date.now()) {
    if (!partyId || result?.ok !== false) return;
    const reason = String(result.reason || 'unknown');
    const detail = String(result.detail || '');
    const key = `${partyId}:${step}:${reason}:${detail}`;
    if (timestamp - Number(partyFailureLogAt.get(key) || 0) < 30000) return;
    // Lapsed keys go once the map grows (a forming roster's id is its member set).
    if (partyFailureLogAt.size >= 256) for (const [old, loggedAt] of partyFailureLogAt) if (timestamp - loggedAt >= 30000) partyFailureLogAt.delete(old);
    partyFailureLogAt.set(key, timestamp);
    utils.infoWarn('BotPopulation', 'party %s deferred %s reason=%s%s',
        step, partyId, reason, detail ? ` detail=${detail}` : '');
}

// A walker a player at `playerLoc` comes near (ColdTrip) shows itself at an
// endpoint of its run, never on the straight line between them (a walker on its
// road is open work): at the spot edge it runs to when that is within the
// activation radius of the player, else at the teleport point it ran from when
// that is; the author's hot movement takes over from there. Either way the trip
// is done (resolveTravel's arrival: activity, spot, region, a detour's standIn);
// at the teleport point only its place differs, where the bot hunts or walks on
// as a hot bot decides. null: no walker; false: neither endpoint in reach (on a
// run longer than twice the radius, a player by its middle), it stays cold.
function walkerAppearance(state, playerLoc) {
    const travel = state?.stats?.travel;
    const run = travel?.run;
    if (state?.activity !== 'traveling' || !run) return null;
    const inReach = (loc) => !!loc && !!playerLoc && Math.hypot(Number(loc.locX) - Number(playerLoc.locX),
        Number(loc.locY) - Number(playerLoc.locY)) <= Config.activationRadius;
    const arrival = BackgroundResolver.resolveSolo({ state, spot: null, timestamp: Number(travel.arrivalAt) });
    const shown = { ...state, ...arrival.patch };
    if (inReach(shown.loc)) return shown;
    return inReach(run.from) ? { ...shown, loc: { ...run.from } } : false;
}

// The spot of a commanded bot, from its request's route: the trip the
// worker's plan started (BotRoute), or the ground the worker fought on when
// the bot needed no trip.
function commandSpot(route) {
    return route?.spotId ? SpotProfiles.findById(route.spotId) : null;
}

function groupBySpot(states, options = {}) {
    const grouped = new Map();
    states.forEach((state) => {
        const planSpotId = !SpotProfiles.isProtectedStarterCohort(state)
            && state.stats?.equipmentPlan?.status === 'active'
            ? state.stats.equipmentPlan.next?.spotId
            : null;
        const spotId = planSpotId || state.spotId;
        if (!spotId) return;
        if (!grouped.has(spotId)) grouped.set(spotId, []);
        grouped.get(spotId).push(state);
    });

    const activePartiesBySpot = options.activePartiesBySpot || new Map();
    return Array.from(grouped.entries())
        .map(([spotId, group]) => ({
            spotId,
            states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
            partyWaiters: group.filter((state) => state.activity === 'party_wait'
                || state.stats?.partyRequest?.status === 'open').length,
            oldestPartyWaitAt: Math.min(...group
                .filter((state) => state.activity === 'party_wait'
                    || state.stats?.partyRequest?.status === 'open')
                .map((state) => Number(state.stats?.partyRequest?.requestedAt
                    || state.timing?.activityStartedAt
                    || state.updatedAt
                    || Date.now())))
        }))
        .sort((a, b) => {
            if (options.prioritizePartyWait) {
                const aDeficit = a.partyWaiters / (1 + Number(activePartiesBySpot.get(a.spotId) || 0));
                const bDeficit = b.partyWaiters / (1 + Number(activePartiesBySpot.get(b.spotId) || 0));
                if (aDeficit !== bDeficit) return bDeficit - aDeficit;
                if (a.oldestPartyWaitAt !== b.oldestPartyWaitAt) return a.oldestPartyWaitAt - b.oldestPartyWaitAt;
            }
            const aGroup = a.states;
            const bGroup = b.states;
            const aPlanned = aGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            const bPlanned = bGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            return bPlanned - aPlanned || bGroup.length - aGroup.length;
        })
        .map((group) => group.states);
}

function leaderIdForMembers(party, members = []) {
    const memberIds = new Set((members || [])
        .map((member) => Number(member?.characterId))
        .filter(Boolean));
    const currentLeaderId = Number(party?.leaderId || 0);
    if (memberIds.has(currentLeaderId)) return currentLeaderId;
    const selectedLeader = PartyComposition.chooseLeader(members);
    return Number(selectedLeader?.characterId || members[0]?.characterId || currentLeaderId || 0);
}

function partyCapacityLimit() {
    return partyLimit(Config);
}

function occupiedPartySlots() {
    return Math.max(0, Number(BackgroundPartyState.counts().active || 0)) + partyAdmission.pending;
}

const { acquisitionRequirementKey, acquisitionFallbackEvent } = require('./PartyRequirementRefresh');

function partyObjectivesShareRoute(left, right) {
    const leftClanGoal = String(left?.clanGoalKey || '');
    const rightClanGoal = String(right?.clanGoalKey || '');
    if (leftClanGoal || rightClanGoal) {
        return Boolean(leftClanGoal && leftClanGoal === rightClanGoal);
    }
    return Boolean(left && right
        && String(left.spotId || '') === String(right.spotId || '')
        && Number(left.npcId || 0) > 0
        && Number(left.npcId || 0) === Number(right.npcId || 0));
}


function partyObjectiveGroupingKey(objective) {
    if (CraftMaterialParty.isObjective(objective)) return `craft-material:${objective.spotId}`;
    const clanGoalKey = String(objective?.clanGoalKey || '');
    return clanGoalKey ? `clan-goal:${clanGoalKey}` : objective?.objectiveKey;
}

// objective: the state's partyObjectiveForState when the caller already has it.
function partyObjectiveKeyForState(state, objective = partyObjectiveForState(state)) {
    return partyObjectiveGroupingKey(objective)
        || `spot:${state?.spotId || 'unknown'}`;
}

function partyObjectiveSpotForState(state, objective = partyObjectiveForState(state)) {
    return PartyRequestPlanner.objectiveSpot(state, objective);
}

// Spot id -> active background parties there, as a Map-like get(). Counted on
// the first read only: a group sort reads it when two groups tie before it,
// and an event assembly usually has one group (no scan of all parties).
function activePartiesBySpotOnRead() {
    let counts = null;
    return {
        get(spotId) {
            if (!counts) {
                counts = new Map();
                for (const party of BackgroundPartyState.active()) {
                    const id = String(party.spotId || '');
                    if (id) counts.set(id, Number(counts.get(id) || 0) + 1);
                }
                Config.developerDiagnostics && Diagnostics.count('party_assembly', 'spot_counts', 'built');
            }
            return counts.get(spotId);
        }
    };
}

// One assembly pass reads each candidate's objective once (it was read up to
// ten times per candidate, also inside sort comparators).
function partyObjectiveMemo() {
    const objectives = new Map();
    return state => {
        if (!objectives.has(state)) objectives.set(state, partyObjectiveForState(state));
        return objectives.get(state);
    };
}

function directDropTargetNpcId(...plans) {
    for (const plan of plans) {
        if (plan?.status !== 'active' || plan?.strategy !== 'direct_drop') continue;
        const npcId = Number(plan.next?.npcId || 0);
        if (npcId > 0) return npcId;
    }
    return 0;
}

function joinedBackgroundParty(state) {
    const current = LifeState.cachedState(state?.characterId);
    return !!current?.party?.partyId;
}

// A trip to buy at a shop is paid from the wallet. When the bot's own buy
// order still holds Adena, the trip withdraws it first (its goal keeps no
// WTB, or beginMarketTravel would refuse) and starts from the refunded
// state. If the order cannot be withdrawn, the bot does not leave; a caller
// that holds the pre-refund state must not apply it after a refund.
async function marketTravelWithRefund(state, goal, timestamp = Date.now()) {
    const travel = GoalExecutor.beginMarketTravel(state, goal, timestamp);
    if (!travel || BotAfkMarketService.desiredSide(goal) !== AfkTrade.BUY
        || BotAfkMarketService.buyOrderEscrow(state.characterId) <= 0) return travel;
    const remote = await BotAfkMarketService.reconcile(state, goal).catch((error) => {
        if (!FailureLog.refusal(error)) FailureLog.note('economy.trip_refund', error);
    });
    const refunded = remote?.withdrawn ? remote.state || state : null;
    if (!refunded || refunded.phase !== 'cold' || joinedBackgroundParty(refunded)) return null;
    return GoalExecutor.beginMarketTravel(refunded, goal, timestamp);
}

function canResumeWarehouseMarketSale(state) {
    if (state?.activity !== 'hunting' || state.stats?.marketReturn || state.stats?.travel) return false;
    return (state.stats?.lastWarehouseWithdrawal?.items || []).some((item) => (
        (Array.isArray(item) ? item[2] === 1 : item.reason === 'market')
        && Number(state.inventory?.[String(Array.isArray(item) ? item[0] : item.selfId)]?.amount || 0) > 0
        && !!MarketOpportunity.bestBuyOffer(Array.isArray(item) ? item[0] : item.selfId, { sellerCharacterId: state.characterId })
    ));
}

function dissolveBackgroundParty(party, reason, memberCount = 0) {
    return BackgroundPartyState.setStatus(party.partyId, 'dissolved')
        .then(() => LifeState.releaseDissolvedPartyMembers(party.partyId, reason))
        .then((cleared) => {
            Config.developerDiagnostics && Metrics.recordPartyDissolution();
            Config.developerDiagnostics && console.info(
                'BotPopulation :: dissolved background party %s reason=%s members=%d cleared=%d',
                party.partyId,
                reason,
                memberCount,
                cleared
            );
            return { ok: false, reason, party, cleared };
        });
}

function partyLimitsForObjective(objective = null) {
    return PartyRequestPlanner.limitsForObjective(objective);
}

function requiresClanEquipmentParty(state) {
    const objective = partyObjectiveForState(state);
    return objective?.status === 'open'
        && objective?.priority === 'required'
        && objective?.clanOperation === 'equipment'
        && Number(objective?.clanId || 0) > 0;
}

async function jointPartyGoals(party, members, timestamp, options = {}) {
    const Policy = invoke('GameServer/Bot/Population/PartyGoalPolicy');
    if (party.stats?.objective?.opportunisticRaid === true) return Policy.pending(party, members);
    if (party.stats?.forming && !members.some(member => member.phase === 'cold'))
        return Policy.formingVerdict(members, party.stats.forming.requested, { timestamp });
    if (!members.some(member => member.phase === 'cold') && CraftMaterialParty.isObjective(party.stats?.objective))
        return Policy.joint(party, members);
    if (!members.some(member => member.phase === 'cold'))
        return Policy.joint(party, members, { context: Policy.groupContext(party, members, { timestamp }) });
    const result = await ColdSimulationCoordinator.requestPartyGoals(party, members, { timestamp,
        onWorkerWait: ms => { options.workerWaitMs = Number(options.workerWaitMs || 0) + ms; } });
    // Two other parties hold the worker's goal slots: keep the current
    // objective now; the next party resolve reviews the goals again.
    if (result.reason === 'party_goal_busy') return Policy.pending(party, members);
    // A member mid native step (party_goal_member_busy) is a designed race,
    // not a failure: no log; the next party resolve asks again.
    if (result.reason !== 'party_goal_member_busy') logPartyFailure(party.partyId, 'goal', result);
    return result.ok && PartyGoalCalculation.matches(members, result.sources) ? result.joint : null;
}

// The trips the worker's party_stay answered for members of a clan duty party
// (ColdSimulationKernel.partyStay): main starts each with the party's return ticket
// (PartyMarketBreak.departure) and the member leaves until it comes back
// (resumePartyMarketBreak). One the duty does not let go now stays on duty, counted:
// behind another member's absence (party:stay_trip:held), its bag is heard again when
// that absence ends (absenceEnded); a bag no longer at its floor or a trip that
// cannot start (party:stay_trip:refused) waits for its next situation. The worker
// decided; main executes.
async function applyPartyStayTrips(party, trips = [], timestamp = Date.now()) {
    party = BackgroundPartyState.find(party?.partyId) || party;
    const departed = [];
    for (const { characterId } of trips) {
        if (party?.status !== 'active') break;
        const member = LifeState.cachedState(characterId);
        if (!member || member.phase !== 'cold' || DecisionSections.partyIdOf(member) !== String(party.partyId)) continue;
        if (PartyMarketBreak.pending(party, timestamp).length) { Situations.note('party:stay_trip:held'); continue; }
        const need = PartyMarketBreak.bagNeed(member, timestamp);
        const goal = PartyMarketBreak.allowed(party, member, timestamp, need) ? PartyMarketBreak.goal(party, member, timestamp, need) : null;
        const travel = goal && GoalExecutor.beginMarketTravel(member, goal, timestamp);
        const departure = travel && PartyMarketBreak.departure(party, member, travel, timestamp, need);
        if (!departure) { Situations.note('party:stay_trip:refused'); continue; }
        const left = await LifeState.leaveParty(departure, 'market_break', { ownerHandoff: true });
        if (!left) continue;
        departed.push(left);
        party = BackgroundPartyState.find(party.partyId) || party;
        const retained = retainedMembers(party, left.characterId);
        // A return token keeps no party below the minimum: the row refuses that roster
        // (prepareCommit). A returning bot finds its party gone and waits (resumePartyMarketBreak).
        if (retained.length < Config.partyMinSize) {
            const dissolved = await dissolveBackgroundParty(party, 'market_break', retained.length);
            return { party: dissolved.party || party, departed, dissolved: true };
        }
        const nextParty = partyWithRoster(party, retained, PartyMarketBreak.stats(party, left));
        await syncPartyLeader(retained, nextParty, nextParty.leaderId);
        party = await BackgroundPartyState.createOrUpdate(nextParty) || party;
    }
    return { party, departed, dissolved: false };
}

// A clan duty lets one member go at a time: a member whose trip it held behind that
// absence (applyPartyStayTrips) hears its bag again when the absence ends, however it
// ends (the absent member back, its ticket dropped or expired, its trip given up):
// each member still in that party at its bag floor raises bag_full (its stay decides
// again). Read on every published row of a far bot (absenceEnded); a row that carried
// no live ticket costs one field read.
function absenceEnded({ state, previousState }) {
    const token = previousState?.stats?.partyMarketReturn;
    if (!token?.partyId || !(Number(token.until) > Number(previousState.updatedAt || 0))) return;
    const ticket = state?.stats?.partyMarketReturn;
    if (ticket?.partyId === token.partyId && Number(ticket.until) > Number(state.updatedAt || 0)) return;
    const party = BackgroundPartyState.find(token.partyId);
    if (party?.status !== 'active') return;
    for (const id of party.memberIds || []) {
        const member = Number(id) !== Number(token.characterId) && LifeState.cachedState(id);
        if (member?.phase === 'cold' && DecisionSections.partyIdOf(member) === String(party.partyId)
            && PartyMarketBreak.bagFact(member) === 2) DecisionEvents.raiseOn(id, 'bag_full');
    }
}
LifeState.subscribePublications(absenceEnded);

async function resumePartyMarketBreak(state, timestamp) {
    const token = state.stats.partyMarketReturn;
    const party = BackgroundPartyState.find(token.partyId);
    const warehouse = token.cleanupReason === 'craft_warehouse';
    const matching = warehouse ? String(party?.stats?.objective?.objectiveKey || '') === String(token.objective?.objectiveKey || '')
        : party?.stats?.objective?.clanGoalKey === token.objective?.clanGoalKey;
    const prepared = { ...state, activity: 'party_wait', stats: { ...state.stats,
        partyMarketReturn: null, clanPartyObjective: warehouse ? state.stats.clanPartyObjective : token.objective,
        partyRequest: warehouse ? state.stats.partyRequest : token.objective } };
    if (party?.status === 'active' && matching && party.memberIds.length < partyLimitsForObjective(party?.stats?.objective).maxSize) {
        const members = await LifeState.statesForParty(party.partyId);
        if (members.length !== party.memberIds.length) return { ok: false, state, reason: 'party_return_retry' };
        const absences = { ...party.stats?.marketAbsences };
        delete absences[state.characterId];
        const roster = [...members, prepared];
        const result = await commitPartyMembership({ ...party,
            memberIds: roster.map(member => member.characterId),
            roleCoverage: PartyComposition.roleCoverage(roster),
            nextResolveAt: timestamp, stats: { ...party.stats, marketAbsences: absences } }, roster, null);
        return { ok: !!result.party, state: LifeState.cachedState(state.characterId) || state,
            reason: result.party ? 'returned_to_clan_party' : 'party_return_retry' };
    }
    if (warehouse) {
        // An ordinary party may fill or dissolve while its member shops. It
        // has no clan request to wait on, so resume the personal route.
        const solo = { ...prepared, activity: 'hunting', timing: { ...(prepared.timing || {}), nextResolveAt: timestamp + 30000 } };
        const saved = await LifeState.upsertState(solo, 'craft_warehouse_party_unavailable');
        return { ok: !!saved, state: saved || state, reason: 'craft_warehouse_party_unavailable' };
    }
    // A dissolved or full party must not turn the clan assignment into solo combat.
    const saved = await LifeState.upsertState(prepared, 'clan_party_return_wait');
    return { ok: !!saved, state: saved || state, reason: 'clan_party_return_wait' };
}

// need: the cold worker's verdict on this state (a far step's proposal); else the
// build's held bag trip (stats.cleanupDue): no resolve decides the bag on its own.
function inventoryCleanupGoal(state, need = PartyMarketBreak.heldCleanup(state)) {
    if (!need) return null;
    return { ...invoke('GameServer/Bot/Goals/NeedsEvaluator').cleanupGoal(need), status: 'active' };
}

function inventoryCleanupTravelState(state, timestamp = Date.now(), simulation = null, need = undefined) {
    const cleanupGoal = inventoryCleanupGoal(state, need);
    if (!cleanupGoal) return null;
    const travelState = GoalExecutor.beginMarketTravel(state, cleanupGoal, timestamp);
    if (!travelState) return null;

    const cleanup = cleanupGoal.target;
    Config.developerDiagnostics && console.info('BotGoals :: forced inventory cleanup for %s slots=%d npcOnly=%d reason=%s',
        state.name, Number(cleanup.itemCount || 0), Number(cleanup.npcOnlySlots || 0), cleanup.cleanupReason);
    return {
        ...travelState,
        stats: {
            ...(travelState.stats || {}),
            // The trip a build decided (stats.cleanupDue) starts here: its hold ends.
            cleanupDue: null,
            forcedMarketCleanup: {
                ...cleanup,
                startedAt: timestamp
            }
        },
        ...(simulation ? { simulation } : {}),
        cleanup
    };
}

// An ended visit is saved in town only while a meeting preparation holds the
// bot (E314); it starts no market travel until that preparation ends.
function heldVisit(state) {
    return state?.stats?.townVisit?.completed === true && TradeMeetingService.hasPreparation(state.characterId);
}

// The departure marker, not the goal re-reviewed on arrival, says the trip came to sell.
function saleVisit(state) {
    const visit = state?.stats?.townVisit;
    return visit?.reason === 'sell_inventory' && visit.completed !== true
        && (!visit.town || visit.town === state.currentRegion);
}
// A visit sells when it came to sell or the step it carries out is a sale (a sale taken in
// town on another visit, where it costs no trip): its own sale (ColdMarketListingService.open)
// places the bag and writes the sale retry on what it could not place, which the held sale's
// end reads (EconomyContext.saleSpent). Read during the step's command, which holds its card.
function visitSells(state) {
    return saleVisit(state) || ColdSimulationCoordinator.economyDecisions.activity(state)?.activity === 'selling';
}

function marketListingIntent(state, goal = null) {
    const ordinaryVisit = state?.phase === 'cold' && state.activity === 'shopping'
        && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state);
    const floor = ordinaryVisit && state.stats?.townVisit?.reason === 'sell_inventory'
        && !state.stats?.forcedMarketCleanup ? SurvivalFloor.bagFor(state) : null;
    // A prepared board plan does not unload the physical bag. Keep a hard
    // slot/weight floor on the native sale path even when an earlier pass
    // already ended the visit or its departure marker was not retained.
    const forcedCleanup = state?.stats?.forcedMarketCleanup
        || (floor?.action === 'unload' ? { cleanupReason: floor.reason } : null)
        // Arrows the sale takes (its own lines): sold at the NPC beside the worker's board plan.
        || (ordinaryVisit && invoke('GameServer/Bot/Economy/ItemDisposition').unusedArrowCandidates(state).length
            ? { cleanupReason: 'unused_arrows' } : null);
    const selling = visitSells(state);
    if (!forcedCleanup && goal?.type !== 'sell_inventory' && !ordinaryVisit && !selling) {
        return { shouldOpen: false, state };
    }
    if (!forcedCleanup) return { shouldOpen: true, saleVisit: selling, state };

    return {
        shouldOpen: true,
        cleanup: forcedCleanup,
        saleVisit: selling,
        state: {
            ...state,
            stats: {
                ...(state.stats || {}),
                forcedMarketCleanup: null
            }
        }
    };
}

function openMarketListing(intent, goal) {
    // An existing shop can sell remotely, but cannot unload the bag that
    // brought its owner to town (a cleanup or a sale trip) or defer the next one.
    if (!intent.cleanup && !intent.saleVisit && BotAfkMarketService.canTradeRemotely(intent.state, goal)) {
        return BotAfkMarketService.reconcile(intent.state, goal)
            .then((remote) => ({ state: remote.state, listed: false, remote: remote.changed }));
    }
    return ColdMarketListingService.open(intent.state, { forcedCleanup: intent.cleanup || null });
}

function assignPartyMembers(members = [], party) {
    const assigned = [];
    const failed = [];
    return (members || []).reduce((chain, member) => chain.then(() => (
        LifeState.assignParty(
            member,
            party.partyId,
            PartyComposition.roleForState(member),
            party.leaderId,
            party.nextResolveAt
        ).then((saved) => {
            if (saved) assigned.push(member);
            else failed.push(member);
            return saved;
        }).catch(() => {
            failed.push(member);
            return null;
        })
    )), Promise.resolve()).then(() => ({ assigned, failed }));
}

function hydratePartyCandidates(candidates = []) {
    const selected = (candidates || []).filter((state) => Number(state?.characterId || 0) > 0
        && invoke('GameServer/AfkTrade/TradeMeetingService').canJoinParty(state.characterId, state));
    if (!selected.length || !Database.isReady() || typeof LifeState.statesByIds !== 'function') {
        return Promise.resolve(selected);
    }
    const projectionById = new Map(selected.map((state) => [Number(state.characterId), state]));
    return LifeState.statesByIds(Array.from(projectionById.keys()), {
        unassigned: true, excludeReserved: true
    }).then((states) => {
        const hydratedById = new Map((states || []).map((state) => [Number(state.characterId), state]));
        return selected.map((projection) => {
            const hydrated = hydratedById.get(Number(projection.characterId));
            if (!hydrated) return null;
            const projectedAt = Number(projection.updatedAt || 0);
            if (projectedAt > 0 && Number(hydrated.updatedAt || 0) !== projectedAt) return null;
            const projectedRevision = Number(projection.simulation?.revision);
            if (Number.isFinite(projectedRevision)
                && Number(hydrated.simulation?.revision || 0) !== projectedRevision) return null;
            return hydrated;
        }).filter(Boolean);
    });
}

// Writes recruits into a party: the leader elected over the whole roster, the
// recruit check's answer (joint: member goals, progress reviews; null for a clan
// or raid objective, which joins without one), the pending join cleared, one
// fenced transaction with every member (commitPartyMembership). The updated
// party, or null when the fence refused it.
function joinPartyRecruits(party, members, recruits, joint) {
    const allMembers = [...members, ...recruits];
    const electedLeaderId = leaderIdForMembers(party, members) || Number(recruits[0]?.characterId || 0);
    const finalLeaderId = leaderIdForMembers({ ...party, leaderId: electedLeaderId }, allMembers);
    const objective = party.stats?.objective || null;
    const agreement = joint ? joint.agreement
        : CraftMaterialParty.isObjective(objective) ? CraftMaterialParty.agreement(allMembers, objective, party.stats.agreement)
            : party.stats?.agreement;
    const stats = {
        ...(party.stats || {}),
        memberGoals: joint?.memberGoals || allMembers.map(PartyGoalPolicy.declaration),
        agreement: agreement ? { ...agreement, memberIds: allMembers.map(member => member.characterId) } : null
    };
    delete stats.pendingRecruits;
    const nextParty = {
        ...party,
        leaderId: finalLeaderId,
        memberIds: allMembers.map((member) => member.characterId),
        roleCoverage: PartyComposition.roleCoverage(allMembers),
        stats
    };
    const recruitEvent = {
        characterId: finalLeaderId,
        eventType: 'party_recruit',
        summary: `${members[0].name} recruited ${recruits.map((recruit) => recruit.name).join(', ')} near ${party.spotId}`,
        meta: {
            partyId: party.partyId,
            recruitIds: recruits.map((recruit) => recruit.characterId),
            spotId: party.spotId
        },
        weight: 1,
        createdAt: Date.now()
    };
    // Validate and persist the complete resulting membership in one
    // transaction, including retained members, with the recruit event. This
    // makes recruitment resilient to a simultaneous party release.
    return commitPartyMembership(nextParty, allMembers, recruitEvent, { expectedPartyRevision: party.revision })
        .then(({ party: updatedParty, failed }) => {
            if (!updatedParty || failed.length) return null;
            Config.developerDiagnostics && Metrics.recordPartyRecruit(recruits.length);
            Config.developerDiagnostics && console.info('BotPopulation :: recruited %d bot(s) into %s near %s', recruits.length, party.partyId, party.spotId || 'none');
            return updatedParty;
        });
}

// Developer diagnostics: a healer or buffer without solo ground
// (PartyRequestPlanner.seeksParty) that a committed membership puts in a party.
function countSeekersFound(members) {
    const found = Config.developerDiagnostics ? members.filter(PartyRequestPlanner.seeksParty).length : 0;
    if (found) Diagnostics.count('party_seek', PartyRequestPlanner.NO_SOLO_GROUND, 'found_party', found);
}

function commitPartyMembership(party, members = [], event = null, options = {}) {
    const selected = (members || []).filter(Boolean);
    if (!party || !selected.length) return Promise.resolve({ party: null, assigned: [], failed: selected });
    if (selected.some(member => {
        const held = require('./RaidSupplyPolicy').held(LifeState.cachedState(member.characterId) || member);
        return held && held.id !== party.stats?.objective?.preparationId;
    })) return Promise.resolve({ party: null, assigned: [], failed: selected, reason: 'raid_supply_reserved' });
    if (selected.some(member => !member.party?.partyId && !member.partyId
        && !invoke('GameServer/AfkTrade/TradeMeetingService').canJoinParty(member.characterId, member))) {
        return Promise.resolve({ party: null, assigned: [], failed: selected, reason: 'party_trade_busy' });
    }
    if (ClanEquipmentPartyPolicy.needsReview(party, selected)) {
        return Promise.resolve({ party: null, assigned: [], failed: selected, reason: 'clan_party_unsafe' });
    }

    // One SQLite queue item and one bounded transaction: party and members
    // commit together or not at all.
    const preparedParty = BackgroundPartyState.prepareCommit(party);
    if (!preparedParty) return Promise.resolve({ party: null, assigned: [], failed: selected });
    const preparedMembers = selected.map((member) => {
        const prepared = LifeState.preparePartyAssignment(
            member,
            preparedParty.snapshot.partyId,
            PartyComposition.roleForState(member),
            preparedParty.snapshot.leaderId,
            preparedParty.snapshot.nextResolveAt
        );
        return prepared && { ...prepared, expectedSimulationRevision: Number(member.simulation?.revision || 0) };
    }).filter(Boolean);
    if (preparedMembers.length !== selected.length) {
        return Promise.resolve({ party: null, assigned: [], failed: selected });
    }

    return Database.commitBackgroundPartyMembership({
        party: preparedParty.row,
        members: preparedMembers,
        event,
        expectedPartyRevision: options.expectedPartyRevision ?? null
    }).then((result) => {
        if (!result?.ok) return { party: null, assigned: [], failed: selected, reason: result?.reason || 'commit_failed' };
        const committedParty = BackgroundPartyState.acceptRow(result.partyRow);
        for (const row of result.lifeRows || []) {
            const entry = preparedMembers.find(member => Number(member.row.characterId) === Number(row.characterId));
            if (entry) entry.snapshot = LifeState.acceptNewerLifecycleRow(row) || entry.snapshot;
        }
        const assigned = LifeState.acceptPartyAssignments(preparedMembers);
        assigned.forEach(() => Config.developerDiagnostics && Metrics.recordDbFlush());
        countSeekersFound(selected);
        invoke('GameServer/Bot/AI/BotClanChat').onClanTask?.(committedParty, assigned);
        return { party: committedParty, assigned, failed: [] };
    }).catch((error) => {
        if (error?.code !== 'BOT_PARTY_MEMBERSHIP_CONFLICT') {
            utils.infoWarn('BotPopulation', 'atomic party membership commit failed for %s: %s', party.partyId, error.message);
        }
        return { party: null, assigned: [], failed: selected, reason: error?.code || 'commit_failed' };
    });
}

async function releaseForClanHelp(state) {
    state = LifeState.cachedState(state.characterId) || state;
    const partyId = state.party?.partyId;
    if (!partyId) return state;
    const previous = BackgroundPartyState.find(partyId);
    if (!previous || previous.status !== 'active' || previous.stats?.objective?.clanGoalKey) return null;
    const released = await LifeState.leaveParty(state, 'clan_rescue', { ownerHandoff: true });
    if (!released) return null;
    const remaining = await LifeState.statesForParty(partyId);
    if (remaining.length < Config.partyMinSize) {
        await dissolveBackgroundParty(previous, 'clan_rescue', remaining.length);
    } else {
        await commitPartyMembership(partyWithRoster(previous, remaining), remaining);
    }
    return LifeState.cachedState(state.characterId) || released;
}

// options (forming's): every roster dropped here says why, none silently: onRefused
// (forming's no: the roster cannot stand, its requests close), onDeferred (the verdict
// not given: its members' next rows ask again), onNoSlot (no party slot: a party's end
// asks again), onCommitRefused (a member's row moved or the commit failed).
async function createAndCommitBackgroundParty(members = [], objectiveOverride = null, options = {}) {
    const objective = objectiveOverride || members.map(partyObjectiveForState).find(ClanPartyCapacity.required);
    const refused = async () => { await options.onRefused?.(); return null; };
    if (objective?.fullRoster) {
        members = ClanRaidRoster.selectMembers(members, objective, partyLimitsForObjective(objective));
        if (members.length !== 9) return refused();
    }
    if (ClanEquipmentPartyPolicy.applies(objective)) {
        members = members.filter(member => ClanEquipmentPartyPolicy.allowed(member, objective));
        if (members.length < partyLimitsForObjective(objective).minSize) return refused();
    }
    let release = partyAdmission.reserve(BackgroundPartyState.admitted(), Config);
    if (!release && ClanPartyCapacity.required(objective) && partyAdmission.canReclaim(BackgroundPartyState.admitted(), Config)) {
        const limits = partyLimitsForObjective(objective);
        if (ClanRaidRoster.selectMembers(members, objective, limits).length < limits.minSize) return refused();
        const reclaimed = await ClanPartyCapacity.reclaim(objective, {
            parties: BackgroundPartyState, life: LifeState, database: Database, metrics: Metrics
        });
        if (reclaimed) release = partyAdmission.reserve(BackgroundPartyState.admitted(), Config);
    }
    if (!release) { options.onNoSlot?.(); return null; }
    try { return await createBackgroundParty(members, objectiveOverride, options); }
    finally { release(); }
}

// The forming verdict of a roster (PartyGoalPolicy.formingVerdict) before main builds the party,
// asked like its goals (jointPartyGoals: main for an all-near roster, the worker otherwise). A busy
// or failed worker defers the roster to the next assembly: no main thought and no build for a far
// roster. The roster's id is its member set, so a refusal repeated per attempt logs once (logPartyFailure).
// Asked once per group event: a refused roster's requests close until their bots' next build.
async function formingVerdict(members, requested, options) {
    const memberIds = members.map(member => Number(member.characterId));
    const timestamp = Date.now();
    if (Config.developerDiagnostics) Diagnostics.count('party_forming', 'judged', requested ? 'requested' : 'open');
    const verdict = await jointPartyGoals({ partyId: `forming_${[...memberIds].sort((a, b) => a - b).join('_')}`,
        leaderId: memberIds[0], memberIds, stats: { forming: { requested: requested || null } } }, members, timestamp, options);
    return Array.isArray(verdict?.formingAccepted) ? verdict : null;
}

async function createBackgroundParty(members = [], objectiveOverride = null, options = {}) {
    const requested = objectiveOverride || members.map(partyObjectiveForState).find(objective => objective?.priority === 'required');
    if (members.length < Config.partyMinSize) return null;
    if (!PartyGoalPolicy.verdictFree(requested)) {
        // Judged where the party will hunt: its required objective, else the spot its members'
        // objective names (a preferred request's), never where its first member stands now.
        const ground = requested ? null : members.map(partyObjectiveForState).find(objective => objective?.spotId);
        const verdict = await formingVerdict(members, requested || (ground ? { spotId: ground.spotId } : null), options);
        const accepted = new Set(verdict?.formingAccepted || []);
        members = members.filter(member => accepted.has(Number(member.characterId)));
        // Forming's no (a verdict) closes the roster's requests; a busy or failed worker's none asks again.
        if (members.length < Config.partyMinSize) {
            if (verdict) await options.onRefused?.(); else options.onDeferred?.();
            return null;
        }
    }
    const leader = PartyComposition.chooseLeader(members);
    if (!leader) { await options.onRefused?.(); return null; }
    const objectiveMember = members.find((member) => (
        member.stats?.partyRequest?.status === 'open'
        && member.stats?.partyRequest?.priority === 'required'
    )) || members.find((member) => partyObjectiveForState(member)) || leader;
    const objective = objectiveOverride || partyObjectiveForState(objectiveMember);
    if (objective?.preparationId) members = members.map(s => s.stats?.raidSupplyPreparation?.id === objective.preparationId
        ? { ...s, stats: { ...s.stats, raidSupplyPreparation: null } } : s);
    const timestamp = Date.now();
    const partyId = `bgp_${timestamp.toString(36)}_${leader.characterId}`;
    const coverage = PartyComposition.roleCoverage(members);
    const party = {
        partyId,
        leaderId: leader.characterId,
        memberIds: members.map((state) => state.characterId),
        // Its objective's ground, else where its leader stands: the party's first step
        // decides its spot (no answer held: party_spot reads woken).
        spotId: objective?.spotId || leader.spotId,
        startedAt: timestamp,
        nextResolveAt: timestamp + 45000 + Math.round(Math.random() * 90000),
        cohesion: 0.55 + Math.random() * 0.25,
        risk: 0.18 + Math.random() * 0.22,
        roleCoverage: coverage,
        stats: {
            formedAt: timestamp,
            objective: objective || null,
            acquisitionGoal: objective?.reason !== 'clan_help' && objectiveMember.stats?.equipmentPlan?.status === 'active'
                ? objectiveMember.stats.equipmentPlan
                : null
        }
    };
    if (CraftMaterialParty.isObjective(objective)) party.stats.agreement = PartyAgreement
        .propose(leader, members, objective, { persona: BotPersona.of(leader) });
    const joint = await jointPartyGoals(party, members, timestamp, options);
    if (!joint) { options.onDeferred?.(); return null; }
    party.stats = { ...party.stats, ...joint,
        agreement: PartyAgreement.propose(leader, members, objective,
            { persona: BotPersona.of(leader), rng: invoke('GameServer/Bot/AI/TendencyRoll').seeded(`agreement:${partyId}`) }) };
    const partyEvent = {
        characterId: leader.characterId,
        eventType: 'party',
        summary: PartyAgreement.formationText(leader.name, party.spotId, party.stats.objective, party.stats.agreement),
        meta: {
            partyId,
            spotId: party.spotId,
            memberIds: party.memberIds
        },
        weight: 2,
        createdAt: timestamp
    };

    // The formation event commits in the same transaction as the party.
    return commitPartyMembership(party, members, partyEvent).then(({ party: savedParty, assigned, failed }) => {
        if (!savedParty || failed.length || assigned.length !== members.length) {
            options.onCommitRefused?.();
            return savedParty
                ? dissolveBackgroundParty(savedParty, 'party_assignment_failed', assigned.length).then(() => null)
                : null;
        }
        Config.developerDiagnostics && Metrics.recordPartyFormation();
        Config.developerDiagnostics && console.info(
            'BotPopulation :: formed background party %s spot=%s members=%d leader=%s',
            savedParty.partyId,
            savedParty.spotId || 'none',
            savedParty.memberIds.length,
            leader.name
        );
        return savedParty;
    });
}

// The members a party keeps after a departure, the owner's newest copies
// (syncPartyLeader writes a member whole). One who left meanwhile is not
// written back in.
function retainedMembers(party, departedId) {
    return (party.memberIds || []).filter(id => Number(id) !== Number(departedId))
        .map(id => LifeState.cachedState(id))
        .filter(member => member && DecisionSections.partyIdOf(member) === String(party.partyId));
}

// The party row with the members it keeps: the one roster of every path that
// drops a member or repairs the list. Each path keeps its own save: a clan
// release or a repair commits row and members in one transaction; the others
// write the members first.
function partyWithRoster(party, retained, stats = {}) {
    return { ...party, leaderId: leaderIdForMembers(party, retained),
        memberIds: retained.map(member => Number(member.characterId)),
        roleCoverage: PartyComposition.roleCoverage(retained),
        stats: { ...party.stats, ...stats } };
}

function syncPartyLeader(members = [], party, leaderId) {
    const nextLeaderId = Number(leaderId || 0);
    const staleMembers = (members || []).filter((member) => (
        Number(member.party?.leaderId || 0) !== nextLeaderId
    ));
    if (!staleMembers.length) return Promise.resolve({ assigned: [], failed: [] });
    return assignPartyMembers(staleMembers, { ...party, leaderId: nextLeaderId });
}

function distance2d(a, b) {
    const dx = Number(a?.fetchLocX?.() || 0) - Number(b?.fetchLocX?.() || 0);
    const dy = Number(a?.fetchLocY?.() || 0) - Number(b?.fetchLocY?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

const PopulationService = {
    groupBySpot,
    initialized: false,
    started: false,
    lifeReadyPromise: null,
    lifecycleSafetyGeneration: 0,
    lifecycleSafetySweep: null,
    lifecycleSafetyStartPromise: null,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    backgroundJobRegistry: null,
    partyAssemblyEvents: null,
    // Party ids whose re-plan of member needs runs at the leader's next step:
    // marked on a membership or objective change (startPartyAssemblyEvents),
    // cleared by the apply of the finished re-plan.
    partyRequirementRefreshDue: new Set(),
    phasePolicyTimer: null,
    seedTimer: null,
    classProgressionMigrationTimer: null,
    nextStateRetentionAt: 0,
    stateRetentionPassRows: 0,
    walResetUnsubscribe: null,
    walResetRunning: false,
    walResetEstimateRetryAt: 0,
    // The last completed truncate's hold on main's DB queue (ms, 0 = none yet).
    walTruncateEstimateMs: 0,
    nextWalResetAt: 0,
    personaBackfillTimer: null,
    personaBackfillRunning: false,
    resolving: false,
    classProgressionMigrationRunning: false,
    stateRetentionRunning: false,
    partyFormationRunning: false,
    partyFormationPending: false,
    phasePolicyRunning: false,
    clanActionRunning: false,
    clanFounderRunning: false,
    nextClanActionAt: 0,
    nextClanFounderAt: 0,

    init() {
        if (Config.enabled === false) return;
        if (this.initialized) return this.lifeReadyPromise;

        Metrics.init();
        Metrics.startEventLoopMonitor();
        invoke('GameServer/Bot/Economy/CraftWorkshopService').init();
        this.lifeReadyPromise = Promise.resolve(LifeState.init()).then(async result => {
            await invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').init();
            await invoke('GameServer/Clan/ClanGoalService').clanProjection();
            return result;
        });
        Promise.resolve(this.lifeReadyPromise).then(() => ClanActionService.startEvents(() => { this.nextClanActionAt = 0; }))
            .catch(error => utils.infoWarn('ClanReview', 'startup: %s', error.message));
        LifeEvents.init();
        BackgroundPartyState.init();
        this.initialized = true;
        utils.infoSuccess('BotPopulation', 'population service initialized');
        return this.lifeReadyPromise;
    },

    start() {
        if (this.started || Config.enabled === false) return;
        if (!this.initialized) this.init();

        this.started = true;
        Promise.resolve(this.lifeReadyPromise).then(() => ClanActionService.startEvents(() => { this.nextClanActionAt = 0; }))
            .catch(error => utils.infoWarn('ClanReview', 'startup: %s', error.message));
        // The summary timers run without diagnostics too: the overdue line
        // (logSummary) is the signal that a bot stopped stepping.
        this.initialSummaryTimer = setTimeout(() => {
            this.logSummary('start');
            this.initialSummaryTimer = null;
        }, 5000);

        if (typeof this.initialSummaryTimer?.unref === 'function') {
            this.initialSummaryTimer.unref();
        }

        this.summaryTimer = setInterval(() => {
            this.logSummary('summary');
        }, Config.summaryIntervalMs);

        if (typeof this.summaryTimer?.unref === 'function') {
            this.summaryTimer.unref();
        }

        if (Config.backgroundResolverEnabled !== false) {
            // Cold simulation is owned by ColdSimulationCoordinator and runs
            // in its worker. This timer publishes the player-activity and lag
            // signal that the worker pressure and work admissions read.
            this.refreshSchedulerTelemetry();
            this.schedulerTimer = setInterval(() => {
                this.refreshSchedulerTelemetry();
            }, Config.schedulerIntervalMs);

            if (typeof this.schedulerTimer.unref === 'function') {
                this.schedulerTimer.unref();
            }
        }

        if (Config.backgroundResolverEnabled !== false) ColdSimulationCoordinator.start(this);

        this.startBackgroundJobRegistry();
        this.startLifecycleSafetySweep();
        this.startPartyAssemblyEvents();
        Promise.resolve(this.lifeReadyPromise).then(() => this.startOpportunisticRaids())
            .catch(error => utils.infoWarn('BotRaid', 'startup failed: %s', error.message));
        Promise.resolve(this.lifeReadyPromise).then(() => this.startClanWars())
            .catch(error => utils.infoWarn('ClanWar', 'startup failed: %s', error.message));

        Promise.resolve(this.lifeReadyPromise).then(() => {
            if (!this.started) return;
            this.classProgressionMigrationUnsubscribe?.();
            this.classProgressionMigrationUnsubscribe = LifeState.subscribeClassProgressionMigration(
                () => this.ensureClassProgressionMigrationTimer());
            this.ensureClassProgressionMigrationTimer();
        });

        if (Config.stateRetentionEnabled !== false) {
            this.nextStateRetentionAt = Date.now() + Math.max(1000, Number(Config.stateRetentionStartDelayMs) || 90000);
            this.armBackgroundAlarm(STATE_RETENTION_KEY, 'state_retention',
                Math.max(250, Number(Config.stateRetentionIntervalMs) || 1000),
                () => this.nextStateRetentionAt, timestamp => this.runStateRetention(timestamp));
        }

        this.armWalReset();

        if (Config.phasePolicyEnabled !== false) {
            this.phasePolicyTimer = setInterval(() => {
                this.tickPhasePolicy();
            }, Config.phasePolicyIntervalMs);

            if (typeof this.phasePolicyTimer.unref === 'function') {
                this.phasePolicyTimer.unref();
            }
        }

        this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
        this.schedulePersonaBackfill();

    },

    stop() {
        this.opportunisticRaids?.stop();
        this.clanWars?.stop();
        this.clanWars = null;
        this.opportunisticRaids = null;
        ClanActionService.stopEvents();
        this.stopPartyAssemblyEvents();
        this.stopLifecycleSafetySweep();
        invoke('GameServer/Bot/AI/BotTownTravel').stopSupplyReturns();
        const coldStop = ColdSimulationCoordinator.stop();
        if (this.initialSummaryTimer) {
            clearTimeout(this.initialSummaryTimer);
            this.initialSummaryTimer = null;
        }
        if (this.summaryTimer) {
            clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        if (this.backgroundJobRegistry) {
            this.backgroundJobRegistry.stop();
            this.backgroundJobRegistry = null;
        }
        this.clanActionRunning = false;
        this.clanFounderRunning = false;
        this.nextClanActionAt = 0;
        this.nextClanFounderAt = 0;
        this.stateRetentionRunning = false;
        this.stateRetentionPassRows = 0;
        this.nextStateRetentionAt = 0;
        this.walResetUnsubscribe?.();
        this.walResetUnsubscribe = null;
        this.walResetRunning = false;
        this.nextWalResetAt = 0;
        this.walResetEstimateRetryAt = 0;
        this.walTruncateEstimateMs = 0;
        PersistentStateRetention.reset();
        if (this.phasePolicyTimer) {
            clearInterval(this.phasePolicyTimer);
            this.phasePolicyTimer = null;
        }
        if (this.seedTimer) {
            clearTimeout(this.seedTimer);
            this.seedTimer = null;
        }
        this.classProgressionMigrationUnsubscribe?.();
        this.classProgressionMigrationUnsubscribe = null;
        if (this.classProgressionMigrationTimer) {
            clearInterval(this.classProgressionMigrationTimer);
            this.classProgressionMigrationTimer = null;
        }
        if (this.personaBackfillTimer) {
            clearInterval(this.personaBackfillTimer);
            this.personaBackfillTimer = null;
        }
        this.personaBackfillRunning = false;
        Metrics.stopEventLoopMonitor();
        this.started = false;
        return coldStop;
    },

    scheduleGeneratedColdSeed(delayMs = Config.generatedColdSeedDelayMs) {
        if (Config.enabled === false || Config.maxPlayingPopulation <= 0 || this.seedTimer) return;

        this.seedTimer = setTimeout(() => {
            this.seedTimer = null;
            GeneratedColdSeeder.seedPopulation().then((result) => {
                if (result.seeded > 0) {
                    Config.developerDiagnostics && console.info(
                        'BotPopulation :: population wave=%d seeded=%d created=%d total=%d/%d target=%d avgLevel=%s starterSpots=%d',
                        result.wave || 1,
                        result.seeded,
                        result.created,
                        result.total,
                        result.limit,
                        result.targetPopulation || result.limit,
                        Number(result.averageLevel || 0).toFixed(1),
                        result.eligible || 0
                    );
                }

                // Keep checking the next wave: once the mean bot level crosses
                // another five-level threshold, newly opened grounds are filled.
                if (this.started && result.limit > 0 && result.total < result.limit && !result.error) {
                    this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
                }
            });
        }, Math.max(1000, Number(delayMs || 0)));

        if (typeof this.seedTimer.unref === 'function') {
            this.seedTimer.unref();
        }
    },

    schedulePersonaBackfill() {
        if (this.personaBackfillTimer) return;

        const run = () => {
            if (this.personaBackfillRunning) return;
            if (this.playerActivityProfile().protected) {
                Config.developerDiagnostics && Metrics.recordBackgroundDeferral();
                return;
            }
            this.personaBackfillRunning = true;
            BotPersona.backfillGenerated().then((result) => {
                // Only a successful short read closes this one-time migration.
                // A failed write stays scheduled for a later retry.
                if (result.exhausted && this.personaBackfillTimer) {
                    clearInterval(this.personaBackfillTimer);
                    this.personaBackfillTimer = null;
                }
            }).finally(() => {
                this.personaBackfillRunning = false;
            });
        };

        run();
        this.personaBackfillTimer = setInterval(run, 2000);
        if (typeof this.personaBackfillTimer.unref === 'function') {
            this.personaBackfillTimer.unref();
        }
    },

    ensureClassProgressionMigrationTimer() {
        if (!this.started || !LifeState.pendingClassProgressionMigration()) {
            if (this.classProgressionMigrationTimer) clearInterval(this.classProgressionMigrationTimer);
            this.classProgressionMigrationTimer = null;
            return;
        }
        if (this.classProgressionMigrationTimer) return;
        this.classProgressionMigrationTimer = setInterval(() => this.migrateLegacyClassProgression(),
            Config.classProgressionMigrationIntervalMs);
        this.classProgressionMigrationTimer.unref?.();
    },

    migrateLegacyClassProgression() {
        // Database uses one ordered connection. Never queue a migration behind
        // an active resolver: a skipped migration tick is harmless, but a
        // queued one can stretch the normal world loop into a long backlog.
        if (this.playerActivityProfile().protected) {
            Config.developerDiagnostics && Metrics.recordBackgroundDeferral();
            return Promise.resolve([]);
        }
        if (this.classProgressionMigrationRunning || this.resolving || Config.enabled === false) return Promise.resolve([]);
        this.classProgressionMigrationRunning = true;
        return LifeState.migrateLegacyClassProgression(Config.classProgressionMigrationBatchSize)
            .then((migrated) => {
                if (migrated.length) {
                    Config.developerDiagnostics && console.info('BotPopulation :: migrated class progression for %d cold bot(s)', migrated.length);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy class progression migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.classProgressionMigrationRunning = false;
                this.ensureClassProgressionMigrationTimer();
            });
    },

    recordHotTick(session) {
        if (Config.enabled === false) return;
        if (!session || !session.accountId || !String(session.accountId).startsWith('bot_')) return;
        Config.developerDiagnostics && Metrics.recordHotTick();
    },

    markHot(session, reason = 'hot') {
        if (Config.enabled === false) return Promise.resolve(null);
        return LifeState.markHot(session, reason);
    },

    cooldownSession(session, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return Cooldown.cooldown(session, reason, options);
    },

    requestActivation(stateOrName, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return HotActivation.activate(stateOrName, reason, options);
    },

    tickPhasePolicy() {
        if (this.phasePolicyRunning || Config.enabled === false || Config.phasePolicyEnabled === false) {
            return Promise.resolve({ cooled: [], activated: [] });
        }

        this.phasePolicyRunning = true;
        return this.activateNearPlayers()
            .then((activated) => {
                // After this scan's activations: a held cold row no player sees any more steps again.
                ColdSimulationCoordinator.releaseNearHolds();
                return this.cooldownEligibleHot().then((cooled) => ({ activated, cooled }));
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'phase policy failed: %s', err.message);
                return { activated: [], cooled: [] };
            })
            .finally(() => {
                this.phasePolicyRunning = false;
            });
    },

    realPlayerSessions() {
        const World = invoke('GameServer/World/World');
        return ActorQueries.humans(World, PlayerActivitySignal.isRealPlayerSession);
    },

    realPlayerSessionsNear(loc, radius) {
        return invoke('GameServer/World/World').realPlayerSessionsNear(loc, radius);
    },

    playerActivityProfile(timestamp = Date.now()) {
        let sessions = [];
        let realPlayers = [];
        try {
            sessions = invoke('GameServer/World/World').user?.sessions || [];
            realPlayers = this.realPlayerSessions();
        } catch (err) {
            sessions = [];
            realPlayers = [];
        }
        return PlayerActivitySignal.observe({
            sessions,
            realPlayers,
            now: timestamp,
            graceMs: Config.playerProtectionGraceMs
        });
    },

    refreshSchedulerTelemetry() {
        if (Config.enabled === false || Config.backgroundResolverEnabled === false) return null;
        const activity = this.playerActivityProfile();
        const profile = { idle: !activity.protected, activity, lagMs: Math.max(0, Number(Metrics.currentEventLoopLag()) || 0) };
        Metrics.recordSchedulerProfile(profile);
        return profile;
    },

    startBackgroundJobRegistry() {
        if (this.backgroundJobRegistry) return this.backgroundJobRegistry;
        const registry = BackgroundJobRegistry.create({
            tickMs: Math.max(50, Number(Config.backgroundJobTickMs) || 250),
            onError: (job, error) => {
                utils.infoWarn('BotPopulation', 'background job %s failed: %s', job, error?.message || error);
            }
        });

        registry.register({ name: 'opportunistic_raids', intervalMs: 11000, offsetMs: 45000,
            run: () => this.opportunisticRaids?.pulse() });
        registry.register({ name: 'opportunistic_raid_combat', intervalMs: 4000, offsetMs: 45000,
            run: () => this.opportunisticRaids?.maintain() });
        registry.register({ name: 'clan_wars', intervalMs: 5000, offsetMs: 60000,
            run: () => this.clanWars?.pulse() });

        if (ClanSimulationConfig.enabled !== false) {
            const clanIntervalMs = Math.max(1000, Number(ClanSimulationConfig.resolveIntervalMs) || 60000);
            const clanContinuationMs = Math.max(
                Math.max(50, Number(Config.backgroundJobTickMs) || 250),
                Math.max(100, Number(Config.backgroundGovernorWindowMs) || 1000)
            );
            registry.register({
                name: 'clan_actions',
                intervalMs: clanContinuationMs,
                offsetMs: 0,
                run: () => this.nextClanActionAt > Date.now()
                    ? { skipped: true, reason: 'not_due' }
                    : this.resolveClanActions()
            });
            registry.register({
                name: 'clan_founders',
                intervalMs: Math.max(50, Number(Config.backgroundJobTickMs) || 250),
                offsetMs: Math.max(250, Math.floor(clanIntervalMs / 2)),
                run: () => this.nextClanFounderAt > Date.now()
                    ? { skipped: true, reason: 'not_due' }
                    : this.resolveClanFounders()
            });
        }


        this.backgroundJobRegistry = registry;
        registry.start();
        return registry;
    },

    async startClanWars() {
        if (!this.started || this.clanWars || !require('../../Clan/ClanWarConfig').enabled
            || ClanSimulationConfig.enabled === false) return;
        const service = new (require('../../Clan/ClanWarDirector').ClanWarDirector)({
            database: Database, life: LifeState, parties: BackgroundPartyState,
            clans: invoke('GameServer/Clan/ClanService'), war: invoke('GameServer/Clan/ClanWarRuntime'),
            social: invoke('GameServer/Clan/ClanSocialRuntime').view, memory: invoke('GameServer/Social/InteractionMemoryRuntime'),
            personaFor: state => BotPersona.of(state), form: (members, operation) => this.formClanWarParty(members, operation),
            updateDemand: ids => partyAdmission.syncWarRequests(Config.backgroundPartyEnabled && this.started ? ids : []),
            formationStatus: () => this.lastClanWarFormation,
            actions: ColdSimulationCoordinator.competitionActions,
            canContinue: () => this.started && ClanSimulationConfig.enabled !== false,
            canWork: () => this.started && ClanSimulationConfig.enabled !== false && !this.resolving && !this.partyFormationRunning
                && Number(Database.pending()) < 4 && Number(Metrics.currentEventLoopLag()) < 40
                && ColdSimulationCoordinator.competitionActions.canRun()
        });
        this.clanWars = service;
        await service.start();
        if (!this.started || this.clanWars !== service) service.stop();
    },

    async startOpportunisticRaids() {
        if (!this.started || this.opportunisticRaids || Config.opportunisticRaidsEnabled === false
            || Config.backgroundPartyEnabled === false) return;
        const Policy = require('./OpportunisticRaidPolicy');
        const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
        const World = invoke('GameServer/World/World');
        const Index = invoke('GameServer/World/RaidEntityIndex');
        const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
        const bossFor = id => Index.bossByTemplateId(World, id);
        const bossFree = (spot, exceptPartyId = null, excludedIds = []) => {
            const boss = bossFor(spot.raidBossTemplateId);
            return !!boss && !boss.isDead() && boss.fetchHp() === boss.fetchMaxHp()
                && !boss.fetchDestId?.() && ['active', 'hot'].every(status =>
                    !BackgroundPartyState.raidCompetitors(spot.raidBossTemplateId, status, exceptPartyId, 'opportunity').length)
                && !invoke('GameServer/RaidBoss/RaidEncounterScope').otherParticipants(World, boss, excludedIds);
        };
        const assess = async (members, spot, timestamp = Date.now(), { fundSupplies = false } = {}) => {
            const party = { partyId: 'raid_assessment', leaderId: members[0].characterId,
                memberIds: members.map(s => s.characterId), spotId: spot.id,
                stats: { objective: { sourceKind: 'raid', opportunisticRaid: true, spotId: spot.id,
                    maxFightSeconds: Config.opportunisticRaidMaxFightSeconds,
                    shotReserve: Config.opportunisticRaidShotReserve,
                    fundRaidSupplies: fundSupplies } } };
            const result = await ColdSimulationCoordinator.requestPartyGoals(party, members, { timestamp });
            return result.ok && result.joint?.raidAssessment
                || { ready: false, reason: result.reason || 'raid_assessment_unavailable' };
        };
        const service = new (require('./OpportunisticRaidDirector').OpportunisticRaidDirector)({
            config: Config, life: LifeState, database: Database, parties: BackgroundPartyState, memory: Memory,
            catalog: Catalog, assembly: require('./PartyHuntingAssembly'), bossFor, bossFree, assess,
            // boss_spawned: a raid boss entered the index (its spawn), looked up alive at the next pulse.
            onBossChanged: listener => Index.onBossChanged(listener),
            bossAlive: id => !!bossFor(id) && !bossFor(id).isDead?.(),
            raidEntities: boss => Index.entitiesForRaid(World,
                { bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId() }),
            hot: invoke('GameServer/Bot/Population/HotPartyLifecycle'),
            sessions: () => invoke('GameServer/Bot/BotManager').sessions,
            ai: invoke('GameServer/Bot/BotAI'), lod: invoke('GameServer/Bot/AI/HotActorLodPolicy'),
            canFinish: sessions => sessions.every(s => Cooldown.canCooldown(s, { ignoreVisibility: true }).ok
                && !invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(s)),
            defeated: id => invoke('GameServer/World/RaidBossState').get(id),
            // Presence subscribers open ordinary formation on the same clock
            // tick. Discovery is read-only worker advice, so only the actual
            // membership commit below shares that formation fence.
            canWork: () => this.started && !this.resolving
                && Number(Database.pending()) < 4
                && Number(Metrics.currentEventLoopLag()) < 40,
            dissolve: async (party, reason) => {
                const current = BackgroundPartyState.find(party.partyId);
                if (!current || current.status !== 'active') return;
                await dissolveBackgroundParty(current, reason, current.memberIds.length);
                await LifeState.releaseDissolvedPartyMembers(current.partyId, reason);
            },
            form: async (members, objective) => {
                if (!this.started || this.partyFormationRunning || !bossFree(Catalog.findById(objective.spotId))) return null;
                const current = await LifeState.statesByIds(members.map(s => s.characterId));
                if (current.length !== 9 || current.some(s => !Policy.available(s, Date.now(), objective.preparationId))
                    || !current.every(s => Policy.recruitLevelAllowed(s, objective.sourceLevel))
                    || !Policy.composition(current).ready) return null;
                const checked = await assess(current, Catalog.findById(objective.spotId));
                if (!checked.ready || !current.every((s, i) => current.slice(i + 1).every(peer =>
                    Policy.compatible(s, peer, Memory.assess.bind(Memory))))) return null;
                if (!this.started || this.partyFormationRunning || this.resolving) return null;
                this.partyFormationRunning = true;
                try { return await createAndCommitBackgroundParty(current, { ...objective, assessment: checked }); }
                finally { this.formationEnded(); }
            }
        });
        service.preparations = new (require('./RaidSupplyPreparation').RaidSupplyPreparation)({
            life: LifeState, coordinator: ColdSimulationCoordinator, memory: Memory,
            market: ColdMarketService, catalog: Catalog, assess, bossFree, form: service.form,
            onReleased: ids => service.remember(ids, Date.now())
        });
        this.opportunisticRaids = service;
        await BackgroundPartyState.init();
        await service.start();
    },

    // One deadline on the shared background heap instead of a fixed interval.
    // The next run is the job's known next...At (its start delay, the pause
    // after a pass) or one interval later: inside a pass, and after a deferral
    // (player protected, event-loop lag, a busy write queue), which has no event
    // to wait for. registry.stop() (population stop) drops the deadline and
    // ends the chain.
    armBackgroundAlarm(key, name, intervalMs, nextAt, run) {
        const registry = this.backgroundJobRegistry;
        if (!registry) return;
        const now = Date.now(), known = Number(nextAt()) || 0;
        registry.armDeadline(key, Math.ceil(Math.max(now + intervalMs, known)), timestamp => {
            Promise.resolve().then(() => run(timestamp)).then(result => {
                Config.developerDiagnostics && Diagnostics.count('background_alarm', result == null ? 'empty' : 'ran', name);
            }, error => {
                utils.infoWarn('BotPopulation', 'background %s failed: %s', name, error?.message || error);
            }).finally(() => {
                if (this.backgroundJobRegistry === registry) this.armBackgroundAlarm(key, name, intervalMs, nextAt, run);
            });
        });
        Config.developerDiagnostics && Diagnostics.count('background_alarm', 'armed', `${name}:${known > now + intervalMs ? 'known' : 'interval'}`);
    },

    startPartyAssemblyEvents() {
        if (this.partyAssemblyEvents || Config.backgroundPartyEnabled === false || !this.backgroundJobRegistry) return;
        const { PartyAssemblyEvents } = invoke('GameServer/Bot/Population/PartyAssemblyEvents');
        const Help = invoke('GameServer/Bot/Population/ClanPartyHelp');
        const service = new PartyAssemblyEvents({
            registry: this.backgroundJobRegistry, life: LifeState, parties: BackgroundPartyState,
            classify: state => this.partyAssemblyInput(state),
            run: (candidates, timestamp, help, moved) => this.runPartyAssemblyEvent(candidates, timestamp, help, moved),
            onRepair: () => Config.developerDiagnostics && Metrics.recordPartySafetyRepair(),
            onError: error => utils.infoWarn('BotPopulation', 'party event failed: %s', error?.message || error)
        });
        this.partyAssemblyEvents = service;
        BackgroundPartyState.useRequirementDue(id => this.partyRequirementRefreshDue.has(id));
        // Subscribed once the saved parties are loaded: a row read at start-up is
        // no member event, so a restart opens no re-plan of its own. A due mark
        // held before the restart is lost: a static party re-plans at its next
        // member, objective or kit event.
        Promise.resolve(BackgroundPartyState.init()).then(() => {
            if (this.partyAssemblyEvents !== service) return;
            service.unsubscribeRequirements = BackgroundPartyState.subscribeChanges(
                (party, previous) => this.markPartyRequirementsDue(party, previous));
        });
        service.start();
        service.unsubscribeHelp = Help.subscribePending(() => service.wakeHelp());
        // A clan plea is tried again only when a clan member (its row or its help
        // party) turns free or its requester's readiness moves (ClanPartyHelp.observe;
        // nothing pending: a size check).
        const helpMoves = LifeState.subscribePublications(packet => {
            if (packet.kind !== 'reset') Help.observe(packet.characterId, packet.state);
        });
        const helpParties = BackgroundPartyState.subscribeChanges(party => Help.observeParty(party));
        const unsubscribeHelp = service.unsubscribeHelp;
        service.unsubscribeHelp = () => { unsubscribeHelp(); helpMoves(); helpParties(); };
        if (Help.hasDue()) service.wakeHelp();
    },

    stopPartyAssemblyEvents() {
        const service = this.partyAssemblyEvents;
        this.partyAssemblyEvents = null;
        service?.unsubscribeHelp?.(); service?.unsubscribeRequirements?.(); service?.stop();
        const due = [...this.partyRequirementRefreshDue];
        this.partyRequirementRefreshDue.clear();
        for (const id of due) BackgroundPartyState.publish(id);
    },

    // The apply of a finished re-plan clears the mark; the party row carries
    // it to the worker (BackgroundPartyState 'parties'), so it is re-published.
    clearPartyRequirementDue(partyId) {
        if (this.partyRequirementRefreshDue.delete(String(partyId))) BackgroundPartyState.publish(partyId);
    },

    // A member's plan write a concurrent write beat: the party row carries the
    // mark to the worker, whose leader step re-plans (run.requirementRefresh).
    markPartyRequirementReplan(partyId) {
        this.partyRequirementRefreshDue.add(String(partyId));
        BackgroundPartyState.publish(partyId);
    },

    // Trigger 1 of the party re-plan (the second is a member's kit, at the
    // party's step in the background thread): a published party row whose
    // members or objective moved against the previous row. A pending join
    // marks nothing: the leader's step reads it from the party row itself
    // (ColdSimulationKernel), and the join it answers moves the members. The
    // re-plan's own objective (the leader's row) and plan writes mark here too;
    // its apply clears the mark after its last write (applyWorkerPartyRequirements),
    // so they open nothing.
    markPartyRequirementsDue(party, previous) {
        const id = String(party.partyId);
        if (party.status !== 'active') {
            this.partyRequirementRefreshDue.delete(id);
            return;
        }
        if (BackgroundPartyLifecycle.raidStarted(party)) return;
        if (!previous
            || (party.memberIds || []).join(',') !== (previous.memberIds || []).join(',')
            || partyObjectiveGroupingKey(party.stats?.objective) !== partyObjectiveGroupingKey(previous.stats?.objective))
            this.partyRequirementRefreshDue.add(id);
    },

    partyAssemblyInput(state) {
        if (state?.phase !== 'cold' || state.party?.partyId || state.partyId
            || !['hunting', 'resting', 'party_wait'].includes(state.activity)) return null;
        const objective = partyObjectiveForState(state);
        const spotId = partyObjectiveSpotForState(state, objective);
        if (!spotId || state.stats?.equipmentPlan?.strategy === 'market'
            || invoke('GameServer/Bot/AI/BotServiceIdentity').isStaticService(state)) return null;
        const request = state.stats?.partyRequest;
        // A bot looking for a party says so (a C4 player's LFP): an open party request or
        // its clan's open call. Only its moves wake its group; a bot merely willing to
        // party is roster fill, judged with a seeker, never at its own moves.
        const seeks = objective?.status === 'open'
            && (request?.status === 'open' || state.stats?.clanPartyObjective?.status === 'open');
        // What wakes the group (a refused roster is judged again only then): its
        // request opened or closed, the objective it seeks, its clan, its gear plan's
        // source, its level and class (the roster's level range and roles) and its held
        // solo answer (re-decided at its grade, gear, death, party_left: the solo side of
        // the verdict). HP, loot and coordinates refresh the reference only.
        const supportRole = PartyComposition.supportRole(state, objective);
        return { key: `spot:${spotId}`, seeks,
            supportKey: supportRole ? `${state.level}:${supportRole}` : null,
            meetingKey: seeks ? PartyRequestPlanner.meetingKey(objective, state.level, SpotProfiles.ensure()) : null,
            stamp: [state.clanId ?? state.stats?.clanId ?? null, objective?.spotId ?? null, request?.status ?? null,
                request?.priority ?? null, state.stats?.equipmentPlan?.strategy ?? null,
                state.stats?.equipmentPlan?.target?.selfId ?? null, state.stats?.earning?.at ?? null,
                Number(state.level) || 0, state.classId ?? state.stats?.classId ?? null] };
    },

    // moved: the ids whose move woke the group (null: every roster is judged).
    async runPartyAssemblyEvent(candidates, timestamp, help, moved = null) {
        if (!this.started || Config.backgroundPartyEnabled === false) return {};
        if (help) {
            const Help = invoke('GameServer/Bot/Population/ClanPartyHelp');
            const tried = await this.helpClanParty(timestamp);
            // A busy main (lag, DB, cold queue, a formation running) tried nothing: that
            // has no event, so PartyAssemblyEvents retries it (retryMs). A try holds until
            // the plea is due again; another due plea runs next.
            if (tried === BUSY_HELP) return { deferred: Help.hasDue() };
            if (Help.hasDue()) this.partyAssemblyEvents?.wakeHelp();
            return {};
        }
        // Busy: the group runs again when the running formation ends (wakeParked).
        if (this.partyFormationRunning || this.resolving) return { busy: true };
        // A member whose request is closed (PartyRequestPlanner.closed) waits for its
        // next build, whose request moves its record and wakes its group; it asks no
        // retry, nor does a state replaced since the page was read (its newer
        // publication refreshes its record, a waking move wakes the group).
        const eligible = candidates.filter(state => LifeState.cachedState(state.characterId) === state
            && !PartyRequestPlanner.closed(state));
        if (!eligible.length) return {};
        // One forming path whether a player is online or not: a player online narrows its
        // budget (partyFormationBudgetMs) and its batch to one party a pass, and the pass
        // waits out main's writes (membershipWritesWait).
        const result = await this.formBackgroundParties(eligible, { moved });
        // Retried (PartyAssemblyEvents.retryMs) only what no event ends: main's lag, DB
        // queue or formation budget (partyFormationPending), a material group that formed
        // nothing (the next page offers other supports). A refused roster is not: its
        // requests are closed until their next build.
        return { deferred: this.partyFormationPending
                || !result.length && eligible.some(state => CraftMaterialParty.isObjective(state.stats?.partyRequest)),
            continuation: result.length > 0 };
    },

    startLifecycleSafetySweep() {
        if (Config.enabled === false || !this.started || !this.backgroundJobRegistry?.started) return Promise.resolve(false);
        if (this.lifecycleSafetyStartPromise) return this.lifecycleSafetyStartPromise;
        if (this.lifecycleSafetySweep?.running) return Promise.resolve(false);
        const generation = ++this.lifecycleSafetyGeneration;
        const registry = this.backgroundJobRegistry;
        const current = () => this.started && Config.enabled !== false && this.lifecycleSafetyGeneration === generation
            && this.backgroundJobRegistry === registry && registry.started;
        const pending = Promise.resolve(this.lifeReadyPromise).then(ready => {
            if (ready !== true || !current()) return false;
            if (!this.lifecycleSafetySweep) this.lifecycleSafetySweep = invoke('GameServer/Bot/Population/LifecycleSafetyRuntime')
                .createLifecycleSafetyRuntime(this, ColdSimulationCoordinator);
            return this.lifecycleSafetySweep.start(registry);
        }).catch(error => {
            ColdSimulationCoordinator.recordError(error);
            return false;
        }).finally(() => {
            if (this.lifecycleSafetyStartPromise === pending) this.lifecycleSafetyStartPromise = null;
        });
        this.lifecycleSafetyStartPromise = pending;
        return pending;
    },

    stopLifecycleSafetySweep() {
        this.lifecycleSafetyGeneration++;
        this.lifecycleSafetySweep?.stop();
        this.lifecycleSafetyStartPromise = null;
    },

    scheduleClanActions(continuation = false) {
        const normalMs = Math.max(1000, Number(ClanSimulationConfig.resolveIntervalMs) || 60000);
        const continuationMs = Math.max(
            Math.max(50, Number(Config.backgroundJobTickMs) || 250),
            Math.max(100, Number(Config.backgroundGovernorWindowMs) || 1000)
        );
        this.nextClanActionAt = Date.now() + (continuation ? continuationMs : normalMs);
        return this.nextClanActionAt;
    },

    resolveClanActions(activity = this.playerActivityProfile()) {
        if (ClanSimulationConfig.enabled === false) return Promise.resolve({ skipped: true, reason: 'disabled' });
        if (this.clanActionRunning) return Promise.resolve({ skipped: true, reason: 'already_running' });
        const idleBudget = Math.max(10, Number(ClanSimulationConfig.resolveBudgetMs) || 80);
        const playerBudget = Math.max(1, Math.min(idleBudget, Number(ClanSimulationConfig.actionPlayerBudgetMs) || 20));
        const requestedBudgetMs = activity?.protected ? playerBudget : idleBudget;
        const admission = BackgroundWorkGovernor.admit({
            job: 'clan_actions',
            resource: 'sqlite-heavy',
            requestedBudgetMs,
            minimumBudgetMs: Math.min(10, requestedBudgetMs),
            playerProtected: !!activity?.protected,
            realPlayers: activity?.realPlayers
        });
        if (!admission.ok) {
            this.scheduleClanActions(true);
            Config.developerDiagnostics && Metrics.recordBackgroundDeferral();
            return Promise.resolve({ skipped: true, reason: `governor_${admission.reason}` });
        }

        this.clanActionRunning = true;
        const startedAt = Date.now();
        let needsContinuation = true;
        return Promise.resolve().then(() => ClanActionService.resolveBatch({
            limit: ClanSimulationConfig.actionBatchSize,
            budgetMs: admission.budgetMs
        })).then((result) => {
            needsContinuation = !!result?.budgetStopped || Number(result?.queue?.ready || 0) > 0;
            return result;
        }).catch((error) => {
            utils.infoWarn('ClanSimulation', 'action resolve failed: %s', error.message);
            return { attempted: 0, claimed: 0, resolved: 0, released: 0, succeeded: 0, failed: 0, leftRunning: 0, error: error.message };
        }).finally(() => {
            BackgroundWorkGovernor.complete(admission.lease, { durationMs: Date.now() - startedAt });
            this.scheduleClanActions(needsContinuation || ClanActionService.hasEvents());
            if (ClanActionService.hasEvents()) this.nextClanActionAt = 0;
            this.clanActionRunning = false;
        });
    },

    resolveClanFounders(activity = this.playerActivityProfile()) {
        if (ClanSimulationConfig.enabled === false) return Promise.resolve({ skipped: true, reason: 'disabled' });
        if (this.clanFounderRunning) return Promise.resolve({ skipped: true, reason: 'already_running' });
        const idleBudget = Math.max(1, Number(ClanSimulationConfig.founderResolveBudgetMs) || 20);
        const playerBudget = Math.max(1, Math.min(idleBudget, Number(ClanSimulationConfig.founderPlayerBudgetMs) || 5));
        const requestedBudgetMs = activity?.protected ? playerBudget : idleBudget;
        const admission = BackgroundWorkGovernor.admit({
            job: 'clan_founders',
            resource: 'sqlite-heavy',
            requestedBudgetMs,
            minimumBudgetMs: Math.min(5, requestedBudgetMs),
            playerProtected: !!activity?.protected,
            realPlayers: activity?.realPlayers
        });
        if (!admission.ok) {
            Config.developerDiagnostics && Metrics.recordBackgroundDeferral();
            return Promise.resolve({ skipped: true, reason: `governor_${admission.reason}` });
        }

        this.clanFounderRunning = true;
        // A governor deferral leaves the pass due, so the registry retries
        // after the competing action releases SQLite instead of colliding
        // with that action again at the next full-minute boundary.
        this.nextClanFounderAt = Date.now() + Math.max(1000, Number(ClanSimulationConfig.resolveIntervalMs) || 60000);
        const startedAt = Date.now();
        return Promise.resolve().then(() => ClanSimulationService.resolveBatch(ClanSimulationConfig.resolveBatchSize, {
            budgetMs: admission.budgetMs
        })).catch((error) => {
            utils.infoWarn('ClanSimulation', 'founder resolve failed: %s', error.message);
            return { attempted: 0, created: 0, joined: 0, blocked: 0, error: error.message };
        }).finally(() => {
            BackgroundWorkGovernor.complete(admission.lease, { durationMs: Date.now() - startedAt });
            this.clanFounderRunning = false;
        });
    },

    resolveClanSimulation() {
        if (ClanSimulationConfig.enabled === false) return Promise.resolve(null);
        const activity = this.playerActivityProfile();
        const startedAt = Config.developerDiagnostics ? Date.now() : 0;
        return this.resolveClanActions(activity).then((actions) => this.resolveClanFounders(activity).then((founder) => ({
            actions,
            founder,
            playerProtected: !!activity?.protected,
            ...(Config.developerDiagnostics ? { elapsedMs: Date.now() - startedAt } : {})
        })));
    },

    isRestingActivationState(state) {
        const activity = state?.activity || 'hunting';
        if (activity === 'resting' || activity === 'dead') return true;

        const vitals = state?.vitals || {};
        const hpPct = Number(vitals.hp || 0) / Math.max(1, Number(vitals.maxHp || vitals.hp || 1));
        const mpPct = Number(vitals.mp || 0) / Math.max(1, Number(vitals.maxMp || vitals.mp || 1));
        // The rest rule of a hunting bot, solo or in a party (RestPolicy).
        const party = !!(state?.party?.partyId || state?.partyId);
        return invoke('GameServer/Bot/AI/RestPolicy').needsRest(state, hpPct, mpPct, { party });
    },

    // Would the near-player scan activate this cold row? Not a traveller or a
    // pk hunter (no hot equivalent of its run), not a bot on a supply errand, a
    // party only while its row is active (one candidate for the roster), a
    // crafter only with its shop, never a merchant. The cold commit holds only
    // such a row near a player (ColdSimulationCoordinator.prepareProposal): a
    // row this scan skips would wait there forever.
    activationCandidate(state) {
        if (!state || ['pk_hunting', 'traveling'].includes(state.activity)
            || BotErrands.busyWith(state, ACTIVATION_BUSY_FLAGS)) return false;
        const partyId = state.party?.partyId;
        if (partyId) return BackgroundPartyState.find(partyId)?.status === 'active';
        if (state.activity === 'crafting') return !!state.stats?.craftShop;
        return state.activity !== 'merchant';
    },

    // Did the last near-player scan refuse this row by its own state (no placement a
    // player would see: HotActivation byState)? Such a row will not turn hot as it
    // stands, so the near hold lets it step and move; the next scan tries it again.
    nearActivationRefused(characterId) {
        return this.nearRefused?.has(Number(characterId)) === true;
    },

    activateNearPlayers() {
        const players = this.realPlayerSessions();
        if (players.length === 0) return Promise.resolve([]);

        const BotManager = invoke('GameServer/Bot/BotManager');
        const activated = [];
        const ambientActivated = [];
        // The rows this scan refused by their own state: the near hold's answer.
        const refused = new Set();
        let chain = Promise.resolve();

        players.forEach((playerSession) => {
            chain = chain.then(() => {
                const actor = playerSession.actor;
                const loc = {
                    locX: actor.fetchLocX(),
                    locY: actor.fetchLocY(),
                    locZ: actor.fetchLocZ()
                };
                // Craft shops are persistent town infrastructure. They must not
                // compete with the ambient-density budget, otherwise a full row
                // of public stations can only appear in several policy ticks.
                return LifeState.coldNear(loc, Config.activationRadius, 100)
                    .then((states) => {
                        // A cold traveller has no hot equivalent for its
                        // persisted route. Keep it cold until its resolver
                        // reaches the destination, instead of spawning a
                        // hunter/resting bot stranded on a road or plaza.
                        // A party contributes one candidate; its lifecycle
                        // transition reserves and materializes the full roster.
                        const seenParties = new Set();
                        const available = states.filter(state => this.activationCandidate(state)).filter(state => {
                            const partyId = state.party?.partyId;
                            if (!partyId) return true;
                            if (seenParties.has(partyId)) return false;
                            seenParties.add(partyId);
                            return true;
                        });
                        // A visible cold party is one actor from the activation policy's point of
                        // view, but represents an entire roster in the client. Give parties first
                        // refusal so a raid cannot keep resolving invisibly behind solo/service
                        // activation work.
                        const parties = available.filter((state) => !!state.party?.partyId);
                        const standalone = available.filter((state) => !state.party?.partyId);
                        const crafters = standalone.filter((state) => state.activity === 'crafting' && state.stats?.craftShop);
                        // There is intentionally no local population target
                        // here. The old fixed local target made a player see
                        // only a fixed handful of bots even when hundreds of
                        // eligible cold states occupied the same area. Keep a
                        // bounded per-pass activation budget (counted in bots
                        // activated, below) so the population converges gradually
                        // and player pressure can still interrupt the work between
                        // scans. The floor and a refused placement are judged
                        // before the budget: a row on another floor or one that
                        // cannot be placed takes no place from the next nearest.
                        const ambient = standalone.filter(state => state.activity !== 'crafting');
                        const candidates = [...parties, ...crafters, ...ambient];
                        const floorAware = FloorAwareActivationPolicy.filterCandidates(candidates, {
                            playerLoc: loc,
                            reason: 'near_player'
                        }).accepted;
                        const shown = floorAware.reduce((stateChain, state) => (
                            stateChain.then(() => {
                                const craft = state.activity === 'crafting' && state.stats?.craftShop;
                                const size = state.party?.partyId ? BackgroundPartyState.find(state.party.partyId)?.memberIds.length || 1 : 1;
                                // One full party may exceed the solo per-scan budget
                                // (9 versus 6), but may not be split or starve forever.
                                if (!craft && ambientActivated.length && ambientActivated.length + size > Config.maxActivationsPerScan) {
                                    return { ok: false, reason: 'activation_budget' };
                                }
                                return this.requestActivation(state, 'near_player', {
                                    recoverOnActivation: this.isRestingActivationState(state),
                                    readyOnActivation: true,
                                    keepStoreLocation: state.activity === 'crafting' && !!state.stats?.craftShop,
                                    playerLoc: loc
                                }).then((result) => {
                                    logPartyFailure(state?.party?.partyId, 'activation', result);
                                    return result;
                                });
                            }).then((result) => {
                                if (result.byState) refused.add(Number(state.characterId));
                                if (result.ok) {
                                    activated.push(result);
                                    if (state.activity !== 'crafting' || !state.stats?.craftShop) {
                                        ambientActivated.push(...Array(result.count || 1).fill(result));
                                    }
                                }
                            })
                        ), Promise.resolve());
                        return shown.then(() => this.showWalkersNear(loc, activated, ambientActivated));
                    });
            });
        });

        return chain.then(() => {
            this.nearRefused = refused;
            return activated;
        });
    },

    // Walkers near a player appear within the same activation budget
    // (walkerAppearance). Only the small walker list is read.
    showWalkersNear(loc, activated = [], ambientActivated = [], timestamp = Date.now()) {
        return LifeState.walkersNear(loc, Config.activationRadius, timestamp).reduce((chain, state) => chain.then(() => {
            if (ambientActivated.length >= Config.maxActivationsPerScan) return null;
            if (!state || state.phase !== 'cold' || BotErrands.busyWith(state, ACTIVATION_BUSY_FLAGS)) return null;
            // HotActivation leaves the trip at walkerAppearance's endpoint in reach of this
            // player, read after its fence; with neither in reach the walker stays cold.
            return this.requestActivation(state, 'near_player', { readyOnActivation: true, preferAnchor: true, playerLoc: loc })
                .then((result) => {
                    if (!result.ok) return;
                    activated.push(result);
                    ambientActivated.push(result);
                });
        }), Promise.resolve()).then(() => activated);
    },

    cooldownEligibleHot() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const HotPartyLifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
        const now = Date.now();
        const players = this.realPlayerSessions();
        const cooldownRadius = Math.max(Config.cooldownRadius, Config.activationRadius);
        const seenParties = new Set();
        // The nearest player distance of each hot bot, once: the filter and the
        // sort read it (the sort recomputed every player distance per comparison).
        const nearest = new Map();
        const candidates = BotManager.sessions
            .filter((session) => session.actor && session.accountId && String(session.accountId).startsWith('bot_'))
            .filter((session) => {
                if (session.chatArrivalActive) return false;
                if (session.plan === 'merchant' && !session.coldMarketState && !session.coldCraftState) return false;
                // Scripted PK encounters stay hot; ordinary chaotic bots can
                // continue hunting and washing karma in the cold simulation.
                if (session.pkProfile || session.plan === 'pk_hunting') return false;
                if (session.clanAllianceQuest || session.partyCompanion === true || session.followPlayerSession) return false;
                let distance = Infinity;
                for (const playerSession of players) distance = Math.min(distance, distance2d(session.actor, playerSession.actor));
                nearest.set(session, distance);
                const failedRaidReady = session.hotBackgroundPartyId
                    && HotPartyLifecycle.raidFailureReady(
                        BackgroundPartyState.find(session.hotBackgroundPartyId),
                        now
                    );
                if (failedRaidReady) return true;
                const lastHotAt = session.populationHotAt || 0;
                if (lastHotAt && now - lastHotAt < Config.cooldownGraceMs && !session.pvpEncounter) return false;
                return distance > cooldownRadius;
            })
            .filter(session => {
                if (!session.hotBackgroundPartyId) return true;
                if (seenParties.has(session.hotBackgroundPartyId)) return false;
                seenParties.add(session.hotBackgroundPartyId);
                return true;
            })
            .sort((a, b) => nearest.get(b) - nearest.get(a))
            .slice(0, Config.cooldownBatchSize);

        return candidates.reduce((chain, session) => (
            chain.then((results) => {
                const failedRaidReady = session.hotBackgroundPartyId
                    && HotPartyLifecycle.raidFailureReady(
                        BackgroundPartyState.find(session.hotBackgroundPartyId),
                        now
                    );
                return this.cooldownSession(
                    session,
                    failedRaidReady ? 'raid_failed' : 'policy',
                    failedRaidReady ? { ignoreVisibility: true } : {}
                ).then((result) => {
                if (result.ok) results.push(result);
                return results;
                });
            })
        ), Promise.resolve([]));
    },

    // A formation pass ended: the groups it kept waiting run (PartyAssemblyEvents busy).
    formationEnded() {
        this.partyFormationRunning = false;
        this.partyAssemblyEvents?.wakeParked();
    },

    async helpClanParty(timestamp = Date.now()) {
        const Help = invoke('GameServer/Bot/Population/ClanPartyHelp');
        if (!Help.hasDue() || Config.enabled === false || Config.backgroundPartyEnabled === false) return null;
        if (this.partyFormationRunning || this.resolving || this.membershipWritesWait()) return BUSY_HELP;
        this.partyFormationRunning = true;
        try {
            return await Help.processOne({ commit: commitPartyMembership, create: createAndCommitBackgroundParty, release: releaseForClanHelp }, timestamp);
        } finally { this.formationEnded(); }
    },

    // Main is busy with writes a membership write would queue behind or stall: event-loop
    // lag, the DB queue or a checkpoint in flight, the cold worker not ready or its commit
    // queue draining. No event ends it: the caller's group is retried (PartyAssemblyEvents.retryMs).
    membershipWritesWait() {
        const cold = ColdSimulationCoordinator.snapshot();
        return Number(Metrics.currentEventLoopLag()) >= Number(Config.schedulerLagThrottleMs || 40)
            || Number(Database.pending() || 0) > 0 || !!Database.checkpointSnapshot()?.inFlight
            || !cold.ready || !cold.snapshotsLoaded || Number(cold.queue?.depth || 0) > 0
            || !!cold.queue?.flushing;
    },

    formBackgroundParties(candidates = null, { moved = null } = {}) {
        // Formation rewrites party membership.  It must not overlap with the
        // scheduler after that scheduler has already selected solo candidates.
        if (this.partyFormationRunning || Config.enabled === false || Config.backgroundPartyEnabled === false) {
            return Promise.resolve([]);
        }
        const activity = this.playerActivityProfile();
        if (this.resolving) {
            // Busy work preserves this group's retry deadline.
            this.partyFormationPending = true;
            return Promise.resolve([]);
        }

        // A player online shares main with the pass: it waits out main's writes and keeps
        // the small player budget (partyFormationBudgetMs), one party a pass.
        const formationBudgetMs = this.partyFormationBudgetMs(activity);
        if (formationBudgetMs <= 0 || activity.protected && this.membershipWritesWait()) {
            this.partyFormationPending = true;
            Config.developerDiagnostics && Metrics.recordPartyFormationDeferral();
            return Promise.resolve([]);
        }

        this.partyFormationRunning = true;
        this.partyFormationPending = false;
        const startedAt = Date.now();
        const deadlineAt = startedAt + formationBudgetMs;
        let budgetStopRecorded = false;
        // A pass its budget stopped left work undone: its group is retried (partyFormationPending).
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            if (!budgetStopRecorded) {
                budgetStopRecorded = true;
                this.partyFormationPending = true;
                Config.developerDiagnostics && Metrics.recordPartyFormationBudgetStop();
            }
            return true;
        };
        const timedStage = (name, work) => {
            const stageStartedAt = Config.developerDiagnostics ? Date.now() : 0;
            return Promise.resolve().then(work).finally(() => {
                Config.developerDiagnostics && Metrics.recordPartyFormationStage(name, Date.now() - stageStartedAt);
            });
        };
        const objectiveOf = partyObjectiveMemo();
        const openRequired = state => objectiveOf(state)?.status === 'open' && objectiveOf(state)?.priority === 'required';
        const formationWork = () => {
            // Production inspects one indexed group page. Tooling can explicitly
            // request the legacy projection; only selected rows hydrate.
            return timedStage('candidate_projection', () => (candidates ? Promise.resolve(candidates) : LifeState.coldPartyCandidateProjections())
                .then((states) => ({
                    states,
                    partyRequestBacklog: states.some((state) => objectiveOf(state)?.status === 'open'),
                    requiredPartyRequestCount: states.filter(openRequired).length
                })))
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const materialRequested = states.some(state => CraftMaterialParty.isObjective(partyObjectiveForState(state)));
                const willingStates = states.filter((state) => (
                    requiresClanEquipmentParty(state)
                    || CraftMaterialParty.isObjective(partyObjectiveForState(state))
                    || materialRequested && !!PartyComposition.supportRole(state, partyObjectiveForState(state))
                    || PersonaPartyPolicy.backgroundIntent(state).accept
                ));
                const recruit = this.recruitBackgroundMembers(willingStates, {
                    deadlineAt,
                    markBudgetStop: () => budgetReached(),
                    objectiveOf
                });
                return recruit.then((recruitedIds) => ({
                    states: willingStates.filter((state) => !recruitedIds.has(Number(state.characterId))),
                    partyRequestBacklog,
                    requiredPartyRequestCount
                }));
            })
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const activeParties = occupiedPartySlots();
                const slots = Math.max(0, partyCapacityLimit() - activeParties);
                const clanDemand = states.some(state => ClanPartyCapacity.required(objectiveOf(state)));
                if (slots <= 0 && !clanDemand) {
                    // Counted once per roster refused: a group at a revision the cap had not refused.
                    if (this.partyAssemblyEvents?.waitSlot(states.filter(state => objectiveOf(state)?.status === 'open')) > 0) {
                        Situations.note('party:cap:hit');
                    }
                    return [];
                }
                // A live player keeps a small formation reserve, but that
                // reserve must not turn into a burst of simultaneous party
                // writes while the foreground session is active.
                const maxNewParties = Math.min(
                    slots || (clanDemand ? 1 : 0),
                    Config.partyFormationBatchSize,
                    activity.protected ? 1 : Config.partyFormationBatchSize
                );
                const groups = this.groupPartyCandidatesByObjective(states, { prioritizePartyWait: partyRequestBacklog,
                    activePartiesBySpot: activePartiesBySpotOnRead(), objectiveOf });
                const clanRequired = new Map(groups.map(group => [group, group.some(state => ClanPartyCapacity.required(objectiveOf(state)))]));
                groups.sort((a, b) => Number(clanRequired.get(b)) - Number(clanRequired.get(a)));
                const created = [];

                return groups.reduce((chain, group) => chain.then(() => {
                    if (created.length >= maxNewParties || budgetReached()) return null;
                    const requestedObjective = group
                        .map(objectiveOf)
                        .find((objective) => objective?.priority === 'required')
                        || objectiveOf(group[0]);
                    const partyLimits = partyLimitsForObjective(requestedObjective);
                    // Forming's no: the open requests (required or preferred) close (attempts +1) and
                    // wait for their bots' next build, which asks again; none held open on no clock.
                    const close = (states, reason) => LifeState.deferUnformablePartyRequests(states
                        .filter((state) => state.stats?.partyRequest?.status === 'open')
                        .map((state) => state.characterId), reason)
                        .catch((error) => { FailureLog.note('party.unformable_close', error); return 0; });
                    const unformable = reason => close(group, reason);
                    if (group.length < partyLimits.minSize) return unformable('too_few_members');

                    const select = CraftMaterialParty.isObjective(requestedObjective)
                        ? CraftMaterialParty.selectMembers
                        : (rows, options) => ClanRaidRoster.selectMembers(rows, requestedObjective, options);
                    // The bots that asked for a party group among themselves first; the willing
                    // fill a roster built around one of them only when too few asked (a material
                    // roster picks its own supports).
                    const asked = group.filter(state => objectiveOf(state)?.status === 'open');
                    const limits = { minSize: partyLimits.minSize, maxSize: partyLimits.maxSize, levelRange: partyLimits.levelRange,
                        anchorIds: new Set(asked.map(state => Number(state.characterId))) };
                    // Too wide a level spread among the askers alone: a roster around each asker with the willing as fill.
                    let selectedMembers = asked.length >= partyLimits.minSize && !CraftMaterialParty.isObjective(requestedObjective)
                        ? select(asked, limits) : [];
                    if (selectedMembers.length < partyLimits.minSize) selectedMembers = select(group, limits);
                    if (selectedMembers.length < partyLimits.minSize) return unformable('no_compatible_level_match');
                    // A roster of members none of which moved holds its last answer: not judged again.
                    if (moved && !selectedMembers.some(state => moved.has(Number(state.characterId)))) return null;
                    // A roster refused past its verdict (a member's row moved since the page was
                    // read, a refused commit: a revision race, the DB) or with no verdict (a busy
                    // worker) is judged again on its members' rows (PartyAssemblyEvents.rewakeOn:
                    // at once for a row already moved, else at its next publication); one with
                    // no party slot when a party ends (waitSlot). Each counted.
                    const rewake = why => () => {
                        Situations.note(`party:form:${why}`);
                        this.partyAssemblyEvents?.rewakeOn(selectedMembers);
                        return null;
                    };
                    return timedStage('candidate_hydration', () => hydratePartyCandidates(selectedMembers)).then((members) => {
                        if (members.length !== selectedMembers.length) return rewake('commit_refused')();
                        return timedStage('party_commit', () => createAndCommitBackgroundParty(members, null, {
                            onCommitRefused: rewake('commit_refused'), onDeferred: rewake('verdict_deferred'),
                            onNoSlot: () => { Situations.note('party:form:no_slot'); this.partyAssemblyEvents?.waitSlot(selectedMembers); },
                            onRefused: () => close(selectedMembers, 'forming_refused') }))
                            .then((savedParty) => {
                                if (savedParty) created.push(savedParty);
                                return savedParty;
                            });
                    });
                }), Promise.resolve()).then(() => created);
            });
        };
        return Database.cooperatively(formationWork, Config.partyFormationSliceMs)
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background party formation failed: %s', err.message);
                return [];
            })
            .finally(() => {
                Config.developerDiagnostics && Metrics.recordPartyFormationDuration(Date.now() - startedAt);
                this.formationEnded();
            });
    },

    groupPartyCandidatesBySpot(states = [], options = {}) {
        return groupBySpot(states, options);
    },

    partyFormationBudgetMs(activity = this.playerActivityProfile()) {
        const baseBudget = activity?.protected
            ? Number(Config.partyFormationPlayerBudgetMs) || 600
            : Number(Config.partyFormationIdleBudgetMs) || 500;
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const lagThrottle = Math.max(0, Number(Config.schedulerLagThrottleMs) || 0);
        const lagAbort = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        if (lagAbort > 0 && lagMs >= lagAbort) return 0;
        if (lagAbort > lagThrottle && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / (lagAbort - lagThrottle));
            return Math.max(25, Math.round(baseBudget * (1 - pressure)));
        }
        if (lagAbort === 0 && lagThrottle > 0 && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / lagThrottle);
            return Math.max(25, Math.round(baseBudget * (1 - pressure)));
        }
        return Math.max(25, baseBudget);
    },

    groupPartyCandidatesByObjective(states = [], options = {}) {
        const timestamp = options.timestamp ?? Date.now();
        const objectiveOf = options.objectiveOf || partyObjectiveMemo();
        const grouped = new Map();
        // Production hands in only the assembly event's page: its helpers were
        // already read from the support index (PartyAssemblyEvents.supportShortlist)
        // and filtered by runPartyAssemblyEvent. A second index read here would
        // rotate the index again and skip that filter; this pool is bounded by the page.
        const supports = new Map();
        (states || []).forEach((state) => {
            const key = partyObjectiveKeyForState(state, objectiveOf(state));
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(state);
            if (PartyComposition.supportRole(state, partyObjectiveForState(state))) {
                if (!supports.has(state.level)) supports.set(state.level, []);
                const pool = supports.get(state.level);
                if (pool.length < 12) pool.push(state);
            }
        });
        // An asker to meet (PartyRequestPlanner.meetingKey: its LFP heard across its
        // region and level band) groups with the page's other askers of its band and
        // region too, from their own spots (PartyAssemblyEvents adds them to the page).
        const meetings = new Map();
        for (const state of states || []) {
            const meeting = PartyRequestPlanner.meetingKey(objectiveOf(state), state.level, SpotProfiles.ensure());
            if (meeting) meetings.set(state, meeting);
        }
        if (meetings.size > 1) for (const group of grouped.values()) {
            const anchor = group.find(state => meetings.has(state));
            if (!anchor) continue;
            const inGroup = new Set(group);
            for (const [state, meeting] of meetings) if (!inGroup.has(state) && meeting === meetings.get(anchor)) group.push(state);
        }
        // The addressed event page supplies a bounded support shortlist. A
        // helper's own hunting spot need not equal the material rendezvous.
        for (const group of grouped.values()) if (CraftMaterialParty.isObjective(partyObjectiveForState(group[0]))) {
            const anchor = group[0];
            const helpers = [];
            for (let gap = 0; gap <= PartyComposition.DEFAULT_LEVEL_RANGE && helpers.length < 12; gap++)
                for (const level of gap ? [Number(anchor.level) - gap, Number(anchor.level) + gap] : [anchor.level])
                    helpers.push(...(supports.get(level) || []).slice(0, 12 - helpers.length));
            group.push(...helpers);
        }
        return Array.from(grouped.entries())
            .map(([key, group]) => ({
                key,
                spotId: partyObjectiveSpotForState(group[0], objectiveOf(group[0])),
                states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
                admissionPriority: admissionPriority(group.map(objectiveOf), timestamp),
                partyWaiters: group.filter((state) => state.activity === 'party_wait'
                    || objectiveOf(state)?.status === 'open').length
            }))
            .sort((a, b) => {
                if (a.admissionPriority !== b.admissionPriority) return b.admissionPriority - a.admissionPriority;
                if (options.prioritizePartyWait && a.partyWaiters !== b.partyWaiters) {
                    return b.partyWaiters - a.partyWaiters;
                }
                const aActive = Number(options.activePartiesBySpot?.get(a.spotId) || 0);
                const bActive = Number(options.activePartiesBySpot?.get(b.spotId) || 0);
                if (aActive !== bActive) return aActive - bActive;
                return b.states.length - a.states.length;
            })
            .map((group) => group.states);
    },

    partyCapacityLimit,
    partyObjectiveForState,

    async applyWorkerPartyRequirements(party, resolution) {
        if (require('./OpportunisticRaidPolicy').isObjective(party.stats?.objective)) {
            this.clearPartyRequirementDue(party.partyId);
            return [];
        }
        // Material completion is checked against the physical bag by the
        // native resolver. A generic gear refresh must not evict its core.
        if (CraftMaterialParty.isObjective(party.stats?.objective)) {
            this.clearPartyRequirementDue(party.partyId);
            return [];
        }
        if (party.status !== 'active') {
            this.clearPartyRequirementDue(party.partyId);
            return [];
        }
        let changed = false, skipped = false;
        const skip = (kind) => {
            skipped = true;
            Config.developerDiagnostics && Diagnostics.count('party_requirement', 'member_write', `skipped_${kind}`);
        };
        for (const { characterId, plan } of resolution.memberPlans || []) {
            const member = LifeState.cachedState(characterId);
            if (!member || member.phase !== 'cold' || member.party?.partyId !== party.partyId) continue;
            if (acquisitionRequirementKey(member.stats?.equipmentPlan) === acquisitionRequirementKey(plan)) continue;
            // Held on the revision of the copy read above: the member's own
            // review runs meanwhile; a write it beat is skipped and the
            // party's re-plan is marked due again below.
            const written = await LifeState.writePartyRequirementPlan(member, plan);
            if (written === false) skip('plan');
            changed = !!written || changed;
        }
        // A bounded worker re-plan may span steps: its mark clears only with its complete
        // projection (requirementRefreshedAt), whose objective rode the leader's party row.
        // The plans are all main writes: the members' stays (party_need_ended) and the
        // party's spot (party_spot) decide on the worker.
        if (skipped) this.markPartyRequirementReplan(party.partyId);
        else if (resolution.requirementRefreshedAt) this.clearPartyRequirementDue(party.partyId);
        return changed ? [party.partyId] : [];
    },

    // The answer of a pending join's recruit check, from the leader's step
    // (ColdSimulationCoordinator, after the party row write). It joins the
    // recruits only while the party keeps the members the check saw and each
    // recruit is still the state the check read.
    async applyWorkerPartyJoin(partyId, check) {
        const count = outcome => Config.developerDiagnostics && Diagnostics.count('party_assembly', 'recruit_join', outcome);
        if (check?.outcome !== 'accepted') return count(check?.outcome || 'declined');
        const party = BackgroundPartyState.find(partyId);
        if (party?.status !== 'active' || (party.memberIds || []).join(',') !== (check.memberIds || []).join(','))
            return count('stale_party');
        const members = (await LifeState.cachedStatesForParties([party])).get(String(partyId)) || [];
        const recruits = await hydratePartyCandidates((check.recruitIds || []).map(id => LifeState.cachedState(id)).filter(Boolean));
        if (recruits.length !== (check.recruitIds || []).length || !PartyGoalCalculation.matches(recruits, check.sources))
            return count('stale_recruit');
        const current = BackgroundPartyState.find(partyId);
        if (current?.revision !== party.revision) return count('stale_party');
        return count(await joinPartyRecruits(party, members, recruits, check.joint) ? 'joined' : 'refused');
    },

    recruitBackgroundMembers(candidates = [], options = {}) {
        const deadlineAt = Number(options.deadlineAt || Infinity);
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            options.markBudgetStop?.();
            return true;
        };
        const claimed = new Set();
        // Each candidate's objective, grouping key and objective spot once per
        // pass; a party is matched against them before its members hydrate.
        const objectiveOf = options.objectiveOf || partyObjectiveMemo();
        const facts = new Map(candidates.map(state => {
            const objective = objectiveOf(state);
            return [state, { objective, key: partyObjectiveKeyForState(state, objective),
                spotId: partyObjectiveSpotForState(state, objective), seeking: PartyRequestPlanner.seeksParty(state) }];
        }));
        // A healer or buffer without solo ground (PartyRequestPlanner.seeksParty)
        // joins a party of its level wherever the party hunts: the party's spot
        // is its own search's pick, ground the party hunts; the level range,
        // the shared experience and the recruit check judge the roster as for
        // any recruit. A clan, raid or material roster keeps its own members.
        // The stored leader's level is read before any hydration, so a pass
        // with a seeker hydrates only the parties of its level.
        const openRoster = objective => !objective || !(objective.clanGoalKey || objective.sourceKind === 'raid'
            || objective.fullRoster || objective.opportunisticRaid || CraftMaterialParty.isObjective(objective));
        const ofLevel = (party, state) => Math.abs(Number(LifeState.cachedState(party.leaderId)?.level || 0)
            - Number(state.level || 0)) <= PartyComposition.DEFAULT_LEVEL_RANGE;
        const matches = (party, state) => {
            const partyObjective = party.stats?.objective || null, fact = facts.get(state);
            if (fact.seeking && openRoster(partyObjective) && ofLevel(party, state)) return true;
            return partyObjective
                ? (fact.key === partyObjectiveGroupingKey(partyObjective)
                    || partyObjectivesShareRoute(partyObjective, fact.objective)
                    || (!partyObjective.clanGoalKey
                        && state.stats?.partyRequest?.priority !== 'required'
                        && fact.spotId === partyObjective.spotId))
                : state.spotId === party.spotId;
        };
        // A party no candidate matches recruits nobody: it is neither hydrated
        // nor visited (claims only shrink the candidates). A party the open
        // slots admit has fewer member ids than its cap, and its hydrated
        // members are a subset of them, so the full-roster repair below never
        // ran for a party without a match either.
        const matched = new Map();
        let skipped = 0;
        const parties = BackgroundPartyState.active()
            .filter((party) => {
                const limits = partyLimitsForObjective(party?.stats?.objective || null);
                if (party.stats?.travel || party.stats?.pveEncounter
                    || PartyMarketBreak.pending(party).length || (party.memberIds || []).length >= limits.maxSize) return false;
                // A pending join waits for its far leader's step; a leader near
                // the player has none, so the check runs here again.
                if (party.stats?.pendingRecruits && LifeState.cachedState(party.leaderId)?.phase === 'cold') return false;
                const pool = candidates.filter(state => matches(party, state));
                if (!pool.length) { skipped++; return false; }
                matched.set(party, pool);
                return true;
            })
            .sort((a, b) => (a.memberIds || []).length - (b.memberIds || []).length);
        if (Config.developerDiagnostics) {
            if (parties.length) Diagnostics.count('party_assembly', 'recruit_parties', 'matched', parties.length);
            if (skipped) Diagnostics.count('party_assembly', 'recruit_parties', 'skipped', skipped);
        }

        return Promise.resolve(LifeState.cachedStatesForParties(parties)).then((membersByParty) => parties.reduce((chain, party) => chain.then(() => {
            if (budgetReached()) return null;
                const members = membersByParty.get(String(party.partyId)) || [];
                const partyLimits = partyLimitsForObjective(party?.stats?.objective || null);
                if (members.length < Config.partyMinSize) return null;
                // ARCH-NOTE: Reverse membership drift remains owned by the lifecycle safety sweep; this read follows only declared member ids.
                const persistedMemberIds = new Set((party.memberIds || []).map(Number));
                const membershipMismatch = members.length !== persistedMemberIds.size
                    || members.some((member) => !persistedMemberIds.has(Number(member.characterId)));
                if (members.length >= partyLimits.maxSize) {
                    if (!membershipMismatch) return null;
                    const reconciledParty = partyWithRoster(party, members, { lastMembershipRepairAt: Date.now() });
                    return commitPartyMembership(reconciledParty, members).then(({ party: repaired, failed }) => {
                        if (!repaired || failed.length) return null;
                        Config.developerDiagnostics && console.info('BotPopulation :: reconciled background party %s members=%d', party.partyId, members.length);
                        return repaired;
                    });
                }
                const partyObjective = party.stats?.objective || null;
                const nearby = matched.get(party).filter((state) => (
                    !claimed.has(Number(state.characterId))
                    && (CraftMaterialParty.isObjective(partyObjective) || !CraftMaterialParty.requestOf(state))
                    && ClanEquipmentPartyPolicy.allowed(state, partyObjective)
                ));
                const recruits = PartyComposition.selectRecruits(members, nearby, {
                    maxSize: partyLimits.maxSize,
                    levelRange: partyLimits.levelRange
                });
                if (!recruits.length) return null;
                return hydratePartyCandidates(recruits).then((hydratedRecruits) => {
                    if (hydratedRecruits.length !== recruits.length) return null;
                    const claim = joined => {
                        if (joined) hydratedRecruits.forEach((recruit) => claimed.add(Number(recruit.characterId)));
                        return joined;
                    };
                    if (partyObjective?.clanGoalKey || partyObjective?.sourceKind === 'raid')
                        return joinPartyRecruits(party, members, hydratedRecruits, null).then(claim);
                    // The recruit check runs where the party steps: for a far
                    // party at its leader's step in the background thread (the
                    // pending join below, answered by applyWorkerPartyJoin), for
                    // a party near the player here.
                    const leader = members.find(member => Number(member.characterId) === Number(party.leaderId));
                    if (leader?.phase === 'cold' && hydratedRecruits.every(recruit => recruit.phase === 'cold')) {
                        const current = BackgroundPartyState.find(party.partyId);
                        if (current?.status !== 'active' || current.revision !== party.revision) return null;
                        claim(true);
                        Config.developerDiagnostics && Diagnostics.count('party_assembly', 'recruit_join', 'pending');
                        return BackgroundPartyState.createOrUpdate({ ...current, stats: { ...(current.stats || {}),
                            pendingRecruits: { ids: hydratedRecruits.map(recruit => Number(recruit.characterId)) } } });
                    }
                    const allMembers = [...members, ...hydratedRecruits];
                    const joint = PartyGoalCalculation.recruitCheck(
                        { ...party, leaderId: leaderIdForMembers(party, members) || Number(hydratedRecruits[0]?.characterId || 0) },
                        allMembers, { spots: SpotProfiles.ensure(), timestamp: Date.now() });
                    return joint ? joinPartyRecruits(party, members, hydratedRecruits, joint).then(claim) : null;
                });
            }), Promise.resolve())).then(() => claimed);
    },

    checkpointPressure() {
        const checkpoint = Database.checkpointSnapshot() || {};
        const last = checkpoint.last || {};
        const lastReset = checkpoint.lastReset || {};
        const walBytes = Math.max(0, Number(last.afterBytes || last.beforeBytes || 0));
        const generationBytes = Math.max(0, Number(last.generationBytes || 0));
        const growthBytes = lastReset.at ? generationBytes : walBytes;
        const resetWalBytes = Math.max(0, Number(options.default.Database?.checkpointResetWalBytes) || 0);
        const resetGrowthBytes = Math.max(1, Number(options.default.Database?.checkpointResetGrowthBytes) || 64 * 1024 * 1024);
        const resetDue = resetWalBytes > 0
            && walBytes >= resetWalBytes
            && (!lastReset.at || growthBytes >= resetGrowthBytes);
        return {
            checkpoint,
            last,
            lastReset,
            walBytes,
            generationBytes,
            growthBytes,
            resetGrowthBytes,
            resetDue
        };
    },

    // The WAL truncate is tried when a passive checkpoint finishes (every
    // checkpointIntervalMs while the WAL is past checkpointMinWalBytes): the
    // gate wants that fresh, complete result and no checkpoint in flight. Not a
    // poll: one on the checkpoint's own period phase-locks with it after a long
    // main turn (both due in one timer pass, the checkpoint first), then sees a
    // checkpoint in flight on every try and the WAL never truncates.
    armWalReset() {
        this.walResetUnsubscribe?.();
        this.walResetUnsubscribe = null;
        if (!(Number(options.default.Database?.checkpointResetWalBytes) > 0)) return;
        this.walResetUnsubscribe = Database.onCheckpoint((result) => {
            if (result?.mode === 'passive' && result.ok && !result.skipped) this.runAdaptiveWalReset();
        });
    },

    // Admission of a DB maintenance pass (state retention, the WAL truncate)
    // on the governor's 'db_maintenance' resource. With a player online and
    // the governor off (BOT_BACKGROUND_GOVERNOR_ENABLED=false) nothing bounds
    // the pass, so it is refused. A refusal is counted with its reason.
    admitMaintenance(job, activity, admit) {
        if (activity.protected && Config.backgroundGovernorEnabled === false) {
            Database.noteMaintenanceRefusal(job, 'governor_off');
            return null;
        }
        const admission = BackgroundWorkGovernor.admit({
            ...admit, job, resource: 'db_maintenance',
            playerProtected: !!activity.protected, realPlayers: activity.realPlayers
        });
        if (admission.ok) return admission;
        Database.noteMaintenanceRefusal(job, `governor_${admission.reason}`);
        return null;
    },

    // The WAL truncate, during play too. It runs on the checkpoint worker, but
    // Database.checkpoint queues it behind main's DB queue, which waits for the
    // whole of it: the IPC round trip, the busy wait for readers (20 ms with a
    // player, 50 idle), backfill, fsync and ftruncate. Its budget is the hold on
    // main of the last completed truncate, queued to resolved (a busy or failed
    // try keeps the previous; at least the busy wait;
    // WAL_TRUNCATE_FIRST_ESTIMATE_MS before any), and with a player a
    // truncate estimated over the governor's player budget is skipped, retried
    // every WAL_TRUNCATE_ESTIMATE_RETRY_MS and forced past
    // WAL_TRUNCATE_FORCE_WAL_BYTES. The
    // gates kept here are about the WAL: big and grown enough, the last passive
    // checkpoint complete, none in flight. Every refusal is counted
    // (Database.noteMaintenanceRefusal); a failed truncate goes to FailureLog.
    runAdaptiveWalReset(timestamp = Date.now()) {
        const resetWalBytes = Math.max(0, Number(options.default.Database?.checkpointResetWalBytes) || 0);
        if (!resetWalBytes) return Promise.resolve(null);
        const refuse = (reason) => {
            Database.noteMaintenanceRefusal('wal_truncate', reason);
            return Promise.resolve(null);
        };
        if (this.walResetRunning) return refuse('running');
        const pressure = this.checkpointPressure();
        const { checkpoint, last, lastReset, walBytes, growthBytes, resetGrowthBytes } = pressure;
        // Past the ceiling only the WAL's own correctness gates hold it back
        // (one in flight, the last passive checkpoint incomplete).
        const forced = walBytes >= WAL_TRUNCATE_FORCE_WAL_BYTES;
        if (!forced && timestamp < Number(this.nextWalResetAt || 0)) return refuse('retry_window');
        if (walBytes < resetWalBytes) return refuse('wal_below_threshold');
        if (checkpoint.inFlight) return refuse('checkpoint_in_flight');
        if (!forced && lastReset.at && growthBytes < resetGrowthBytes) return refuse('growth_below_threshold');
        const logFrames = Math.max(0, Number(last.logFrames || 0));
        const checkpointedFrames = Math.max(0, Number(last.checkpointedFrames || 0));
        if (!last.ok || last.mode !== 'passive' || Number(last.busy || 0) > 0 || checkpointedFrames < logFrames) {
            return refuse('passive_incomplete');
        }

        const activity = this.playerActivityProfile(timestamp);
        const configuredBusyMs = Math.max(1, Math.min(250, Number(options.default.Database?.checkpointResetBusyTimeoutMs) || 50));
        const busyTimeoutMs = activity.protected ? Math.min(20, configuredBusyMs) : configuredBusyMs;
        const estimateMs = Math.ceil(Math.max(busyTimeoutMs, this.walTruncateEstimateMs || WAL_TRUNCATE_FIRST_ESTIMATE_MS));
        const playerBudgetMs = Math.max(1, Number(Config.backgroundGovernorPlayerBudgetMs) || 50);
        // Over budget with a player: skipped, but tried once per retry period
        // (with the player budget; the governor records the overrun).
        let ranAs = forced ? 'forced_over_ceiling' : null;
        if (!forced && activity.protected && estimateMs > playerBudgetMs) {
            if (!this.walResetEstimateRetryAt) {
                this.walResetEstimateRetryAt = timestamp + WAL_TRUNCATE_ESTIMATE_RETRY_MS;
                return refuse('estimate_over_budget');
            }
            if (timestamp < this.walResetEstimateRetryAt) return refuse('estimate_over_budget');
            ranAs = 'estimate_retry';
        }
        const budgetMs = activity.protected ? Math.min(estimateMs, playerBudgetMs) : estimateMs;
        const admission = forced
            ? BackgroundWorkGovernor.admit({ job: 'wal_truncate', force: true, requestedBudgetMs: estimateMs,
                playerProtected: !!activity.protected, realPlayers: activity.realPlayers })
            : this.admitMaintenance('wal_truncate', activity, { requestedBudgetMs: budgetMs, minimumBudgetMs: budgetMs });
        if (!admission) return Promise.resolve(null);
        this.walResetEstimateRetryAt = 0;

        const retryMs = Math.max(1000, Number(options.default.Database?.checkpointResetRetryMs) || 5000);
        const cooldownMs = Math.max(retryMs, Number(options.default.Database?.checkpointResetCooldownMs) || 60000);
        const startedAt = Date.now();
        this.walResetRunning = true;
        this.nextWalResetAt = timestamp + retryMs;
        return Database.checkpoint({ mode: 'truncate', busyTimeoutMs }).then((result) => {
            // A forced or retried truncate is counted once it ran, whatever its result.
            if (ranAs) Database.noteMaintenanceRefusal('wal_truncate', ranAs);
            if (!result?.ok) {
                FailureLog.note('db.wal_truncate', new Error(result?.error || 'wal_truncate_failed'));
            } else if (Number(result.busy || 0) > 0) {
                Database.noteMaintenanceRefusal('wal_truncate', 'busy');
            } else {
                this.walTruncateEstimateMs = Math.max(1, Date.now() - startedAt);
                this.nextWalResetAt = Date.now() + cooldownMs;
                Config.developerDiagnostics && console.info(
                    'DB          :: adaptive WAL truncate complete wal=%dMB frames=%d/%d duration=%dms',
                    Math.round(Number(result.afterBytes || walBytes) / 1024 / 1024),
                    Number(result.checkpointedFrames || 0),
                    Number(result.logFrames || 0),
                    Math.round(Number(result.durationMs || 0))
                );
            }
            return result;
        }).catch((error) => {
            if (ranAs) Database.noteMaintenanceRefusal('wal_truncate', ranAs);
            FailureLog.note('db.wal_truncate', error);
            return null;
        }).finally(() => {
            BackgroundWorkGovernor.complete(admission.lease, { durationMs: Date.now() - startedAt });
            this.walResetRunning = false;
        });
    },

    // One retention step (PersistentStateRetention: one policy, at most two
    // statements, each bounded by construction to fit the slice) per 1 s
    // alarm, during play too: it runs on main's DB queue, where the player's
    // writes wait behind it, so it goes through the governor ('db_maintenance',
    // with a player at most its 50 ms per second), its cooperative slice is the
    // granted budget (<= 12 ms; the queue yields between its statements) and
    // it waits while main lags past schedulerLagThrottleMs. Refusals are
    // counted (Database.noteMaintenanceRefusal), failures go to FailureLog.
    runStateRetention(timestamp = Date.now()) {
        if (Config.stateRetentionEnabled === false || Config.enabled === false
            || this.stateRetentionRunning
            || timestamp < Number(this.nextStateRetentionAt || 0)) {
            return Promise.resolve(null);
        }
        if (this.checkpointPressure().resetDue) {
            // A truncate that starts takes this tick; one refused (counted
            // there, e.g. over budget for up to 10 min) leaves it to retention.
            const reset = this.runAdaptiveWalReset(timestamp);
            if (this.walResetRunning) {
                Database.noteMaintenanceRefusal('state_retention', 'wal_pressure');
                return reset;
            }
        }
        const activity = this.playerActivityProfile(timestamp);
        const requestedBudgetMs = Math.max(4, Math.min(50, Number(Config.stateRetentionBudgetMs) || 12));
        const admission = this.admitMaintenance('state_retention', activity, {
            requestedBudgetMs, minimumBudgetMs: 4,
            maxLagMs: Math.max(1, Number(Config.schedulerLagThrottleMs) || 40)
        });
        if (!admission) return Promise.resolve(null);

        const startedAt = Date.now();
        const budgetMs = admission.budgetMs;
        this.stateRetentionRunning = true;
        return Database.cooperatively(() => PersistentStateRetention.runNextBatch({
            timestamp,
            batchSize: Config.stateRetentionBatchSize,
            activityRetentionMs: Config.activityJournalRetentionMs,
            activityRowsPerPair: Config.activityJournalRowsPerPair,
            activityMaxRows: Config.activityJournalMaxRows,
            auditRetentionMs: Config.aiAuditRetentionMs,
            toolOutcomeMaxRows: Config.toolOutcomeMaxRows,
            llmTurnMaxRows: Config.llmTurnMaxRows,
            staleLlmTurnMs: Config.staleLlmTurnMs,
            compactedConversationRetentionMs: Config.compactedConversationRetentionMs,
            conversationMaxUncompactedRows: Config.conversationMaxUncompactedRows
        }), budgetMs).then((result) => {
            const durationMs = Date.now() - startedAt;
            this.stateRetentionPassRows += Math.max(0, Number(result?.rowsRemoved || 0));
            if (result?.cycleComplete) {
                const pauseMs = this.stateRetentionPassRows > 0
                    ? Math.max(1000, Number(Config.stateRetentionPassPauseMs) || 60000)
                    : Math.max(60000, Number(Config.stateRetentionIdlePauseMs) || (10 * 60 * 1000));
                this.stateRetentionPassRows = 0;
                this.nextStateRetentionAt = Date.now() + pauseMs;
            }
            Config.developerDiagnostics && Metrics.recordStateRetention(result || {}, durationMs, durationMs > budgetMs);
            return result;
        }).catch((error) => {
            Config.developerDiagnostics && Metrics.recordStateRetention({ errors: 1 }, Date.now() - startedAt);
            FailureLog.note('db.state_retention', error);
            return null;
        }).finally(() => {
            BackgroundWorkGovernor.complete(admission.lease, { durationMs: Date.now() - startedAt });
            this.stateRetentionRunning = false;
        });
    },

    resolveColdState(state, workerRequest = null, options = {}) {
        // A bot in a trade meeting preparation takes no step until it ends: its answer
        // waits, and the worker holds the bot until the end republishes its row
        // (TradeMeetingService.discard), else the unchanged row would step it again at once.
        if (invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(state.characterId)) {
            return Promise.resolve({ ok: true, pending: true, waiting: true, state });
        }
        if (workerRequest?.precomputedPlan?.statsPacket) options = { ...options, statsPacket: workerRequest.precomputedPlan.statsPacket };
        // The worker's plan of the step: the projection reads its held leaf (arrived_town:own).
        if (workerRequest?.precomputedPlan) options = { ...options, stepPlan: workerRequest.precomputedPlan };
        const startedAt = Date.now();
        if (require('./RaidSupplyPolicy').held(state, startedAt)) {
            const result = workerRequest?.precomputedResult || BackgroundResolver.resolveSolo({ state, timestamp: startedAt });
            return LifeState.applyResolve(state, result, options).then(async saved => {
                if (!saved) return { ok: false, reason: 'state_write_rejected', state };
                let current = saved;
                if (current.activity === 'shopping') {
                    const purchase = await ColdMarketService.tryPurchase(current, null);
                    current = purchase.state || current;
                    if (!purchase.pending && !LifeState.hotRow(current.characterId)
                        && !invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(current.characterId)) {
                        current = await ColdMarketService.finishTownErrands(current, { raidSupplyOnly: true });
                        const returning = GoalExecutor.finishMarketVisit(current);
                        if (returning) current = await LifeState.upsertState(returning, 'raid_supply_return') || current;
                    }
                }
                await LifeEvents.recordMany(state.characterId, result.events || []);
                return { ok: true, state: current, debug: result.debug };
            });
        }
        const entryResult = this.resolveColdEntryBranch(state, options, startedAt, workerRequest?.hallVisit === true);
        if (entryResult !== COLD_RESOLVE_NEXT) return entryResult;
        const precomputedResult = workerRequest?.precomputedResult || null;
        if (joinedBackgroundParty(state)) {
            Config.developerDiagnostics && Metrics.recordSkippedResolve('joined_party_before_resolve');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }
        // With a worker result the fight already happened: the transition
        // branch below applies it first and then starts the cleanup trip.
        const cleanupAfterFight = !!precomputedResult && state.activity !== 'shopping'
            && !!inventoryCleanupGoal(state);
        const cleanupState = precomputedResult ? null : inventoryCleanupTravelState(state, startedAt);
        if (cleanupState) return this.resolveColdCleanupTravel(state, cleanupState, startedAt);
        const elapsedMs = stepElapsedMs(state, startedAt);
        // These transitions have no planning, market search, or inventory work
        // between their persisted deadline and the next state change.
        if (cleanupAfterFight || state.activity === 'traveling'
            || (state.activity === 'resting' && Number(state.stats?.restUntil || 0) > 0)) {
            return this.resolveColdTransition(state, workerRequest, options, precomputedResult, cleanupAfterFight, elapsedMs, startedAt);
        }
        const serviceResult = this.resolveColdServiceBranch(state, startedAt, workerRequest?.precomputedPlan?.buildTaken === true);
        if (serviceResult !== COLD_RESOLVE_NEXT) return serviceResult;
        const staleShopping = BackgroundResolver.staleShopping(state);
        const passiveActivity = ['traveling', 'shopping', 'merchant', 'crafting', 'dead'].includes(state?.activity) && !staleShopping;
        const workerPlan = workerRequest?.precomputedPlan || null;
        const previousPlan = workerPlan ? workerPlan.previousPlan : state.stats?.equipmentPlan;
        // The worker's gear plan (source and replacement included) is applied
        // as is: main does not pick a source again.
        let replanContext = { failure: workerPlan?.replanFailure || null };
        let acquisitionPlan = workerPlan?.acquisitionPlan || null;
        if (!acquisitionPlan) {
            acquisitionPlan = previousPlan;
            replanContext = {};
            this.planDeferred = Number(this.planDeferred || 0) + 1;
        }
        // The background thread's request, built with the bot's economy for
        // the plan it sent; none when the worker sent no plan for that target.
        // Without a worker plan the saved request stands (a served card carries the
        // held one: it is held until the next build).
        const partyRequest = !workerPlan ? state.stats?.partyRequest || null
            : Number(workerPlan.acquisitionPlan?.target?.selfId || 0) === Number(acquisitionPlan?.target?.selfId || 0)
                ? workerPlan.partyRequest || null : null;
        const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
        if (partyRequest) plannedStats.partyRequest = partyRequest;
        else delete plannedStats.partyRequest;
        const plannedState = {
            ...state,
            stats: plannedStats
        };
        const planEvents = CraftTelemetry.planEvents(state, previousPlan, acquisitionPlan);
        if (replanContext.failure) {
            planEvents.push(acquisitionFallbackEvent(state, previousPlan, replanContext.failure, acquisitionPlan));
        }
        if (plannedState.activity === 'crafting') return this.resolveColdCraft(state, plannedState, startedAt);
        // The spot is the worker's route (BotRoute.choose: a party waiter's safe
        // fallback too, PartyWaitFallback): main chooses none (situations.md §8).
        const routedState = plannedState;
        const travellingState = ColdCraftingService.beginTravel(routedState, Date.now(), { decided: workerPlan?.buildTaken === true }) || routedState;
        const travel = travellingState.stats?.travel;
        const travelEvents = travellingState !== plannedState && travel?.stationId
            ? [CraftTelemetry.stationTravelEvent(plannedState, travel)]
            : [];
        // Craft availability can change after the worker planned a hunt (for
        // example, a clan warehouse handoff). Persist this transition directly;
        // applying the earlier combat/travel result would overwrite the trip.
        if (travellingState !== routedState) {
            return this.resolveColdCraftTravel(state, travellingState, travel, planEvents, travelEvents, startedAt);
        }
        // A worker result is a fight at the worker's spot (its command's route);
        // this command never starts a trip of its own: the worker is routed by its
        // own plan (BotRoute) from the state this command writes.
        const selectedSpot = passiveActivity ? null : commandSpot(workerRequest?.route);
        const effectiveState = travellingState;
        const spot = effectiveState.activity === 'traveling' ? null : selectedSpot;
        if (!spot && !passiveActivity && effectiveState.activity !== 'traveling') {
            return this.resolveColdMissingSpot(state, plannedState, startedAt);
        }

        const result = precomputedResult || BackgroundResolver.resolveSolo({
            state: effectiveState,
            spot,
            spotHunters: SpotProfiles.spotHunters(spot),
            targetNpcId: directDropTargetNpcId(acquisitionPlan),
            elapsedMs
        });

        if (joinedBackgroundParty(state)) {
            Config.developerDiagnostics && Metrics.recordSkippedResolve('joined_party_after_planning');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }

        return LifeState.applyResolve(effectiveState, result, { ...options, ...(workerPlan?.statsPacket ? { statsPacket: workerPlan.statsPacket } : {}) })
            .then((updatedState) => this.applyColdResolve(state, updatedState, workerPlan, result, spot, acquisitionPlan, planEvents, travelEvents))
            .then((outcome) => this.reviewColdOutcomeAfterCommit(state, outcome, options))
            .finally(() => {
                if (workerPlan?.economyDecision) ColdSimulationCoordinator.economyDecisions.release(state.characterId);
                Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt);
            });
    },

    // workerHall: the worker sent a hall or guide visit (its placeholder result); a
    // visit main does not take here falls through on that empty result.
    resolveColdEntryBranch(state, options, startedAt, workerHall = false) {
        // The rebuff's guide answer (ColdGuideVisit), then its hall answer, a hall
        // visit under way or a restart in the hall (ColdVisit).
        const guide = invoke('GameServer/Bot/Population/ColdGuideVisit');
        if (!joinedBackgroundParty(state) && guide.pending(state)) return guide.resolve(state, startedAt, options);
        const hallVisit = invoke('GameServer/ClanHall/ColdVisit');
        const visit = !joinedBackgroundParty(state) && hallVisit.needed(state);
        if (workerHall) Config.developerDiagnostics && Diagnostics.count('hall_visit', visit ? 'visit' : 'fall_through');
        if (visit) {
            // ARCH-NOTE: Hall dispatch bypasses the ordinary resolve branch; keep Main's captured admission through its inner writer.
            return hallVisit.resolve(state, startedAt, options);
        }
        if (PartyMarketBreak.ready(state)) return resumePartyMarketBreak(state, startedAt);
        const karmaPolicy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
        const karmaPlan = karmaPolicy.active(state) ? karmaPolicy.plan(state, SpotProfiles.ensure(), startedAt) : null;
        if (karmaPlan && !joinedBackgroundParty(state)) {
            const result = BackgroundResolver.resolveSolo({ state: karmaPlan.plannedState,
                spot: karmaPlan.spot, spotHunters: SpotProfiles.spotHunters(karmaPlan.spot),
                targetNpcId: karmaPlan.targetNpcId, timestamp: startedAt,
                elapsedMs: stepElapsedMs(state, startedAt) });
            return LifeState.applyResolve(karmaPlan.plannedState, result, options)
                .then(saved => ({ ok: !!saved, state: saved || state, debug: result.debug }));
        }
        return COLD_RESOLVE_NEXT;
    },

    resolveColdCleanupTravel(state, cleanupState, startedAt) {
        const { cleanup, ...travelState } = cleanupState;
        return LifeState.upsertState(travelState, 'inventory_cleanup_market_travel')
                .then((saved) => (saved ? {
                    ok: true,
                    state: saved,
                    debug: {
                        activity: 'inventory_cleanup_travel',
                        slots: cleanup.itemCount,
                        npcOnlySlots: cleanup.npcOnlySlots,
                        reason: cleanup.cleanupReason
                    }
                } : {
                    ok: false,
                    reason: 'state_write_rejected',
                    state
                }))
                .finally(() => Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt));
    },

    resolveColdTransition(state, workerRequest, options, precomputedResult, cleanupAfterFight, elapsedMs, startedAt) {
        const result = precomputedResult || BackgroundResolver.resolveSolo({
            state,
            spot: null,
            elapsedMs,
            timestamp: startedAt
        });
        if (joinedBackgroundParty(state)) {
            Config.developerDiagnostics && Metrics.recordSkippedResolve('joined_party_during_transition');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }
        return LifeState.applyResolve(state, result, options).then((updatedState) => {
            if (!updatedState) {
                Config.developerDiagnostics && Metrics.recordSkippedResolve('transition_apply_failed');
                return { ok: false, reason: 'apply_failed', state };
            }
            if (workerRequest?.precomputedPlan?.economyDecision) ColdSimulationCoordinator.economyDecisions
                .hold(updatedState.characterId, workerRequest.precomputedPlan.economyDecision, updatedState);
            Config.developerDiagnostics && Metrics.recordBackgroundResolve();
            Config.developerDiagnostics && Metrics.recordCombat(result.debug);
            const recoveredForMarket = state.activity === 'resting' && canResumeWarehouseMarketSale(updatedState);
            const cleanupTrip = cleanupAfterFight
                ? inventoryCleanupTravelState(PartyMarketBreak.withoutStartedTrip(state, updatedState), startedAt)
                : null;
            if (cleanupTrip) delete cleanupTrip.cleanup;
            const marketHandoff = cleanupTrip
                ? LifeState.upsertState(cleanupTrip, 'inventory_cleanup_market_travel').then((saved) => saved || updatedState)
                : recoveredForMarket
                ? Promise.resolve().then(async () => {
                    const travelState = await marketTravelWithRefund(updatedState, NeedsEvaluator.goal(updatedState), Date.now());
                    return travelState
                        ? LifeState.upsertState(travelState, 'goal_market_travel_after_recovery').then((saved) => saved || travelState)
                        : LifeState.cachedState(updatedState.characterId) || updatedState;
                }).catch((err) => {
                    utils.infoWarn('BotGoals', 'post-recovery market handoff failed for %s: %s', state.name, err.message);
                    return updatedState;
                })
                : Promise.resolve(updatedState);
            return marketHandoff.then((finalState) => LifeEvents.recordMany(state.characterId, result.events).then(() => ({
                ok: true,
                state: finalState,
                debug: result.debug
            })));
        }).finally(() => {
            if (workerRequest?.precomputedPlan?.economyDecision) ColdSimulationCoordinator.economyDecisions.release(state.characterId);
            Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    // buildTaken: the worker's step took the build (F6: the Mammon trip is a side errand).
    resolveColdServiceBranch(state, startedAt, buildTaken = false) {
        const MammonUnseal = invoke('GameServer/Bot/AI/BotMammonUnseal');
        if (state.activity === 'crafting' && state.stats?.mammonReturn) {
            return MammonUnseal.finish(state,startedAt)
                .then(next => LifeState.upsertState(next,'mammon_unseal_complete'))
                .then(saved => ({ok:!!saved,state:saved || state}));
        }
        const mammonTravel = buildTaken && MammonUnseal.beginTravel(state,startedAt);
        if (mammonTravel) {
            return LifeState.upsertState(mammonTravel,'mammon_unseal_travel')
                .then(saved => ({ok:!!saved,state:saved || state}));
        }
        if (GearAcquisitionPlanner.isCraftService(state)) {
            const { equipmentPlan, ...serviceStats } = state.stats || {};
            const serviceState = {
                ...state,
                timing: { ...(state.timing || {}), nextResolveAt: null },
                stats: serviceStats
            };
            return LifeState.upsertState(serviceState, 'craft_service_idle')
                .then((saved) => ({ ok: true, state: saved || serviceState, debug: { activity: 'craft_service_idle' } }))
                .finally(() => Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        return COLD_RESOLVE_NEXT;
    },

    resolveColdCraft(state, plannedState, startedAt) {
        return ColdCraftingService.craft(plannedState).then(async (craft) => {
            const completed = craft.reason === 'crafted'
                || craft.reason === 'component_crafted'
                || craft.reason === 'dual_sword_combined';
            const reason = craft.reason === 'component_crafted'
                ? 'cold_component_craft_complete'
                : craft.reason === 'dual_sword_combined'
                    ? 'cold_dual_sword_combine_complete'
                    : craft.reason === 'crafted' ? 'cold_craft_complete' : 'cold_craft_wait';
            // A persisted plan can say ready_to_craft even when an earlier
            // component craft consumed the raw inputs for the next batch,
            // or a station may be temporarily unavailable. Do not pin the
            // bot at a station: re-enter hunting so the acquisition planner
            // can select the missing material again.
            let recoveredState = !completed && craft.state?.activity !== 'traveling'
                ? {
                    ...(craft.state || plannedState),
                    activity: 'hunting',
                    stats: {
                        ...((craft.state || plannedState).stats || {}),
                        travel: null
                    },
                    timing: {
                        ...((craft.state || plannedState).timing || {}),
                        nextResolveAt: Date.now() + 30000
                    }
                }
                : craft.state || plannedState;
            // A rejection raised on the row (its own writer): the saved state is
            // built on the raised row's revision and carries its raised mind.
            const raised = !completed && ['materials_changed', 'missing_product', 'missing_station', 'insufficient_adena'].includes(craft.reason)
                ? await DecisionEvents.rejectOnRow(recoveredState, plannedState, `craft:${craft.reason}`) : null;
            if (raised) recoveredState = DecisionEvents.withRaise(recoveredState, raised);
            return LifeState.upsertState(recoveredState, reason).then(async (saved) => {
                if (saved && craft.reason === 'component_crafted' && saved.activity !== 'crafting'
                    && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(saved)
                    && require('../Economy/CraftWarehousePolicy').planFor(saved)) {
                    const deposit = await BotWarehouse.depositCold(saved);
                    saved = deposit.state || saved;
                }
                const supplemented = craft.supplementedMaterials || [];
                const supplyEvent = supplemented.length
                    ? LifeEvents.record(state.characterId, 'craft_supplemented', `${state.name} received ${supplemented.map((item) => `${item.amount} ${item.name}`).join(', ')} for crafting`, {
                        recipeId: craft.recipeId,
                        materials: supplemented
                    }, 2)
                    : Promise.resolve(null);
                if (!completed) return supplyEvent.then(() => ({ ok: true, state: saved || craft.state || plannedState, debug: craft }));
                const eventType = craft.reason === 'component_crafted'
                    ? 'component_craft'
                    : craft.reason === 'dual_sword_combined' ? 'dual_sword_combine' : 'equipment_craft';
                const quantity = Math.max(1, Number(craft.batchCount || 1));
                const verb = craft.reason === 'dual_sword_combined' ? 'combined' : 'crafted';
                const summary = `${state.name} ${verb} ${quantity > 1 ? `${quantity}x ` : ''}${craft.productName} at ${craft.stationId}`;
                return supplyEvent.then(() => LifeEvents.record(state.characterId, eventType, summary, {
                    recipeId: craft.recipeId,
                    productId: craft.productId,
                    stationId: craft.stationId
                }, ['crafted', 'dual_sword_combined'].includes(craft.reason) ? 3 : 2)).then(() => (
                    { ok: true, state: saved || craft.state || plannedState, debug: craft }
                ));
            });
        })
            .finally(() => Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt));
    },

    resolveColdCraftTravel(state, travellingState, travel, planEvents, travelEvents, startedAt) {
        const craftTravel = { ...travellingState, timing: { ...travellingState.timing,
            activityStartedAt: startedAt, nextResolveAt: travel.arrivalAt } };
        return LifeState.upsertState(craftTravel, 'cold_craft_travel').then(async saved => {
            if (!saved) return { ok: false, reason: 'state_write_rejected', state };
            await LifeEvents.recordMany(state.characterId, [...planEvents, ...travelEvents]);
            return { ok: true, state: saved, debug: { activity: 'craft_travel', fights: 0, wins: 0 } };
        }).finally(() => Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt));
    },

    resolveColdMissingSpot(state, plannedState, startedAt) {
        Config.developerDiagnostics && Metrics.recordSkippedResolve('missing_spot');
        Config.developerDiagnostics && Metrics.recordResolveDuration(Date.now() - startedAt);
        const retryAt = startedAt + 30000;
        const waiting = { ...plannedState, activity: 'resting',
            timing: { ...plannedState.timing, nextResolveAt: retryAt },
            stats: { ...plannedState.stats, restUntil: retryAt,
                routeRecovery: { reason: 'missing_spot', at: startedAt,
                    attempts: Number(state.stats?.routeRecovery?.attempts || 0) + 1 } } };
        return LifeState.upsertState(waiting, 'missing_spot_recovery').then(saved => ({
            ok: !!saved, reason: saved ? 'missing_spot_recovery' : 'state_write_rejected',
            state: saved || state, debug: { fights: 0, wins: 0, reason: 'missing_spot' }
        }));
    },

    async applyColdResolve(state, updatedState, workerPlan, result, spot, acquisitionPlan, planEvents, travelEvents) {
        if (!updatedState) {
            Config.developerDiagnostics && Metrics.recordSkippedResolve('cold_apply_failed');
            return { ok: false, reason: 'apply_failed', state };
        }
        if (workerPlan?.economyDecision) ColdSimulationCoordinator.economyDecisions.hold(updatedState.characterId, workerPlan.economyDecision, updatedState);
        // The step's writes below hold to the worker that planned it and to a far bot:
        // a replaced worker or a bot gone hot writes nothing.
        const sourceWorker = ColdSimulationCoordinator.worker, sourceEpoch = ColdSimulationCoordinator.workerEpoch;
        const beforeWrite = () => {
            if (ColdSimulationCoordinator.stopping || ColdSimulationCoordinator.worker !== sourceWorker
                || ColdSimulationCoordinator.workerEpoch !== sourceEpoch)
                throw new WorkerCommandAdmissionRefusal('stale_worker_source');
            if (ColdSimulationCoordinator.fencedBots?.has(updatedState.characterId)
                || LifeState.cachedState(updatedState.characterId)?.phase !== 'cold')
                throw new WorkerCommandAdmissionRefusal('hot_handoff_fenced');
        };

        // Every ordinary town visit publishes its worker-selected stock
        // before native errands can finish the visit and leave town.
        let correctedBids = false;
        const checked = await BotAfkMarketService.reviewPurchaseLimits(updatedState);
        updatedState = checked.state || updatedState;
        correctedBids = checked.changed;
        // A correction changed the owner's board revision. Its earlier
        // optional plan waits for fresh preparation, rather than replaying it.
        // A selling visit's own sale (open) decides the bag: the worker showcase
        // first would make two pricers fight over it. A forced cleanup keeps
        // the author's path (E306).
        if (updatedState.activity === 'shopping' && workerPlan?.economyPlan && !correctedBids
            && (!visitSells(updatedState) || updatedState.stats?.forcedMarketCleanup)) {
            const board = await BotAfkMarketService.executePlan(updatedState, workerPlan.economyPlan,
                { reviewGoal: false, beforeWrite });
            updatedState = board.state || updatedState;
            // A deal of the plan staged a meeting preparation the bot pays in: the visit stops
            // at the staging point with no write of its own (its write voids its consent, read at
            // its revision). The round (applyResolve above) is written: its events are recorded
            // once here, with that write; the rest of the visit runs on the step after the
            // preparation ends (the answer waits for it), a new round with its own events.
            if (TradeMeetingService.paysInPreparation(updatedState.characterId)) {
                await LifeEvents.recordMany(state.characterId, [...planEvents, ...travelEvents, ...result.events,
                    ...CraftTelemetry.progressEvents(state, acquisitionPlan, updatedState)]);
                return { ok: true, pending: true, waiting: true, state: updatedState, debug: result.debug };
            }
        }

        Config.developerDiagnostics && Metrics.recordBackgroundResolve();
        Config.developerDiagnostics && Metrics.recordCombat(result.debug);
        // The one place a far bot carries out its held improvement (reviewCold owns where it may:
        // an enchant anywhere, a henna or a smith's work in a town that has the NPC), first in
        // the step's work: a visit draws the henna it came for before it buys, sells and leaves
        // (a review after the commit found the bot already on its way out of town). Consumed
        // inputs retire the card; the rest of the visit runs on the improved bag and, as after a
        // purchase, the bot stays for one pass that replans from it (a crystallization's exchange).
        const decision = ColdSimulationCoordinator.economyDecisions.decided(updatedState);
        let improved = false;
        if (decision?.activity?.activity === 'improving') {
            const review = await invoke('GameServer/Bot/Economy/BotImprovementService')
                .reviewCold(updatedState, { beforeWrite, decide: () => decision });
            if (review.changed) {
                ColdSimulationCoordinator.economyDecisions.release(updatedState.characterId);
                exchangeWaits.delete(Number(updatedState.characterId));
                improved = true;
            }
            updatedState = review.state || updatedState;
        }
        if (updatedState.activity === 'crafting') {
            return { ok: true, state: updatedState, debug: result.debug };
        }
        const tripEdge = CombinedErrands.edge(state, updatedState, result);
        const preparation = ColdShotEconomyService.review(updatedState, Date.now(), { edge: tripEdge })
            .then(async (shotEconomy) => {
                const current = shotEconomy.state || updatedState;
                const inTown = invoke('GameServer/Bot/Economy/BotImprovementService').inTown(current);
                const released = inTown ? await BotWarehouse.releaseCold(current, { inTown: true, before: state }) : { state: current };
                const afterRelease = released.state || current;
                const deposited = inTown && !released.aborted && (afterRelease.stats?.equipmentPlan?.inputPreparation
                    || require('../Economy/CraftWarehousePolicy').planFor(afterRelease))
                    && invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(afterRelease)
                    ? await BotWarehouse.depositCold(afterRelease) : { state: afterRelease };
                return ColdMarketListingService.resolve(deposited.state || afterRelease);
            });
        // The goal on arrival: the held card's step over the bag as the visit found it.
        return preparation.then((marketLifecycle) => {
            const goal = NeedsEvaluator.goal(marketLifecycle.state);
            return (heldVisit(marketLifecycle.state)
                ? Promise.resolve({ state: marketLifecycle.state, purchased: false, reason: 'other_town_deferred' })
                : ColdMarketService.tryPurchase(marketLifecycle.state, goal))
                .then((marketResult) => ({ marketLifecycle, marketResult, goal }));
        })
            .then(({ marketLifecycle, marketResult, goal }) => this.finishColdMarketStep(updatedState, workerPlan, spot, tripEdge, marketLifecycle,
                improved ? { ...marketResult, improved } : marketResult, goal))
            .then((finalState) => {
                const craftEvents = CraftTelemetry.progressEvents(state, acquisitionPlan, updatedState);
                return LifeEvents.recordMany(state.characterId, [...planEvents, ...travelEvents, ...result.events, ...craftEvents])
                    .then(() => finalState);
            })
            .then(async (finalState) => {
                // A side errand on a taken build only (F6, temporary until step 6).
                const trip = workerPlan?.buildTaken === true && !LifeState.hotRow(finalState.characterId)
                    && BotWarehouse.beginCraftReturn(finalState, Date.now(), { decided: true });
                if (trip) finalState = await LifeState.upsertState(trip, 'craft_warehouse_return') || finalState;
                // A bot that went hot meanwhile speaks through its own AI.
                if (finalState.phase !== 'hot') GlobalChat.maybeAnnounce(finalState, result.events);
                return {
                    ok: true,
                    state: finalState,
                    debug: result.debug
                };
            });
    },

    finishColdMarketStep(updatedState, workerPlan, spot, tripEdge, marketLifecycle, marketResult, goal) {
        const purchasedState = marketResult.state || marketLifecycle.state || updatedState;
        if (marketResult.pending) return purchasedState;
        // The bot was activated while the market step ran (the activation fence waits
        // 500 ms at most): its row is the actor's now; nothing cold is written over it.
        const hotRow = LifeState.hotRow(purchasedState.characterId);
        if (hotRow) return hotRow;
        // marketResult.improved: the step carried out its held improvement (applyColdResolve).
        if (marketResult.purchased || marketResult.improved) {
            exchangeWaits.delete(Number(purchasedState.characterId));
            const batchState = {
                ...purchasedState,
                activity: 'shopping',
                timing: {
                    ...(purchasedState.timing || {}),
                    activityStartedAt: Number(purchasedState.timing?.activityStartedAt || Date.now()),
                    nextResolveAt: Date.now() + 1000
                }
            };
            // Keep the bot in town for one prompt follow-up pass.
            // The next scheduler tick replans from the purchased (or improved)
            // inventory and can buy another item in this same town
            // without returning to the hunting ground in between.
            return LifeState.upsertState(batchState, 'market_batch_continue')
                .then((saved) => saved || batchState);
        }
        const listingIntent = marketListingIntent(purchasedState, goal);
        // A sale trip must reach the buyers and its sale retry, which only open does.
        const listingPromise = !marketLifecycle.closed && listingIntent.shouldOpen
            && (!workerPlan?.economyPlan || listingIntent.cleanup || listingIntent.saleVisit)
            ? openMarketListing(listingIntent, goal)
            : Promise.resolve({ state: purchasedState, listed: false });
        const marketStatePromise = listingPromise.then(async (listingResult) => {
            let listingState = listingResult.state || purchasedState;
            if (listingResult.pending) {
                // The sale retry of a deal through a meeting is on the row already
                // (ColdMarketListingService.open saves it before the answers): a save
                // here would move the revision the staged meeting recorded. The fresh
                // row may carry a meeting marker. A deal still preparing, or accepted
                // as a meeting, keeps the bot in town; a refused one ends the visit
                // below as every other sale outcome (E311).
                const id = listingState.characterId;
                if (LifeState.hotRow(id)) return LifeState.hotRow(id);
                listingState = LifeState.cachedState(id) || listingState;
                if (TradeMeetingService.hasPreparation(id) || listingState.stats?.tradeMeeting) return listingState;
            }
            if (listingResult.listed && listingState.activity !== 'shopping') return listingState;
            const sale = saleVisit(listingState);
            return ColdMarketService.finishTownErrands(listingState, { saleVisit: sale }).then((restockedState) => {
                if (LifeState.hotRow(restockedState.characterId)) return LifeState.hotRow(restockedState.characterId);
                // A deal in preparation keeps the bot in town: a sale visit saved its
                // end before the meeting was staged (ColdMarketService.finishTownErrands).
                if (TradeMeetingService.hasPreparation(restockedState.characterId)) return restockedState;
                // So does a meeting accepted while the errands ran (its marker on the row,
                // not on the state this step began from): the meeting holds the bot and its
                // end resumes the visit. Ended here, the bot went home with the meeting
                // still accepted and its leg restarted from the field.
                const meeting = LifeState.cachedState(restockedState.characterId);
                if (meeting?.stats?.tradeMeeting) return meeting;
                const improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
                const continuation = improvement.acquisitionTravel(restockedState,
                    ColdSimulationCoordinator.economyDecisions.activity(restockedState));
                if (continuation) return LifeState.upsertState(continuation, 'equipment_improvement_travel');
                // A paid-for C piece waits for a fresh worker command in town.
                // Returning to the field here loses the purchase -> break ->
                // exchange handoff when the purchase retired the previous card.
                // One wait per key until the next buy or improvement: a worker
                // that does not answer with the improving card on it has chosen
                // otherwise, and its later card brings the bot back (acquisitionTravel).
                const crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
                const id = Number(restockedState.characterId);
                const exchangeKey = restockedState.activity === 'shopping' && crystals.ready(restockedState)
                    && crystals.completionKey(restockedState);
                if (!exchangeKey) exchangeWaits.delete(id);
                else if (exchangeWaits.get(id) !== exchangeKey) {
                    exchangeWaits.set(id, exchangeKey);
                    return LifeState.upsertState({ ...restockedState, timing: { ...restockedState.timing,
                        nextResolveAt: Date.now() + 1000 } }, 'equipment_exchange_continue').then(saved => {
                        // The paid piece waits for its exchange: the purchase's goal is done.
                        if (saved) DecisionEvents.raiseOn(saved.characterId, 'goal_done:goal');
                        return saved || restockedState;
                    });
                }
                const returnState = GoalExecutor.finishMarketVisit(restockedState);
                if (returnState) exchangeWaits.delete(id);
                return returnState
                    ? LifeState.upsertState(returnState, 'market_visit_complete').then((saved) => saved || returnState)
                    : restockedState;
            });
        });
        return marketStatePromise.then((persistedState) => persistedState || purchasedState)
            .then((marketState) => {
            if (TradeMeetingService.hasPreparation(marketState.characterId) || marketState.stats?.tradeMeeting) return marketState;
            // The needs after the visit's purchases and sales: read once for the board
            // reconcile and the trip below. A failed read is no goal (none): the
            // reconcile does not evaluate them again.
            return Promise.resolve().then(() => NeedsEvaluator.needs(marketState)).catch((err) => {
            FailureLog.note('population.goal_read', err);
            return [];
        }).then(async (needs) => {
            const goal = needs?.[0] || null;
            const remote = await BotAfkMarketService.reconcile(marketState, goal, needs);
            const current = remote.state || marketState;
            // forState unloads only where the bag alone does (the mana floor comes first), so
            // the cheap bag floor answers the common no; one moment for both reads.
            const now = Date.now();
            const travelState = tripEdge || (SurvivalFloor.bagFor(current, now)?.action === 'unload'
                && SurvivalFloor.forState(current, now)?.action === 'unload')
                ? GoalExecutor.beginMarketTravel(current, goal, Date.now()) : null;
            return travelState ? LifeState.upsertState(travelState, 'goal_market_travel') : current;
        });
        });
    },

    async reviewColdOutcomeAfterCommit(state, outcome, options) {
        if (outcome?.ok && !options.workerAdmission
            && !invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(state.characterId)) {
            const current = LifeState.cachedState(state.characterId) || outcome.state;
            if (current) outcome.state = await LifeState.reviewTrainingAfterCommit(current) || current;
        }
        // Native errands can start a new trip after publishing the bids.
        // Finish this owner's resolve against that final route and money
        // packet, including recovery and preparation-pending branches.
        if (outcome?.ok && outcome.state && !TradeMeetingService.paysInPreparation(state.characterId)) {
            const checked = await BotAfkMarketService.reviewPurchaseLimits(outcome.state);
            outcome.state = checked.state || outcome.state;
        }
        return outcome;
    },

    async executeWorkerLifecycleCommand(state, request = {}, options = {}) {
        try {
            checkWorkerCommandAdmission(state, options);
            if (!request.precomputedResult) {
                return Promise.resolve({ ok: false, reason: 'worker_result_required', state });
            }
            if (require('./RaidSupplyPolicy').held(state)) return await this.resolveColdState(state, request, options);
            const card = request.precomputedPlan?.economyDecision;
            const acquisitionLeaf = card && invoke('GameServer/Bot/Population/ColdEconomyDecision').compact(card).activity;
            const acquisitionTravel = invoke('GameServer/Bot/Economy/BotImprovementService')
                .acquisitionTravel(state, acquisitionLeaf);
            if (acquisitionTravel) {
                const saved = await LifeState.upsertState(acquisitionTravel, 'equipment_improvement_travel');
                const checked = saved && await BotAfkMarketService.reviewPurchaseLimits(saved);
                return { ok: !!saved, state: checked?.state || saved || state,
                    reason: saved ? 'equipment_improvement_travel' : 'state_write_rejected' };
            }
            return await this.resolveColdState(state, request, options);
        } catch (error) {
            if (!(error instanceof WorkerCommandAdmissionRefusal)) throw error;
            // The row moved past the cache: the next command must carry the row's checkpoint.
            if (Array.isArray(error.checkpointDrift) && error.checkpointDrift.length) {
                await LifeState.reloadRow(state?.characterId, error.checkpointDrift);
            }
            const latest = LifeState.cachedState(state?.characterId);
            return { ok: false, reason: error.message, retryAfterMs: 1000, ...(latest ? { state: latest } : {}) };
        }
    },

    // need: the worker's forced cleanup verdict the proposal carries (cleanupNeed).
    prepareInventoryCleanupProposal(state, timestamp = Date.now(), simulation = null, before = state, need = undefined) {
        return inventoryCleanupTravelState(PartyMarketBreak.withoutStartedTrip(before, state), timestamp, simulation, need);
    },

    reserveCompetitionPartySlot() {
        return Config.backgroundPartyEnabled ? partyAdmission.reserve(BackgroundPartyState.admitted(), Config) : null;
    },

    async formClanWarParty(members, operation) {
        if (!this.started || this.partyFormationRunning || this.resolving || members.length < 3 || members.length > 9) return null;
        const release = Config.backgroundPartyEnabled
            ? partyAdmission.reserveWar(BackgroundPartyState.admitted(), Config, operation.clanId) : null;
        if (!release) {
            this.lastClanWarFormation = { at: Date.now(), clanId: operation.clanId, reason: 'party_capacity_wait' };
            return null;
        }
        this.partyFormationRunning = true;
        const ids = members.map(s => s.characterId);
        try {
            const fenced = await Promise.all(ids.map(id => ColdSimulationCoordinator.fenceBot(id)));
            if (fenced.some(r => !r.ok)) {
                this.lastClanWarFormation = { at: Date.now(), clanId: operation.clanId, reason: 'member_busy' };
                return null;
            }
            await LifeState.settleWrites(ids);
            const current = ids.map(id => LifeState.cachedState(id));
            if (!this.started || current.some(s => !s || s.party?.partyId || s.partyId
                || !require('../../Clan/ClanWarPolicy').available(s, Date.now()))) {
                this.lastClanWarFormation = { at: Date.now(), clanId: operation.clanId, reason: 'roster_changed' };
                return null;
            }
            const leader = PartyComposition.chooseLeader(current), timestamp = Date.now();
            const home = { ...operation, homeSpotId: leader.spotId, homeLoc: { ...leader.loc } };
            home.homeLoc = require('./ClanWarHome').point(home);
            if (!home.homeLoc) {
                this.lastClanWarFormation = { at: timestamp, clanId: operation.clanId, reason: 'home_unavailable' };
                return null;
            }
            const party = { partyId: `war_${timestamp.toString(36)}_${leader.characterId}`, leaderId: leader.characterId,
                memberIds: ids, spotId: leader.spotId, status: 'active', startedAt: timestamp, nextResolveAt: timestamp + 1000,
                roleCoverage: PartyComposition.roleCoverage(current), cohesion: 0.75, risk: 0.3,
                stats: { formedAt: timestamp, warOperation: home, memberGoals: current.map(PartyGoalPolicy.declaration) } };
            const result = await commitPartyMembership(party, current, { characterId: leader.characterId, eventType: 'clan_war_assembly',
                summary: 'Clan assembled a war party', meta: { operationId: operation.id, enemyClanId: operation.enemyClanId }, weight: 3, createdAt: timestamp });
            this.lastClanWarFormation = { at: timestamp, clanId: operation.clanId, reason: result.party ? 'formed' : result.reason || 'membership_refused' };
            return result.party || null;
        } finally {
            this.formationEnded(); release();
            ids.map(id => LifeState.cachedState(id)).filter(Boolean).forEach(s => ColdSimulationCoordinator.notifyState(s));
        }
    },

    async formCompetitionParty(members, event, options = {}) {
        if (!Config.backgroundPartyEnabled || members.length !== 2) return { rejected: 'party_disabled_or_invalid' };
        if (members.some(state => CraftMaterialParty.requestOf(state)))
            return { rejected: 'material_party_requires_review' };
        if (members.some(s => s.party?.partyId || s.partyId)) {
            const result = await invoke('GameServer/Bot/Population/ColdCompetitionRecruitment').recruit({ participants: members, event,
                parties: BackgroundPartyState, life: LifeState, memory: invoke('GameServer/Social/InteractionMemoryRuntime'),
                composition: PartyComposition, limitsFor: partyLimitsForObjective, clanReserved: requiresClanEquipmentParty,
                commit: commitPartyMembership, participantAllowed: options.participantAllowed });
            if (result.recruited) Config.developerDiagnostics && Metrics.recordPartyRecruit(result.recruited);
            return result;
        }
        if (members.some(state => requiresClanEquipmentParty(state))) return { rejected: 'clan_objective' };
        if (occupiedPartySlots() >= partyCapacityLimit()) { Situations.note('party:cap:hit'); return { rejected: 'party_capacity' }; }
        return createAndCommitBackgroundParty(members, {
                status: 'open', priority: 'preferred', reason: 'shared_target',
                objectiveKey: `competition:${event.spotId}:${event.npcId}`,
                spotId: event.spotId, npcId: event.npcId
        });
    },

    applyPartyStayTrips(party, trips, timestamp = Date.now()) {
        return applyPartyStayTrips(party, trips, timestamp);
    },

    coldWorkerSnapshot() {
        return ColdSimulationCoordinator.snapshot();
    },

    summary() {
        return Status.summary();
    },

    logSummary(reason = 'summary') {
        // Without diagnostics only the cheap cold-queue scan runs, for the line below.
        const summary = Config.developerDiagnostics ? this.summary() : { enabled: false, coldQueue: LifeState.coldDueSummary() };
        const coordinator = summary.line ? null : ColdSimulationCoordinator.snapshot();
        if (summary.line) console.info('BotPopulation :: %s %s', reason, summary.line);
        else console.info('BotPopulation :: %s %s %s', reason, Status.goalText(summary.coldQueue, coordinator), Status.nearText(coordinator));
        invoke('Perf/LiveRecorder').recordSummary(reason, summary, () => coordinator || ColdSimulationCoordinator.snapshot(),
            () => Status.vitals());
        // A bot due for over a minute is not normal (user 2026-10-17): name it
        // and say why it waits, one line per summary.
        const queue = summary.coldQueue || {};
        if (queue.oldest && queue.oldestAgeMs >= 60000) {
            const bot = queue.oldest, at = Date.now();
            const reason = ColdSimulationCoordinator.overdueReason(bot.characterId);
            // What the bot carries that makes the worker hold it on purpose.
            const held = LifeState.cachedState(bot.characterId);
            if (Config.developerDiagnostics) {
                Database.traceRevisions(bot.characterId);
                ColdSimulationCoordinator.traceBot(bot.characterId, { at, activity: bot.activity, nextResolveAt: held?.timing?.nextResolveAt,
                    lastResolvedAt: held?.timing?.lastResolvedAt, updatedAt: held?.updatedAt, revision: held?.simulation?.revision });
            }
            const carried = ['pvpEncounter', 'pveEncounter', 'tradeMeeting', 'travel', 'constPartySession']
                .filter(key => held?.stats?.[key]).join('+');
            console.info('BotPopulation :: overdue %s(%d) %s due %ds ago, last step %ds ago, reason %s%s, due total %d',
                bot.name, bot.characterId, bot.activity, Math.round(queue.oldestAgeMs / 1000),
                bot.lastResolvedAt > 0 ? Math.round((at - bot.lastResolvedAt) / 1000) : -1, reason,
                carried ? ` carries ${carried}` : '', queue.due);
        }
        return summary;
    }
};

PopulationService.arrivalPointForState = (state, spot) => SpotService.arrivalPointForState(state, spot);
PopulationService.walkerAppearance = walkerAppearance;
PopulationService.marketListingIntent = marketListingIntent;
PopulationService.openMarketListing = openMarketListing;
PopulationService.partyLimitsForObjective = partyLimitsForObjective;
PopulationService.requiresClanEquipmentParty = requiresClanEquipmentParty;
PopulationService.partyObjectivesShareRoute = partyObjectivesShareRoute;

module.exports = PopulationService;

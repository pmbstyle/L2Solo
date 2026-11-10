const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Material = require('./CraftMaterialParty');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Trace = require('../DecisionTrace');

// No solo ground -> a party: a healer or buffer (BotRoles)
// with no gear plan source to hunt (an active plan's next spot is its solo hunt) whose
// held earning answer (the solo spot it hunts, EquipmentIncomeRoute) names no spot, or
// ground its level does not fit (BotRoute.soloLevelFits at its solo target level: grey
// ground, the easier ground the earning search names when no camp near its level takes
// its kit, unless it hunts for gain there), has no solo ground: it asks for a party,
// as a C4 healer who can kill little alone looks for one, and hunts that grey
// ground alone meanwhile (BotRoute.huntSpot reads the answer, the request does not):
// forming's no closes the request and leaves it hunting there; its next build, at its
// own situations, asks again. Its solo side counts as none wherever a party is weighed
// against its solo hunt (PartyProgressComparison.heldSoloRoute: forming's verdict, its
// stay). earning, plan: the ones to read (the build's when it took them); no answer
// held yet: not known.
const NO_SOLO_GROUND = 'no_solo_ground';
function supportWithoutGround(state, spots, earning = state?.stats?.earning, plan = state?.stats?.equipmentPlan) {
    if (!earning || !(Roles.isHealer(state) || Roles.canBuff(state))) return false;
    if (plan?.status === 'active' && plan.next?.spotId) return false;
    const spot = earning.spotId ? invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, earning.spotId) : null;
    return !spot || !invoke('GameServer/Bot/Population/BotRoute').soloLevelFits(state, spot, // lazy: BotRoute's chain loads this planner
        invoke('GameServer/Bot/AI/LevelingRoutes').targetLevelForState(state, { mode: 'solo' }));
}

// A bot whose open request is that seeking (main's party assembly reads it:
// the persona's intent, the recruitment across parties).
function seeksParty(state) {
    const request = state?.stats?.partyRequest;
    return request?.status === 'open' && request.reason === NO_SOLO_GROUND;
}

// The seeking objective: a party of its level meets at the spot a party
// search finds for it (mode party: the level fit and the group's matchup,
// not its solo gate), so it groups with the bots that hunt there
// (objectiveKey = their spot key) and the askers of its band in the region
// (meetingKey), and joins parties that hunt there. The
// spot holds while the request is open; a reopened request searches again.
// Null: no such seeker, or no spot.
function seekObjective(state, previous, { spots, timestamp, economy = null, plan }) {
    if (state?.party?.partyId || !supportWithoutGround(state, spots, economy?.statsPacket?.earning || state?.stats?.earning, plan)) return null;
    const held = previous?.reason === NO_SOLO_GROUND && previous.status === 'open' ? previous.spotId : null;
    // lazy: cycle SpotProfiles' chain loads this planner
    const searched = held ? null : invoke('GameServer/Bot/Population/SpotProfiles').findForState({ ...state, spotId: null,
        stats: Object.fromEntries(Object.entries(state.stats || {}).filter(([key]) => key !== 'equipmentPlan')) },
    { profiles: spots, mode: 'party', timestamp });
    const spotId = held || searched?.id || null;
    if (!spotId) return null;
    return { status: 'open', priority: 'preferred', objectiveKey: `spot:${spotId}`, reason: NO_SOLO_GROUND,
        spotId, npcId: null, itemId: null, targetId: null };
}

// Party progress -> a party: a bot that would reach its next level (and the piece its
// path saves for) sooner in a party of two at its earning spot, itself and a partner of
// its level (PartyProgressComparison.partnerFor: a healer, a damage dealer for a healer),
// than solo there, its persona weighing it (PartyProgressComparison.compare: the same
// comparison forming's verdict then asks of the real roster), asks for a party on that
// ground (a C4 player's LFP), so it groups with the bots that hunt there and the askers
// of its band in the region (meetingKey). Asked at the build, as every request, but
// decided only when what it stands on moves (progressAskKey) and held between, in the
// bot's worker record (memo.progressAsk; no memo: decided every time). Counted as
// party_ask:decided:<reason> and party_ask:held (developer diagnostics). Null: no held
// answer with a spot, or solo is sooner. economy: the build's (its earning answer when
// the build took it with the request, else the held one).
const PARTY_PROGRESS = 'party_progress';
// What the ask stands on: the bot's class and level (its table rows, its partner, the
// level it aims at), its held earning answer (its time and spot: the solo row, renewed
// at its situations: a level, new gear, a death...), its persona (the party lean, the
// death weight, the belief error) and its saving goal (the price it saves for, its
// focus, its plan step and a request that names a piece, not one that only meets at a
// spot as this ask's own answer does: the piece's hours). Read when it decides, stale
// until one of these moves: the exp inside a level, the wallet, prices, samples and
// the crowd (as the held earning answer's own inputs).
function progressAskKey(state, earning) {
    const stats = state.stats || {}, traits = invoke('GameServer/Bot/AI/BotPersona').of(state)?.traits || {};
    const goal = row => row ? [row.spotId ?? null, row.npcId ?? null, row.itemId ?? null, row.strategy ?? row.kind ?? null, row.amount ?? null] : null;
    return JSON.stringify([stats.classId ?? state.classId ?? null, Number(state.level) || 0, earning.at ?? null, earning.spotId,
        traits.sociability ?? null, traits.caution ?? null, traits.resilience ?? null, traits.understanding ?? null,
        stats.wishSections?.affordAt?.at ?? null, stats.wishSections?.affordAt?.kind ?? null, stats.wishFocus?.[0] ?? null,
        goal(stats.equipmentPlan?.next), goal(meetsAtSpot(stats.partyRequest) ? null : stats.partyRequest)]);
}
function progressObjective(state, { spots, timestamp, economy = null, memo = null }) {
    const earning = economy?.statsPacket?.earning || state?.stats?.earning;
    const spotId = earning?.spotId;
    if (!spotId) return null;
    const asked = earning === state.stats.earning ? state : { ...state, stats: { ...state.stats, earning } };
    const key = progressAskKey(asked, earning);
    let held = memo?.progressAsk;
    if (held?.key === key && held.spots === spots) Diagnostics.count('party_ask', 'held', held.accept ? 'party' : 'solo');
    else {
        const Progress = require('./PartyProgressComparison'); // lazy: its chain loads this planner
        const partner = Progress.partnerFor(asked);
        const verdict = partner && Progress.compare(asked, [partner], { spots, timestamp, objective: { spotId } });
        held = { key, spots, accept: !!verdict?.accept };
        if (memo) memo.progressAsk = held;
        Diagnostics.count('party_ask', 'decided', verdict?.reason || 'no_partner');
    }
    if (!held.accept) return null;
    return { status: 'open', priority: 'preferred', objectiveKey: `spot:${spotId}`, reason: PARTY_PROGRESS,
        spotId, npcId: null, itemId: null, targetId: null };
}
const seeksProgress = state => state?.stats?.partyRequest?.status === 'open' && state.stats.partyRequest.reason === PARTY_PROGRESS;

// A C4 player's LFP goes out in trade chat, which reaches the map region it is said
// in (L2J Lisvus Say2 TRADE, DEFAULT_TRADE_CHAT "limited": the players of the
// speaker's MapRegionTable region). An open request to meet for no target (no solo
// ground, party progress) is heard by the askers of its level band in the region of
// the spot it names (TownRespawn.getRegionGroup, the C4 map regions) besides the bots
// of that spot, so a damage dealer's ask meets a healer's from another spot (main's
// assembly, PartyAssemblyEvents: a region-band pool beside the spot groups). The band
// spans the party's level spread (BackgroundPartyComposition.DEFAULT_LEVEL_RANGE): any
// two of a band fit one roster. Null: no such request, or a spot outside every region.
const LFP_REASONS = new Set([NO_SOLO_GROUND, PARTY_PROGRESS]);
function meetingKey(objective, level, spots) {
    if (objective?.status !== 'open' || !LFP_REASONS.has(objective.reason)) return null;
    const center = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, objective.spotId)?.center;
    const region = center ? invoke('GameServer/World/TownRespawn').getRegionGroup(center.locX, center.locY, center.locZ) : null;
    const range = invoke('GameServer/Bot/Population/BackgroundPartyComposition').DEFAULT_LEVEL_RANGE;
    return region ? `${region}:${Math.floor(Math.max(1, Math.floor(Number(level) || 1)) / (range + 1))}` : null;
}

// An objective that only names a spot to meet at (no target, no clan duty): a shared
// target (a hot competition's offer_party, HotCompetitionParty; a saved row's request
// reason), no solo ground, party progress. Its party hunts
// there only while that spot stands for it as any party ground (BotRoute.choose),
// else the objective ends and the party routes as any other.
const MEETING_REASONS = new Set(['shared_target', NO_SOLO_GROUND, PARTY_PROGRESS]);
const meetsAtSpot = objective => MEETING_REASONS.has(objective?.reason) || objective?.kind === 'shared_target';

// A party request is held with no clock (C4 has no LFG timeout: a player asks
// and hunts on): open while forming may answer it; closed (lastReason) when
// forming found no group for it, its assembled party gave up, or a material
// party parked it for a supply errand. A closed request is held until the bot's
// next build, which asks again (reopens it) or drops it; forming skips it.
const closed = state => state?.stats?.partyRequest?.status === 'closed';

// A bot forming never takes: one buying its gear on the market (its plan shops
// first; the end of the plan, a write of its row, makes it a candidate again)
// or a static service (a merchant or craft station stays at its post). It is on
// no forming page, so no clan call holds it waiting for a party either.
const formingSkips = state => state?.stats?.equipmentPlan?.strategy === 'market'
    || invoke('GameServer/Bot/AI/BotServiceIdentity').isStaticService(state);

// Party size and level spread: a clan equipment duty sets its own within
// fixed bounds, any other party uses the defaults (the configured sizes
// unless the caller gives its own).
function limitsForObjective(objective = null, defaults = {}) {
    if (objective?.opportunisticRaid === true) return { minSize: 9, maxSize: 9, levelRange: 7 };
    const maxSize = Number(defaults.maxSize ?? Config.partyMaxSize);
    const minSize = Number(defaults.minSize ?? Config.partyMinSize);
    if (objective?.fullRoster) return { maxSize: 9, minSize: 9, levelRange: defaults.levelRange ?? 99 };
    const clanEquipment = objective?.clanOperation === 'equipment'
        && Number(objective?.clanId || 0) > 0;
    if (!clanEquipment) return { maxSize, minSize, levelRange: defaults.levelRange };
    const clanMaxSize = Math.max(2, Math.min(9, Number(objective.maxPartySize) || maxSize));
    return {
        maxSize: clanMaxSize,
        minSize: Math.max(2, Math.min(clanMaxSize, Number(objective.minPartySize) || minSize)),
        levelRange: Math.max(4, Number(objective.levelRange) || 99)
    };
}

// The spot a party for this bot hunts: its objective's, else the next spot of
// an active gear plan, else where the bot is. The SQL prefilter column
// bot_life_state.partyObjectiveSpot follows it with the party request as the
// objective (database/sql/sqlite.sql, migration 51).
function objectiveSpot(state, objective = null) {
    return objective?.spotId
        || (state?.stats?.equipmentPlan?.status === 'active' ? state.stats.equipmentPlan.next?.spotId : null)
        || state?.spotId
        || null;
}

function partyObjectiveForPlan(plan) {
    if (!plan || !['active', 'blocked'].includes(plan.status) || !plan.next?.spotId) return null;
    const partyNeed = plan.clanGoal?.partyNeed
        || plan.partyNeed
        || (plan.requiresParty ? 'required' : 'solo_ok');
    if (!['required', 'preferred'].includes(partyNeed)) return null;
    const strategy = plan.strategy || 'acquisition';
    const targetItemId = Number(plan.next.itemId || plan.target?.selfId || 0);
    const npcId = Number(plan.next.npcId || 0);
    // A party hunts a route/NPC, not one item at a time. The item remains in
    // the request for personal reward tracking, but it must not fragment all
    // bots killing the same dropper into incompatible groups.
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    return {
        status: 'open',
        priority: partyNeed,
        objectiveKey,
        reason: strategy === 'craft' ? 'craft_material' : 'gear_acquisition',
        partyNeedReason: plan.partyNeedReason || null,
        strategy,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: Number(plan.target?.selfId || 0) || null,
        clanId: Number(plan.clanGoal?.clanId || 0) || null,
        clanGoalKey: plan.clanGoal?.goalKey || null,
        partyPreference: plan.clanGoal?.partyPreference || null,
        ...(plan.clanGoal?.fullRoster ? { fullRoster: plan.clanGoal.fullRoster, minPartySize: 9, maxPartySize: 9 } : {})
    };
}

function partyRequestEligible(state) {
    return !require('./RaidSupplyPolicy').held(state) && !state?.party?.partyId
        && ['hunting', 'resting', 'party_wait'].includes(state?.activity);
}

function clanPartyObjectiveForState(state) {
    const objective = state?.stats?.clanPartyObjective;
    return objective && ['open', 'deferred'].includes(objective.status) ? objective : null;
}

// options: spots, economy (the bot's own economy, built in the background
// thread; required, no build here) and memo (the bot's worker record).
function partyRequestForPlan(state, plan, timestamp = Date.now(), options = {}) {
    const previous = state?.stats?.partyRequest;
    const supplyPause = Material.supplyPause(state, plan, { ...options, timestamp });
    if (supplyPause) return supplyPause;
    // A bot that cannot ask now (travel, a recovery, a party) keeps a closed request as
    // it is, its attempts with it: the next build that can asks again.
    if (plan?.levelingRecovery || !partyRequestEligible(state)) return previous?.status === 'closed' ? previous : null;
    const sharedTarget = previous?.reason === 'shared_target' && ['open', 'closed'].includes(previous.status)
        && plan?.status === 'active' && previous.spotId === plan.next?.spotId
        && Number(previous.npcId) === Number(plan.next?.npcId || plan.targetNpcId)
        ? { ...previous, status: 'open' } : null;
    let objective = clanPartyObjectiveForState(state) || partyObjectiveForPlan(plan)
        || Material.request(state, plan, { ...options, timestamp }) || sharedTarget
        || seekObjective(state, previous, { spots: options.spots, timestamp, economy: options.economy, plan })
        || progressObjective(state, { spots: options.spots, timestamp, economy: options.economy, memo: options.memo });
    if (objective?.priority === 'required' && objective.itemId && !objective.clanGoalKey && !objective.helpDeal) {
        const context = options.economy;
        const amount = Math.max(1, Math.floor(Number(objective.materialParty ? objective.amount : plan?.next?.amount || 1)));
        const fee = Math.floor(Math.min(invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(state, 0, { itemId: objective.itemId }),
            Math.max(0, Number(context.worth(objective.itemId)) || 0) * amount));
        if (fee > 0) objective = { ...objective, helpDeal: { payerId: Number(state.characterId),
            itemId: Number(objective.itemId), count: amount, fee } };
    }
    if (!objective) return null;
    const sameRequest = ['open', 'closed'].includes(previous?.status)
        && previous.objectiveKey === objective.objectiveKey
        && Number(previous.itemId || 0) === Number(objective.itemId || 0)
        && Number(previous.targetId || 0) === Number(objective.targetId || 0);
    // A camp change asks anew, but keeps this material operation's failed
    // assemblies so every bounded alternative is visited.
    const sameMaterialNeed = Material.isObjective(previous) && Material.isObjective(objective)
        && Number(previous.itemId) === Number(objective.itemId)
        && Number(previous.targetId) === Number(objective.targetId);
    const kept = sameRequest && previous.status === 'open';
    // Its attempts are counted where a request closes (forming's no, an assembly's
    // departure); asked again it keeps them.
    const previousAttempts = sameRequest || sameMaterialNeed ? Number(previous.attempts || 0) : 0;

    if (objective.reason === NO_SOLO_GROUND && !kept) {
        Diagnostics.count('party_seek', NO_SOLO_GROUND, 'seeking');
    }
    return {
        ...objective,
        status: 'open',
        requestedAt: kept ? Number(previous.requestedAt || timestamp) : timestamp,
        // The plan selection's input key (GearPlanSelection `planKey`): the
        // waiting plan is kept until it moves.
        planKey: options.planKey ?? null,
        attempts: previousAttempts,
        lastMatchedAt: sameRequest ? previous.lastMatchedAt || null : null
    };
}

// What an ungrouped bot asks of a party now: its open request (its build issued it) or
// its clan's open call. An objective its build did not issue (a plan needing a party
// while the bot could not ask: a request deferred or closed) asks for nothing: it
// anchors no roster and sets no party's objective; the bot is willing fill at most.
function partyObjectiveForState(state) {
    if (closed(state)) return null;
    if (state?.stats?.equipmentPlan?.levelingRecovery) return null;
    const request = state?.stats?.partyRequest;
    const clanObjective = clanPartyObjectiveForState(state);
    if (clanObjective?.status === 'open') {
        if (request?.status === 'open'
            && String(request.clanGoalKey || '') === String(clanObjective.clanGoalKey || '')) {
            return { ...request, ...clanObjective, requestedAt: request.requestedAt || clanObjective.requestedAt };
        }
        return clanObjective;
    }
    return request?.status === 'open' ? request : null;
}

// A party member's objective at its party's re-plan (PartyRequirementRefresh): what it
// asks, else what its gear plan needs from a party, else its clan's deferred call. A
// member holds no request (joining a party clears it), so its plan speaks for it there.
function memberObjective(state) {
    const asked = partyObjectiveForState(state);
    if (asked || closed(state) || state?.stats?.equipmentPlan?.levelingRecovery || state?.stats?.partyRequest) return asked;
    return partyObjectiveForPlan(state?.stats?.equipmentPlan) || clanPartyObjectiveForState(state);
}

// A request's lifecycle, traced at the commit that changes it (every end, whoever wrote it: the build's own closes,
// forming's no, a leave, a party joined, a death): one request is the open one asked at requestedAt for its
// objective; it ends when the committed state no longer holds it open, and the next one opened is traced.
const openKey = request => request?.status === 'open' ? `${request.objectiveKey || ''}@${Number(request.requestedAt) || 0}` : null;
function traceCommitted(previous, next) {
    const was = previous?.stats?.partyRequest, now = next?.stats?.partyRequest, from = openKey(was), to = openKey(now);
    if (from === to) return;
    const bot = Number(next.characterId);
    if (from) Trace.record({ kind: 'party', bot, phase: 'request', outcome: 'closed', reason: to ? 'replaced'
        : now?.suspendedFor ? 'supply_pause' : now?.status ? String(now.lastReason || now.status)
            : next.party?.partyId || next.stats?.backgroundPartyId ? 'joined' : next.activity === 'dead' ? 'dead' : 'not_needed' });
    if (to) Trace.record({ kind: 'party', bot, phase: 'request', outcome: 'open', reason: String(now.reason || '') });
}

module.exports = {
    NO_SOLO_GROUND,
    PARTY_PROGRESS,
    supportWithoutGround,
    seeksParty,
    seeksProgress,
    meetsAtSpot,
    meetingKey,
    closed,
    formingSkips,
    limitsForObjective,
    objectiveSpot,
    partyObjectiveForPlan,
    clanPartyObjectiveForState,
    partyRequestForPlan,
    partyObjectiveForState,
    memberObjective,
    traceCommitted
};

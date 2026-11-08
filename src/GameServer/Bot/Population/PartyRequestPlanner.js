const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Material = require('./CraftMaterialParty');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');

// No solo ground -> a party (decision 10-30, T106): a healer or buffer (BotRoles)
// with no gear plan source to hunt (an active plan's next spot is its solo hunt) whose
// held earning answer (the solo spot it hunts, EquipmentIncomeRoute) names no spot, or
// ground its level does not fit (BotRoute.soloLevelFits at its solo target level: grey
// ground, unless it hunts for gain there), has no solo ground: it seeks a party instead
// of farming grey ground alone, and its solo side counts as none wherever a party is
// weighed against its solo hunt (PartyProgressComparison.heldSoloRoute: forming's verdict,
// its stay). earning, plan: the ones to read (the build's when it took them); no
// answer held yet: not known.
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
// (objectiveKey = their spot key) and joins parties that hunt there. The
// spot holds while the request is open; a reopened request searches again.
// Null: no such seeker, or no spot.
function seekObjective(state, previous, { spots, timestamp, search = null, economy = null, plan }) {
    if (state?.party?.partyId || !supportWithoutGround(state, spots, economy?.statsPacket?.earning || state?.stats?.earning, plan)) return null;
    const held = previous?.reason === NO_SOLO_GROUND && previous.status === 'open' ? previous.spotId : null;
    // lazy: cycle SpotProfiles' chain loads this planner
    const searched = held ? null : invoke('GameServer/Bot/Population/SpotProfiles').findForState({ ...state, spotId: null,
        stats: Object.fromEntries(Object.entries(state.stats || {}).filter(([key]) => key !== 'equipmentPlan')) },
    { profiles: spots, mode: 'party', timestamp, ...(search?.spotHunters ? { spotHunters: search.spotHunters } : {}),
        // A party search on main reads main's index (temporary until step 8); none on the worker.
        hasRoom: invoke('GameServer/Bot/Population/SpotProfiles').defaultRoomFilter(state, spots) });
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
// ground (a C4 player's LFP), so it groups with the bots that hunt there. Asked at the
// build, as every request; the next build asks again (two table rows, cheaper than
// keying it on its inputs). Null: no held answer with a spot, or solo is sooner.
// economy: the build's (its earning answer when the build took it with the request,
// else the held one).
const PARTY_PROGRESS = 'party_progress';
function progressObjective(state, { spots, timestamp, economy = null }) {
    const earning = economy?.statsPacket?.earning || state?.stats?.earning;
    const spotId = earning?.spotId;
    if (!spotId) return null;
    const asked = earning === state.stats.earning ? state : { ...state, stats: { ...state.stats, earning } };
    const Progress = require('./PartyProgressComparison'); // lazy: its chain loads this planner
    const partner = Progress.partnerFor(asked);
    const verdict = partner && Progress.compare(asked, [partner], { spots, timestamp, objective: { spotId } });
    if (!verdict?.accept) return null;
    return { status: 'open', priority: 'preferred', objectiveKey: `spot:${spotId}`, reason: PARTY_PROGRESS,
        spotId, npcId: null, itemId: null, targetId: null };
}
const seeksProgress = state => state?.stats?.partyRequest?.status === 'open' && state.stats.partyRequest.reason === PARTY_PROGRESS;

// An objective that only names a spot to meet at (no target, no clan duty): a shared
// target (a competition's offer_party), no solo ground, party progress. Its party hunts
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
// thread; required, no build here), memo (the bot's worker record) and search
// (the worker's route search inputs, supportWithoutGround).
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
        || seekObjective(state, previous, { spots: options.spots, timestamp, search: options.search, economy: options.economy, plan })
        || progressObjective(state, { spots: options.spots, timestamp, economy: options.economy });
    if (objective?.priority === 'required' && objective.itemId && !objective.clanGoalKey && !objective.helpDeal) {
        const context = options.economy;
        const amount = Math.max(1, Math.floor(Number(objective.materialParty ? objective.amount : plan?.next?.amount || 1)));
        // ARCH-NOTE: party value is pending; the help fee buys progress on its requested item.
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
    if (request) {
        return request.status === 'open' ? request : null;
    }
    return partyObjectiveForPlan(state?.stats?.equipmentPlan) || clanObjective;
}

module.exports = {
    NO_SOLO_GROUND,
    PARTY_PROGRESS,
    supportWithoutGround,
    seeksParty,
    seeksProgress,
    meetsAtSpot,
    closed,
    limitsForObjective,
    objectiveSpot,
    partyObjectiveForPlan,
    clanPartyObjectiveForState,
    partyRequestForPlan,
    partyObjectiveForState
};

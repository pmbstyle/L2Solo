// A body's rebuff (Bot/AI/Rebuff, the decision the background thread takes): the raise
// at its last buff's end (buffEnded) and the held answer its executors carry out once
// (takeAnswer). And the Newbie Guide trips a player's companion takes by its own
// threshold (FollowingState, player-led): the guide in reach, the town visit's key.
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const GUIDE_TOWN_RADIUS = BotBuffs.GUIDE_TOWN_RADIUS;
const TOWN_CENTER_RADIUS = 1500;
const GUIDE_CORE_RADIUS = 1500;

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function distance2d(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

// Whether the guide stands within the town radius of the point (an actor or
// a plain location): the one guide-town rule (BotBuffs).
const guideInReach = (point, guide) => BotBuffs.guideInReach(pointOf(point), guide);

// The closest newbie guide when it is in reach of the point, else null (BotAI's
// locator: BotBuffs.closestGuide).
function nearGuide(point, BotAI) {
    const at = pointOf(point);
    const guide = BotAI?.getClosestNewbieGuide?.(at.locX, at.locY);
    return guideInReach(at, guide) ? guide : null;
}

// The guide a newbie-guide trip may head to from the actor, else null: the one
// rule every trip entry and the trip itself read. A guide beyond its town
// radius has no town path, and an abandoned trip waits for its retry time.
function tripGuide(session, actor, BotAI) {
    return Number(session?.newbieGuideRetryAt || 0) > Date.now() ? null : nearGuide(actor, BotAI);
}

// The guide a low-HP/MP bot may recover at: the trip rule, for levels the
// guide still serves.
function recoveryGuide(session, bot, BotAI) {
    return bot.fetchLevel() <= BotBuffs.NEWBIE_GUIDE_MAX_LEVEL ? tripGuide(session, bot, BotAI) : null;
}

function currentVisit(actor, BotAI) {
    if (!BotBuffs.isNewbieEligible(actor)) return null;
    const point = pointOf(actor);
    const guide = nearGuide(point, BotAI);
    if (!guide) return null;

    const town = TownRespawn.getClosestTown(point.locX, point.locY, point.locZ);
    const insideTown = TownPathfinder.isInsideTown(point)
        || (town && distance2d(point, town) <= TOWN_CENTER_RADIUS)
        || distance2d(point, guide) <= GUIDE_CORE_RADIUS;
    if (!insideTown) return null;

    return {
        key: `newbie-guide:${Number(guide.npcSelfId || 0)}:${town?.name || guide.name || 'town'}`,
        guide,
        town: town?.name || guide.name || null
    };
}

function syncVisit(session, actor, BotAI) {
    const visit = currentVisit(actor, BotAI);
    if (!visit && session) delete session.hotTownRebuffCompletedVisitKey;
    return visit;
}

function needsVisit(session, visit) {
    return !!visit && session?.hotTownRebuffCompletedVisitKey !== visit.key;
}

function markCompleted(session, actor, BotAI, key = null) {
    if (!session) return null;
    const visitKey = key || currentVisit(actor, BotAI)?.key || null;
    if (!visitKey) return null;
    session.hotTownRebuffCompletedVisitKey = visitKey;
    return visitKey;
}

// A body's last hunting buff ended (EffectTicker at an effect's expiry): buffs_expired,
// raised when no rebuffable effect is left in force (BotBuffs). A death clears the
// timers (no raise). A player's companion keeps its own threshold and a party member's
// buffs are its party's: neither raises. Once per fall: buffs with one end time end
// on as many timers, and the first that finds the bot unbuffed raises; the rest find
// the raise held (in the body's bag, or the rebuff bit still woken or waiting).
function buffEnded(actor, timestamp = Date.now()) {
    const session = invoke('GameServer/Bot/BotManager').findSessionById(actor?.fetchId?.());
    if (!session || session.actor !== actor || session.followPlayerSession || session.partyCompanion
        || session.hotBackgroundPartyId || BotBuffs.buffedAt(EffectStore.list(actor), timestamp)) return false;
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    if (Events.inBag(session, 'buffs_expired') || invoke('GameServer/Bot/Situations').raised(Events.statsFor(session), 'rebuff')) return false;
    Events.raiseDecision(session, 'buffs_expired');
    return true;
}

// The held rebuff answer a body's executor carries out now (this way, not done):
// returned once, held done on the body's stats (a failed trip holds it so: nothing
// more until the next situation); null otherwise.
function takeAnswer(session, via) {
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const stats = Events.statsFor(session), answer = Rebuff.pending(stats, via);
    if (answer) Events.replaceStats(session, { ...stats, rebuff: Rebuff.done(answer) });
    return answer;
}

module.exports = {
    buffEnded,
    takeAnswer,
    GUIDE_CORE_RADIUS,
    GUIDE_TOWN_RADIUS,
    TOWN_CENTER_RADIUS,
    currentVisit,
    guideInReach,
    markCompleted,
    nearGuide,
    needsVisit,
    recoveryGuide,
    syncVisit,
    tripGuide
};

const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const GUIDE_TOWN_RADIUS = 7500;
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

function currentVisit(actor, BotAI) {
    if (!BotBuffs.isNewbieEligible(actor)) return null;
    const point = pointOf(actor);
    const guide = BotAI?.getClosestNewbieGuide?.(point.locX, point.locY);
    if (!guide || distance2d(point, guide) > GUIDE_TOWN_RADIUS) return null;

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

module.exports = {
    GUIDE_CORE_RADIUS,
    GUIDE_TOWN_RADIUS,
    TOWN_CENTER_RADIUS,
    currentVisit,
    markCompleted,
    needsVisit,
    syncVisit
};

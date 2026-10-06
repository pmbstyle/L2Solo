'use strict';

function point(actor) {
    return { locX: Number(actor?.fetchLocX?.()), locY: Number(actor?.fetchLocY?.()) };
}
function validPoint(loc) { return Number.isFinite(loc?.locX) && Number.isFinite(loc?.locY); }
function distance(loc, actor) {
    const to = point(actor), dx = loc.locX - to.locX, dy = loc.locY - to.locY;
    return Math.sqrt(dx * dx + dy * dy);
}
function native(World) { return World?.actorSpatialIndex === true; }
function near(World, actorOrPoint, radius, accept = null, legacy = null) {
    const loc = typeof actorOrPoint?.fetchLocX === 'function' ? point(actorOrPoint) : actorOrPoint;
    if (!validPoint(loc)) return [];
    if (native(World)) return World.actorSessionsNear(loc, radius, accept);
    return (legacy ?? World?.user?.sessions ?? []).filter(session => session?.actor
        && (!accept || accept(session)) && distance(loc, session.actor) <= radius);
}
function humans(World, accept = null, online = false) {
    const sessions = native(World) ? World.actorPresenceSessions(online ? 'onlineHuman' : 'human')
        : World?.user?.sessions ?? [];
    return accept ? sessions.filter(accept) : sessions;
}
function byId(World, id) {
    if (native(World)) return World.registeredActorById(id)?.session ?? null;
    return (World?.user?.sessions ?? []).find(session => Number(session?.actor?.fetchId?.()) === Number(id)) ?? null;
}
function nearestPlayer(World, actor) {
    const loc = point(actor);
    if (!validPoint(loc)) return { session: null, distance: Infinity, count: World.actorPresenceCount() };
    return World.nearestRealPlayer(loc);
}
module.exports = { native, near, humans, byId, point, nearestPlayer };

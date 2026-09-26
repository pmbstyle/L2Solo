const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const CHECKS_PER_SCAN = 4;

function canSee(actor, target) {
    return Geodata.hasLineOfSight(
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
        target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()
    );
}

// Check ranked candidates in bounded batches. Never treat an unchecked NPC
// as visible, and continue past a blocked prefix on the next idle tick.
function select(session, key, actor, candidates, actorFor = candidate => candidate) {
    const scans = session.huntingVisibilityScans || (session.huntingVisibilityScans = {});
    const previous = scans[key];
    const origin = [actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()];
    const sameOrigin = previous && Math.hypot(...origin.map((value, index) => value - previous.origin[index])) <= 128;
    const start = sameOrigin
        ? Math.max(0, candidates.findIndex(candidate => actorFor(candidate).fetchId() === previous.nextId))
        : 0;
    const end = Math.min(candidates.length, start + CHECKS_PER_SCAN);
    for (let index = start; index < end; index++) {
        if (!canSee(actor, actorFor(candidates[index]))) continue;
        delete scans[key];
        return { candidate: candidates[index], pending: false };
    }
    const pending = end < candidates.length;
    if (pending) scans[key] = { nextId: actorFor(candidates[end]).fetchId(), origin };
    else delete scans[key];
    return { candidate: null, pending };
}

module.exports = { CHECKS_PER_SCAN, canSee, select };

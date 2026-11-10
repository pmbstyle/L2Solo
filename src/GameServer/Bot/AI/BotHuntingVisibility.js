const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');

// Line-of-sight checks per idle tick, and how far the actor may move before a
// blocked scan restarts at its first candidate.
const CHECKS_PER_SCAN = 4;
const RESUME_RANGE = 128;

function canSee(actor, target) {
    return Geodata.hasLineOfSight(
        actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
        target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()
    );
}

// The candidate a blocked batch stopped at, while the actor still stands within
// RESUME_RANGE of where it scanned: the next batch starts there. null: at the first.
function resumeId(session, key, actor) {
    const previous = session.huntingVisibilityScans?.[key];
    if (!previous) return null;
    const origin = [actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()];
    return Math.hypot(...origin.map((value, index) => value - previous.origin[index])) <= RESUME_RANGE ? previous.nextId : null;
}

// The next batch: the candidate it resumes at, how many it checks, and whether the
// last batch had reached the list's tail (options.tail of select). A caller that
// orders its list after reading it (HuntingState.readyRanked) places the resume
// point itself and passes select its index (options.start); it must have read the
// batch and the candidate after it, which the next batch resumes at.
function batch(session, key, actor) {
    const id = resumeId(session, key, actor);
    return { resumeId: id, checks: CHECKS_PER_SCAN, inTail: id !== null && session.huntingVisibilityScans[key].inTail === true };
}

// Check ranked candidates in bounded batches. Never treat an unchecked NPC
// as visible, and continue past a blocked prefix on the next idle tick.
// A blocked batch with candidates left is counted (visibility:batch_blocked:<key>).
function select(session, key, actor, candidates, actorFor = candidate => candidate, options = {}) {
    const scans = session.huntingVisibilityScans || (session.huntingVisibilityScans = {});
    const origin = [actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()];
    let start = options.start;
    if (start === undefined) {
        const resume = resumeId(session, key, actor);
        start = resume !== null ? Math.max(0, candidates.findIndex(candidate => actorFor(candidate).fetchId() === resume)) : 0;
    }
    const end = Math.min(candidates.length, start + CHECKS_PER_SCAN);
    for (let index = start; index < end; index++) {
        if (!canSee(actor, actorFor(candidates[index]))) continue;
        delete scans[key];
        return { candidate: candidates[index], pending: false };
    }
    const pending = end < candidates.length;
    if (pending) {
        scans[key] = { nextId: actorFor(candidates[end]).fetchId(), origin,
            ...(options.tail !== undefined ? { inTail: end >= options.tail } : {}) };
        Diagnostics.count('visibility', 'batch_blocked', key);
    } else delete scans[key];
    return { candidate: null, pending };
}

module.exports = { CHECKS_PER_SCAN, RESUME_RANGE, canSee, resumeId, batch, select };

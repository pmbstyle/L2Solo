// Event-driven target tracking for hot party casts. A target owns only the
// casts that are currently in flight against it, so death handling touches a
// handful of casters instead of polling HP or scanning every online bot.
const castsByTarget = new WeakMap();
const castByActor = new WeakMap();

function isTrackable(session, target, skill) {
    return session?.partyCompanion === true &&
        !!session.followPlayerSession &&
        target?.fetchAttackable?.() === true &&
        skill?.fetchTargetKind?.() === 'enemy';
}

function clear(actor) {
    const entry = actor ? castByActor.get(actor) : null;
    if (!entry) return false;

    castByActor.delete(actor);
    const targetCasts = castsByTarget.get(entry.target);
    if (targetCasts) {
        targetCasts.delete(entry);
        if (targetCasts.size === 0) castsByTarget.delete(entry.target);
    }
    if (actor.attack?.activePartyCast === entry) {
        actor.attack.activePartyCast = null;
    }
    return true;
}

function begin(session, actor, target, skill) {
    clear(actor);
    if (!isTrackable(session, target, skill)) return false;

    const entry = {
        session,
        actor,
        target,
        targetId: Number(target.fetchId?.() || 0) || null,
        skillId: Number(skill.fetchSelfId?.() || 0) || null
    };
    let targetCasts = castsByTarget.get(target);
    if (!targetCasts) {
        targetCasts = new Set();
        castsByTarget.set(target, targetCasts);
    }
    targetCasts.add(entry);
    castByActor.set(actor, entry);
    if (actor.attack) actor.attack.activePartyCast = entry;
    return true;
}

function cancelForDeadNpc(npc) {
    const targetCasts = castsByTarget.get(npc);
    if (!targetCasts || targetCasts.size === 0) return 0;

    const entries = [...targetCasts];
    castsByTarget.delete(npc);
    let cancelled = 0;

    entries.forEach((entry) => {
        castByActor.delete(entry.actor);
        if (entry.actor?.attack?.activePartyCast === entry) {
            entry.actor.attack.activePartyCast = null;
        }
        if (!entry.actor?.state?.fetchCasts?.()) return;
        if (entry.actor.attack?.abortCast?.(entry.session, entry.actor) !== true) return;

        entry.session.lastCombatDecision = {
            action: 'cast_cancelled',
            reason: 'target_died',
            targetId: entry.targetId,
            skillId: entry.skillId,
            at: Date.now()
        };
        cancelled += 1;
    });

    return cancelled;
}

function trackedCount(target) {
    return castsByTarget.get(target)?.size || 0;
}

module.exports = { begin, clear, cancelForDeadNpc, isTrackable, trackedCount };

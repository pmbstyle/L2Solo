const EffectStore = invoke('GameServer/Effects/EffectStore');
const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const FEAR_RANGE = 500;
const FEAR_TICK_MS = 6000;

function canMove(actor) {
    const impairments = EffectStore.impairments(actor);
    return !(impairments.disabled || impairments.rooted);
}

function canAttack(actor) {
    return !EffectStore.impairments(actor).disabled;
}

function canCast(actor) {
    const impairments = EffectStore.impairments(actor);
    return !(impairments.disabled || impairments.silenced);
}

function canUseBasicAction(actor) {
    return !EffectStore.impairments(actor).disabled;
}

function reject(session) {
    if (session?.dataSendToMe) {
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

function interruptOnApply(session, actor, effect, source = session?.actor) {
    if (!actor || !effect || effect.type !== 'debuff') return;
    const impairments = EffectStore.impairments(actor);
    if (!(impairments.disabled || impairments.rooted)) return;

    actor.automation?.abortAll?.(actor);
    actor.attack?.clearTimers?.();
    actor.attack?.resetQueuedEvent?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    if (impairments.disabled) {
        actor.state?.setCombats?.(false);
        if (typeof actor.abortCombatState === 'function') {
            const safeSession = session?.dataSendToMeAndOthers ? session : { dataSendToMeAndOthers() {} };
            actor.abortCombatState(safeSession);
        }
    }
    if (session?.moveTimer) {
        clearInterval(session.moveTimer);
        session.moveTimer = null;
    }
    if (impairments.afraid) {
        startFear(session, actor, source, effect);
    }
}

function startFear(session, actor, source, effect) {
    if (!actor || !source || !effect?.key) return false;
    if (!EffectStore.hasDebuff(actor, 'fear')) return false;
    if (!canFearMove(actor, source)) return false;

    actor.isAfraid = true;
    actor.effectTimers = actor.effectTimers || {};
    if (actor.effectTimers[effect.key]) {
        clearInterval(actor.effectTimers[effect.key]);
        delete actor.effectTimers[effect.key];
    }

    const move = () => {
        if (!EffectStore.hasDebuff(actor, 'fear')) {
            stopFear(actor, effect.key);
            return;
        }
        fearMoveStep(session, actor, source);
    };

    move();
    actor.effectTimers[effect.key] = setInterval(move, FEAR_TICK_MS);
    if (typeof actor.effectTimers[effect.key].unref === 'function') {
        actor.effectTimers[effect.key].unref();
    }
    return true;
}

function stopFear(actor, key = 'fear') {
    actor.isAfraid = false;
    if (actor?.effectTimers?.[key]) {
        clearInterval(actor.effectTimers[key]);
        delete actor.effectTimers[key];
    }
    if (actor?.fearMoveTimer) {
        clearTimeout(actor.fearMoveTimer);
        actor.fearMoveTimer = undefined;
    }
    if (actor?.state?.fetchTowards?.() === 'fear') {
        actor.state.setTowards(false);
    }
}

function canFearMove(actor, source) {
    return typeof actor.fetchId === 'function' &&
        typeof actor.fetchLocX === 'function' &&
        typeof actor.fetchLocY === 'function' &&
        typeof actor.fetchLocZ === 'function' &&
        typeof actor.setLocXYZ === 'function' &&
        typeof source.fetchLocX === 'function' &&
        typeof source.fetchLocY === 'function';
}

function fearMoveStep(session, actor, source) {
    const from = {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
    const dX = from.locX > source.fetchLocX() ? 1 : -1;
    const dY = from.locY > source.fetchLocY() ? 1 : -1;
    const to = {
        locX: Math.round(from.locX + dX * FEAR_RANGE),
        locY: Math.round(from.locY + dY * FEAR_RANGE),
        locZ: from.locZ
    };
    to.locZ = GeodataEngine.getHeight(to.locX, to.locY, to.locZ);

    actor.setStateRun?.(true);
    if (actor.fetchStateRun && session?.dataSendToMeAndOthers) {
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(actor.fetchId(), actor.fetchStateRun()), actor);
    }

    session?.dataSendToMeAndOthers?.(
        ServerResponse.moveToLocation(actor.fetchId(), { from, to }),
        actor
    );

    actor.state?.setTowards?.('fear');
    if (actor.fearMoveTimer) {
        clearTimeout(actor.fearMoveTimer);
    }

    const distance = Math.sqrt(((to.locX - from.locX) ** 2) + ((to.locY - from.locY) ** 2));
    const speed = Math.max(1, Number(actor.fetchCollectiveRunSpd?.()) || 120);
    actor.fearMoveTimer = setTimeout(() => {
        actor.setLocXYZ(to);
        actor.state?.setTowards?.(false);
        actor.fearMoveTimer = undefined;
    }, Math.max(1, Math.round(distance / speed * 1000)));
    if (typeof actor.fearMoveTimer.unref === 'function') {
        actor.fearMoveTimer.unref();
    }
}

function wakeOnDamage(actor) {
    if (!actor) return false;
    const removed = EffectStore.remove(actor, 'sleep');
    if (!removed) return false;

    const packet = ServerResponse.abnormalStatusUpdate.fromActor(actor);
    if (actor.session?.dataSendToMe) {
        actor.session.dataSendToMe(packet);
    }
    return true;
}

module.exports = {
    canMove,
    canAttack,
    canCast,
    canUseBasicAction,
    reject,
    interruptOnApply,
    startFear,
    stopFear,
    wakeOnDamage
};

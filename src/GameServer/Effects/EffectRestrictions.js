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

function stopMovement(session, actor) {
    if (session?.moveTimer) {
        clearInterval(session.moveTimer);
        session.moveTimer = null;
    }
    if (!actor?.fetchId) return false;
    actor.state?.setTowards?.(false);
    const packet = ServerResponse.stopMove(actor.fetchId(), {
        locX: actor.fetchLocX?.() || 0,
        locY: actor.fetchLocY?.() || 0,
        locZ: actor.fetchLocZ?.() || 0,
        head: actor.fetchHead?.() || 0
    });
    session?.dataSendToMeAndOthers?.(packet, actor);
    return true;
}

function interruptOnApply(session, actor, effect, source = session?.actor) {
    if (!actor || !effect || effect.type !== 'debuff') return;
    const impairments = EffectStore.impairments(actor);
    const confused = EffectStore.hasDebuff(actor, 'confusion');
    if (!(impairments.disabled || impairments.rooted || confused)) return;

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
    stopMovement(session, actor);
    if (impairments.afraid) {
        startFear(session, actor, source, effect);
    }
    if (confused) {
        startConfusion(session, actor, effect);
    }
}

// Lisvus EffectConfusion / EffectConfuseMob: immediately, then once per
// effect period, pick a known character in a 600 radius and attack it. The
// ConfuseMob variant limits the candidates to attackable NPCs.
function startConfusion(session, actor, effect) {
    if (!actor?.fetchId || !effect?.key || !EffectStore.hasDebuff(actor, 'confusion')) return false;
    const timers = actor.effectTimers || (actor.effectTimers = {});
    if (timers[effect.key]) clearInterval(timers[effect.key]);

    const act = () => {
        if (!EffectStore.hasDebuff(actor, 'confusion')) {
            stopConfusion(actor, effect.key);
            return;
        }
        const targets = confusionTargets(actor, effect.confusionMobOnly);
        if (!targets.length) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        // Npc.enterCombatState deliberately ignores a second start while the
        // mob has an active combat loop. Confusion must replace that target.
        actor.abortCombatState?.(session);
        actor.enterCombatState?.(session, target);
    };

    act();
    timers[effect.key] = setInterval(act, 6000);
    timers[effect.key].unref?.();
    return true;
}

function stopConfusion(actor, key = 'confusion') {
    if (!actor?.effectTimers?.[key]) return false;
    clearInterval(actor.effectTimers[key]);
    delete actor.effectTimers[key];
    return true;
}

function confusionTargets(actor, attackableOnly) {
    const World = invoke('GameServer/World/World');
    const npcs = World.npc?.spawns || [];
    const users = attackableOnly ? [] : (World.user?.sessions || []).map((session) => session.actor).filter(Boolean);
    return [...npcs, ...users].filter((candidate) => {
        if (!candidate || candidate === actor || candidate.state?.fetchDead?.()) return false;
        if (attackableOnly && candidate.fetchAttackable?.() !== true) return false;
        const dx = (candidate.fetchLocX?.() || 0) - (actor.fetchLocX?.() || 0);
        const dy = (candidate.fetchLocY?.() || 0) - (actor.fetchLocY?.() || 0);
        const dz = (candidate.fetchLocZ?.() || 0) - (actor.fetchLocZ?.() || 0);
        return Math.hypot(dx, dy, dz) <= 600;
    });
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

function wakeOnDamage(actor, session = actor?.session) {
    if (!actor) return false;
    const removed = EffectStore.remove(actor, 'sleep');
    if (!removed) return false;

    const EffectTicker = invoke('GameServer/Effects/EffectTicker');
    EffectTicker.refreshEffects(session, actor);
    return true;
}

module.exports = {
    canMove,
    canAttack,
    canCast,
    canUseBasicAction,
    reject,
    stopMovement,
    interruptOnApply,
    startFear,
    stopFear,
    startConfusion,
    stopConfusion,
    wakeOnDamage
};

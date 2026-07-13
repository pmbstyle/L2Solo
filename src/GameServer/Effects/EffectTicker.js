function ensureTimers(actor) {
    if (!actor.effectTimers) actor.effectTimers = {};
    return actor.effectTimers;
}

function ensureExpiryTimers(actor) {
    if (!actor.effectExpiryTimers) actor.effectExpiryTimers = {};
    return actor.effectExpiryTimers;
}

function clear(actor, key) {
    let removed = false;
    if (actor?.effectTimers?.[key]) {
        clearInterval(actor.effectTimers[key]);
        delete actor.effectTimers[key];
        removed = true;
    }
    if (actor?.effectExpiryTimers?.[key]) {
        clearTimeout(actor.effectExpiryTimers[key]);
        delete actor.effectExpiryTimers[key];
        removed = true;
    }
    return removed;
}

function clearRuntime(actor, key) {
    if (!actor?.effectTimers?.[key]) return false;
    clearInterval(actor.effectTimers[key]);
    delete actor.effectTimers[key];
    return true;
}

function clearExpiry(actor, key) {
    if (!actor?.effectExpiryTimers?.[key]) return false;
    clearTimeout(actor.effectExpiryTimers[key]);
    delete actor.effectExpiryTimers[key];
    return true;
}

function refreshEffects(session, target) {
    const ServerResponse = invoke('GameServer/Network/Response');
    const packet = ServerResponse.abnormalStatusUpdate.fromActor(target);
    if (target?.session?.dataSendToMe) {
        target.session.dataSendToMe(packet);
    } else if (target === session?.actor && session?.dataSendToMe) {
        session.dataSendToMe(packet);
    }

    if (target?.session?.dataSendToMe && target?.backpack?.fetchPaperdollSelfId) {
        target.session.dataSendToMe(ServerResponse.userInfo(target));
    }

    if (target?.fetchKind && session?.dataSendToMeAndOthers) {
        session.dataSendToMeAndOthers(ServerResponse.npcInfo(target), target);
    } else if (target?.session?.dataSendToOthers && target?.backpack?.fetchPaperdollSelfId) {
        target.session.dataSendToOthers(ServerResponse.charInfo(target), target);
    }

    try {
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        if (target?.session) PartyCompanionService.updateActorEffects(target.session);
    } catch (err) {
        utils.infoWarn('EffectTicker', 'party effect refresh failed: %s', err.message);
    }
}

function scheduleExpiry(session, target, effect) {
    if (!target || !effect?.key || !effect.expiresAt) return false;

    const delay = Number(effect.expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return false;

    const timers = ensureExpiryTimers(target);
    clearExpiry(target, effect.key);
    timers[effect.key] = setTimeout(() => {
        if (target.effectExpiryTimers?.[effect.key]) {
            delete target.effectExpiryTimers[effect.key];
        }

        const EffectStore = invoke('GameServer/Effects/EffectStore');
        EffectStore.prune(target);
        clearRuntime(target, effect.key);
        if (target.activeBuffs?.[effect.key] && target.activeBuffs[effect.key] <= Date.now()) {
            delete target.activeBuffs[effect.key];
        }
        if (Object.keys(effect.stats || {}).length > 0) {
            refreshStats(target.session || session, target);
        }
        refreshEffects(session, target);
    }, Math.max(1, delay + 25));
    if (typeof timers[effect.key].unref === 'function') {
        timers[effect.key].unref();
    }
    return true;
}

function applyDot(session, source, target, effect) {
    const dot = effect?.dot;
    if (!target || !effect?.key || !dot) return false;

    const damage = Math.max(0, Number(dot.damage) || 0);
    const intervalMs = Math.max(1, Number(dot.intervalMs) || 3000);
    let remaining = Math.max(0, Number(dot.count) || 0);
    if (!damage || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        applyDamage(session, source, target, damage);
        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyHot(session, source, target, effect) {
    const hot = effect?.hot;
    if (!target || !effect?.key || !hot) return false;

    const heal = Math.max(0, Number(hot.heal) || 0);
    const intervalMs = Math.max(1, Number(hot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(hot.count) || 0);
    if (!heal || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        applyHeal(target, heal);
        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyManaDot(session, source, target, effect) {
    const manaDot = effect?.manaDot;
    if (!target || !effect?.key || !manaDot) return false;

    const damage = Math.max(0, Number(manaDot.damage) || 0);
    const intervalMs = Math.max(1, Number(manaDot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(manaDot.count) || 0);
    if (!damage || (!remaining && !manaDot.toggle)) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            if (effect.stats?.relaxing) target.silentMoving = false;
            clearRuntime(target, effect.key);
            return;
        }

        if (manaDot.requiresSeated && !target.state?.fetchSeated?.()) {
            if (effect.stats?.relaxing) target.silentMoving = false;
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        if (manaDot.toggle && damage > (Number(target.fetchMp?.()) || 0)) {
            if (effect.stats?.relaxing) target.silentMoving = false;
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        applyManaDamage(target, damage);
        if (manaDot.toggle) {
            refreshStats(target.session || session, target);
            return;
        }

        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    if (typeof timers[effect.key].unref === 'function') {
        timers[effect.key].unref();
    }
    return true;
}

function applyManaHot(session, source, target, effect) {
    const manaHot = effect?.manaHot;
    if (!target || !effect?.key || !manaHot) return false;

    const heal = Math.max(0, Number(manaHot.heal) || 0);
    const intervalMs = Math.max(1, Number(manaHot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(manaHot.count) || 0);
    if (!heal || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        applyManaHeal(target, heal);
        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyDamage(session, source, target, damage) {
    if (session && source && target?.fetchId && source !== target) {
        if (target.fetchId() >= 2000000) {
            invoke(path.actor).receivedHit(session, target, damage, { wakeSleep: true });
        } else {
            // Lisvus keeps an attackable NPC asleep when it takes DOT damage.
            invoke(path.npc).receivedHit(session, source, target, damage, { wakeSleep: false });
        }
        return;
    }

    target.setHp(Math.max(0, target.fetchHp() - damage));
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

function applyManaDamage(target, damage) {
    const currentMp = Number(target.fetchMp?.()) || 0;
    target.setMp(Math.max(0, currentMp - damage));
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

function refreshStats(session, target) {
    if (target?.session) {
        try {
            invoke(path.actor).calculateStats(target?.session || session, target);
        } catch (_) {}
    }
    if (target?.statusUpdateVitals) {
        target.statusUpdateVitals(target);
    }

    if (target && session?.dataSendToMe) {
        try {
            const ServerResponse = invoke('GameServer/Network/Response');
            session.dataSendToMe(ServerResponse.userInfo(target));
        } catch (_) {}
    }
}

function applyManaHeal(target, heal) {
    const currentMp = Number(target.fetchMp?.()) || 0;
    const maxMp = Number(target.fetchMaxMp?.()) || 0;
    const nextMp = maxMp > 0 ? Math.min(maxMp, currentMp + heal) : currentMp + heal;
    target.setMp(nextMp);
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

function applyHeal(target, heal) {
    const currentHp = Number(target.fetchHp?.()) || 0;
    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + heal) : currentHp + heal;
    target.setHp(nextHp);
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

module.exports = {
    applyDot,
    applyManaDot,
    applyManaHot,
    applyHot,
    scheduleExpiry,
    refreshEffects,
    clear
};

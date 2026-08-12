const ConsoleText = invoke('GameServer/ConsoleText');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const ServerResponse = invoke('GameServer/Network/Response');

function isToggle(skill) {
    return skill?.fetchSemantic?.().operateType === 'toggle';
}

function effectKey(skill) {
    const semantic = skill.fetchSemantic();
    return semantic.effect || invoke('GameServer/Skills/C4SkillRules').normalizeKey(skill.fetchName());
}

function isActive(actor, skill) {
    if (!isToggle(skill)) return false;
    const key = effectKey(skill);
    return EffectStore.list(actor).some((effect) => (
        effect.key === key && Number(effect.id) === Number(skill.fetchSelfId())
    ));
}

function handleRequest(session, actor, skill) {
    if (!isToggle(skill)) return false;

    const key = effectKey(skill);
    const active = isActive(actor, skill);

    if (active) {
        deactivate(session, actor, key);
        return true;
    }

    activate(session, actor, skill, key);
    return true;
}

function activate(session, actor, skill, key) {
    const semantic = skill.fetchSemantic();
    if (!matchesRequirements(actor, semantic.requires)) {
        session.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    }
    const initialMp = Math.max(0, Number(semantic.mpInitialConsume) || 0);

    if (initialMp > 0 && (Number(actor.fetchMp?.()) || 0) < initialMp) {
        ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
        session.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    }

    if (initialMp > 0 && typeof actor.setMp === 'function') {
        actor.setMp(Math.max(0, actor.fetchMp() - initialMp));
    }

    const toggleMpConsume = Math.max(0, Number(semantic.toggleMpConsume) || 0);
    if (semantic.stats?.relaxing) {
        actor.silentMoving = true;
        if (!actor.state?.fetchSeated?.()) {
            actor.state?.setSeated?.(true);
            session?.dataSendToMeAndOthers?.(ServerResponse.sitAndStand(actor), actor);
        }
    }
    if (semantic.stats?.silentMoving) actor.silentMoving = true;
    if (semantic.stats?.fakeDeath) startFakeDeath(session, actor);
    const effect = EffectStore.apply(actor, {
        key,
        id: skill.fetchSelfId(),
        level: skill.fetchLevel(),
        name: skill.fetchName(),
        type: semantic.effectType || 'buff',
        category: semantic.trait || key,
        dispellable: semantic.dispellable,
        toggle: true,
        stats: semantic.stats || {},
        manaDot: toggleMpConsume > 0 ? {
            toggle: true,
            damage: toggleMpConsume,
            intervalMs: Math.max(1, Number(semantic.toggleIntervalMs) || 3000),
            requiresSeated: semantic.stats?.relaxing === true
        } : null
    });

    if (effect?.manaDot) {
        EffectTicker.applyManaDot(session, actor, actor, effect);
    }

    refreshActor(session, actor);
    return true;
}

function matchesRequirements(actor, requires = {}) {
    if (!requires) return true;
    if (requires.shield && !(Number(actor?.backpack?.fetchTotalShieldPDef?.()) > 0)) return false;
    return true;
}

function deactivate(session, actor, key) {
    const effect = EffectStore.list(actor).find((entry) => entry.key === key);
    EffectStore.remove(actor, key);
    cleanupState(session, actor, effect);
    refreshActor(session, actor);
    session.dataSendToMe?.(ServerResponse.actionFailed());
    return true;
}

function cleanupState(session, actor, effect) {
    if (!effect) return;
    if (effect.stats?.relaxing || effect.stats?.silentMoving) {
        actor.silentMoving = EffectStore.list(actor).some((entry) => entry.stats?.silentMoving === true);
    }
    if (effect.stats?.fakeDeath) stopFakeDeath(session, actor);
}

function startFakeDeath(session, actor) {
    actor.fakeDeath = true;
    actor.automation?.abortAll?.(actor, { notifyClient: false });
    actor.attack?.clearTimers?.();
    actor.attack?.resetQueuedEvent?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    actor.state?.setCombats?.(false);
    invoke('GameServer/Effects/EffectRestrictions').stopMovement(session, actor);
    const World = invoke('GameServer/World/World');
    (World.npc?.spawns || []).forEach((npc) => {
        if (Number(npc.fetchDestId?.()) === Number(actor.fetchId?.())) npc.abortCombatState?.(session);
    });
    session?.dataSendToMeAndOthers?.(ServerResponse.changeWaitType(actor, 2), actor);
}

function stopFakeDeath(session, actor) {
    if (!actor.fakeDeath) return;
    actor.fakeDeath = false;
    session?.dataSendToMeAndOthers?.(ServerResponse.changeWaitType(actor, 3), actor);
    session?.dataSendToMeAndOthers?.(ServerResponse.revive(actor.fetchId()), actor);
}

function refreshActor(session, actor) {
    actor.statusUpdateVitals?.(actor);
    if (session?.dataSendToMe) {
        session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(actor));
        try {
            session.dataSendToMe(ServerResponse.userInfo(actor));
        } catch (_) {}
    }
}

module.exports = {
    isToggle,
    isActive,
    handleRequest,
    activate,
    deactivate,
    cleanupState
};

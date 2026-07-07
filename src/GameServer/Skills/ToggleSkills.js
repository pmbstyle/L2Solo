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

function handleRequest(session, actor, skill) {
    if (!isToggle(skill)) return false;

    const key = effectKey(skill);
    const active = EffectStore.list(actor).some((effect) => (
        effect.key === key && Number(effect.id) === Number(skill.fetchSelfId())
    ));

    if (active) {
        deactivate(session, actor, key);
        return true;
    }

    activate(session, actor, skill, key);
    return true;
}

function activate(session, actor, skill, key) {
    const semantic = skill.fetchSemantic();
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
            intervalMs: Math.max(1, Number(semantic.toggleIntervalMs) || 3000)
        } : null
    });

    if (effect?.manaDot) {
        EffectTicker.applyManaDot(session, actor, actor, effect);
    }

    refreshActor(session, actor);
    return true;
}

function deactivate(session, actor, key) {
    EffectStore.remove(actor, key);
    refreshActor(session, actor);
    session.dataSendToMe?.(ServerResponse.actionFailed());
    return true;
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
    handleRequest,
    activate,
    deactivate
};

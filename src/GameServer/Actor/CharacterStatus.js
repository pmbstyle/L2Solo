const EffectStore  = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

function activeBuffs(actor) {
    return EffectStore.list(actor)
        .filter((effect) => effect.type !== 'debuff' && effect.toggle !== true && Number(effect.expiresAt) > Date.now());
}

function serializeEffects(actor) {
    return JSON.stringify(activeBuffs(actor));
}

function parseEffects(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];

    try {
        const effects = JSON.parse(value);
        return Array.isArray(effects) ? effects : [];
    } catch (_) {
        return [];
    }
}

function restoreEffects(session, actor, value) {
    const restored = [];
    parseEffects(value).forEach((effect) => {
        if (
            !effect ||
            effect.type === 'debuff' ||
            effect.toggle === true ||
            !effect.key ||
            !Number(effect.id) ||
            Number(effect.expiresAt) <= Date.now()
        ) {
            return;
        }

        const applied = EffectStore.apply(actor, effect);
        if (!applied) return;

        if (!actor.activeBuffs) actor.activeBuffs = {};
        actor.activeBuffs[applied.key] = applied.expiresAt;
        if (applied.dot) EffectTicker.applyDot(session, actor, actor, applied);
        if (applied.manaDot) EffectTicker.applyManaDot(session, actor, actor, applied);
        if (applied.manaHot) EffectTicker.applyManaHot(session, actor, actor, applied);
        if (applied.hot) EffectTicker.applyHot(session, actor, actor, applied);
        EffectTicker.scheduleExpiry(session, actor, applied);
        restored.push(applied);
    });
    return restored;
}

function savedVitals(actor) {
    const cp = actor?.model?.cp;
    return {
        hp: Number(actor.fetchHp()),
        mp: Number(actor.fetchMp()),
        cp: cp !== null && cp !== undefined && Number.isFinite(Number(cp)) ? Number(cp) : null
    };
}

function restoreVitals(actor, vitals) {
    const clamp = (value, maximum) => Math.max(0, Math.min(Number(value), Number(maximum)));

    if (Number.isFinite(vitals?.hp)) actor.setHp(clamp(vitals.hp, actor.fetchMaxHp()));
    if (Number.isFinite(vitals?.mp)) actor.setMp(clamp(vitals.mp, actor.fetchMaxMp()));
    if (Number.isFinite(vitals?.cp) && typeof actor.setCp === 'function') {
        actor.setCp(clamp(vitals.cp, actor.fetchMaxCp()));
    }
}

function persistenceRecord(actor) {
    return {
        hp: Number(actor.fetchHp()),
        mp: Number(actor.fetchMp()),
        cp: Number(actor.fetchCp?.()) || 0,
        effects: serializeEffects(actor)
    };
}

module.exports = {
    serializeEffects,
    parseEffects,
    restoreEffects,
    savedVitals,
    restoreVitals,
    persistenceRecord
};

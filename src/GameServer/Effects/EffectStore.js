const DEFAULT_EFFECT_LEVEL = 1;

// C4 abnormal-effect bits used by CharInfo/NpcInfo. MagicEffectIcons is only
// sent to the affected player, so nearby clients need this mask to render
// persistent control effects on another creature.
const ABNORMAL_MASKS = {
    bleed: 0x0001,
    poison: 0x0002,
    stun: 0x0040,
    sleep: 0x0080,
    silence: 0x0100,
    root: 0x0200,
    paralyze: 0x0400
};

function now() {
    return Date.now();
}

function ensure(actor) {
    if (!actor) return {};
    if (!actor.effects) {
        actor.effects = {};
    }
    return actor.effects;
}

function normalize(effect = {}) {
    const key = effect.key || effect.name || String(effect.id || effect.skillId || '');
    const skillId = Number(effect.id || effect.skillId || effect.selfId || 0);
    const level = Number(effect.level || DEFAULT_EFFECT_LEVEL);
    const durationMs = Number(effect.durationMs || effect.duration || 0);
    const expiresAt = effect.expiresAt || (durationMs > 0 ? now() + durationMs : null);

    return {
        key,
        id: skillId,
        level,
        type: effect.type || 'buff',
        name: effect.name || key,
        category: effect.category || null,
        dispellable: effect.dispellable !== false,
        toggle: effect.toggle === true,
        stats: effect.stats || {},
        dot: effect.dot || null,
        manaDot: effect.manaDot || null,
        manaHot: effect.manaHot || null,
        hot: effect.hot || null,
        confusionMobOnly: effect.confusionMobOnly === true,
        expiresAt
    };
}

function prune(actor) {
    if (!actor) return {};
    const store = ensure(actor);
    const current = now();
    Object.keys(store).forEach((key) => {
        const effect = store[key];
        if (effect?.expiresAt && effect.expiresAt <= current) {
            delete store[key];
        }
    });
    return store;
}

function apply(actor, effect) {
    if (!actor) return null;
    const normalized = normalize(effect);
    if (!normalized.key || !normalized.id) return null;
    const store = ensure(actor);
    const existing = store[normalized.key];

    // A key represents one C4 effect/stack slot. Refreshing an equal or higher
    // level is valid, but a lower-level cast must never downgrade it.
    if (existing && Number(existing.level || 0) > normalized.level) {
        return existing;
    }

    store[normalized.key] = normalized;
    return normalized;
}

function remove(actor, key) {
    if (!actor?.effects) return false;
    if (!actor.effects[key]) return false;
    try {
        invoke('GameServer/Effects/EffectTicker').clear(actor, key);
    } catch (_) {}
    delete actor.effects[key];
    return true;
}

function removeByCategory(actor, category, maxLevel = Infinity) {
    const removed = [];
    list(actor).forEach((effect) => {
        const matches = effect.key === category || effect.category === category;
        const allowedLevel = Number(effect.level || 0) <= Number(maxLevel);
        if (matches && allowedLevel && remove(actor, effect.key)) {
            removed.push(effect);
        }
    });
    return removed;
}

function removeBySkillId(actor, skillId, maxLevel = Infinity) {
    const removed = [];
    const id = Number(skillId);
    list(actor).forEach((effect) => {
        const matches = Number(effect.id || 0) === id;
        const allowedLevel = Number(effect.level || 0) <= Number(maxLevel);
        if (matches && allowedLevel && remove(actor, effect.key)) {
            removed.push(effect);
        }
    });
    return removed;
}

function remainingMs(actor, key) {
    const effect = prune(actor)[key];
    if (!effect) return 0;
    if (!effect.expiresAt) return 0;
    return Math.max(0, effect.expiresAt - now());
}

function list(actor, options = {}) {
    const includeBuffs = options.includeBuffs !== false;
    const includeDebuffs = options.includeDebuffs !== false;
    return Object.values(prune(actor))
        .filter((effect) => (
            (effect.type === 'debuff' && includeDebuffs) ||
            (effect.type !== 'debuff' && includeBuffs)
        ))
        .sort((a, b) => a.id - b.id);
}

function packetEffects(actor, options = {}) {
    return list(actor, options)
        .map((effect) => ({
            id: effect.id,
            level: effect.level || DEFAULT_EFFECT_LEVEL,
            duration: effect.toggle && !effect.expiresAt
                ? 0x7fffffff
                : Math.max(0, Math.round(remainingMs(actor, effect.key) / 1000)),
            type: effect.type,
            key: effect.key
        }))
        .filter((effect) => effect.duration > 0);
}

function activeDebuffs(actor) {
    return list(actor, { includeBuffs: false, includeDebuffs: true });
}

function hasDebuff(actor, keys) {
    const wanted = new Set(Array.isArray(keys) ? keys : [keys]);
    return activeDebuffs(actor).some((effect) => wanted.has(effect.key) || wanted.has(effect.category));
}

function impairments(actor) {
    return {
        disabled: hasDebuff(actor, ['stun', 'sleep', 'paralyze', 'fear']),
        afraid: hasDebuff(actor, ['fear']),
        confused: hasDebuff(actor, ['confusion']),
        rooted: hasDebuff(actor, ['root']),
        silenced: hasDebuff(actor, ['silence']),
        slowed: hasDebuff(actor, ['slow'])
    };
}

function abnormalMask(actor) {
    return activeDebuffs(actor).reduce((mask, effect) => {
        const key = effect.key || effect.category;
        const category = effect.category || effect.key;
        return mask | (ABNORMAL_MASKS[key] || ABNORMAL_MASKS[category] || 0);
    }, 0);
}

module.exports = {
    apply,
    remove,
    removeByCategory,
    removeBySkillId,
    remainingMs,
    list,
    packetEffects,
    activeDebuffs,
    hasDebuff,
    impairments,
    abnormalMask,
    prune
};

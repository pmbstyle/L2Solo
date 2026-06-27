const DEFAULT_EFFECT_LEVEL = 1;

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
        stats: effect.stats || {},
        dot: effect.dot || null,
        manaDot: effect.manaDot || null,
        hot: effect.hot || null,
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
    ensure(actor)[normalized.key] = normalized;
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
            duration: Math.max(0, Math.round(remainingMs(actor, effect.key) / 1000)),
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
        disabled: hasDebuff(actor, ['stun', 'sleep', 'paralyze']),
        confused: hasDebuff(actor, ['confusion']),
        rooted: hasDebuff(actor, ['root']),
        silenced: hasDebuff(actor, ['silence']),
        slowed: hasDebuff(actor, ['slow'])
    };
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
    prune
};

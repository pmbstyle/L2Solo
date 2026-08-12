const DEFAULT_EFFECT_LEVEL = 1;
const BUFF_LIMIT = 20;
const DEBUFF_RESERVED_SLOTS = 10;
const SELF_PACKET_LIMIT = 30;
const PARTY_PACKET_LIMIT = 20;

let effectSequence = 0;

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
        negateType: effect.negateType || null,
        magicLevel: Number(effect.magicLevel) || 0,
        name: effect.name || key,
        category: effect.category || null,
        stackFamily: effect.stackFamily || null,
        stackOrder: resolveStackOrder(effect),
        dispellable: effect.dispellable !== false,
        toggle: effect.toggle === true,
        requires: effect.requires || null,
        stats: effect.stats || {},
        situationalStats: effect.situationalStats || [],
        dot: effect.dot || null,
        healthDot: effect.healthDot || null,
        manaDot: effect.manaDot || null,
        manaHot: effect.manaHot || null,
        hot: effect.hot || null,
        confusionMobOnly: effect.confusionMobOnly === true,
        expiresAt,
        sequence: claimSequence(effect.sequence)
    };
}

function claimSequence(value) {
    const restored = Number(value);
    if (Number.isFinite(restored) && restored > 0) {
        effectSequence = Math.max(effectSequence, restored);
        return restored;
    }
    effectSequence += 1;
    return effectSequence;
}

function resolveStackOrder(effect) {
    const explicit = Number(effect.stackOrder);
    if (Number.isFinite(explicit)) return explicit;

    const stats = effect.stats || {};
    switch (effect.stackFamily) {
        case 'SpeedUp': return Number(stats.runSpdAdd) || 0;
        case 'pAtk': return Number(stats.pAtkMul) || 0;
        case 'pDef': return Number(stats.pDefMul) || 0;
        case 'pAtkSpeedUp': return Number(stats.pAtkSpdMul) || 0;
        case 'mAtkSpeedUp': return Number(stats.castSpdMul) || 0;
        case 'mAtk': return Number(stats.mAtkMul) || 0;
        default: return Number(effect.level || DEFAULT_EFFECT_LEVEL);
    }
}

function clearLegacyMarker(actor, key) {
    if (actor?.activeBuffs?.[key] !== undefined) {
        delete actor.activeBuffs[key];
    }
}

function removeStored(actor, key, clearTimer = true) {
    if (!actor?.effects?.[key]) return false;
    if (clearTimer) {
        try {
            invoke('GameServer/Effects/EffectTicker').clear(actor, key);
        } catch (_) {}
    }
    delete actor.effects[key];
    clearLegacyMarker(actor, key);
    return true;
}

function prune(actor) {
    if (!actor) return {};
    const store = ensure(actor);
    const current = now();
    Object.keys(store).forEach((key) => {
        const effect = store[key];
        if (effect?.expiresAt && effect.expiresAt <= current) {
            delete store[key];
            clearLegacyMarker(actor, key);
        }
    });
    return store;
}

function apply(actor, effect) {
    if (!actor) return null;
    const normalized = normalize(effect);
    if (!normalized.key || !normalized.id) return null;
    const store = prune(actor);
    const existing = store[normalized.key];
    const removedEffects = [];

    if (normalized.stackFamily) {
        const stacked = Object.values(store).filter((entry) => (
            entry.stackFamily === normalized.stackFamily
        ));
        const stronger = stacked.find((entry) => Number(entry.stackOrder || 0) > normalized.stackOrder);
        if (stronger) return null;

        const equalDebuff = normalized.type === 'debuff' && stacked.find((entry) => (
            entry.type === 'debuff' && Number(entry.stackOrder || 0) === normalized.stackOrder
        ));
        if (equalDebuff) return null;

        // Lisvus runs with CancelLesserEffect enabled: once a stronger or equal
        // member wins the stack, the displaced effect is removed rather than kept
        // as an inactive stat/icon source.
        stacked.forEach((entry) => {
            if (removeStored(actor, entry.key)) removedEffects.push(entry);
        });
    } else if (existing) {
        const existingLevel = Number(existing.level || 0);
        // Lisvus does not restart an equal offensive effect. Repeated NPC casts
        // therefore keep the original expiry instead of extending a debuff forever.
        if (normalized.type === 'debuff' && existingLevel >= normalized.level) return null;
        if (normalized.type !== 'debuff' && existingLevel > normalized.level) return null;
        if (removeStored(actor, existing.key)) removedEffects.push(existing);
    }

    store[normalized.key] = normalized;
    removedEffects.push(...enforceSlotLimits(actor));
    Object.defineProperty(normalized, 'removedEffects', {
        value: removedEffects,
        enumerable: false
    });
    return normalized;
}

function includedInBuffCount(effect) {
    return effect.type !== 'debuff'
        && effect.toggle !== true
        && !['hp_recover', 'life_force_orc'].includes(effect.stackFamily);
}

function orderedEffects(actor) {
    const effects = Object.values(prune(actor));
    const bySequence = (a, b) => Number(a.sequence || 0) - Number(b.sequence || 0);
    const commonBuffs = effects.filter((effect) => (
        effect.type !== 'debuff' && effect.toggle !== true && !(effect.id > 4360 && effect.id < 4367)
    )).sort(bySequence);
    const specialBuffs = effects.filter((effect) => (
        effect.type !== 'debuff' && (effect.toggle === true || (effect.id > 4360 && effect.id < 4367))
    )).sort(bySequence);
    const debuffs = effects.filter((effect) => effect.type === 'debuff').sort(bySequence);
    return [...commonBuffs, ...specialBuffs, ...debuffs];
}

function enforceSlotLimits(actor) {
    const effects = orderedEffects(actor);
    const debuffCount = effects.filter((effect) => effect.type === 'debuff').length;
    const allowedBuffs = Math.max(0, BUFF_LIMIT - Math.max(0, debuffCount - DEBUFF_RESERVED_SLOTS));
    const countedBuffs = effects.filter(includedInBuffCount);
    const excess = Math.max(0, countedBuffs.length - allowedBuffs);
    return countedBuffs.slice(0, excess).filter((effect) => removeStored(actor, effect.key));
}

function remove(actor, key) {
    return removeStored(actor, key);
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
    return orderedEffects(actor)
        .filter((effect) => (
            (effect.type === 'debuff' && includeDebuffs) ||
            (effect.type !== 'debuff' && includeBuffs)
        ))
        .sort((a, b) => a.id - b.id);
}

function packetEffects(actor, options = {}) {
    const includeBuffs = options.includeBuffs !== false;
    const includeDebuffs = options.includeDebuffs !== false;
    const effects = orderedEffects(actor)
        .filter((effect) => (
            (effect.type === 'debuff' && includeDebuffs) ||
            (effect.type !== 'debuff' && includeBuffs)
        ))
        .filter((effect) => options.includeShortBuffs !== false || effect.stackFamily !== 'life_force_orc')
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
    return limitPacketEffects(effects, options.limit);
}

function shortBuff(actor) {
    return orderedEffects(actor).find((effect) => (
        effect.type !== 'debuff' && effect.stackFamily === 'life_force_orc'
    )) || null;
}

function limitPacketEffects(effects = [], limit = Infinity) {
    const capacity = Number(limit);
    if (!Number.isFinite(capacity) || capacity <= 0 || effects.length <= capacity) {
        return capacity <= 0 ? [] : [...effects];
    }

    const visible = effects.slice(0, capacity);
    effects.slice(capacity).forEach((effect, index) => {
        visible[index % capacity] = effect;
    });
    return visible;
}

function activeDebuffs(actor) {
    return list(actor, { includeBuffs: false, includeDebuffs: true });
}

function hasDebuff(actor, keys) {
    const wanted = new Set(Array.isArray(keys) ? keys : [keys]);
    return activeDebuffs(actor).some((effect) => wanted.has(effect.key) || wanted.has(effect.category));
}

function impairments(actor) {
    const debuffs = activeDebuffs(actor);
    return {
        disabled: debuffs.some((effect) => ['stun', 'sleep', 'paralyze', 'fear'].includes(effect.key) || ['stun', 'sleep', 'paralyze', 'fear'].includes(effect.category)),
        afraid: debuffs.some((effect) => effect.key === 'fear' || effect.category === 'fear'),
        confused: debuffs.some((effect) => effect.key === 'confusion' || effect.category === 'confusion'),
        rooted: debuffs.some((effect) => effect.key === 'root' || effect.category === 'root'),
        silenced: debuffs.some((effect) => effect.key === 'silence' || effect.category === 'silence'),
        physicalMuted: debuffs.some((effect) => effect.stats?.physicalMute === true),
        magicMuted: debuffs.some((effect) => effect.stats?.magicMute === true),
        slowed: debuffs.some((effect) => effect.key === 'slow' || effect.category === 'slow')
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
    BUFF_LIMIT,
    DEBUFF_RESERVED_SLOTS,
    SELF_PACKET_LIMIT,
    PARTY_PACKET_LIMIT,
    apply,
    remove,
    removeByCategory,
    removeBySkillId,
    remainingMs,
    list,
    packetEffects,
    shortBuff,
    limitPacketEffects,
    activeDebuffs,
    hasDebuff,
    impairments,
    abnormalMask,
    prune
};

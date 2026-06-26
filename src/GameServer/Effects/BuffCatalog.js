const ALL_BUFFS = {
    windwalk: {
        key: 'windWalk',
        id: 1204,
        level: 2,
        name: 'Wind Walk',
        stats: { runSpdAdd: 33 }
    },
    shield: {
        key: 'shield',
        id: 1040,
        level: 2,
        name: 'Shield',
        stats: { pDefMul: 1.12 }
    },
    haste: {
        key: 'haste',
        id: 1086,
        level: 2,
        name: 'Haste',
        stats: { pAtkSpdMul: 1.33 }
    },
    might: {
        key: 'might',
        id: 1068,
        level: 2,
        name: 'Might',
        stats: { pAtkMul: 1.12 }
    }
};

function byTypeOrKey(typeOrKey) {
    return ALL_BUFFS[typeOrKey] || Object.values(ALL_BUFFS).find((buff) => buff.key === typeOrKey);
}

function isActive(actor, typeOrKey, at = Date.now()) {
    const buff = byTypeOrKey(typeOrKey);
    return !!(buff && actor?.activeBuffs?.[buff.key] && at < actor.activeBuffs[buff.key]);
}

function statMultiplier(actor, typeOrKey, stat, fallback = 1) {
    const buff = byTypeOrKey(typeOrKey);
    if (!buff || !isActive(actor, typeOrKey)) return fallback;
    return Number(buff.stats?.[stat]) || fallback;
}

function statAdd(actor, typeOrKey, stat, fallback = 0) {
    const buff = byTypeOrKey(typeOrKey);
    if (!buff || !isActive(actor, typeOrKey)) return fallback;
    return Number(buff.stats?.[stat]) || fallback;
}

module.exports = {
    ALL_BUFFS,
    byTypeOrKey,
    isActive,
    statMultiplier,
    statAdd
};

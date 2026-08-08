const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');

const ROLE_CLASSES = {
    healer: [15, 16, 29, 30, 42, 43],
    buffer: [17, 21, 34, 49, 50, 51, 52],
    tank: [4, 5, 6, 19, 20, 32, 33],
    dagger: [7, 8, 23, 35, 36],
    archer: [9, 22, 24, 37],
    mage: [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41],
    crafter: [56, 57]
};

function classIdOf(value) {
    if (typeof value === 'number' || typeof value === 'string') return value;
    if (value && typeof value.fetchClassId === 'function') return value.fetchClassId();
    if (value?.classId !== null && value?.classId !== undefined) return Number(value.classId);
    if (value?.stats?.classId !== null && value?.stats?.classId !== undefined) return Number(value.stats.classId);
    if (value?.stats?.classProgressionClassId !== null && value?.stats?.classProgressionClassId !== undefined) {
        return Number(value.stats.classProgressionClassId);
    }
    return null;
}

function normalizedClassId(value) {
    const classId = classIdOf(value);
    if (classId === null || classId === undefined || classId === '') return null;
    const number = Number(classId);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function className(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return (DataCache.classTemplates || [])
        .find((template) => Number(template.classId) === classId)
        ?.template?.class || null;
}

function presentation(value) {
    const classId = normalizedClassId(value);
    return {
        classId,
        className: className(value),
        role: inferRole(value)
    };
}

function roleClassId(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return Number(ClassProgression.getThirdClass(classId)?.parentClassId || classId);
}

function inferRole(value) {
    const classId = roleClassId(value);
    if (classId === null || classId === undefined) return 'dps';

    if (ROLE_CLASSES.healer.includes(classId)) return 'healer';
    if (ROLE_CLASSES.buffer.includes(classId)) return 'buffer';
    if (ROLE_CLASSES.tank.includes(classId)) return 'tank';
    if (ROLE_CLASSES.dagger.includes(classId)) return 'dagger';
    if (ROLE_CLASSES.archer.includes(classId)) return 'archer';
    if (ROLE_CLASSES.mage.includes(classId)) return 'mage';
    if (ROLE_CLASSES.crafter.includes(classId)) return 'crafter';
    return 'dps';
}

function isRole(value, role) {
    const classId = roleClassId(value);
    const classes = ROLE_CLASSES[role];
    return !!classes && classes.includes(classId);
}

function isHealer(value) {
    return isRole(value, 'healer');
}

function isTank(value) {
    return isRole(value, 'tank');
}

function canBuff(value) {
    return isRole(value, 'buffer');
}

function isRanged(roleOrActor) {
    const role = typeof roleOrActor === 'string' ? roleOrActor : inferRole(roleOrActor);
    return role === 'archer' || role === 'mage';
}

function hasMeleeWeapon(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon?.();
    if (!weapon) return false;

    const kind = String(weapon.fetchKind?.() || '');
    const name = String(weapon.fetchName?.() || '');
    // C4 stores staves, wands and rods under Weapon.Blunt together with real
    // clubs and maces. Their names are the authoritative distinction in the
    // datapack, so do not let a support class treat every blunt as melee.
    const casterWeapon = /\b(staff|wand|rod|spellbook|voodoo|scroll)\b/i.test(name);
    return kind.startsWith('Weapon.') && kind !== 'Weapon.Bow' && !casterWeapon;
}

function partyRoleStance(role) {
    if (role === 'healer') return 'support';
    if (role === 'buffer') return 'buff_support';
    if (role === 'tank') return 'protector';
    if (role === 'dagger') return 'flank_assist';
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    return 'assist';
}

module.exports = {
    ROLE_CLASSES,
    className,
    presentation,
    inferRole,
    isRole,
    isHealer,
    isTank,
    canBuff,
    isRanged,
    hasMeleeWeapon,
    partyRoleStance
};

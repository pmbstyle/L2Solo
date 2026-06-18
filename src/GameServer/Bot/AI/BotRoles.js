const ROLE_CLASSES = {
    healer: [15, 16, 17, 29, 30, 42, 43],
    tank: [4, 5, 6, 19, 20, 32, 33],
    archer: [8, 9, 22, 23, 35, 36, 37],
    mage: [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41, 49, 50, 51, 52],
    spoiler: [54, 55],
    crafter: [56, 57],
    dwarf: [53, 54, 55, 56, 57]
};

function classIdOf(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value.fetchClassId === 'function') return value.fetchClassId();
    return null;
}

function inferRole(value) {
    const classId = classIdOf(value);
    if (classId === null || classId === undefined) return 'dps';

    if (ROLE_CLASSES.healer.includes(classId)) return 'healer';
    if (ROLE_CLASSES.tank.includes(classId)) return 'tank';
    if (ROLE_CLASSES.archer.includes(classId)) return 'archer';
    if (ROLE_CLASSES.mage.includes(classId)) return 'mage';
    if (ROLE_CLASSES.spoiler.includes(classId)) return 'spoiler';
    if (ROLE_CLASSES.crafter.includes(classId)) return 'crafter';
    if (ROLE_CLASSES.dwarf.includes(classId)) return 'dwarf';
    return 'dps';
}

function isRole(value, role) {
    const classId = classIdOf(value);
    const classes = ROLE_CLASSES[role];
    return !!classes && classes.includes(classId);
}

function isHealer(value) {
    return isRole(value, 'healer');
}

function isTank(value) {
    return isRole(value, 'tank');
}

function isRanged(roleOrActor) {
    const role = typeof roleOrActor === 'string' ? roleOrActor : inferRole(roleOrActor);
    return role === 'archer' || role === 'mage';
}

function valuesMaterial(role) {
    return role === 'dwarf' || role === 'spoiler' || role === 'crafter';
}

function partyRoleStance(role) {
    if (role === 'healer') return 'support';
    if (role === 'tank') return 'protector';
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    if (role === 'spoiler') return 'spoil_assist';
    if (role === 'crafter') return 'economic_support';
    if (role === 'dwarf') return 'combat_support';
    return 'assist';
}

module.exports = {
    ROLE_CLASSES,
    inferRole,
    isRole,
    isHealer,
    isTank,
    isRanged,
    valuesMaterial,
    partyRoleStance
};

const ROLE_CLASSES = {
    healer: [15, 16, 29, 30, 42, 43],
    buffer: [17, 49, 50, 51],
    tank: [4, 5, 6, 19, 20, 32, 33],
    dagger: [7, 8, 23, 35, 36],
    archer: [9, 22, 24, 37],
    mage: [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41, 52],
    crafter: [56, 57]
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
    if (ROLE_CLASSES.buffer.includes(classId)) return 'buffer';
    if (ROLE_CLASSES.tank.includes(classId)) return 'tank';
    if (ROLE_CLASSES.dagger.includes(classId)) return 'dagger';
    if (ROLE_CLASSES.archer.includes(classId)) return 'archer';
    if (ROLE_CLASSES.mage.includes(classId)) return 'mage';
    if (ROLE_CLASSES.crafter.includes(classId)) return 'crafter';
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

function canBuff(value) {
    return isRole(value, 'buffer');
}

function isRanged(roleOrActor) {
    const role = typeof roleOrActor === 'string' ? roleOrActor : inferRole(roleOrActor);
    return role === 'archer' || role === 'mage';
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
    inferRole,
    isRole,
    isHealer,
    isTank,
    canBuff,
    isRanged,
    partyRoleStance
};

const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');

const ROLE_CLASSES = {
    healer: [15, 16, 29, 30, 42, 43],
    buffer: [17, 21, 34, 49, 50, 51, 52],
    tank: [4, 5, 6, 19, 20, 32, 33],
    dagger: [7, 8, 23, 35, 36],
    archer: [9, 22, 24, 37],
    mage: [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41],
    spoiler: [53, 54, 55],
    crafter: [56, 57]
};
const DWARF_CLASS_IDS = new Set([53, 54, 55, 56, 57, 117, 118]);
const SPOILER_CLASS_IDS = new Set([53, 54, 55, 117]);
const MANA_REST_ROLES = new Set(['mage', 'archer', 'healer']);
// Prophet and the Orc mystic line cast as their primary party job. Sword
// Singer and Bladedancer share the buffer role, but they are melee fighters
// whose combat loop must not stop merely because their MP is low.
const CASTER_BUFFER_CLASSES = new Set([17, 49, 50, 51, 52]);
const SUMMONER_CLASSES = new Set([14, 28, 41]);
const NECROMANCER_CLASSES = new Set([13]);

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

function levelOf(value) {
    const raw = value && typeof value.fetchLevel === 'function'
        ? value.fetchLevel()
        : value?.level ?? value?.stats?.level;
    const level = Number(raw);
    return Number.isFinite(level) && level > 0 ? level : null;
}

function isSpoiler(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return false;

    const baseClassId = roleClassId(value);
    if (SPOILER_CLASS_IDS.has(classId) || SPOILER_CLASS_IDS.has(baseClassId)) return true;

    const level = levelOf(value);
    return DWARF_CLASS_IDS.has(classId) && level !== null && level < 40;
}

function inferRole(value) {
    const classId = roleClassId(value);
    if (classId === null || classId === undefined) return 'dps';

    if (isSpoiler(value)) return 'spoiler';
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
    if (role === 'spoiler') return isSpoiler(value);
    if (role === 'crafter' && isSpoiler(value)) return false;
    const classId = roleClassId(value);
    const classes = ROLE_CLASSES[role];
    return !!classes && classes.includes(classId);
}

// Crafting remains a separate economic identity, but until its dedicated
// combat policy exists a non-spoiler dwarf should fight as a normal DPS.
function combatRoleFor(value) {
    if (isSpoiler(value)) return 'spoiler';
    const role = inferRole(value);
    return role === 'crafter' && DWARF_CLASS_IDS.has(normalizedClassId(value)) ? 'dps' : role;
}

function isHealer(value) {
    return isRole(value, 'healer');
}

function isTank(value) {
    return isRole(value, 'tank');
}

function isSummoner(value) {
    return SUMMONER_CLASSES.has(roleClassId(value));
}

function isNecromancer(value) {
    return NECROMANCER_CLASSES.has(roleClassId(value));
}

function canBuff(value) {
    return isRole(value, 'buffer');
}

function shouldRestForMana(value) {
    const role = inferRole(value);
    return MANA_REST_ROLES.has(role) || (
        role === 'buffer' && CASTER_BUFFER_CLASSES.has(roleClassId(value))
    );
}

// Sitting and receiving Recharge are deliberately separate policies. A tank
// must stay on its feet with the melee line, but an empty MP bar prevents it
// from using Aggression/Hate Aura and therefore threatens the whole party.
function needsPartyManaRecovery(value) {
    return shouldRestForMana(value) || inferRole(value) === 'tank';
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
    const casterWeapon = BotWeaponCompatibility.isCasterWeapon(
        kind,
        name,
        weapon.fetchPAtk?.(),
        weapon.fetchMAtk?.()
    );
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
    SUMMONER_CLASSES,
    NECROMANCER_CLASSES,
    className,
    roleClassId,
    isSpoiler,
    presentation,
    inferRole,
    combatRoleFor,
    isRole,
    isHealer,
    isTank,
    isSummoner,
    isNecromancer,
    canBuff,
    shouldRestForMana,
    needsPartyManaRecovery,
    isRanged,
    hasMeleeWeapon,
    partyRoleStance
};

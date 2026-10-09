const ClassProgression = invoke('GameServer/ClassProgression');

const CASTER_ROLES = new Set(['mage', 'healer']);
const CASTER_BUFFER_CLASSES = new Set([17, 49, 51, 52]);

const CLASS_PROFILES = {
    // First-profession Orc Shamans level through melee while retaining their
    // support role. A physical blunt preserves Stun Attack; one hand leaves
    // room for a shield. Second professions keep their own support profiles.
    50: {
        weaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: [],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    // Gladiator and Bladedancer need a dual sword, which NPCs do not sell.
    // Until they hold one they keep fighting with the weapons of their
    // previous profession (interimClassId); the dual sword stays their target.
    2: {
        weaponKinds: ['Weapon.Dual'],
        interimClassId: 1,
        preferredWeaponKinds: ['Weapon.Dual'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Dual'],
        shield: false,
        weaponHint: 'dual_swords'
    },
    3: {
        weaponKinds: ['Weapon.Pole'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: false,
        weaponHint: 'polearm'
    },
    21: {
        weaponKinds: ['Weapon.Sword', 'Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: [],
        shield: true,
        weaponHint: 'melee_sword_or_blunt'
    },
    34: {
        weaponKinds: ['Weapon.Dual'],
        interimClassId: 32,
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Dual'],
        shield: false,
        weaponHint: 'dual_swords'
    },
    44: {
        weaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: [],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    45: {
        weaponKinds: ['Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: true,
        weaponHint: 'blunt_or_polearm'
    },
    46: {
        weaponKinds: ['Weapon.GreatSword', 'Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.GreatSword'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.GreatSword', 'Weapon.Blunt', 'Weapon.Pole'],
        shield: false,
        weaponHint: 'two_handed_sword_or_blunt'
    },
    47: {
        weaponKinds: ['Weapon.Fist', 'Weapon.DualFist'],
        preferredWeaponKinds: ['Weapon.DualFist'],
        armorStyle: 'light',
        twoHandedWeaponKinds: ['Weapon.DualFist'],
        shield: false,
        weaponHint: 'dual_fist'
    },
    48: {
        weaponKinds: ['Weapon.Fist', 'Weapon.DualFist'],
        preferredWeaponKinds: ['Weapon.DualFist'],
        armorStyle: 'light',
        twoHandedWeaponKinds: ['Weapon.DualFist'],
        shield: false,
        weaponHint: 'dual_fist'
    },
    53: {
        weaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: [],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    54: {
        weaponKinds: ['Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    55: {
        weaponKinds: ['Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    56: {
        weaponKinds: ['Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: true,
        weaponHint: 'one_handed_blunt'
    },
    57: {
        weaponKinds: ['Weapon.Blunt', 'Weapon.Pole'],
        preferredWeaponKinds: ['Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: ['Weapon.Pole'],
        shield: true,
        weaponHint: 'one_handed_blunt'
    }
};

function baseClassId(classId) {
    if (classId === null || classId === undefined || classId === '') return null;
    const value = Number(classId);
    if (!Number.isInteger(value) || value < 0) return null;
    return Number(ClassProgression.getThirdClass(value)?.parentClassId || value);
}

function isCasterRole(role, classId) {
    const classBase = baseClassId(classId);
    return CASTER_ROLES.has(role) || (
        role === 'buffer' && (classBase === null || CASTER_BUFFER_CLASSES.has(classBase))
    );
}

function roleProfile(role, classId) {
    if (role === 'archer') {
        return {
            weaponKinds: ['Weapon.Bow'],
            armorStyle: 'light',
            twoHandedWeaponKinds: ['Weapon.Bow'],
            shield: false,
            weaponHint: 'bow'
        };
    }
    if (role === 'dagger') {
        return {
            weaponKinds: ['Weapon.Knife'],
            armorStyle: 'light',
            twoHandedWeaponKinds: [],
            shield: false,
            weaponHint: 'dagger'
        };
    }
    if (isCasterRole(role, classId)) {
        return {
            weaponKinds: ['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'],
            armorStyle: 'robe',
            twoHandedWeaponKinds: ['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'],
            shield: false,
            weaponHint: 'caster_weapon'
        };
    }
    if (role === 'buffer') {
        return {
            weaponKinds: ['Weapon.Sword', 'Weapon.Blunt'],
            armorStyle: 'heavy',
            twoHandedWeaponKinds: [],
            shield: true,
            weaponHint: 'one_handed_sword_or_blunt'
        };
    }

    return {
        weaponKinds: ['Weapon.Sword', 'Weapon.Blunt'],
        armorStyle: 'heavy',
        twoHandedWeaponKinds: [],
        shield: !['mage', 'healer', 'archer', 'dagger'].includes(role),
        weaponHint: role === 'spoiler' || role === 'crafter'
            ? 'one_handed_blunt'
            : 'one_handed_sword_or_blunt'
    };
}

// Retail starter weapons a class profile does not list: usable until the bot
// buys a preferred one, never preferred. An Orc Mystic is created with Training
// Gloves (Weapon.DualFist); judged unarmed, it could only wait for a rod it
// could not pay for (live 2026-10-03: 25 of 165 stood at level 6 for 18 hours).
const STARTER_WEAPON_KINDS = {
    49: ['Weapon.Fist', 'Weapon.DualFist']
};

function profileFor(role, classId) {
    const explicit = CLASS_PROFILES[baseClassId(classId)];
    const profile = explicit || roleProfile(role, classId);
    const starterKinds = STARTER_WEAPON_KINDS[baseClassId(classId)] || [];
    const weaponKinds = [...profile.weaponKinds, ...starterKinds];

    return {
        baseClassId: baseClassId(classId),
        weaponKinds,
        preferredWeaponKinds: [...(profile.preferredWeaponKinds || profile.weaponKinds)],
        armorStyle: profile.armorStyle,
        twoHandedWeaponKinds: [...profile.twoHandedWeaponKinds, ...starterKinds.filter((kind) => kind === 'Weapon.DualFist')],
        shield: profile.shield,
        weaponHint: profile.weaponHint
    };
}

function weaponKindsFor(role, classId) {
    return profileFor(role, classId).weaponKinds;
}

// A retail starter weapon the class profile does not list (STARTER_WEAPON_KINDS).
function isStarterWeaponKind(kind, classId) {
    return (STARTER_WEAPON_KINDS[baseClassId(classId)] || []).includes(kind);
}

function interimClassIdFor(classId) {
    return Number(CLASS_PROFILES[baseClassId(classId)]?.interimClassId || 0);
}

function preferredWeaponKindsFor(role, classId) {
    return profileFor(role, classId).preferredWeaponKinds;
}

function armorStyleFor(role, classId) {
    return profileFor(role, classId).armorStyle;
}

function armorKindFor(role, classId) {
    const style = armorStyleFor(role, classId);
    if (style === 'robe') return 'Armor.Fabric';
    if (style === 'light') return 'Armor.Leather';
    return 'Armor.Chain';
}

function allowsTwoHandedWeapon(kind, role, classId) {
    return profileFor(role, classId).twoHandedWeaponKinds.includes(kind);
}

function usesShield(role, classId) {
    return profileFor(role, classId).shield;
}

function weaponHintFor(role, classId) {
    return profileFor(role, classId).weaponHint;
}

// A weapon occupies one shared group; a two-handed weapon also clears the
// shield. These are paperdoll rules, independent of class or economic policy.
function isWeaponSlot(slot) {
    const value = Number(slot || 0);
    return value === 7 || value === 14;
}
function equipmentSlotKey(slot) {
    const value = Number(slot || 0);
    return isWeaponSlot(value) ? 'weapon' : String(value);
}
function equipmentReplacementConflict(slot, wornSlot) {
    const next = Number(slot || 0), worn = Number(wornSlot || 0);
    return next === worn || isWeaponSlot(next) && isWeaponSlot(worn)
        || next === 14 && worn === 8;
}

module.exports = {
    isWeaponSlot,
    equipmentSlotKey,
    equipmentReplacementConflict,
    armorKindFor,
    armorStyleFor,
    allowsTwoHandedWeapon,
    baseClassId,
    interimClassIdFor,
    isCasterRole,
    isStarterWeaponKind,
    preferredWeaponKindsFor,
    profileFor,
    usesShield,
    weaponHintFor,
    weaponKindsFor
};

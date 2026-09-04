const ClassProgression = invoke('GameServer/ClassProgression');

const CASTER_ROLES = new Set(['mage', 'healer']);
const CASTER_BUFFER_CLASSES = new Set([17, 49, 50, 51, 52]);

const CLASS_PROFILES = {
    2: {
        weaponKinds: ['Weapon.Dual'],
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

function profileFor(role, classId) {
    const explicit = CLASS_PROFILES[baseClassId(classId)];
    const profile = explicit || roleProfile(role, classId);
    const weaponKinds = [...profile.weaponKinds];

    return {
        baseClassId: baseClassId(classId),
        weaponKinds,
        preferredWeaponKinds: [...(profile.preferredWeaponKinds || weaponKinds)],
        armorStyle: profile.armorStyle,
        twoHandedWeaponKinds: [...profile.twoHandedWeaponKinds],
        shield: profile.shield,
        weaponHint: profile.weaponHint
    };
}

function weaponKindsFor(role, classId) {
    return profileFor(role, classId).weaponKinds;
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

module.exports = {
    armorKindFor,
    armorStyleFor,
    allowsTwoHandedWeapon,
    baseClassId,
    isCasterRole,
    preferredWeaponKindsFor,
    profileFor,
    usesShield,
    weaponHintFor,
    weaponKindsFor
};

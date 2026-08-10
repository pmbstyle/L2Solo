const ClassProgression = invoke('GameServer/ClassProgression');

const CASTER_ROLES = new Set(['mage', 'healer']);
const CASTER_BUFFER_CLASSES = new Set([17, 49, 50, 51, 52]);
const FIST_CLASSES = new Set([47, 48]);
const ORC_BLUNT_CLASSES = new Set([44, 45, 46, 49, 50, 51, 52, 53, 54, 55, 56, 57]);
const CASTER_WEAPON_NAME = /\b(staff|wand|rod|spellbook|voodoo|scroll)\b/i;

function baseClassId(classId) {
    const value = Number(classId);
    if (!Number.isInteger(value) || value < 0) return null;
    return Number(ClassProgression.getThirdClass(value)?.parentClassId || value);
}

function isCasterRole(role, classId) {
    return CASTER_ROLES.has(role) || (
        role === 'buffer' && CASTER_BUFFER_CLASSES.has(baseClassId(classId))
    );
}

function isFistClass(classId) {
    return FIST_CLASSES.has(baseClassId(classId));
}

function isCasterWeapon(kind, name = '', pAtk = 0, mAtk = 0) {
    if (kind === 'Weapon.Etc') return true;
    if (!['Weapon.Sword', 'Weapon.Blunt'].includes(kind)) return false;
    if (CASTER_WEAPON_NAME.test(String(name || ''))) return true;

    const physical = Math.max(0, Number(pAtk) || 0);
    const magical = Math.max(0, Number(mAtk) || 0);
    // Starter weapons have tiny, naturally close P.Atk/M.Atk values (for
    // example Broadsword 11/9).  Treating that ratio alone as a caster signal
    // makes a newly promoted Sword Singer or Bladedancer abandon a perfectly
    // ordinary melee weapon.  Real hybrid caster swords/blunts either lead in
    // M.Atk or start at the established D-grade combat-stat band.
    return magical > 0 && (
        magical >= physical ||
        (physical >= 40 && magical >= physical * 0.8)
    );
}

function scoreWeapon(pAtk, mAtk, role, classId) {
    const physical = Number(pAtk) || 0;
    const magical = Number(mAtk) || 0;
    return isCasterRole(role, classId)
        ? magical * 3 + physical
        : physical * 2 + magical;
}

function weaponKindsFor(role, classId) {
    if (role === 'archer') return ['Weapon.Bow'];
    if (role === 'dagger') return ['Weapon.Knife'];
    if (isCasterRole(role, classId)) return ['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'];
    if (isFistClass(classId)) return ['Weapon.Fist', 'Weapon.DualFist'];
    if (ORC_BLUNT_CLASSES.has(baseClassId(classId))) return ['Weapon.Blunt'];
    return ['Weapon.Sword', 'Weapon.Blunt'];
}

function isCompatibleWeapon(kind, role, classId) {
    return weaponKindsFor(role, classId).includes(kind);
}

function isSuitableWeapon(kind, name, pAtk, mAtk, role, classId) {
    if (!isCompatibleWeapon(kind, role, classId)) return false;
    if (isCasterRole(role, classId)) return true;
    return !isCasterWeapon(kind, name, pAtk, mAtk);
}

module.exports = {
    isCasterRole,
    isCasterWeapon,
    isFistClass,
    isCompatibleWeapon,
    isSuitableWeapon,
    scoreWeapon,
    weaponKindsFor
};

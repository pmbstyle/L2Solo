const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');

const CASTER_WEAPON_NAME = /\b(staff|wand|rod|spellbook|voodoo|scroll)\b/i;

function isCasterRole(role, classId) {
    return BotEquipmentCompatibility.isCasterRole(role, classId);
}

function isFistClass(classId) {
    return [47, 48].includes(BotEquipmentCompatibility.baseClassId(classId));
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
    return BotEquipmentCompatibility.weaponKindsFor(role, classId);
}

function isCompatibleWeapon(kind, role, classId) {
    return weaponKindsFor(role, classId).includes(kind);
}

function isSuitableWeapon(kind, name, pAtk, mAtk, role, classId) {
    if (!isCompatibleWeapon(kind, role, classId)) return false;
    if (isCasterRole(role, classId)) return isCasterWeapon(kind, name, pAtk, mAtk);
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

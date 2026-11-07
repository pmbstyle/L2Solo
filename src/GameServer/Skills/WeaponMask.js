// L2WeaponType.mask() values used by the C4 weaponsAllowed condition.
// Kept independent of native actors/networking for cold combat workers.
const MASK_BY_KIND = Object.freeze({
    'Weapon.Sword': 4,
    'Weapon.Blunt': 8,
    'Weapon.Knife': 16,
    'Weapon.Bow': 32,
    'Weapon.Pole': 64,
    'Weapon.Fist': 256,
    'Weapon.Dual': 512,
    'Weapon.DualFist': 1024,
    'Weapon.GreatSword': 2048,
    'Weapon.BigBlunt': 16384
});

// The C4 weapon type of a worn weapon (L2WeaponType): the datapack names a
// two-handed blunt 'Weapon.Blunt' in the two-handed slot; C4 types it BIGBLUNT,
// as the two-handed weapon mastery (293) and the weaponsAllowed masks ask (T119).
const TWO_HANDED_SLOT = 14;
function weaponType(kind, slot) {
    return kind === 'Weapon.Blunt' && Number(slot) === TWO_HANDED_SLOT ? 'Weapon.BigBlunt' : kind;
}

function weaponMaskFor(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon?.();
    const kind = weaponType(actor?.backpack?.fetchTotalWeaponKind?.() || '', weapon?.fetchSlot?.());
    const hasShield = (actor?.backpack?.fetchEquippedArmors?.() || [])
        .some(item => item?.fetchKind?.() === 'Armor.Shield');
    return (MASK_BY_KIND[kind] || 0) | (hasShield ? 1048576 : 0);
}

module.exports = { weaponMaskFor, weaponType, MASK_BY_KIND };

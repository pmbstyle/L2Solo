function enchantLevel(item) {
    return Math.min(127, Math.max(0, Number(
        item?.fetchEnchantLevel?.() ?? item?.enchant ?? item?.model?.enchant ?? 0
    ) || 0));
}

function activeWeapon(actor) {
    const backpack = actor?.backpack;
    if (!backpack) return null;

    const equippedWeapon = backpack.fetchEquippedWeapon?.();
    if (equippedWeapon) return equippedWeapon;
    if (typeof backpack.fetchItemRaw !== 'function') return null;

    for (const slot of [7, 14]) {
        const objectId = backpack.fetchPaperdollId?.(slot);
        const item = objectId ? backpack.fetchItemRaw?.(objectId) : null;
        if (item) return item;
    }

    return null;
}

function characterSelectWeapon(character) {
    const paperdoll = character?.paperdoll;
    const items = Array.isArray(character?.items) ? character.items : [];

    for (const slot of [7, 14]) {
        const entry = paperdoll?.[slot];
        if (!entry?.id && !entry?.selfId) continue;

        const item = items.find((candidate) => Number(candidate.id) === Number(entry.id));
        return item || entry;
    }

    return null;
}

function weaponEnchantEffect(character) {
    const weapon = character?.backpack
        ? activeWeapon(character)
        : characterSelectWeapon(character);
    return enchantLevel(weapon);
}

module.exports = weaponEnchantEffect;
module.exports.enchantLevel = enchantLevel;

const SCROLLS = invoke('GameServer/Items/C4EnchantScrolls');

const DEFAULTS = Object.freeze({
    weaponChance: 68,
    armorChance: 52,
    accessoryChance: 54,
    blessedWeaponChance: 68,
    blessedArmorChance: 52,
    blessedAccessoryChance: 54,
    crystalWeaponChance: 68,
    crystalArmorChance: 52,
    crystalAccessoryChance: 54,
    maxWeapon: 0,
    maxArmor: 0,
    maxAccessory: 0,
    safeMax: 3,
    safeMaxFull: 4
});

const CRYSTAL_IDS = Object.freeze({
    D: 1458,
    C: 1459,
    B: 1460,
    A: 1461,
    S: 1462
});

const CRYSTAL_BONUS = Object.freeze({
    D: { armor: 11, weapon: 90 },
    C: { armor: 6, weapon: 45 },
    B: { armor: 11, weapon: 67 },
    A: { armor: 19, weapon: 144 },
    S: { armor: 25, weapon: 250 }
});

const FISHING_RODS = new Set([6529, 6530, 6531, 6532, 6533, 6534, 7560]);

function gradeOf(item) {
    return String(item?.fetchRank?.() ?? item?.model?.rank ?? item?.rank ?? 'none').trim().toUpperCase();
}

function categoryOf(item) {
    if (item?.isWeapon?.()) return 'weapon';
    if (!item?.isArmor?.()) return null;
    return String(item.fetchKind?.() || item.model?.kind || '').toLowerCase().includes('jewel')
        ? 'accessory'
        : 'armor';
}

function enchantLevelOf(item) {
    return Math.max(0, Number(item?.fetchEnchantLevel?.() ?? item?.model?.enchant ?? item?.enchant ?? 0) || 0);
}

function validTarget(item, scroll) {
    const category = categoryOf(item);
    if (!category || !scroll || scroll.target !== (category === 'weapon' ? 'weapon' : 'armor')) return false;
    if (gradeOf(item) !== String(scroll.grade || '').toUpperCase()) return false;
    if (FISHING_RODS.has(Number(item.fetchSelfId?.() || item.selfId))) return false;
    if (Number(item.fetchSelfId?.() || item.selfId) >= 7816 && Number(item.fetchSelfId?.() || item.selfId) <= 7831) return false;
    return Number(item.fetchAmount?.() ?? item.amount ?? 0) === 1;
}

function configWith(overrides = {}) {
    return { ...DEFAULTS, ...(overrides || {}) };
}

function chanceFor(category, scrollType, config) {
    const prefix = scrollType === 'blessed' ? 'blessed' : scrollType === 'crystal' ? 'crystal' : '';
    const key = `${prefix ? `${prefix}` : ''}${category[0].toUpperCase()}${category.slice(1)}Chance`;
    return Number(config[key] ?? config[`${category}Chance`] ?? 0);
}

function maxFor(category, config) {
    return Number(config[{ weapon: 'maxWeapon', armor: 'maxArmor', accessory: 'maxAccessory' }[category]] || 0);
}

function isSafe(item, level, config) {
    if (level < Number(config.safeMax || 0)) return true;
    return categoryOf(item) === 'armor'
        && Number(item.fetchSlot?.() ?? item.model?.slot ?? item.slot ?? 0) === 15
        && level < Number(config.safeMaxFull || 0);
}

function crystalCount(item, enchantLevel = enchantLevelOf(item)) {
    const base = Math.max(0, Number(item?.fetchCristals?.() ?? item?.model?.cristals ?? item?.cristals ?? 0) || 0);
    if (base <= 0) return 0;
    const grade = gradeOf(item);
    const bonus = CRYSTAL_BONUS[grade];
    if (!bonus) return base;
    const level = Math.max(0, Number(enchantLevel) || 0);
    if (level <= 0) return base;
    if (categoryOf(item) === 'weapon') {
        return base + bonus.weapon * (level > 3 ? (2 * level - 3) : level);
    }
    return base + bonus.armor * (level > 3 ? (3 * level - 6) : level);
}

function statBonus(item, stat) {
    const level = enchantLevelOf(item);
    if (level <= 0) return 0;

    const category = categoryOf(item);
    const rank = gradeOf(item);
    const overEnchantValue = Math.min(level, 3) + Math.max(0, level - 3) * 3;
    if (category !== 'weapon') {
        return ['pDef', 'mDef'].includes(stat) ? overEnchantValue : 0;
    }

    const weaponValue = Math.min(level, 3) + Math.max(0, level - 3) * 2;
    const pAtkPerLevel = { S: 5, A: 4, B: 3, C: 3, D: 2, NONE: 2 }[rank] || 2;
    const mAtkPerLevel = { S: 4, A: 3, B: 3, C: 3, D: 2, NONE: 2 }[rank] || 2;
    if (stat === 'pAtk') {
        const bow = String(item.fetchKind?.() || item.model?.kind || '').toLowerCase().includes('bow');
        return weaponValue * pAtkPerLevel * (bow ? 2 : 1);
    }
    if (stat === 'mAtk') return weaponValue * mAtkPerLevel;
    return 0;
}

module.exports = {
    DEFAULTS,
    CRYSTAL_IDS,
    CRYSTAL_BONUS,
    categoryOf,
    chanceFor,
    configWith,
    crystalCount,
    enchantLevelOf,
    gradeOf,
    isSafe,
    maxFor,
    statBonus,
    validTarget,
    resolveScroll: SCROLLS.resolve
};

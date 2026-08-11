const DataCache = invoke('GameServer/DataCache');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const GearSkillHints = invoke('GameServer/Bot/AI/GearSkillHints');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');

const ARMOR_SLOTS = {
    earringRight: 1,
    earringLeft: 2,
    necklace: 3,
    ringRight: 4,
    ringLeft: 5,
    head: 6,
    weapon: 7,
    shield: 8,
    hands: 9,
    chest: 10,
    pants: 11,
    feet: 12,
    dual: 14,
    fullArmor: 15
};

const GRADE_BANDS = [
    { rank: 'none', min: 1, max: 19 },
    { rank: 'd', min: 20, max: 39 },
    { rank: 'c', min: 40, max: 51 },
    { rank: 'b', min: 52, max: 60 },
    { rank: 'a', min: 61, max: 75 },
    { rank: 's', min: 76, max: 99 }
];

const RANK_ORDER = ['none', 'd', 'c', 'b', 'a', 's'];
const NO_GRADE_PRICE_CAPS = [
    { maxLevel: 5, price: 1000 },
    { maxLevel: 10, price: 12500 },
    { maxLevel: 15, price: 33600 },
    { maxLevel: 19, price: 66600 }
];

function gradeForLevel(level) {
    const value = Number(level || 1);
    return GRADE_BANDS.find((band) => value >= band.min && value <= band.max) || GRADE_BANDS[0];
}

function progression(level, band) {
    const value = Number(level || 1);
    const span = Math.max(1, band.max - band.min);
    const inBand = Math.max(0, Math.min(1, (value - band.min) / span));
    return Math.max(0.20, Math.min(0.78, 0.30 + inBand * 0.42));
}

function flattenItem(item) {
    const stats = item.stats || {};
    const etc = item.etc || {};
    const template = item.template || {};

    return {
        selfId: item.selfId,
        name: template.name,
        kind: template.kind || '',
        price: Number(template.price || 0),
        slot: etc.slot,
        rank: etc.rank || 'none',
        pAtk: stats.pAtk || 0,
        mAtk: stats.mAtk || 0,
        pDef: stats.pDef || 0,
        mDef: stats.mDef || 0,
        maxMp: stats.maxMp || 0
    };
}

function allItems() {
    return (DataCache.items || [])
        .filter((item) => {
            const kind = item?.template?.kind || '';
            return kind.startsWith('Weapon.') || kind.startsWith('Armor.');
        })
        .map(flattenItem);
}

function validRank(item, rank) {
    return RANK_ORDER.indexOf(item.rank) >= 0 && item.rank === rank;
}

function notQuestOddity(item) {
    return item.price > 0 && item.pAtk < 1000 && item.mAtk < 1000;
}

function priceCapFor(rank, level) {
    if (rank !== 'none') return Infinity;

    const value = Number(level || 1);
    const band = NO_GRADE_PRICE_CAPS.find((entry) => value <= entry.maxLevel);
    return band ? band.price : NO_GRADE_PRICE_CAPS[NO_GRADE_PRICE_CAPS.length - 1].price;
}

function candidatesFor(rank, predicate) {
    return allItems()
        .filter((item) => validRank(item, rank))
        .filter(notQuestOddity)
        .filter(predicate)
        .sort((a, b) => a.price - b.price || a.selfId - b.selfId);
}

function choose(rank, level, predicate, score) {
    const candidates = candidatesFor(rank, predicate);
    if (candidates.length === 0) return null;

    const band = gradeForLevel(level);
    const pct = rank === band.rank ? progression(level, band) : 0.55;
    const levelPriceCap = priceCapFor(rank, level);
    const priced = candidates.filter((item) => item.price > 0);
    const sorted = priced.length > 0 ? priced : candidates;
    const capIndex = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
    const progressivePriceCap = sorted[capIndex].price;
    const priceCap = Number.isFinite(levelPriceCap)
        ? Math.min(progressivePriceCap || levelPriceCap, levelPriceCap)
        : progressivePriceCap;
    const affordable = candidates.filter((item) => !priceCap || item.price <= priceCap);
    if (affordable.length === 0 && Number.isFinite(levelPriceCap)) return null;

    const pool = affordable.length > 0 ? affordable : candidates;

    return pool.reduce((best, item) => {
        if (!best) return item;
        const itemScore = score(item);
        const bestScore = score(best);
        if (itemScore !== bestScore) return itemScore > bestScore ? item : best;
        if (item.price !== best.price) return item.price < best.price ? item : best;
        return item.selfId < best.selfId ? item : best;
    }, null);
}

function chooseWeapon(rank, level, role, classId) {
    const allowedKinds = BotEquipmentCompatibility.weaponKindsFor(role, classId);
    const preferredKinds = BotEquipmentCompatibility.preferredWeaponKindsFor(role, classId);
    const chooseKinds = (kinds, candidateRank = rank) => choose(
        candidateRank,
        level,
        (item) => kinds.includes(item.kind)
            && BotWeaponCompatibility.isSuitableWeapon(item.kind, item.name, item.pAtk, item.mAtk, role, classId)
            && (
                item.slot === ARMOR_SLOTS.weapon
                || item.slot === ARMOR_SLOTS.dual
                    && BotEquipmentCompatibility.allowsTwoHandedWeapon(item.kind, role, classId)
            ),
        (item) => BotWeaponCompatibility.scoreWeapon(item.pAtk, item.mAtk, role, classId)
    );

    const exact = chooseKinds(preferredKinds) || chooseKinds(allowedKinds);
    if (exact || !allowedKinds.includes('Weapon.Dual')) return exact;

    // The current C4 item catalog ends its dual-sword combinations at B grade.
    // Bladedancers must keep that compatible weapon until higher-grade duals
    // are added instead of generating an empty weapon slot at level 61+.
    for (let index = RANK_ORDER.indexOf(rank) - 1; index >= 0; index--) {
        const fallback = chooseKinds(preferredKinds, RANK_ORDER[index]) || chooseKinds(allowedKinds, RANK_ORDER[index]);
        if (fallback) return fallback;
    }
    return null;
}

function chooseArmorPiece(rank, level, style, slot) {
    const kind = style === 'robe'
        ? 'Armor.Fabric'
        : style === 'light'
            ? 'Armor.Leather'
            : 'Armor.Chain';

    return choose(
        rank,
        level,
        (item) => item.kind === kind && item.slot === slot,
        (item) => item.pDef + item.maxMp
    );
}

function chooseWear(rank, level, slot) {
    return choose(
        rank,
        level,
        (item) => item.kind === 'Armor.Wear' && item.slot === slot,
        (item) => item.pDef
    );
}

function chooseJewel(rank, level, slot) {
    return choose(
        rank,
        level,
        (item) => item.kind === 'Armor.Jewel' && item.slot === slot,
        (item) => item.mDef
    );
}

function chooseShield(rank, level) {
    return choose(
        rank,
        level,
        (item) => item.kind === 'Armor.Shield' && item.slot === ARMOR_SLOTS.shield,
        (item) => item.pDef
    );
}

function noGradeArmorStyles(style, rank) {
    if (rank !== 'none') return [style];
    if (style === 'heavy') return ['heavy', 'light'];
    if (style === 'light') return ['light', 'heavy'];
    return [style];
}

function itemEntry(item, slot) {
    if (!item) return null;
    return {
        selfId: item.selfId,
        name: item.name,
        amount: 1,
        equipped: true,
        slot: slot || item.slot
    };
}

function buildArmor(rank, level, style) {
    const pieces = [];
    let fullFallback = null;

    noGradeArmorStyles(style, rank).some((candidateStyle) => {
        const chest = chooseArmorPiece(rank, level, candidateStyle, ARMOR_SLOTS.chest);
        const pants = chooseArmorPiece(rank, level, candidateStyle, ARMOR_SLOTS.pants);
        const full = chooseArmorPiece(rank, level, candidateStyle, ARMOR_SLOTS.fullArmor);

        if (candidateStyle === 'robe' && full) fullFallback = fullFallback || full;

        if (chest && pants) {
            pieces.push(itemEntry(chest, ARMOR_SLOTS.chest));
            pieces.push(itemEntry(pants, ARMOR_SLOTS.pants));
            return true;
        }

        if (candidateStyle !== 'robe' && full) {
            pieces.push(itemEntry(full, ARMOR_SLOTS.fullArmor));
            return true;
        }

        return false;
    });

    if (pieces.length === 0 && fullFallback) {
        pieces.push(itemEntry(fullFallback, ARMOR_SLOTS.fullArmor));
    }

    pieces.push(itemEntry(chooseWear(rank, level, ARMOR_SLOTS.head), ARMOR_SLOTS.head));
    pieces.push(itemEntry(chooseWear(rank, level, ARMOR_SLOTS.hands), ARMOR_SLOTS.hands));
    pieces.push(itemEntry(chooseWear(rank, level, ARMOR_SLOTS.feet), ARMOR_SLOTS.feet));

    return pieces.filter(Boolean);
}

function buildJewels(rank, level) {
    const earring = chooseJewel(rank, level, ARMOR_SLOTS.earringRight);
    const necklace = chooseJewel(rank, level, ARMOR_SLOTS.necklace);
    const ring = chooseJewel(rank, level, ARMOR_SLOTS.ringRight);

    return [
        itemEntry(earring, ARMOR_SLOTS.earringRight),
        itemEntry(earring, ARMOR_SLOTS.earringLeft),
        itemEntry(necklace, ARMOR_SLOTS.necklace),
        itemEntry(ring, ARMOR_SLOTS.ringRight),
        itemEntry(ring, ARMOR_SLOTS.ringLeft)
    ].filter(Boolean);
}

function planFor(character) {
    const level = Number(character.level || 1);
    const classId = Number(character.classId || 0);
    const role = BotRoles.inferRole(classId);
    const band = gradeForLevel(level);
    const rank = band.rank;
    const style = BotEquipmentCompatibility.armorStyleFor(role, classId);
    const weapon = chooseWeapon(rank, level, role, classId);
    const plan = [];

    if (weapon) {
        plan.push(itemEntry(weapon, weapon.slot));
        if (weapon.slot === ARMOR_SLOTS.weapon && BotEquipmentCompatibility.usesShield(role, classId)) {
            plan.push(itemEntry(chooseShield(rank, level), ARMOR_SLOTS.shield));
        }
    }

    plan.push(...buildArmor(rank, level, style));
    plan.push(...buildJewels(rank, level));

    return {
        rank,
        role,
        style,
        hint: GearSkillHints.forCharacter({ classId, level }, { role }),
        items: plan.filter(Boolean)
    };
}

const BotGear = {
    planFor
};

module.exports = BotGear;

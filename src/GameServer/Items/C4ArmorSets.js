const EffectStore = invoke('GameServer/Effects/EffectStore');

const CATEGORY = 'armor_set';

const ARMOR_SETS = [
    { name: 'Wooden Breastplate Set', chest: 23, legs: 2386, head: 43, gloves: 0, feet: 0, skillId: 3500, shield: 0, shieldSkillId: 0 },
    { name: 'Devotion Robe Set', chest: 1101, legs: 1104, head: 44, gloves: 0, feet: 0, skillId: 3501, shield: 0, shieldSkillId: 0 },
    { name: 'Mithril Breastplate Set', chest: 58, legs: 59, head: 47, gloves: 0, feet: 0, skillId: 3502, shield: 628, shieldSkillId: 3543 },
    { name: 'Brigandine Set', chest: 352, legs: 2378, head: 2411, gloves: 0, feet: 0, skillId: 3506, shield: 2493, shieldSkillId: 3544 },
    { name: 'Reinforced Leather Set', chest: 394, legs: 416, head: 0, gloves: 0, feet: 2422, skillId: 3503, shield: 0, shieldSkillId: 0 },
    { name: 'Manticore Skin Set', chest: 395, legs: 417, head: 0, gloves: 0, feet: 2424, skillId: 3505, shield: 0, shieldSkillId: 0 },
    { name: 'Knowledge Set', chest: 436, legs: 469, head: 0, gloves: 2447, feet: 0, skillId: 3504, shield: 0, shieldSkillId: 0 },
    { name: 'Mithril Robe Set', chest: 437, legs: 470, head: 0, gloves: 2450, feet: 0, skillId: 3507, shield: 0, shieldSkillId: 0 },
    { name: 'Chain Mail Set', chest: 354, legs: 381, head: 2413, gloves: 0, feet: 0, skillId: 3509, shield: 2495, shieldSkillId: 3545 },
    { name: 'Composite Set', chest: 60, legs: 0, head: 517, gloves: 0, feet: 0, skillId: 3512, shield: 107, shieldSkillId: 3546 },
    { name: 'Full Plate Set', chest: 356, legs: 0, head: 2414, gloves: 0, feet: 0, skillId: 3516, shield: 2497, shieldSkillId: 3547 },
    { name: 'Mithril Light Set', chest: 397, legs: 2387, head: 0, gloves: 0, feet: 62, skillId: 3508, shield: 0, shieldSkillId: 0 },
    { name: 'Plated Leather Set', chest: 398, legs: 418, head: 0, gloves: 0, feet: 2431, skillId: 3511, shield: 0, shieldSkillId: 0 },
    { name: 'Theca Leather Set', chest: 400, legs: 420, head: 0, gloves: 0, feet: 2436, skillId: 3514, shield: 0, shieldSkillId: 0 },
    { name: 'Drake Leather Set', chest: 401, legs: 0, head: 0, gloves: 0, feet: 2437, skillId: 3515, shield: 0, shieldSkillId: 0 },
    { name: 'Karmian Robe Set', chest: 439, legs: 471, head: 0, gloves: 2454, feet: 0, skillId: 3510, shield: 0, shieldSkillId: 0 },
    { name: 'Demon Robe Set', chest: 441, legs: 472, head: 0, gloves: 2459, feet: 0, skillId: 3513, shield: 0, shieldSkillId: 0 },
    { name: 'Divine Robe Set', chest: 442, legs: 473, head: 0, gloves: 2463, feet: 0, skillId: 3517, shield: 0, shieldSkillId: 0 },
    { name: 'Zubei Breastplate Set', chest: 357, legs: 383, head: 503, gloves: 5710, feet: 5726, skillId: 3518, shield: 0, shieldSkillId: 0 },
    { name: 'Zubei Light Set', chest: 2384, legs: 2388, head: 503, gloves: 5711, feet: 5727, skillId: 3520, shield: 0, shieldSkillId: 0 },
    { name: 'Zubei Robe Set', chest: 2397, legs: 2402, head: 503, gloves: 5712, feet: 5728, skillId: 3522, shield: 0, shieldSkillId: 0 },
    { name: 'Avadon Heavy Set', chest: 2376, legs: 2379, head: 2415, gloves: 5714, feet: 5730, skillId: 3519, shield: 673, shieldSkillId: 3548 },
    { name: 'Avadon Light Set', chest: 2390, legs: 0, head: 2415, gloves: 5715, feet: 5731, skillId: 3521, shield: 0, shieldSkillId: 0 },
    { name: 'Avadon Robe Set', chest: 2406, legs: 0, head: 2415, gloves: 5716, feet: 5732, skillId: 3523, shield: 0, shieldSkillId: 0 },
    { name: 'Blue Wolf Heavy Set', chest: 358, legs: 2380, head: 2416, gloves: 5718, feet: 5734, skillId: 3524, shield: 0, shieldSkillId: 0 },
    { name: 'Blue Wolf Light Set', chest: 2391, legs: 0, head: 2416, gloves: 5719, feet: 5735, skillId: 3526, shield: 0, shieldSkillId: 0 },
    { name: 'Blue Wolf Robe Set', chest: 2398, legs: 2403, head: 2416, gloves: 5720, feet: 5736, skillId: 3528, shield: 0, shieldSkillId: 0 },
    { name: 'Doom Heavy Set', chest: 2381, legs: 0, head: 2417, gloves: 5722, feet: 5738, skillId: 3525, shield: 110, shieldSkillId: 3549 },
    { name: 'Doom Light Set', chest: 2392, legs: 0, head: 2417, gloves: 5723, feet: 5739, skillId: 3527, shield: 0, shieldSkillId: 0 },
    { name: 'Doom Robe Set', chest: 2399, legs: 2404, head: 2417, gloves: 5724, feet: 5740, skillId: 3529, shield: 0, shieldSkillId: 0 },
    { name: 'Dark Crystal Heavy Set', chest: 365, legs: 388, head: 512, gloves: 5765, feet: 5777, skillId: 3530, shield: 641, shieldSkillId: 3550 },
    { name: 'Dark Crystal Light Set', chest: 2385, legs: 2389, head: 512, gloves: 5766, feet: 5778, skillId: 3532, shield: 0, shieldSkillId: 0 },
    { name: 'Dark Crystal Robe Set', chest: 2407, legs: 0, head: 512, gloves: 5767, feet: 5779, skillId: 3535, shield: 0, shieldSkillId: 0 },
    { name: 'Tallum Heavy Set', chest: 2382, legs: 0, head: 547, gloves: 5768, feet: 5780, skillId: 3531, shield: 0, shieldSkillId: 0 },
    { name: 'Tallum Light Set', chest: 2393, legs: 0, head: 547, gloves: 5769, feet: 5781, skillId: 3533, shield: 0, shieldSkillId: 0 },
    { name: 'Tallum Robe Set', chest: 2400, legs: 2405, head: 547, gloves: 5770, feet: 5782, skillId: 3534, shield: 0, shieldSkillId: 0 },
    { name: 'Nightmare Heavy Set', chest: 374, legs: 0, head: 2418, gloves: 5771, feet: 5783, skillId: 3536, shield: 2498, shieldSkillId: 3551 },
    { name: 'Nightmare Light Set', chest: 2394, legs: 0, head: 2418, gloves: 5772, feet: 5784, skillId: 3538, shield: 0, shieldSkillId: 0 },
    { name: 'Nightmare Robe Set', chest: 2408, legs: 0, head: 2418, gloves: 5773, feet: 5785, skillId: 3540, shield: 0, shieldSkillId: 0 },
    { name: 'Majestic Heavy Set', chest: 2383, legs: 0, head: 2419, gloves: 5774, feet: 5786, skillId: 3537, shield: 0, shieldSkillId: 0 },
    { name: 'Majestic Leather Set', chest: 2395, legs: 0, head: 2419, gloves: 5775, feet: 5787, skillId: 3539, shield: 0, shieldSkillId: 0 },
    { name: 'Majestic Robe Set', chest: 2409, legs: 0, head: 2419, gloves: 5776, feet: 5788, skillId: 3541, shield: 0, shieldSkillId: 0 },
    { name: 'Imperial Crusader Set', chest: 6373, legs: 6374, head: 6378, gloves: 6375, feet: 6376, skillId: 3553, shield: 6377, shieldSkillId: 3554 },
    { name: 'Draconic Leather Set', chest: 6379, legs: 0, head: 6382, gloves: 6380, feet: 6381, skillId: 3555, shield: 0, shieldSkillId: 0 },
    { name: 'Major Arcana Set', chest: 6383, legs: 0, head: 6386, gloves: 6384, feet: 6385, skillId: 3556, shield: 0, shieldSkillId: 0 }
];

const SET_SKILLS = {
    3500: { name: 'Wooden Set', stats: { pDefMul: 1.02, maxHpAdd: 41 } },
    3501: { name: 'Devotion Set', stats: { castSpdMul: 1.15 } },
    3502: { name: 'Mithril Heavy Armor Set', stats: { poisonVuln: 0.8 } },
    3503: { name: 'Reinforced Leather Set', stats: { maxMpAdd: 80 } },
    3504: { name: 'Knowledge Set', stats: { mAtkMul: 1.1, regMp: 0.95 } },
    3505: { name: 'Manticore Set', stats: { maxMpAdd: 92 } },
    3506: { name: 'Brigandine Set', stats: { pDefMul: 1.05, maxHpAdd: 153 } },
    3507: { name: 'Elven Mithril Set', stats: { runSpdAdd: 7, WIT: 1, INT: -1 } },
    3508: { name: 'Mithril Light Armor Set', stats: { pEvasionRateAdd: 4 } },
    3509: { name: 'Chain Mail Set', stats: { daggerWpnVuln: 0.9476 } },
    3510: { name: 'Karmian Set', stats: { pDefMul: 1.0524, castSpdMul: 1.15 } },
    3511: { name: 'Plated Leather Set', stats: { STR: 4, CON: -1 } },
    3512: { name: 'Composite Heavy Armor Set', stats: { maxLoad: 5795 } },
    3513: { name: "Demon's Set", stats: { maxHpAdd: -270, INT: 4, WIT: -1 } },
    3514: { name: 'Theca Leather Light Armor Set', stats: { pDefMul: 1.0524 } },
    3515: { name: 'Drake Leather Set', stats: { mDefMul: 1.0524 } },
    3516: { name: 'Full Plate Set', stats: { maxHpAdd: 270 } },
    3517: { name: 'Divine Set', stats: { pDefMul: 1.0524, maxMpAdd: 171, INT: -1, WIT: 1 } },
    3518: { name: "Zubei's Heavy Armor Set", stats: { pDefMul: 1.0524, maxHpAdd: 294 } },
    3519: { name: 'Avadon Breastplate Heavy Armor Set', stats: { maxHpAdd: 294 } },
    3520: { name: "Zubei's Leather Shirt Light Armor Set", stats: { pEvasionRateAdd: 4 } },
    3521: { name: 'Avadon Light Armor Set', stats: { mDefMul: 1.0525, maxLoad: 5795 } },
    3522: { name: 'Tunic of Zubei Robe Set', stats: { mAtkMul: 1.1, regMp: 0.95 } },
    3523: { name: 'Avadon Robe Set', stats: { pDefMul: 1.0547, castSpdMul: 1.15 } },
    3524: { name: 'Blue Wolf Heavy Armor Set', stats: { runSpdAdd: 7, regHp: 1.0524, STR: 3, CON: -1, DEX: -2 } },
    3525: { name: 'Doom Heavy Armor Set', stats: { maxHpAdd: 320, breath: 200, STR: -3, CON: 3 } },
    3526: { name: 'Blue Wolf Light Armor Set', stats: { pDefMul: 1.0524, castSpdMul: 1.15, INT: -2, MEN: 3, WIT: -1 } },
    3527: { name: 'Doom Light Armor Set', stats: { breath: 200, pAtkMul: 1.027, regMp: 1.025, STR: -1, CON: -2, DEX: 3, poisonVuln: 0.8 } },
    3528: { name: 'Blue Wolf Robe Set', stats: { maxMpAdd: 206, regMp: 1.0524, INT: -2, MEN: -1, WIT: 3 } },
    3529: { name: 'Doom Robe Set', stats: { runSpdAdd: 7, breath: 200, regMp: 1.0524, INT: 2, MEN: 1, WIT: -3 } },
    3530: { name: 'Dark Crystal Breastplate Heavy Armor Set', stats: { gainHp: 1.04, paralyzeVuln: 0.5, STR: -2, CON: 2 } },
    3531: { name: 'Tallum Heavy Armor Set', stats: { pAtkSpdMul: 1.08, maxLoad: 5759, poisonVuln: 0.2, bleedVuln: 0.2, STR: 2, CON: -2 } },
    3532: { name: 'Dark Crystal Light Armor Set', stats: { pAtkSpdMul: 1.04, pAtkMul: 1.04, paralyzeVuln: 0.5, STR: 1, CON: -1 } },
    3533: { name: 'Tallum Light Armor Set', stats: { regMp: 1.08, maxMpAdd: 222, poisonVuln: 0.2, bleedVuln: 0.2, MEN: 2, WIT: -2 } },
    3534: { name: 'Tallum Robe Set', stats: { castSpdMul: 1.15, mDefMul: 1.08, poisonVuln: 0.2, bleedVuln: 0.2, INT: -2, WIT: 2 } },
    3535: { name: 'Dark Crystal Robe Set', stats: { pDefMul: 1.08, castSpdMul: 1.15, runSpdAdd: 7, cancel: -18, paralyzeVuln: 0.5, WIT: 2, MEN: -2 } },
    3536: { name: 'Nightmare Heavy Armor Set', stats: { pAtkMul: 1.04, sleepVuln: 0.3, rootVuln: 0.3, CON: 2, DEX: -2 } },
    3537: { name: 'Majestic Heavy Armor Set', stats: { pAtkMul: 1.04, pAccuracyCombatAdd: 3, stunVuln: 0.5, STR: 2, CON: -2 } },
    3538: { name: 'Nightmarish Leather Light Armor Set', stats: { mDefMul: 1.04, sleepVuln: 0.3, rootVuln: 0.3, absorbDam: 3, DEX: 1, CON: -1 } },
    3539: { name: 'Majestic Light Armor Set', stats: { maxMpAdd: 240, maxLoad: 5759, stunVuln: 0.5, DEX: 1, CON: -1 } },
    3540: { name: 'Nightmare Robe Set', stats: { regMp: 1.04, mAtkMul: 1.08, sleepVuln: 0.3, rootVuln: 0.3, INT: 2, WIT: -2 } },
    3541: { name: 'Majestic Robe Set', stats: { maxMpAdd: 240, castSpdMul: 1.15, regMp: 1.08, stunVuln: 0.5, MEN: 1, INT: -1 } },
    3543: { name: 'Equipped with Shield', stats: { maxHpAdd: 126 } },
    3544: { name: 'Equipped with Shield', stats: { maxHpAdd: 20 } },
    3545: { name: 'Equipped with Shield', stats: { maxHpAdd: 198 } },
    3546: { name: 'Equipped with Shield', stats: { mDefMul: 1.0526 } },
    3547: { name: 'Equipped with Shield', stats: { rShldMul: 1.0525 } },
    3548: { name: 'Equipped with Shield', stats: { rShldMul: 1.24 } },
    3549: { name: 'Equipped with Shield', stats: { rShldMul: 1.24 } },
    3550: { name: 'Equipped with Shield', stats: { rShldMul: 1.18 } },
    3551: { name: 'Equipped with Shield', stats: { reflectDam: 5 } },
    3553: { name: 'Imperial Crusader Heavy Armor Set', stats: { pDefMul: 1.08, maxHpAdd: 445, sleepVuln: 0.3, rootVuln: 0.3, DEX: -2, STR: 2 } },
    3554: { name: 'Equipped with Shield', stats: { poisonVuln: 0.2, bleedVuln: 0.2 } },
    3555: { name: 'Draconic Light Armor Set', stats: { pAtkSpdMul: 1.04, pAtkMul: 1.04, maxMpAdd: 289, maxLoad: 5759, DEX: 1, STR: 1, CON: -2 } },
    3556: { name: 'Major Arcana Robe Set', stats: { mAtkMul: 1.17, runSpdAdd: 7, cancel: -50, maxLoad: 5759, WIT: 1, INT: 1, MEN: -2, stunVuln: 0.5 } }
};

function equippedSelfIds(items = []) {
    return new Set(items
        .filter((item) => !!item?.fetchEquipped?.())
        .map((item) => Number(item.fetchSelfId?.()) || 0)
        .filter(Boolean));
}

function hasRequiredParts(set, equipped) {
    return [set.chest, set.legs, set.head, set.gloves, set.feet]
        .every((selfId) => !selfId || equipped.has(selfId));
}

function activeSets(items = []) {
    const equipped = equippedSelfIds(items);
    return ARMOR_SETS.filter((set) => hasRequiredParts(set, equipped));
}

function resolveSkill(skillId) {
    return SET_SKILLS[Number(skillId)] || null;
}

function effectForSkill(set, skillId, suffix) {
    const skill = resolveSkill(skillId);
    if (!skill || Object.keys(skill.stats).length === 0) return null;
    return {
        key: `armor_set:${set.chest}:${skillId}:${suffix}`,
        id: Number(skillId),
        level: 1,
        type: 'item_passive',
        name: suffix === 'shield' ? `${set.name} Shield Bonus` : set.name,
        category: CATEGORY,
        dispellable: false,
        stats: { ...skill.stats }
    };
}

function sync(actor, items = []) {
    if (!actor) return [];
    EffectStore.removeByCategory(actor, CATEGORY);
    const equipped = equippedSelfIds(items);
    const applied = [];

    activeSets(items).forEach((set) => {
        const setEffect = effectForSkill(set, set.skillId, 'set');
        if (setEffect) {
            applied.push(EffectStore.apply(actor, setEffect));
        }

        if (set.shield && set.shieldSkillId && equipped.has(set.shield)) {
            const shieldEffect = effectForSkill(set, set.shieldSkillId, 'shield');
            if (shieldEffect) {
                applied.push(EffectStore.apply(actor, shieldEffect));
            }
        }
    });

    return applied.filter(Boolean);
}

module.exports = {
    CATEGORY,
    ARMOR_SETS,
    SET_SKILLS,
    activeSets,
    resolveSkill,
    sync
};

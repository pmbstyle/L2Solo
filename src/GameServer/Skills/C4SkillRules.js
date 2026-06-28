const DAMAGE = 'damage';
const DAMAGE_EFFECT = 'damageEffect';
const DEATH_LINK = 'deathLink';
const DRAIN = 'drain';
const HEAL = 'heal';
const HEAL_PERCENT = 'healPercent';
const HEAL_HOT = 'healHot';
const HEAL_STATIC = 'healStatic';
const HOT = 'hot';
const EFFECT = 'effect';
const BLOW = 'blow';
const CLEANSE = 'cleanse';
const HEAL_CLEANSE = 'healCleanse';
const MANA_RECHARGE = 'manaRecharge';
const MANA_HEAL = 'manaHeal';
const SUMMON = 'summon';
const AGGRO_DAMAGE = 'aggroDamage';
const AGGRO_REMOVE = 'aggroRemove';
const AGGRO_REDUCE = 'aggroReduce';
const AGGRO_REDUCE_CHAR = 'aggroReduceChar';
const CANCEL = 'cancel';
const CHARGE = 'charge';

const RULES = {
    1: { skillType: DAMAGE, trait: 'physical', target: 'enemy', ssBoost: 1, requires: { weaponsAllowed: 512, itemKind: 'Dual Sword' } },
    3: { skillType: DAMAGE, trait: 'sword', ssBoost: 1 },
    5: { skillType: DAMAGE, trait: 'physical', target: 'enemy', ssBoost: 1, requires: { weaponsAllowed: 512, itemKind: 'Dual Sword', charges: 2, condition: 128, conditionValue: 2 } },
    6: { skillType: DAMAGE, trait: 'physical', target: 'enemy', ssBoost: 1, requires: { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 } },
    7: { skillType: DAMAGE, trait: 'physical', target: 'enemy', sourceTarget: 'area', radius: 205, ssBoost: 1, requires: { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 } },
    8: { skillType: CHARGE, trait: 'charge', target: 'self', ssBoost: 0, maxChargesByLevel: [1, 2, 3, 4, 5, 6, 7], aggroPoints: 200, requires: { weaponsAllowed: 524 } },
    9: { skillType: DAMAGE, trait: 'physical', target: 'enemy', sourceTarget: 'front_area', radius: 200, ssBoost: 1, requires: { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 } },
    10: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    11: { skillType: AGGRO_REDUCE_CHAR, trait: 'derangement', target: 'enemy', ssBoost: 0, baseLandRate: 50 },
    12: { skillType: EFFECT, trait: 'confusion', effect: 'confusion', effectType: 'debuff', target: 'enemy', ssBoost: 0, baseLandRate: 80, mobOnly: true },
    13: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    15: { skillType: AGGRO_REDUCE, trait: 'derangement', target: 'enemy', ssBoost: 1, mobOnly: true },
    16: { skillType: BLOW, trait: 'dagger', target: 'enemy', ssBoost: 1, blowChance: 50, requires: { weaponsAllowed: 16, condition: 16 } },
    17: { skillType: DAMAGE, trait: 'physical', target: 'enemy', sourceTarget: 'front_area', radius: 200, ssBoost: 1, requires: { weaponsAllowed: 1024, charges: 1, condition: 128, conditionValue: 1 } },
    18: { skillType: AGGRO_DAMAGE, trait: 'derangement', target: 'enemy', sourceTarget: 'aura', radius: 200, ssBoost: 0 },
    19: { skillType: DAMAGE, trait: 'bow', target: 'enemy', ssBoost: 1, overHit: true, requires: { weaponsAllowed: 32 } },
    24: { skillType: DAMAGE, trait: 'bow', target: 'enemy', sourceTarget: 'area', radius: 150, ssBoost: 1, overHit: true, requires: { weaponsAllowed: 32 } },
    22: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    25: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    30: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    33: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    56: { skillType: DAMAGE, trait: 'bow', ssBoost: 1 },
    67: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    92: { skillType: EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', target: 'enemy', baseLandRate: 80, requires: { itemKind: 'shield' } },
    100: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    101: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    102: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', baseLandRate: 80 },
    105: { skillType: DAMAGE_EFFECT, trait: 'water', effect: 'freezing_strike', effectType: 'debuff', baseLandRate: 60, stats: { runSpdMul: 0.7 } },
    115: { skillType: EFFECT, trait: 'debuff', effect: 'power_break', effectType: 'debuff', baseLandRate: 80, statsByLevel: { pAtkMul: [0.8, 0.8, 0.77] } },
    120: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', target: 'enemy', ssBoost: 1, baseLandRate: 50, levelDepend: 2, requires: { weaponsAllowed: 1024 } },
    122: { skillType: EFFECT, trait: 'debuff', effect: 'hex', effectType: 'debuff', baseLandRate: 80, stats: { pDefMul: 0.77 } },
    127: { skillType: EFFECT, trait: 'slow', effect: 'hamstring', effectType: 'debuff', baseLandRate: 80, stats: { runSpdMul: 0.7 } },
    21: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7, 9] }] },
    34: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevelByLevel: [3, 7, 9] }] },
    45: { skillType: HEAL, trait: 'heal', target: 'self', ssBoost: 0 },
    58: { skillType: HEAL, trait: 'heal', target: 'self', ssBoost: 0 },
    69: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    70: { skillType: DRAIN, trait: 'dark', target: 'enemy', ssBoost: 1, absorbPart: 0.2, baseLandRate: 92 },
    61: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevelByLevel: [3, 7, 9] }] },
    44: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevelByLevel: [3, 7, 9] }] },
    46: { skillType: DRAIN, trait: 'magic', target: 'corpse_mob', ssBoost: 1, absorbAbsByLevel: [105, 113, 122, 131, 140, 150, 159, 169, 180, 190, 201, 211, 222, 232, 243] },
    48: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', target: 'enemy', sourceTarget: 'aura', radius: 150, ssBoost: 1, baseLandRate: 50, levelDepend: 1, requires: { weaponsAllowed: 64 } },
    72: { skillType: EFFECT, trait: 'buff', effect: 'iron_will', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { mDefMul: [1.15, 1.23, 1.3] } },
    77: { skillType: EFFECT, trait: 'buff', effect: 'attack_aura', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12] } },
    78: { skillType: EFFECT, trait: 'buff', effect: 'war_cry', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pAtkMul: [1.20, 1.25] } },
    91: { skillType: EFFECT, trait: 'buff', effect: 'defense_aura', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12] } },
    94: { skillType: EFFECT, trait: 'buff', effect: 'rage', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pAtkMul: [1.45, 1.55], pDefMul: [0.8, 0.8], pEvasionRateAdd: [-3, -3] } },
    95: { skillType: EFFECT, trait: 'slow', effect: 'cripple', effectType: 'debuff', target: 'enemy', baseLandRate: 80, requires: { weaponsAllowed: 1024 }, statsByLevel: { runSpdMul: [0.7, 0.7, 0.7, 0.7, 0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
    96: { skillType: EFFECT, trait: 'bleed', effect: 'bleed', effectType: 'debuff', baseLandRate: 100, dot: { count: 7, intervalMs: 3000, damageByLevel: [39, 51, 66, 81, 93, 102] } },
    109: { skillType: HEAL_PERCENT, trait: 'heal', target: 'self', ssBoost: 0, healPowerByLevel: [20] },
    121: { skillType: HEAL_PERCENT, trait: 'heal', target: 'self', ssBoost: 0, healPowerByLevel: [9.1, 13, 16.6, 20, 23, 25.7] },
    123: { skillType: EFFECT, trait: 'buff', effect: 'spirit_barrier', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { mDefMul: [1.15, 1.23, 1.3] } },
    129: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', baseLandRate: 70, dot: { count: 10, intervalMs: 3000 } },
    139: { skillType: EFFECT, trait: 'buff', effect: 'guts', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pDefMul: [2.0, 2.5, 3.0] }, condition: { actorHpPercentAtMost: 30 } },
    176: { skillType: EFFECT, trait: 'buff', effect: 'frenzy', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { pAtkMul: [2.0, 2.5, 3.0] }, condition: { actorHpPercentAtMost: 30 } },
    181: { skillType: HEAL_STATIC, trait: 'heal', target: 'self', ssBoost: 0, healPowerByLevel: [1685], condition: { actorHpPercentAtMost: 10 } },
    230: { skillType: EFFECT, trait: 'buff', effect: 'sprint', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { runSpdAdd: [20, 33] } },
    262: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    260: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', target: 'enemy', ssBoost: 1, baseLandRate: 50, levelDepend: 1, requires: { weaponsAllowed: 16392 } },
    263: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    264: { skillType: EFFECT, trait: 'buff', effect: 'song_of_earth', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pDefMul: 1.25 } },
    265: { skillType: EFFECT, trait: 'buff', effect: 'song_of_life', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { regHp: 1.2 } },
    266: { skillType: EFFECT, trait: 'buff', effect: 'song_of_water', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pEvasionRateAdd: 3 } },
    267: { skillType: EFFECT, trait: 'buff', effect: 'song_of_warding', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { mDefMul: 1.3 } },
    268: { skillType: EFFECT, trait: 'buff', effect: 'song_of_wind', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { runSpdAdd: 20 } },
    269: { skillType: EFFECT, trait: 'buff', effect: 'song_of_hunter', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pCritRateMul: 2 } },
    270: { skillType: EFFECT, trait: 'buff', effect: 'song_of_invocation', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { darkVuln: 0.8 } },
    271: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_warrior', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pAtkMul: 1.12 } },
    272: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_inspiration', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pAccuracyCombatAdd: 4 } },
    273: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_mystic', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { mAtkMul: 1.2 } },
    274: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_fire', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pCritDamageMul: 1.5 } },
    275: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_fury', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pAtkSpdMul: 1.15 } },
    276: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_concentration', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { castSpdMul: 1.3, cancelAdd: -40 } },
    277: { skillType: EFFECT, trait: 'buff', effect: 'dance_of_light', effectType: 'buff', target: 'party', baseLandRate: 100, stats: { pAtkUndeadMul: 1.3 } },
    278: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    279: { skillType: DAMAGE_EFFECT, trait: 'paralyze', effect: 'paralyze', effectType: 'debuff', target: 'enemy', ssBoost: 1, baseLandRate: 40, levelDepend: 1 },
    280: { skillType: DAMAGE, trait: 'fire', target: 'enemy', ssBoost: 1, requires: { weaponsAllowed: 1024 } },
    281: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', target: 'enemy', ssBoost: 1, baseLandRate: 50, levelDepend: 1, requires: { weaponsAllowed: 1024 } },
    283: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    284: { skillType: DAMAGE, trait: 'wind', target: 'enemy', ssBoost: 1, requires: { weaponsAllowed: 1024, charges: 2, condition: 128, conditionValue: 2 } },
    299: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    301: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1010: { skillType: EFFECT, trait: 'buff', effect: 'soul_shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1040: { skillType: EFFECT, trait: 'buff', effect: 'shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1068: { skillType: EFFECT, trait: 'buff', effect: 'might', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1011: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1012: { skillType: CLEANSE, trait: 'poison', target: 'friendly', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7, 9] }] },
    1013: { skillType: MANA_RECHARGE, trait: 'mana', target: 'friendly', ssBoost: 0 },
    1015: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1018: { skillType: CLEANSE, trait: 'purify', target: 'friendly', cleanse: [
        { category: 'poison', maxLevelByLevel: [3, 7, 9] },
        { category: 'bleed', maxLevelByLevel: [3, 7, 9] },
        { category: 'paralyze', maxLevelByLevel: [3, 7, 9] },
        { category: 'petrification', maxLevelByLevel: [3, 7, 9] }
    ] },
    1020: { skillType: HEAL_CLEANSE, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [
        440, 454, 467, 494, 508, 521, 548, 562, 575, 588, 602, 615, 627, 640,
        653, 665, 677, 689, 700, 711, 722, 733, 743, 753, 763, 772, 780
    ], cleanse: [
        { category: 'poison', maxLevelByLevel: [3, 3, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9] },
        { category: 'bleed', maxLevelByLevel: [3, 3, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9] }
    ] },
    1027: { skillType: HEAL, trait: 'heal', target: 'party', ssBoost: 0 },
    1028: { skillType: DAMAGE, trait: 'holy', target: 'enemy', ssBoost: 1, undeadOnly: true },
    1031: { skillType: DAMAGE, trait: 'holy', target: 'enemy', ssBoost: 1, undeadOnly: true },
    1003: { skillType: EFFECT, trait: 'buff', effect: 'power_of_paagrio', effectType: 'buff', target: 'ally', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1004: { skillType: EFFECT, trait: 'buff', effect: 'wisdom_of_paagrio', effectType: 'buff', target: 'ally', baseLandRate: 100, statsByLevel: { castSpdMul: [1.15, 1.23, 1.3] } },
    1005: { skillType: EFFECT, trait: 'buff', effect: 'blessing_of_paagrio', effectType: 'buff', target: 'ally', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1002: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_flame', effectType: 'buff', target: 'party', baseLandRate: 100, statsByLevel: { castSpdMul: [1.15, 1.23, 1.3] } },
    1006: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_fire', effectType: 'buff', target: 'party', baseLandRate: 100, statsByLevel: { mDefMul: [1.15, 1.23, 1.3] } },
    1007: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_battle', effectType: 'buff', target: 'party', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1008: { skillType: EFFECT, trait: 'buff', effect: 'glory_of_paagrio', effectType: 'buff', target: 'ally', baseLandRate: 100, statsByLevel: { mDefMul: [1.15, 1.23, 1.3] } },
    1009: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_shielding', effectType: 'buff', target: 'party', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1032: { skillType: EFFECT, trait: 'buff', effect: 'invigor', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { bleedResist: [30, 40, 50] } },
    1033: { skillType: EFFECT, trait: 'buff', effect: 'resist_poison', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { poisonResist: [30, 40, 50] } },
    1034: { skillType: AGGRO_REMOVE, trait: 'derangement', target: 'enemy', ssBoost: 1, undeadOnly: true, baseLandRateByLevel: [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150] },
    1035: { skillType: EFFECT, trait: 'buff', effect: 'mental_shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        rootResist: [20, 30, 40, 50],
        sleepResist: [20, 30, 40, 50],
        mentalResist: [20, 30, 40, 50]
    } },
    1036: { skillType: EFFECT, trait: 'buff', effect: 'magic_barrier', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { mDefMul: [1.23, 1.3] } },
    1042: { skillType: EFFECT, trait: 'paralyze', effect: 'paralyze', effectType: 'debuff', target: 'enemy', baseLandRate: 20, undeadOnly: true },
    1043: { skillType: EFFECT, trait: 'buff', effect: 'holy_weapon', effectType: 'buff', target: 'friendly', baseLandRate: 100, stats: { pAtkUndeadMul: 1.2 } },
    1044: { skillType: EFFECT, trait: 'buff', effect: 'regeneration', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { regHp: [1.1, 1.15, 1.2] } },
    1045: { skillType: EFFECT, trait: 'buff', effect: 'blessed_body', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxHpMul: [1.1, 1.15, 1.2, 1.25, 1.3, 1.35] } },
    1047: { skillType: EFFECT, trait: 'buff', effect: 'mana_regeneration', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { regMp: [1.72, 2.16, 2.74, 3.09] } },
    1048: { skillType: EFFECT, trait: 'buff', effect: 'blessed_soul', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxMpMul: [1.1, 1.15, 1.2, 1.25, 1.3, 1.35] } },
    1049: { skillType: AGGRO_REMOVE, trait: 'derangement', target: 'enemy', ssBoost: 1, undeadOnly: true, baseLandRate: 35 },
    1056: { skillType: CANCEL, trait: 'cancel', target: 'enemy', ssBoost: 1, baseLandRate: 25, maxCancelled: 0 },
    1059: { skillType: EFFECT, trait: 'buff', effect: 'empower', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { mAtkMul: [1.55, 1.65, 1.75] } },
    1062: { skillType: EFFECT, trait: 'buff', effect: 'berserker_spirit', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        mAtkMul: [1.1, 1.16],
        pAtkMul: [1.05, 1.08],
        pDefMul: [0.95, 0.92],
        mDefMul: [0.90, 0.84],
        castSpdMul: [1.05, 1.08],
        pAtkSpdMul: [1.05, 1.08],
        runSpdAdd: [5, 8],
        pEvasionRateAdd: [-2, -4]
    } },
    1064: { skillType: EFFECT, trait: 'derangement', effect: 'silence', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1069: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', baseLandRate: 80 },
    1071: { skillType: EFFECT, trait: 'water', effect: 'surrender_to_water', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { waterVuln: 1.3 } },
    1072: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1073: { skillType: EFFECT, trait: 'buff', effect: 'kiss_of_eva', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { breath: [5, 7] } },
    1074: { skillType: EFFECT, trait: 'wind', effect: 'surrender_to_wind', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { windVuln: 1.3 } },
    1077: { skillType: EFFECT, trait: 'buff', effect: 'focus', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritRateAdd: [20, 25, 30] } },
    1078: { skillType: EFFECT, trait: 'buff', effect: 'concentration', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { cancelAdd: [-18, -25, -36, -42, -48, -53] } },
    1083: { skillType: EFFECT, trait: 'fire', effect: 'surrender_to_fire', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { fireVuln: [1.25, 1.25, 1.25, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3] } },
    1085: { skillType: EFFECT, trait: 'buff', effect: 'acumen', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { castSpdMul: [1.15, 1.23, 1.3] } },
    1086: { skillType: EFFECT, trait: 'buff', effect: 'haste', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1087: { skillType: EFFECT, trait: 'buff', effect: 'agility', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1090: { skillType: DRAIN, trait: 'dark', target: 'enemy', ssBoost: 1, absorbPart: 0.8, baseLandRate: 92 },
    1096: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_chaos', effectType: 'debuff', target: 'enemy', baseLandRate: 40, statsByLevel: { pAccuracyCombatAdd: [-12, -12, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13] } },
    1097: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1099: { skillType: EFFECT, trait: 'slow', effect: 'seal_of_slow', effectType: 'debuff', target: 'enemy', baseLandRate: 40, statsByLevel: { runSpdMul: [0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
    1100: { skillType: EFFECT, trait: 'fire', effect: 'chill_flame', effectType: 'debuff', target: 'enemy', baseLandRate: 70, dot: { count: 15, intervalMs: 1000, damageByLevel: [20, 30] } },
    1101: { skillType: EFFECT, trait: 'fire', effect: 'blaze_quake', effectType: 'debuff', target: 'enemy', baseLandRate: 35, dot: { count: 15, intervalMs: 1000, damageByLevel: [44, 60] } },
    1102: { skillType: EFFECT, trait: 'mana', effect: 'aura_sink', effectType: 'debuff', target: 'enemy', baseLandRateByLevel: [16, 22, 29, 36, 46, 51], manaDot: { count: 10, intervalMs: 3000, damageByLevel: [4, 5, 7, 8, 10, 11] } },
    1104: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_winter', effectType: 'debuff', target: 'enemy', baseLandRate: 40, stats: { pAtkSpdMul: 0.77 } },
    1105: { skillType: EFFECT, trait: 'confusion', effect: 'confusion', effectType: 'debuff', target: 'enemy', mobOnly: true },
    1107: { skillType: EFFECT, trait: 'fire', effect: 'frost_flame', effectType: 'debuff', target: 'enemy', baseLandRate: 70, dot: { count: 15, intervalMs: 1000, damageByLevel: [44, 60] } },
    1108: { skillType: EFFECT, trait: 'fire', effect: 'seal_of_flame', effectType: 'debuff', target: 'enemy', baseLandRate: 35, dot: { count: 15, intervalMs: 1000, damageByLevel: [77, 94, 108, 118] } },
    1111: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1126: { skillType: MANA_RECHARGE, trait: 'mana', target: 'pet', ssBoost: 0 },
    1127: { skillType: HEAL, trait: 'heal', target: 'pet', ssBoost: 0 },
    1128: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1129: { skillType: SUMMON, trait: 'summon', target: 'corpse_mob', ssBoost: 0 },
    1139: { skillType: EFFECT, trait: 'buff', effect: 'servitor_magic_shield', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { mDefMul: [1.23, 1.3] } },
    1140: { skillType: EFFECT, trait: 'buff', effect: 'servitor_physical_shield', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1141: { skillType: EFFECT, trait: 'buff', effect: 'servitor_haste', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1144: { skillType: EFFECT, trait: 'buff', effect: 'servitor_wind_walk', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { runSpdAdd: [20, 33] } },
    1145: { skillType: EFFECT, trait: 'buff', effect: 'bright_servitor', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { mAtkMul: [1.55, 1.65, 1.75] } },
    1146: { skillType: EFFECT, trait: 'buff', effect: 'mighty_servitor', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1147: { skillType: DRAIN, trait: 'dark', target: 'enemy', ssBoost: 1, absorbPart: 0.4, baseLandRate: 92 },
    1148: { skillType: DAMAGE, trait: 'dark', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1151: { skillType: DRAIN, trait: 'dark', target: 'corpse_mob', ssBoost: 1, absorbAbsByLevel: [260, 299, 347, 384, 426, 467, 509, 541, 570, 592, 625, 647, 673, 701, 729, 758] },
    1154: { skillType: SUMMON, trait: 'summon', target: 'corpse_mob', ssBoost: 0 },
    1157: { skillType: MANA_HEAL, trait: 'mana', target: 'self', ssBoost: 0, manaPowerByLevel: [22, 35, 47, 53, 61] },
    1159: { skillType: DEATH_LINK, trait: 'dark', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1160: { skillType: EFFECT, trait: 'slow', effect: 'slow', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { runSpdMul: [0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
    1163: { skillType: EFFECT, trait: 'confusion', effect: 'confusion', effectType: 'debuff', target: 'enemy', baseLandRate: 80, mobOnly: true },
    1164: { skillType: EFFECT, trait: 'debuff', effect: 'curse_weakness', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { pAtkMul: [0.83, 0.8, 0.8, 0.8, 0.8, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77] } },
    1167: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', target: 'enemy', baseLandRateByLevel: [3, 4, 5, 6, 7, 8], dot: { count: 10, intervalMs: 3000, damageByLevel: [18, 24, 31, 38, 44, 48] } },
    1168: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', target: 'enemy', baseLandRateByLevel: [1, 3, 4, 5, 6, 7, 8], dot: { count: 10, intervalMs: 3000, damageByLevel: [8, 18, 24, 31, 38, 44, 48] } },
    1169: { skillType: EFFECT, trait: 'fear', effect: 'fear', effectType: 'debuff', target: 'enemy', baseLandRate: 20 },
    1170: { skillType: EFFECT, trait: 'paralyze', effect: 'paralyze', effectType: 'debuff', target: 'enemy', baseLandRate: 20 },
    1171: { skillType: DAMAGE, trait: 'fire', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1172: { skillType: DAMAGE, trait: 'fire', ssBoost: 1, baseLandRate: 92 },
    1174: { skillType: DAMAGE, trait: 'water', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1175: { skillType: DAMAGE, trait: 'water', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1176: { skillType: DAMAGE, trait: 'wind', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1178: { skillType: DAMAGE, trait: 'wind', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1177: { skillType: DAMAGE, trait: 'wind', ssBoost: 1, baseLandRate: 92 },
    1181: { skillType: DAMAGE, trait: 'fire', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1182: { skillType: EFFECT, trait: 'buff', effect: 'resist_aqua', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { waterVuln: [0.85, 0.77, 0.7] } },
    1183: { skillType: EFFECT, trait: 'water', effect: 'freezing_shackle', effectType: 'debuff', target: 'enemy', baseLandRate: 70, dot: { count: 15, intervalMs: 1000, damageByLevel: [77, 94, 108, 118] } },
    1184: { skillType: DAMAGE_EFFECT, trait: 'water', effect: 'ice_bolt', effectType: 'debuff', target: 'enemy', baseLandRate: 60, stats: { runSpdMul: 0.7 } },
    1189: { skillType: EFFECT, trait: 'buff', effect: 'resist_wind', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { windVuln: [0.85, 0.77, 0.7] } },
    1191: { skillType: EFFECT, trait: 'buff', effect: 'resist_fire', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { fireVuln: [0.85, 0.77, 0.7] } },
    1201: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1204: { skillType: EFFECT, trait: 'buff', effect: 'windWalk', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { runSpdAdd: [20, 33] } },
    1206: { skillType: EFFECT, trait: 'debuff', effect: 'wind_shackle', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { pAtkSpdMul: [0.83, 0.80, 0.80, 0.80, 0.80, 0.77] } },
    1208: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1209: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', target: 'enemy', baseLandRateByLevel: [3, 4, 5, 6, 7, 8], dot: { count: 10, intervalMs: 3000, damageByLevel: [18, 24, 31, 38, 44, 48] } },
    1210: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_gloom', effectType: 'debuff', target: 'enemy', baseLandRateByLevel: [29, 36, 46, 53], manaDot: { count: 15, intervalMs: 1000, damageByLevel: [7, 8, 10, 12] } },
    1213: { skillType: EFFECT, trait: 'confusion', effect: 'confusion', effectType: 'debuff', target: 'enemy', mobOnly: true },
    1216: { skillType: HEAL, trait: 'heal', target: 'self', ssBoost: 0 },
    1217: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1218: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1219: { skillType: HEAL, trait: 'heal', target: 'party', ssBoost: 0 },
    1220: { skillType: DAMAGE, trait: 'fire', target: 'enemy', ssBoost: 1, baseLandRate: 92 },
    1222: { skillType: EFFECT, trait: 'debuff', effect: 'curse_chaos', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { pAccuracyCombatAdd: [-12, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13] } },
    1223: { skillType: EFFECT, trait: 'earth', effect: 'surrender_to_earth', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { earthVuln: [1.25, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3] } },
    1224: { skillType: EFFECT, trait: 'poison', effect: 'surrender_to_poison', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { poisonVuln: [1.25, 1.25, 1.25, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 1.3] } },
    1225: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1226: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1227: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1228: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1234: { skillType: DRAIN, trait: 'dark', target: 'enemy', ssBoost: 1, absorbPart: 0.4, baseLandRate: 92 },
    1245: { skillType: DRAIN, trait: 'magic', target: 'enemy', ssBoost: 1, absorbPart: 0.8, baseLandRate: 92 },
    1276: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1277: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1278: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1279: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1280: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1281: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1328: { skillType: SUMMON, trait: 'summon', target: 'party', ssBoost: 0 },
    1329: { skillType: SUMMON, trait: 'summon', target: 'party', ssBoost: 0 },
    1330: { skillType: SUMMON, trait: 'summon', target: 'party', ssBoost: 0 },
    1331: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1332: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1333: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1334: { skillType: SUMMON, trait: 'summon', target: 'corpse_mob', ssBoost: 0 },
    1366: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_despair', effectType: 'debuff', target: 'enemy', baseLandRate: 40, stats: {
        pAtkMul: 0.9,
        runSpdMul: 0.8,
        mDefMul: 0.7,
        pAtkSpdMul: 0.7,
        pCritRateMul: 0.7,
        pCritDamageMul: 0.7,
        pAccuracyCombatAdd: -6
    } },
    1367: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_disease', effectType: 'debuff', target: 'enemy', baseLandRate: 40, stats: { regHp: 0.5, cancelVuln: 1.3 } },
    4080: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    4091: { skillType: HEAL_PERCENT, trait: 'heal', target: 'self', ssBoost: 0, healPowerByLevel: [14] },
    4115: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    2001: { skillType: HOT, trait: 'buff', effect: 'red_potion', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 3, intervalMs: 5000, heal: 2 } },
    2002: { skillType: HOT, trait: 'buff', effect: 'healing_drug', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 4, intervalMs: 5000, heal: 1.5 } },
    2005: { skillType: MANA_HEAL, trait: 'mana', target: 'self', ssBoost: 0, manaPowerByLevel: [400] },
    2011: { skillType: EFFECT, trait: 'buff', effect: 'quick_step_potion', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { runSpdAdd: 20 } },
    2012: { skillType: EFFECT, trait: 'buff', effect: 'potion_of_alacrity', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pAtkSpdMul: 1.15 } },
    2031: { skillType: HOT, trait: 'buff', effect: 'lesser_healing_potion', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 7, intervalMs: 2000, heal: 16 } },
    2032: { skillType: HOT, trait: 'buff', effect: 'healing_potion', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 7, intervalMs: 2000, heal: 48 } },
    2033: { skillType: EFFECT, trait: 'buff', effect: 'haste_potion', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { runSpdAdd: 33 } },
    2034: { skillType: EFFECT, trait: 'buff', effect: 'greater_haste_potion', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { runSpdAdd: 33 } },
    2035: { skillType: EFFECT, trait: 'buff', effect: 'greater_swift_attack_potion', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pAtkSpdMul: 1.33 } },
    2037: { skillType: HOT, trait: 'buff', effect: 'greater_healing_potion', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 7, intervalMs: 2000, heal: 100 } },
    2038: { skillType: HEAL_STATIC, trait: 'heal', target: 'self', ssBoost: 0, healPowerByLevel: [435] },
    2042: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ category: 'poison', maxLevel: 3 }] },
    2043: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ category: 'poison', maxLevel: 7 }] },
    2044: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevel: 3 }] },
    2045: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevel: 7 }] },
    2050: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_guidance', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pAccuracyCombatAdd: 4 } },
    2051: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_death_whisper', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pCritDamageMul: 1.5 } },
    2052: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_focus', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pCritRateMul: 1.3 } },
    2053: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_greater_acumen', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { castSpdMul: 1.3 } },
    2054: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_haste', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pAtkSpdMul: 1.33 } },
    2055: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_agility', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pEvasionRateAdd: 4 } },
    2056: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_mystic_empower', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { mAtkMul: 1.75 } },
    2057: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_might', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pAtkMul: 1.15 } },
    2058: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_wind_walk', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { runSpdAdd: 33 } },
    2059: { skillType: EFFECT, trait: 'buff', effect: 'scroll_of_shield', effectType: 'buff', target: 'self', baseLandRate: 100, stats: { pDefMul: 1.15 } },
    2060: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ skillId: 4082 }] },
    4097: { skillType: HOT, trait: 'buff', effect: 'npc_chant_of_life', effectType: 'buff', target: 'self', baseLandRate: 100, hot: { count: 5, intervalMs: 3000, healByLevel: [7, 12, 18, 27, 37, 46, 55, 23, 32, 42, 51, 58] } },
    4338: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    7030: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    7031: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    7032: { skillType: SUMMON, trait: 'summon', target: 'self', ssBoost: 0 },
    1229: { skillType: HOT, trait: 'buff', effect: 'chant_of_life', effectType: 'buff', target: 'friendly', baseLandRate: 100, hot: { count: 15, intervalMs: 1000, healByLevel: [12, 15, 18, 23, 27, 31, 35, 39, 43, 45, 46, 48, 50, 52, 53, 55, 56, 58] } },
    1240: { skillType: EFFECT, trait: 'buff', effect: 'guidance', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAccuracyCombatAdd: [2, 3, 4] } },
    1242: { skillType: EFFECT, trait: 'buff', effect: 'death_whisper', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritDamageMul: [1.25, 1.3, 1.35] } },
    1243: { skillType: EFFECT, trait: 'buff', effect: 'bless_shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { rShldMul: [1.05, 1.1, 1.15, 1.2, 1.25, 1.3] } },
    1246: { skillType: EFFECT, trait: 'derangement', effect: 'silence', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1247: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_scourge', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { regHp: 0 } },
    1248: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_suspension', effectType: 'debuff', target: 'enemy', baseLandRate: 60, stats: { mReuseMul: 3, pReuseMul: 3 } },
    1249: { skillType: EFFECT, trait: 'buff', effect: 'vision_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAccuracyCombatAdd: [2, 3, 4] } },
    1250: { skillType: EFFECT, trait: 'buff', effect: 'protection_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { rShldMul: [1.3, 1.4, 1.5] } },
    1251: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_fury', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1252: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_evasion', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1253: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_rage', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritDamageMul: [1.25, 1.3, 1.35] } },
    1256: { skillType: HEAL_HOT, trait: 'buff', effect: 'heart_of_paagrio', effectType: 'buff', target: 'friendly', ssBoost: 0, healPowerByLevel: [91, 103, 115, 127, 133, 138, 144, 149, 154, 158, 164, 168, 172], hot: { count: 15, intervalMs: 1000, healByLevel: [31, 35, 39, 43, 45, 46, 48, 50, 52, 53, 55, 56, 58] } },
    1257: { skillType: EFFECT, trait: 'buff', effect: 'decrease_weight', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxLoad: [3000, 6000, 9000] } },
    1258: { skillType: HEAL_PERCENT, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [15, 20, 25, 30] },
    1259: { skillType: EFFECT, trait: 'buff', effect: 'resist_shock', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { stunResist: [15, 20, 30, 40] } },
    1260: { skillType: EFFECT, trait: 'buff', effect: 'tact_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1261: { skillType: EFFECT, trait: 'buff', effect: 'rage_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        mAtkMul: [1.1, 1.16],
        pAtkMul: [1.05, 1.08],
        pDefMul: [0.95, 0.92],
        mDefMul: [0.90, 0.84],
        castSpdMul: [1.05, 1.08],
        pAtkSpdMul: [1.05, 1.08],
        runSpdAdd: [5, 8],
        pEvasionRateAdd: [-2, -4]
    } },
    1263: { skillType: DAMAGE_EFFECT, trait: 'unholy', effect: 'curse_gloom', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { mDefMul: 0.85 } },
    1268: { skillType: EFFECT, trait: 'buff', effect: 'vampiric_rage', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { absorbDam: [6, 7, 8, 9] } },
    1269: { skillType: EFFECT, trait: 'debuff', effect: 'curse_disease', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { regHp: 0.5 } },
    1271: { skillType: HEAL_PERCENT, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [100], condition: { actorHpPercentAtMost: 25 } }
};

const SELF_NAME_PATTERNS = [
    /^dash$/i,
    /^self heal$/i,
    /^ultimate /i,
    /^totem spirit /i,
    /^war cry$/i,
    /^rage$/i,
    /^rapid shot$/i,
    /^deflect arrow$/i,
    / aura$/i,
    /^detect /i
];

function resolve(skill = {}) {
    const name = String(skill.name || '');
    const rule = RULES[Number(skill.selfId)] || {};
    const inferred = infer(skill, name);

    const semantic = {
        skillType: rule.skillType || inferred.skillType,
        target: rule.target || inferred.target,
        sourceTarget: rule.sourceTarget || inferred.sourceTarget || null,
        radius: rule.radius ?? inferred.radius ?? 0,
        effect: rule.effect || inferred.effect,
        effectType: rule.effectType || inferred.effectType,
        trait: rule.trait || inferred.trait,
        ssBoost: rule.ssBoost ?? inferred.ssBoost,
        baseLandRate: resolveByLevel(rule.baseLandRateByLevel, skill.level) ?? rule.baseLandRate ?? inferred.baseLandRate,
        levelDepend: rule.levelDepend ?? inferred.levelDepend ?? 0,
        blowChance: rule.blowChance ?? inferred.blowChance,
        healPower: resolveByLevel(rule.healPowerByLevel, skill.level),
        manaPower: resolveByLevel(rule.manaPowerByLevel, skill.level),
        absorbPart: resolveByLevel(rule.absorbPartByLevel, skill.level) ?? rule.absorbPart ?? inferred.absorbPart ?? 0,
        absorbAbs: resolveByLevel(rule.absorbAbsByLevel, skill.level) ?? rule.absorbAbs ?? inferred.absorbAbs ?? 0,
        dot: rule.dot || inferred.dot || null,
        manaDot: rule.manaDot || inferred.manaDot || null,
        hot: resolveHot(rule, inferred, skill.level),
        cleanse: resolveCleanse(rule, inferred, skill.level),
        lethal: rule.lethal || inferred.lethal || null,
        condition: rule.condition || inferred.condition || null,
        requires: rule.requires || inferred.requires || null,
        maxCharges: resolveByLevel(rule.maxChargesByLevel, skill.level) ?? rule.maxCharges ?? null,
        aggroPoints: rule.aggroPoints ?? inferred.aggroPoints ?? 0,
        overHit: rule.overHit || inferred.overHit || false,
        mobOnly: rule.mobOnly || inferred.mobOnly || false,
        undeadOnly: rule.undeadOnly || inferred.undeadOnly || false,
        maxCancelled: rule.maxCancelled ?? inferred.maxCancelled
    };
    semantic.stats = resolveStats(rule, inferred, skill.level);
    return semantic;
}

function resolveCleanse(rule, inferred, level) {
    return (rule.cleanse || inferred.cleanse || []).map((entry) => {
        const maxLevel = entry.maxLevelByLevel
            ? entry.maxLevelByLevel[Math.max(0, Math.min(entry.maxLevelByLevel.length - 1, (Number(level) || 1) - 1))]
            : entry.maxLevel;
        return { ...entry, maxLevel };
    });
}

function resolveByLevel(values, level) {
    if (!values) return null;
    const index = Math.max(0, Math.min(values.length - 1, (Number(level) || 1) - 1));
    return values[index];
}

function resolveHot(rule, inferred, level) {
    const hot = rule.hot || inferred.hot || null;
    if (!hot) return null;
    const heal = resolveByLevel(hot.healByLevel, level);
    return { ...hot, heal: heal ?? hot.heal };
}

function resolveStats(rule, inferred, level) {
    const stats = { ...(inferred.stats || {}), ...(rule.stats || {}) };
    Object.entries(rule.statsByLevel || {}).forEach(([stat, values]) => {
        const index = Math.max(0, Math.min(values.length - 1, (Number(level) || 1) - 1));
        stats[stat] = values[index];
    });
    return stats;
}

function infer(skill, name) {
    const lower = name.toLowerCase();
    const power = Number(skill.power) || 0;
    const buffMs = Number(skill.buff) || 0;
    const spell = skill.spell === true;
    const selfTarget = Number(skill.distance) < 0 || SELF_NAME_PATTERNS.some((pattern) => pattern.test(name));

    if (lower.includes('heal')) {
        return { skillType: HEAL, target: selfTarget ? 'self' : 'friendly', trait: 'heal', ssBoost: 0 };
    }

    if (lower.includes('blow') || lower.includes('backstab')) {
        return {
            skillType: BLOW,
            target: 'enemy',
            trait: 'dagger',
            ssBoost: 1,
            blowChance: lower.includes('mortal') ? 50 : 70,
            lethal: lower.includes('deadly') || lower.includes('backstab') ? { halfKillChance: 5 } : null
        };
    }

    if (buffMs > 0) {
        const debuff = inferDebuff(name);
        if (debuff) {
            return {
                skillType: power > 1 ? DAMAGE_EFFECT : EFFECT,
                target: 'enemy',
                effect: debuff.effect,
                effectType: 'debuff',
                trait: debuff.trait,
                baseLandRate: debuff.baseLandRate,
                ssBoost: spell ? 1 : 0
            };
        }

        return {
            skillType: EFFECT,
            target: 'self',
            effect: normalizeKey(name),
            effectType: 'buff',
            trait: 'buff',
            baseLandRate: 100,
            ssBoost: 0
        };
    }

    return {
        skillType: DAMAGE,
        target: selfTarget ? 'self' : 'enemy',
        trait: spell ? 'magic' : 'physical',
        baseLandRate: spell ? 92 : 100,
        ssBoost: 1
    };
}

function inferDebuff(name) {
    const lower = name.toLowerCase();
    if (lower.includes('sleep')) return { effect: 'sleep', trait: 'sleep', baseLandRate: 70 };
    if (lower.includes('stun')) return { effect: 'stun', trait: 'shock', baseLandRate: 50 };
    if (lower.includes('poison')) return { effect: 'poison', trait: 'poison', baseLandRate: 70 };
    if (lower.includes('bleed')) return { effect: 'bleed', trait: 'bleed', baseLandRate: 70 };
    if (lower.includes('entangle') || lower.includes('root')) return { effect: 'root', trait: 'root', baseLandRate: 70 };
    if (lower.includes('hex') || lower.includes('power break')) return { effect: normalizeKey(name), trait: 'debuff', baseLandRate: 80 };
    if (lower.includes('cripple') || lower.includes('slow')) return { effect: 'slow', trait: 'slow', baseLandRate: 70 };
    return null;
}

function normalizeKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

module.exports = {
    DAMAGE,
    DAMAGE_EFFECT,
    DEATH_LINK,
    DRAIN,
    HEAL,
    HEAL_PERCENT,
    HEAL_HOT,
    HEAL_STATIC,
    HOT,
    EFFECT,
    BLOW,
    CLEANSE,
    HEAL_CLEANSE,
    MANA_RECHARGE,
    MANA_HEAL,
    SUMMON,
    AGGRO_DAMAGE,
    AGGRO_REMOVE,
    AGGRO_REDUCE,
    AGGRO_REDUCE_CHAR,
    CANCEL,
    CHARGE,
    resolve,
    normalizeKey
};

const assert = require('assert');

require('../src/Global');

// T109 (user 10-29 "Max HP by class"): max HP, MP and CP are the class's C4
// template value at the level (L2J Mobius C4 lvlUpgainData) times the CON or
// MEN bonus, for players and bots alike.
const Formulas = invoke('GameServer/Formulas');
const CON = con => Formulas.calcBaseMod.CON(con);
const MEN = men => Formulas.calcBaseMod.MEN(men);
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} vs ${expected}`);

// Mobius C4 values before the bonus, [level, hp, mp, cp], from
// 2ndClass/{Gladiator,Sorcerer,Bishop,Warsmith,SilverRanger}.xml and 3rdClass/Duelist.xml.
const pins = {
    2: [[10, 191.15, 81.3, 172.035], [20, 327, 144, 294.3], [40, 1044, 359.1, 939.6], [56, 1880, 689.1, 1692], [76, 3061.8, 1155.6, 2755.62]],
    12: [[10, 246.35, 108.4, 123.175], [20, 424, 192, 212], [40, 1021.5, 478.8, 510.75], [56, 1791.5, 918.8, 895.75], [76, 2880, 1540.8, 1440]],
    16: [[10, 246.35, 108.4, 172.445], [20, 424, 192, 296.8], [40, 1164.9, 478.8, 815.43], [56, 2000.9, 918.8, 1400.63], [76, 3182.7, 1540.8, 2227.89]],
    57: [[10, 199.7, 81.3, 159.76], [20, 346, 144, 276.8], [40, 1063, 359.1, 850.4], [56, 1987, 689.1, 1589.6], [76, 3293.2, 1155.6, 2634.56]],
    24: [[10, 208.7, 81.3, 104.35], [20, 355, 144, 177.5], [40, 1024.2, 359.1, 512.1], [56, 1860.2, 689.1, 930.1], [76, 3042, 1155.6, 1521]],
    88: [[10, 191.15, 81.3, 172.035], [20, 327, 144, 294.3], [40, 1044, 359.1, 939.6], [56, 1880, 689.1, 1692], [76, 3061.8, 1155.6, 2755.62]]
};
for (const [classId, rows] of Object.entries(pins)) {
    for (const [level, hp, mp, cp] of rows) {
        near(Formulas.calcHp(level, Number(classId), 43), hp * CON(43), `class ${classId} L${level} hp`);
        near(Formulas.calcMp(level, Number(classId), 25), mp * MEN(25), `class ${classId} L${level} mp`);
        near(Formulas.calcCp(level, Number(classId), 43), cp * CON(43), `class ${classId} L${level} cp`);
    }
}
// The 2nd class grows into its 3rd: no jump on the transfer at 76.
near(Formulas.calcCp(76, 2, 43), Formulas.calcCp(76, 88, 43), 'Gladiator 76 = Duelist 76');

// The cold bot's profile reads the same values.
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const gladiator = { characterId: 81, name: 'ColdGladiator', level: 76, levelBand: '76-78', activity: 'hunting',
    vitals: { hp: 1, maxHp: 1, mp: 1, maxMp: 1 }, inventory: {}, party: { role: 'dps' },
    stats: { classId: 2, coldCombat: { version: 1, classId: 2,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk: 100, pAtkRnd: 0, mAtk: 50, atkSpd: 300, critical: 0, accur: 0,
            pDef: 100, mDef: 100, evasion: 0, bonusMp: 0, shieldPDef: 0 },
        effects: [], skills: [] } } };
const profile = Cold.fightProfile(gladiator, 1e12);
near(profile.maxHp, Formulas.calcHp(76, 2, 43), 'cold maxHp');
near(profile.maxMp, Formulas.calcMp(76, 2, 25), 'cold maxMp');
near(profile.maxCp, Formulas.calcCp(76, 2, 43), 'cold maxCp');
// A bot that took its transfers cold keeps the class its kit was captured
// with in coldCombat; the profile reads the current class main publishes.
const transferred = { ...gladiator, stats: { ...gladiator.stats,
    coldCombat: { ...gladiator.stats.coldCombat, classId: 1 } } };
const refreshed = Cold.legacySnapshot(transferred, [], 1e12);
assert.strictEqual(refreshed.classId, 2, 'a refreshed kit takes the current class');
near(Cold.fightProfile(transferred, 1e12).maxHp, Formulas.calcHp(76, 2, 43), 'cold maxHp after a cold transfer');
near(Cold.fightProfile(transferred, 1e12).maxMp, Formulas.calcMp(76, 2, 25), 'cold maxMp after a cold transfer');

console.log('Class vitals checks passed');

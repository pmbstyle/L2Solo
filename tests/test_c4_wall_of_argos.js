const assert = require('assert');

require('../src/Global');

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');

const mobIds = [1294, 1295, 1296, 1297, 1298, 1299, 1300, 1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1312];

assertC4MonsterLocation({
    slug: 'c4_wall_of_argos',
    displayName: 'Wall of Argos',
    mobIds,
    importedNpcIds: mobIds,
    bindingSlugs: ['c4_wall_of_argos'],
    origin: [180000, -50000, -3200],
    sample: {
        id: 1294, name: 'Canyon Antelope', level: 68, hostile: false,
        pAtk: 1217, pDef: 449, mAtk: 713, mDef: 365, hp: 3706,
        exp: 6893, sp: 666, clan: '', race: 'animal'
    },
    sourceDropRows: 266,
    importedItems: {},
    importedSkillRows: 143,
    sourceSkillRows: 143,
    combatSkills: {
        1294: [4032], 1295: [4032, 4092], 1296: [], 1297: [4032, 4090],
        1298: [4038], 1299: [4032], 1300: [4158, 4160],
        1301: [4098, 4046, 4105, 4047], 1302: [4098, 4046, 4105, 4657],
        1303: [4561], 1304: [4089, 4090, 4092], 1305: [4158, 4160],
        1306: [], 1307: [4257, 4561, 4038], 1308: [4158], 1309: [4033],
        1310: [4158], 1311: [4158, 4160], 1312: [4156, 4160, 4047, 4571]
    },
    multipliers: [
        { npcId: 1296, stat: 'maxHpMul', value: 3 },
        { npcId: 1306, stat: 'maxHpMul', value: 5 },
        { npcId: 1306, stat: 'holyVuln', value: 0.3 }
    ]
});


const hold = C4SkillRules.resolve({ selfId: 4657, level: 7, name: 'Hold', power: 102, buff: 30000, spell: true, distance: 600 });
assert.strictEqual(hold.skillType, C4SkillRules.DRAIN);
assert.strictEqual(hold.effect, 'root');
assert.strictEqual(hold.absorbPart, 0.2);
assert.deepStrictEqual(C4SkillRules.resolve({ selfId: 4609, level: 4, name: 'NPC Clan Buff - Vampiric Rage' }).stats, { absorbDam: 9 });
assert.strictEqual(C4SkillRules.resolve({ selfId: 4335, level: 1, name: 'Sacred Attack' }).skillType, C4SkillRules.NOT_DONE);

console.log('C4 Wall of Argos skill semantics checks passed');

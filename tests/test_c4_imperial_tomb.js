const assert = require('assert');
require('../src/Global');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const mobIds = [1396,1397,1398,1399,1400,1401,1402,1403,1404,1405,1406,1407,1408,1410,1411,1412,1413,1414,1415,1416,1417,1418,1420,1421,1424,1425,1426,1427,1428,1429,1430,1431,1432,1434,1798,1799,1800];

assertC4MonsterLocation({
    unspawned: [1404], // Mobius has the template, no spawn
    slug:'c4_imperial_tomb', displayName:'Imperial Tomb', mobIds, importedNpcIds:mobIds, bindingSlugs:['c4_imperial_tomb'],
    origin:[182000,-80000,-5000],
    sample:{id:1396,name:'Carrion Scarab',level:78,hostile:false,pAtk:1417,pDef:672,mAtk:1069,mDef:451,hp:4428,exp:8182,sp:895,clan:'tomb_clan',race:'insect'},
    sourceDropRows:520, importedItems:{}, importedSkillRows:339, sourceSkillRows:339,
    combatSkills:{1396:[4001,4002,4047],1397:[4032],1398:[],1399:[4157,4160],1400:[],1401:[4072],1402:[4072,4090,4032],1403:[4643],1404:[4157,4561],1405:[4001,4029],1406:[4157,4561,4117],1407:[4032,4663],1408:[4036],1410:[4317,4073,4047],1411:[4077],1412:[],1413:[4047],1414:[4603,4561],1415:[],1416:[4665,4160],1417:[4002],1418:[],1420:[4317,4072,4076],1421:[],1424:[4077,4076,4633],1425:[4565,4098,4632],1426:[],1427:[4560],1428:[4571],1429:[4151,4072],1430:[4257,4160],1431:[4560],1432:[4040,4341],1434:[4605],1798:[4073],1799:[4631,4571,4032],1800:[4567]}
});
assert.strictEqual(C4SkillRules.resolve({selfId:4665,level:8,name:'NPC 100% HP Drain - Magic'}).absorbPart,1);
assert.strictEqual(C4SkillRules.resolve({selfId:4577,level:8,name:'Decrease Accuracy'}).skillType,C4SkillRules.NOT_DONE);
assert.deepStrictEqual(C4SkillRules.resolve({selfId:4341,level:1,name:'Ultimate Buff, 3rd'}).stats,{pDefMul:5});
console.log('C4 Imperial Tomb skill semantics checks passed');

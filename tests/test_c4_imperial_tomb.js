const assert = require('assert');
require('../src/Global');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');
const mobIds = [1396,1397,1398,1399,1400,1401,1402,1403,1404,1405,1406,1407,1408,1410,1411,1412,1413,1414,1415,1416,1417,1418,1420,1421,1424,1425,1426,1427,1428,1429,1430,1431,1432,1434,1798,1799,1800];

assertC4MonsterLocation({
    slug:'c4_imperial_tomb', displayName:'Imperial Tomb', areaId:'c4-imperial-tomb', mobIds, importedNpcIds:mobIds, bindingSlugs:['c4_imperial_tomb'],
    spawnCounts:[[1396,6],[1397,6],[1398,8],[1399,8],[1400,12],[1401,9],[1402,4],[1403,20],[1404,4],[1405,4],[1406,13],[1407,26],[1408,19],[1410,15],[1411,30],[1412,6],[1413,6],[1414,20],[1415,10],[1416,8],[1417,4],[1418,6],[1420,6],[1421,6],[1424,8],[1425,2],[1426,8],[1427,8],[1428,6],[1429,6],[1430,8],[1431,4],[1432,9],[1434,3],[1798,6],[1799,4],[1800,4]],
    respawn:40, respawnByMob:{1396:60,1397:60,1398:30,1399:180,1400:45,1402:45,1403:90,1408:45,1410:60,1411:60,1412:80,1413:80,1414:45,1415:45,1418:45,1420:80,1421:80,1425:90,1426:30,1427:60,1428:60,1429:90,1430:90,1431:120,1434:720,1798:90,1799:90,1800:90},
    region:[25,15], maxHeightDelta:5472, origin:[182000,-80000,-5000],
    sample:{id:1396,name:'Carrion Scarab',level:78,hostile:false,pAtk:1417,pDef:672,mAtk:1069,mDef:451,hp:4428,exp:8182,sp:895,clan:'tomb_clan',race:'insect'},
    sourceDropRows:520, importedItems:{}, importedSkillRows:339, sourceSkillRows:339,
    combatSkills:{1396:[4001,4002,4047],1397:[4032],1398:[],1399:[4157,4160],1400:[],1401:[4072],1402:[4072,4090,4032],1403:[4643],1404:[4157,4561],1405:[4001,4029],1406:[4157,4561,4117],1407:[4032,4663],1408:[4036],1410:[4317,4073,4047],1411:[4077],1412:[],1413:[4047],1414:[4603,4561],1415:[],1416:[4665,4160],1417:[4002],1418:[],1420:[4317,4072,4076],1421:[],1424:[4077,4076,4633],1425:[4565,4098,4632],1426:[],1427:[4560],1428:[4571],1429:[4151,4072],1430:[4257,4160],1431:[4560],1432:[4040,4341],1434:[4605],1798:[4073],1799:[4631,4571,4032],1800:[4567]}
});
assertMonsterEmptyBeforeSlice({slug:'c4_imperial_tomb',displayName:'Imperial Tomb',box:{minX:174690,maxX:189858,minY:-84275,maxY:-75022,minZ:-7256,maxZ:-2720}});
assert.strictEqual(C4SkillRules.resolve({selfId:4665,level:8,name:'NPC 100% HP Drain - Magic'}).absorbPart,1);
assert.strictEqual(C4SkillRules.resolve({selfId:4577,level:8,name:'Decrease Accuracy'}).skillType,C4SkillRules.NOT_DONE);
assert.deepStrictEqual(C4SkillRules.resolve({selfId:4341,level:1,name:'Ultimate Buff, 3rd'}).stats,{pDefMul:5});
console.log('C4 Imperial Tomb skill semantics checks passed');

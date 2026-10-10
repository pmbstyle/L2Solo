'use strict';
const assert = require('node:assert/strict');
const gameRoot = require('node:path').resolve(process.env.N53_GAME_ROOT || require('node:path').join(__dirname, '..'));
require(require('node:path').join(gameRoot, 'src/Global'));
invoke('GameServer/DataCache').init();
const Catalog = invoke('GameServer/Skills/SkillBookCatalog'), Training = invoke('GameServer/Bot/BotSkillTraining');
assert.equal(typeof Catalog.nextTrainingSp,'function');
const support = {level:45,inventory:{},stats:{classId:16,clanId:1,coldCombat:{skills:[]}}};
const eligible = Catalog.entries(16).map(entry=>Catalog.nextTraining(16,45,entry.selfId))
    .filter(next=>next && next.bookId===null);
assert(eligible.some(next=>next.skillId===1011),'E6 heal rank opens without an attack book');
assert.equal(Catalog.nextTrainingSp(support),Math.min(...eligible.map(next=>next.sp)));
assert.equal(Catalog.nextTrainingSp({level:1,inventory:{},stats:{classId:999999}}),Infinity);
const Progression = invoke('GameServer/Bot/BotClassProgression');
const old = {next:Catalog.nextTrainingSp,needs:Catalog.needsTraining,plan:Progression.plan};
let needs=0, bags=0, level=45, classId=16, sp=0;
const actor={fetchLevel:()=>level,fetchClassId:()=>classId,fetchSp:()=>sp,fetchId:()=>77,
    backpack:{fetchItems(){bags++;return[];}},skillset:{fetchSkills:()=>[]}};
const session={actor,accountId:'bot_gate_fixture'};
(async()=>{
    try {
        Catalog.nextTrainingSp=()=>50; Catalog.needsTraining=()=>{needs++;return false;};
        Progression.plan=()=>({transitions:[]});
        await Training.review(session); needs=bags=0;
        for(let i=0;i<50;i++){sp=i;await Training.review(session,{onSpAward:true});}
        assert.equal(needs,0);assert.equal(bags,0,'SP gate never rebuilds the bag below its threshold');
        sp=50;await Training.review(session,{onSpAward:true});assert.equal(needs,1);assert.equal(bags,1);
        needs=0;level++;await Training.review(session,{onSpAward:true});assert.equal(needs,1,'level change bypasses the old gate');
        needs=0;classId++;await Training.review(session,{onSpAward:true});assert.equal(needs,1,'class change bypasses it too');
        needs=0;sp=0;await Training.review(session);assert.equal(needs,1,'book purchase/full review bypasses SP gate');
        assert.deepEqual(session.skillTrainingGate,{level,classId,nextSp:50});
        console.log('Skill gate:50 SP awards0bag/needs checks, threshold/level/class/book event opens, E6support unneeded book eligible:PASS');
    } finally {Catalog.nextTrainingSp=old.next;Catalog.needsTraining=old.needs;Progression.plan=old.plan;}
})().catch(error=>{console.error(error);process.exitCode=1;});

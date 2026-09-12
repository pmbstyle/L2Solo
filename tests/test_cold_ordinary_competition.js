const assert = require('assert');
const {spawnSync} = require('child_process');
const Target = require('../src/GameServer/Bot/Population/PartyHuntingTarget');
const {ColdCompetitionMonitor} = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const spot = { id: 'ordinary', avgLevel: 20, npcEntries: [{selfId:10,level:20,count:1},{selfId:11,level:20,count:3}] };
const memory = new Memory();
const entries=Array.from({length:40},(_,i)=>{
    memory.accept(Policy.empty(i+1));
    return { state:{characterId:i+1,level:20,phase:'cold',activity:'hunting',spotId:spot.id,
        vitals:{hp:100},stats:{equipmentPlan:i%2?{status:'active',strategy:'market'}:{status:'complete'}},party:{}},
        context:{spot,targetNpcId:0} };
});
const selected=entries.map(e=>Target.competitionNpcId(null,e.state,spot));
assert(selected.includes(10)&&selected.includes(11),'ordinary hunters distribute across actual spawn types');
assert(selected.filter(id=>id===11).length>selected.filter(id=>id===10).length,'spawn density weights the representative target');
assert.strictEqual(Target.competitionNpcId(null,{...entries[0].state,level:79},spot),0,'outleveled mobs are not ordinary competition targets');
assert.strictEqual(Target.competitionNpcId(null,entries[0].state,{...spot,npcEntries:[]}),0);
const party={partyId:'ordinary-party',spotId:spot.id,stats:{}};
assert.strictEqual(Target.competitionNpcId(party,entries[0].state,spot),Target.competitionNpcId(party,entries[0].state,{...spot,npcEntries:[...spot.npcEntries].reverse()}));
const monitor = new ColdCompetitionMonitor({capacityForSpot:()=>4,personaFor:()=>({traits:{assertiveness:1,ambition:1,empathy:0,caution:0}})});
for(let tick=0;tick<100;tick++)monitor.sample(entries,memory,1800000000000+tick*30000);
assert(monitor.snapshot().evaluated>0);
assert(monitor.snapshot().pvpIntents>0,'ordinary hunters can generate real conflict proposals');
assert(monitor.snapshot().sampledPairs<=32,'ordinary hunting retains the existing work bound');
const peaceful = new ColdCompetitionMonitor({capacityForSpot:()=>1000,personaFor:()=>({traits:{assertiveness:1}})});
for(let tick=0;tick<10;tick++)peaceful.sample(entries,memory,1800000000000+tick*30000);
assert.strictEqual(peaceful.snapshot().evaluated,0,'abundant ordinary mobs do not invent competition');
console.log('Ordinary hunting targets, weighted demand, bounded proposals and abundance checks passed');
for (const test of ['./test_cold_pvp', './test_cold_competition_actions']) {
    const result=spawnSync(process.execPath,[require.resolve(test),'--ordinary-hunt'],{stdio:'inherit'});
    if (result.status !== 0) { process.exitCode=result.status??1; break; }
}

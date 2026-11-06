const assert = require('assert');
const {spawnSync} = require('child_process');
const Target = require('../src/GameServer/Bot/Population/PartyHuntingTarget');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const spot = { id: 'ordinary', avgLevel: 20, npcEntries: [{selfId:10,level:20,count:1},{selfId:11,level:20,count:3}] };
const memory = new Memory();
const entries=Array.from({length:40},(_,i)=>{
    memory.accept(Policy.empty(i+1));
    return { state:{characterId:i+1,level:20,phase:'cold',activity:'hunting',spotId:spot.id,
        vitals:{hp:100},stats:{equipmentPlan:i%2?{status:'active',strategy:'market'}:{status:'complete'}},party:{}} };
});
const selected=entries.map(e=>Target.competitionNpcId(null,e.state,spot));
assert(selected.includes(10)&&selected.includes(11),'ordinary hunters distribute across actual spawn types');
assert(selected.filter(id=>id===11).length>selected.filter(id=>id===10).length,'spawn density weights the representative target');
assert.strictEqual(Target.competitionNpcId(null,{...entries[0].state,level:79},spot),0,'outleveled mobs are not ordinary competition targets');
assert.strictEqual(Target.competitionNpcId(null,entries[0].state,{...spot,npcEntries:[]}),0);
const party={partyId:'ordinary-party',spotId:spot.id,stats:{}};
assert.strictEqual(Target.competitionNpcId(party,entries[0].state,spot),Target.competitionNpcId(party,entries[0].state,{...spot,npcEntries:[...spot.npcEntries].reverse()}));
console.log('Ordinary hunting targets and weighted demand checks passed');
for (const test of ['./test_cold_pvp', './test_cold_competition_actions']) {
    const result=spawnSync(process.execPath,[require.resolve(test),'--ordinary-hunt'],{stdio:'inherit'});
    if (result.status !== 0) { process.exitCode=result.status??1; break; }
}

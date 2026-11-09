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
// A unit that outlevelled the spot's spawns past the target window still hunts there: it competes for them.
const outleveled=entries.map(e=>Target.competitionNpcId(null,{...e.state,level:79},spot));
assert(outleveled.every(id=>id===10||id===11)&&outleveled.includes(10)&&outleveled.includes(11),'an outlevelled hunter draws among every spawn');
// A planned target counts only where it spawns: elsewhere the unit competes for what does.
const planned=npc=>({...entries[0].state,stats:{equipmentPlan:{status:'active',next:{npcId:npc}}}});
assert.strictEqual(Target.competitionNpcId(null,planned(11),spot),11,'a planned target that spawns there is the target');
assert([10,11].includes(Target.competitionNpcId(null,planned(99),spot)),'a planned target absent from the spot is not');
assert.strictEqual(Target.competitionNpcId(null,entries[0].state,{...spot,npcEntries:[]}),0);
const party={partyId:'ordinary-party',spotId:spot.id,stats:{}};
assert.strictEqual(Target.competitionNpcId(party,entries[0].state,spot),Target.competitionNpcId(party,entries[0].state,{...spot,npcEntries:[...spot.npcEntries].reverse()}));
console.log('Ordinary hunting targets and weighted demand checks passed');
for (const test of ['./test_cold_pvp', './test_cold_competition_actions']) {
    const result=spawnSync(process.execPath,[require.resolve(test),'--ordinary-hunt'],{stdio:'inherit'});
    if (result.status !== 0) { process.exitCode=result.status??1; break; }
}

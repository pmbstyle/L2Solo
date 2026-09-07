const { count, step, evolve, abort } = require('../../Pets/PetQuest');
const trees=[5185,5186,5187,5188];
const link=(event,text)=>`<a action="bypass -h quest 421 ${event}">${text}</a><br>`;
const page=text=>`<html><body>Little Wing's Big Adventure:<br>${text}</body></html>`;
function hatchling(state, requireNearby = true) {
    const actor=state.session.actor, pet=actor.pet;
    if(actor.fetchLevel()<45 || !pet || ![12311,12312,12313].includes(pet.fetchSelfId()) || pet.fetchLevel()<55 || pet.state.fetchDead() || pet.evolving || pet.ownerTeleport || actor.fetchMounted?.() || actor.mounted) return null;
    if(requireNearby && Math.hypot(pet.fetchLocX()-actor.fetchLocX(),pet.fetchLocY()-actor.fetchLocY(),pet.fetchLocZ()-actor.fetchLocZ())>100) return null;
    if(state.isStarted() && state.getInt('controlId')!==pet.fetchPetControlItemObjectId()) return null;
    return pet;
}
module.exports={
    questItems:[4325], onAbort:abort,
    id:421, name:"Little Wing's Big Adventure", npcs:[7610,7747], startNpcs:[7610], attackNpcs:trees,
    canTalk: state=>state.isStarted() || state.session.actor.fetchLevel()>=45,
    eventNpc:event=>({start:7610,leaves:7747,evolve:7747})[event] ?? null,
    async onTalk(state,npc) {
        if(!hatchling(state)) return page('You must be level 45 or higher. Summon your level 55 or higher hatchling and keep it within 100 distance. Use the same hatchling throughout this quest.');
        const c=state.getInt('cond');
        if(!state.isStarted() && npc.fetchSelfId()===7610) return page(link('start','Ask Cronos how to raise a strider.'));
        if(npc.fetchSelfId()===7747 && (c===1 || (c===2 && count(state,4325)===0))) return page(link('leaves','Ask Mymyu for Fairy Leaves.'));
        if(npc.fetchSelfId()===7747 && c===3) return page('Your hatchling has drunk from all four trees. Its name and progress will be preserved. Hatchling equipment will be unequipped and kept in its inventory.<br>'+link('evolve','Evolve this hatchling into a strider.'));
        if(c===2) return page(`Let your hatchling attack the Fairy Trees of Wind, Star, Twilight and Abyss in Hunters Valley until each accepts a leaf. Do not kill them.<br>Completed: ${trees.map((_,i)=>state.getInt('trees')&(1<<i)?['Wind','Star','Twilight','Abyss'][i]:'—').join(', ')}.`);
        return page('Visit Fairy Mymyu in the Enchanted Valley with your hatchling.');
    },
    async onEvent(state,event) {
        const pet=hatchling(state); if(!pet) return this.onTalk(state,{fetchSelfId:()=>this.eventNpc(event)});
        const c=state.getInt('cond');
        if(event==='start' && !state.isStarted()) await step(state,{cond:1,controlId:pet.fetchPetControlItemObjectId(),trees:0});
        else if(event==='leaves' && (c===1 || (c===2 && count(state,4325)===0))) await step(state,{...state.variables,cond:2,trees:0},[],[[4325,4]]);
        else if(event==='evolve' && c===3 && state.getInt('trees')===15) { await evolve(state); return page('Your strider is ready. Use its Dragon Bugle to summon it.'); }
        else return null;
        return this.onTalk(state,{fetchSelfId:()=>this.eventNpc(event)});
    },
    async onAttack(state,npc,source,damage) {
        if(state.getInt('cond')!==2 || source!==hatchling(state,false) || damage<=0 || npc.state.fetchDead() || count(state,4325)<1) return;
        const index=trees.indexOf(npc.fetchSelfId()); if(index<0) return;
        const bits=state.getInt('trees'); if((bits&(1<<index)) || Math.random()>=0.03) return;
        const next=bits|(1<<index);
        await step(state,{...state.variables,trees:next,cond:next===15?3:2},[[4325,1]]);
    }, hatchling, trees
};

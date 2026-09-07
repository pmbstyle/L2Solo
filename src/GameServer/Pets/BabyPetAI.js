const Skills = invoke('GameServer/Npc/NpcSkills');
const Control = invoke('GameServer/Npc/SummonControl');
function tick(pet, rng = Math.random) {
    const session = pet.ownerSession, owner = session?.actor;
    if (!owner?.fetchHp || owner.pet !== pet || pet.ownerTeleport || pet.evolving || owner.isDead() || pet.state.fetchDead() || pet.state.fetchCasts() || owner.fetchMounted?.() || owner.mounted) return false;
    const ratio = owner.fetchHp()/owner.fetchMaxHp();
    const id = ratio<0.2 && rng()<0.75 ? 4718 : ratio<0.8 && rng()<0.25 ? 4717 : 0;
    if (!id) return false;
    const skill = Skills.forNpc(pet).find(skill=>skill.fetchSelfId()===id);
    if(!skill || !pet.canUseSkill(skill) || pet.fetchMp()<skill.fetchConsumedMp() ||
        Math.hypot(pet.fetchLocX()-owner.fetchLocX(),pet.fetchLocY()-owner.fetchLocY())>600 || !pet.hasCombatLineOfSight(owner)) return false;
    const following=pet.followOwner;
    Control.stop(session,pet);
    pet.castSkill(session,owner,skill);
    if(following) {
        pet.timer.summonResume=setTimeout(()=>{
            if(session.actor===owner && owner.pet===pet && !pet.ownerTeleport && !pet.state.fetchDead()) Control.startFollowOwner(session,owner,pet);
        },Math.max(100,skill.fetchCalculatedHitTime())+100);
        pet.timer.summonResume.unref?.();
    }
    return true;
}
function start(pet) {
    if(![12780,12781,12782].includes(pet.fetchSelfId())) return;
    clearInterval(pet.timer.babyHeal);
    pet.timer.babyHeal=setInterval(()=>tick(pet),1000);
    pet.timer.babyHeal.unref?.();
}
module.exports={start,tick};

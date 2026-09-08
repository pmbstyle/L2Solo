const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Control = invoke('GameServer/Npc/SummonControl');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
function set(actor,value,id=0) {
    actor.setMounted?.(value); actor.mounted=value;
    actor.setMountNpcId?.(id); actor.mountNpcId=id;
}
function publish(session,actor) {
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToOthers?.(Response.charInfo(actor),actor);
}
function busy(actor,pet) {
    return actor.state?.fetchHits?.() || actor.state?.fetchCasts?.() || pet.state?.fetchHits?.() || pet.state?.fetchCasts?.();
}
function mount(session,actor) {
    const pet=actor.pet;
    if(!pet?.petData || pet.evolving || pet.ownerTeleport || ![12526,12527,12528].includes(pet.fetchSelfId()) || actor.isDead() || pet.state.fetchDead() ||
        busy(actor,pet) || actor.state?.fetchSeated?.() || actor.fishing || session.activeTrade || actor.fetchPrivateStoreType?.() ||
        !Restrictions.canMove(pet) || pet.fetchCurrentFeed()<pet.fetchMaxFeed()*0.55 ||
        Math.hypot(actor.fetchLocX()-pet.fetchLocX(),actor.fetchLocY()-pet.fetchLocY(),actor.fetchLocZ()-pet.fetchLocZ())>100) return false;
    Control.stop(session,pet);
    World.removeNpcFromGrid?.(pet);
    World.npc.spawns=World.npc.spawns.filter(n=>n!==pet);
    session.dataSendToMeAndOthers(Response.deleteOb(pet.fetchId()),pet);
    set(actor,true,pet.fetchSelfId());
    session.dataSendToMeAndOthers(Response.ride(actor,true),actor);
    publish(session,actor);
    return true;
}
function dismount(session,actor,force=false) {
    const pet=actor.pet;
    if(!pet || (!force && (busy(actor,pet) || pet.fetchCurrentFeed()<pet.fetchMaxFeed()*0.55))) return false;
    session.dataSendToMeAndOthers(Response.ride(actor,false),actor);
    set(actor,false);
    Control.unsummon(session,actor,pet);
    publish(session,actor);
    return true;
}
function stats(actor) {
    const pet=actor.pet;
    if(!(actor.fetchMounted?.() || actor.mounted) || !pet?.petData) return null;
    const gap=pet.fetchLevel()-actor.fetchLevel();
    // C2 official notes: penalty starts beyond five levels; speed at ten.
    return { pAtk: pet.fetchPAtk()*(gap>5?Math.max(0.05,0.5-(gap-6)*0.05):1),
        run: pet.fetchCollectiveRunSpd()*(gap>=10?0.5:1),
        walk: pet.fetchCollectiveWalkSpd()*(gap>=10?0.5:1) };
}
module.exports={mount,dismount,stats,set};

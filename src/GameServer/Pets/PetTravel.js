const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Control = invoke('GameServer/Npc/SummonControl');
function begin(session, actor) {
    return [...new Set([actor.pet, actor.summon].filter(Boolean))].map(pet => {
        const following = pet.ownerTeleport ? pet.teleportFollow : pet.followOwner === true;
        pet.teleportFollow = following;
        pet.ownerTeleport = true;
        Control.stop(session, pet);
        World.removeNpcFromGrid?.(pet);
        World.npc.spawns = World.npc.spawns.filter(npc => npc !== pet);
        session.dataSendToMeAndOthers(Response.deleteOb(pet.fetchId()), pet);
        return { pet, following };
    });
}
function finish(session, actor, moved, coords) {
    for (const { pet, following } of moved) {
        pet.ownerTeleport = false;
        delete pet.teleportFollow;
        if (actor.pet !== pet && actor.summon !== pet) continue;
        World.removeNpcFromGrid?.(pet);
        pet.setLocXYZ(coords);
        if (actor.fetchMounted?.() || actor.mounted) continue;
        if (!World.npc.spawns.includes(pet)) World.npc.spawns.push(pet);
        World.addNpcToGrid?.(pet);
        session.dataSendToMeAndOthers(Response.npcInfo(pet), pet);
        if (pet.petData) invoke('GameServer/Pets/PetRuntime').publish(pet);
        if (following && !pet.state.fetchDead()) Control.startFollowOwner(session, actor, pet);
    }
}
module.exports = { begin, finish };

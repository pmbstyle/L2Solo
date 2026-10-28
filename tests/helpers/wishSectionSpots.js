'use strict';

// Standalone SpotProfiles.ensure sees only raid profiles until physical
// spawns exist. Populate its ordinary input from actual native definitions
// of the given monsters, then let the native index/profile builders make
// the test's catalogue.
// T43 spawns: the default is Ol Mahum Sergeant (210, level 29); the former 414 has no coordinate spawn.
module.exports = (npcIds = [210]) => {
    const Data = invoke('GameServer/DataCache');
    const World = invoke('GameServer/World/World');
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const Npc = invoke('GameServer/Model/Npc');
    const Catalogue = invoke('GameServer/Knowledge/GameDataCatalogue').native();
    const spawns = npcIds.flatMap(selfId => {
        const npc = Data.npcs.find(row => row.selfId === selfId);
        if (!npc) throw new Error(`native npc fixture ${selfId} does not exist`);
        const model = { model: { ...npc.template, selfId: npc.selfId } };
        return Catalogue.spawnsForNpc(selfId).flatMap(({ definition }) => (definition.coords || []).map(loc => ({
            ...npc, fetchAttackable: () => Npc.prototype.fetchAttackable.call(model),
            fetchSelfId: () => npc.selfId, fetchName: () => npc.template.name, fetchLevel: () => npc.template.level,
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ
        })));
    });
    const original = World.npc;
    try {
        World.npc = { ...original, spawns };
        Service.reset(); Profiles.reset();
        const rows = Profiles.ensure();
        for (const selfId of npcIds) if (!rows.some(row => row.npcEntries?.some(entry => entry.selfId === selfId)))
            throw new Error(`native ordinary spawn fixture ${selfId} was not indexed`);
        return rows;
    } finally { World.npc = original; }
};

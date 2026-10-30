'use strict';

// Standalone SpotProfiles.ensure sees only raid profiles until spawn
// definitions exist. Populate its ordinary input (World.npc.definitions)
// from actual native definitions of the given monsters, then let the native
// index/profile builders make the test's catalogue.
// T43 spawns: the default is Ol Mahum Sergeant (210, level 29); the former 414 has no coordinate spawn.
module.exports = (npcIds = [210]) => {
    const Data = invoke('GameServer/DataCache');
    const World = invoke('GameServer/World/World');
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const Catalogue = invoke('GameServer/Knowledge/GameDataCatalogue').native();
    // The catalogue reads spawn definitions (SpawnNpcs.catalogueSpawns): one
    // per explicit coordinate, as SpawnNpcs.spawnNpcs keeps them.
    const definitions = npcIds.flatMap(selfId => {
        const npc = Data.npcRow(selfId);
        if (!npc) throw new Error(`native npc fixture ${selfId} does not exist`);
        return Catalogue.spawnsForNpc(selfId).flatMap(({ group, definition }) => (definition.coords || [])
            .map(loc => ({ npc, spawn: { ...definition, coords: [loc] }, bounds: group.bounds || [] })));
    });
    const original = World.npc;
    try {
        World.npc = { ...original, spawns: [], definitions };
        Service.reset(); Profiles.reset();
        const rows = Profiles.ensure();
        for (const selfId of npcIds) if (!rows.some(row => row.npcEntries?.some(entry => entry.selfId === selfId)))
            throw new Error(`native ordinary spawn fixture ${selfId} was not indexed`);
        return rows;
    } finally { World.npc = original; }
};

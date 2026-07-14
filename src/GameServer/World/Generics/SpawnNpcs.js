const Npc       = invoke('GameServer/Npc/Npc');
const DataCache = invoke('GameServer/DataCache');

function createNpc(world, npc, coords, spawnDefinition = null) {
    const instance = new Npc(world.npc.nextId++, { ...utils.crushOb(npc), ...coords });
    instance.spawnDefinition = spawnDefinition;
    world.npc.spawns.push(instance);
    return instance;
}

function randomCoords(definition) {
    const { spawn, bounds } = definition;
    if (utils.size(spawn.coords) > 0) {
        const info = spawn.coords[Math.floor(Math.random() * spawn.coords.length)];
        return {
            locX: info.locX,
            locY: info.locY,
            locZ: info.locZ,
            head: definition.npc.template.kind === 'Monster' && info.head === 0 ? utils.randomNumber(65536) : info.head
        };
    }

    const polygon = bounds.map((bound) => [bound.locX, bound.locY]);
    const pos = require('random-point-in-shape')(polygon);
    return { locX: pos[0], locY: pos[1], locZ: bounds[0].maxZ, head: utils.randomNumber(65536) };
}

function spawnNpc(world, definition) {
    const coords = randomCoords(definition);
    const npc = createNpc(world, definition.npc, coords, definition);
    return npc;
}

function spawnNpcs() {
    DataCache.npcSpawns.forEach((item) => {
        const bounds = item.bounds;

        item.spawns.forEach((spawn) => {
            DataCache.fetchNpcFromSelfId(spawn.selfId, (npc) => {
                const definition = { npc, spawn: structuredClone(spawn), bounds: structuredClone(bounds) };

                for (let i = 0; i < spawn.total; i++) {
                    if (utils.size(spawn.coords) > 0) { // Explicit location
                        spawn.coords.forEach((info) => {
                            const fixedDefinition = {
                                ...definition,
                                spawn: { ...definition.spawn, coords: [structuredClone(info)] }
                            };
                            createNpc(this, npc, {
                                locX: info.locX, locY: info.locY, locZ: info.locZ,
                                head: npc.template.kind === 'Monster' && info.head === 0 ? utils.randomNumber(65536) : info.head,
                            }, fixedDefinition);
                        });
                    }
                    else { // Random location within bounds
                        spawnNpc(this, definition);
                    }
                }
            });
        });
    });

    utils.infoSuccess('Spawns', '%d Npcs & Monsters', utils.size(this.npc.spawns));
}

module.exports = spawnNpcs;
module.exports.spawnNpc = spawnNpc;
module.exports.shouldRespawn = function shouldRespawn(spawn) {
    return Number(spawn?.respawn) > 0;
};
module.exports.respawnDelayMs = function respawnDelayMs(spawn, random = Math.random) {
    const seconds = Math.max(0, Number(spawn?.respawn) || 0);
    const bias = Math.max(0, Number(spawn?.bias) || 0);
    return Math.round((seconds - bias + (random() * bias * 2)) * 1000);
};

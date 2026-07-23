const Npc       = invoke('GameServer/Npc/Npc');
const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');

const VISIBILITY_RADIUS = 6000;

function distanceSquared(first, second) {
    const dx = first.fetchLocX() - second.fetchLocX();
    const dy = first.fetchLocY() - second.fetchLocY();
    return (dx * dx) + (dy * dy);
}

function notifyNearby(world, npc, response = ServerResponse) {
    if (!world?.user?.sessions || !npc) return;
    const radiusSquared = VISIBILITY_RADIUS * VISIBILITY_RADIUS;
    const packet = response.npcInfo(npc);

    world.user.sessions.forEach((session) => {
        const actor = session?.actor;
        if (
            actor?.fetchIsOnline?.() === true &&
            typeof session.dataSendToMe === 'function' &&
            distanceSquared(actor, npc) <= radiusSquared
        ) {
            session.dataSendToMe(packet);
        }
    });
}

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
    // Respawns happen independently of player movement.  Announce the new
    // object immediately, otherwise it can aggro a nearby player before that
    // player next crosses UpdateEnvironment's movement refresh threshold.
    notifyNearby(world, npc);
    return npc;
}

function templateFor(selfId) {
    const id = Number(selfId);
    const template = DataCache.npcs?.find((npc) => Number(npc.selfId) === id);
    return template ? structuredClone(template) : null;
}

// Dynamic quest NPCs intentionally have no spawnDefinition: they never enter
// the ordinary respawn loop. Ownership is checked by QuestService on kill so
// one player's personal objective cannot advance another player's quest.
function spawnQuestNpc(world, {
    selfId,
    locX,
    locY,
    locZ,
    head = 0,
    ownerId = 0,
    questId = 0,
    despawnDelay = 0
} = {}) {
    if (!world?.npc?.spawns || !Number.isFinite(Number(world.npc.nextId))) return null;
    const template = templateFor(selfId);
    const coords = { locX: Number(locX), locY: Number(locY), locZ: Number(locZ), head: Number(head) || 0 };
    if (!template || !Object.values(coords).slice(0, 3).every(Number.isFinite)) return null;

    const npc = createNpc(world, template, coords);
    npc.questSpawn = {
        ownerId: Number(ownerId) || 0,
        questId: Number(questId) || 0,
        timer: undefined
    };
    if (Number(despawnDelay) > 0) {
        npc.questSpawn.timer = setTimeout(() => despawnQuestNpc(world, npc), Number(despawnDelay));
    }
    world.indexSpawnsInGrid?.();
    notifyNearby(world, npc);
    return npc;
}

function clearQuestSpawn(npc) {
    if (!npc?.questSpawn) return;
    clearTimeout(npc.questSpawn.timer);
    npc.questSpawn.timer = undefined;
}

function despawnQuestNpc(world, npc, sourceSession = null) {
    if (!world?.npc?.spawns || !npc) return false;
    const objectId = npc.fetchId?.();
    if (!world.npc.spawns.some((entry) => entry.fetchId?.() === objectId)) return false;

    clearQuestSpawn(npc);
    npc.destructor?.(sourceSession || { dataSendToMeAndOthers: () => {}, dataSendToMe: () => {} });
    NpcVisibility.deleteKnownNpc(world, sourceSession, objectId);
    world.npc.spawns = world.npc.spawns.filter((entry) => entry.fetchId?.() !== objectId);
    world.indexSpawnsInGrid?.();
    return true;
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
module.exports.spawnQuestNpc = spawnQuestNpc;
module.exports.despawnQuestNpc = despawnQuestNpc;
module.exports.clearQuestSpawn = clearQuestSpawn;
module.exports.notifyNearby = notifyNearby;
module.exports.shouldRespawn = function shouldRespawn(spawn) {
    return Number(spawn?.respawn) > 0;
};
module.exports.respawnDelayMs = function respawnDelayMs(spawn, random = Math.random) {
    const seconds = Math.max(0, Number(spawn?.respawn) || 0);
    const bias = Math.max(0, Number(spawn?.bias) || 0);
    return Math.round((seconds - bias + (random() * bias * 2)) * 1000);
};

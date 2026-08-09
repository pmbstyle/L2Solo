const GameTime = invoke('GameServer/World/GameTime');
const NpcDecay = invoke('GameServer/World/Generics/NpcDecay');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const ServerResponse = invoke('GameServer/Network/Response');

function normalizeMode(value) {
    return value === 'night' ? 'night' : 'day';
}

function noOpSession() {
    return {
        dataSendToMe: () => {},
        dataSendToMeAndOthers: () => {}
    };
}

function stopNpc(npc) {
    try {
        npc.destructor?.(noOpSession());
    }
    catch (error) {
        utils.infoWarn('DayNight', 'failed to stop NPC %d: %s', npc.fetchId?.() || 0, error.message);
    }
}

function broadcast(world, mode, response = ServerResponse) {
    const packet = mode === 'night' ? response.sunset() : response.sunrise();
    (world.user?.sessions || []).forEach((session) => {
        if (session?.actor?.fetchIsOnline?.() !== true || typeof session.dataSendToMe !== 'function') return;
        session.dataSendToMe(packet);
    });
}

function changeMode(world, nextMode, response = ServerResponse) {
    if (!world?.npc) return { changed: false, removed: 0, spawned: 0 };
    const mode = normalizeMode(nextMode);
    if (world.npc.periodMode === mode) return { changed: false, removed: 0, spawned: 0 };

    world.npc.periodMode = mode;
    world.npc.periodRevision = Number(world.npc.periodRevision || 0) + 1;

    const inactive = (world.npc.spawns || []).filter((npc) => {
        const spawn = npc?.spawnDefinition?.spawn;
        return SpawnNpcs.isPeriodic(spawn) && !SpawnNpcs.isPeriodActive(spawn, mode);
    });
    inactive.forEach(stopNpc);
    const removed = NpcDecay.decayMany(world, inactive);

    let spawned = 0;
    (world.npc.periodDefinitions || []).forEach((definition) => {
        if (!SpawnNpcs.isPeriodActive(definition.spawn, mode)) return;
        if ((world.npc.spawns || []).some((npc) => npc.spawnDefinition === definition)) return;
        if (SpawnNpcs.spawnNpc(world, definition)) spawned += 1;
    });

    if (spawned > 0) world.indexSpawnsInGrid?.();
    broadcast(world, mode, response);
    utils.infoSuccess('DayNight', '%s mode: removed %d, spawned %d periodic NPCs', mode, removed, spawned);
    return { changed: true, removed, spawned };
}

function schedule(world, now = Date.now()) {
    if (!world?.npc) return null;
    clearTimeout(world.npc.dayNightTimer);
    world.npc.dayNightTimer = setTimeout(() => {
        changeMode(world, GameTime.mode());
        schedule(world);
    }, GameTime.msUntilTransition(now));
    world.npc.dayNightTimer.unref?.();
    return world.npc.dayNightTimer;
}

function start(world, now = Date.now()) {
    if (!world?.npc) return null;
    const current = GameTime.mode(now);
    if (!world.npc.periodMode) world.npc.periodMode = current;
    else if (world.npc.periodMode !== current) changeMode(world, current);
    return schedule(world, now);
}

function stop(world) {
    if (!world?.npc?.dayNightTimer) return;
    clearTimeout(world.npc.dayNightTimer);
    world.npc.dayNightTimer = undefined;
}

module.exports = { changeMode, start, stop, broadcast };

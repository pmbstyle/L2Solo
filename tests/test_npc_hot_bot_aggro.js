const assert = require('assert');

require('../src/Global');

const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function actorAt(id, x, y = 0, z = 0) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => z,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { fetchDead: () => false }
    };
}

function hostileNpcAt(x, y = 0, z = 0) {
    const npc = {
        combats: 0,
        fetchHostile: () => true,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => z,
        state: {
            fetchDead: () => false,
            fetchCombats: () => false
        },
        enterCombatState(session, actor) {
            this.combats++;
            this.targetSession = session;
            this.target = actor;
        }
    };
    return npc;
}

const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
GeodataEngine.hasLineOfSight = () => true;

const bot = actorAt(2000001, 100);
const hotSession = { constructor: { name: 'BotSession' }, accountId: 'bot_hot_aggro', actor: bot };
const npc = hostileNpcAt(0);
const world = {
    npc: {
        spawns: [npc],
        grid: { '0_0': [npc] }
    },
    user: { sessions: [hotSession] },
    fetchNpcsInRadius() { return this.npc.spawns; }
};

const spawnedAt = 5000;
assert.strictEqual(NpcAggro.armSpawnGrace(npc, spawnedAt), spawnedAt + 10000, 'spawn grace must match the source 10-second global-aggro delay');
assert.deepStrictEqual(
    NpcAggro.engageNearby(hotSession, bot, { world, now: spawnedAt + 9999 }),
    [],
    'a hot bot entering range during spawn grace must not be auto-aggroed'
);
assert.strictEqual(npc.combats, 0, 'spawn grace must suppress combat before the delay ends');

NpcAggro.engageNearby(hotSession, bot, { world, now: spawnedAt + 10000 });
assert.strictEqual(npc.combats, 1, 'a moving hot bot must trigger native hostile aggro after spawn grace');
assert.strictEqual(npc.target, bot, 'the hostile NPC must target the hot bot that entered its aggro radius');

const respawnedNpc = hostileNpcAt(0);
world.npc.spawns = [respawnedNpc];
world.npc.grid = { '0_0': [respawnedNpc] };
NpcAggro.armSpawnGrace(respawnedNpc, 9000);
NpcAggro.tickLiveActors(world, 18999);
assert.strictEqual(respawnedNpc.combats, 0, 'a respawn must not immediately aggro a stationary hot bot');
NpcAggro.tickLiveActors(world, 19000);
assert.strictEqual(respawnedNpc.combats, 1, 'a respawned hostile NPC must aggro a stationary nearby hot bot after spawn grace');
assert.strictEqual(respawnedNpc.targetSession, hotSession, 'respawn aggro must use the hot bot session for native combat delivery');

const startupNpc = hostileNpcAt(0);
world.npc.spawns = [startupNpc];
world.npc.grid = { '0_0': [startupNpc] };
NpcAggro.armSpawnGrace(startupNpc, 12000);
NpcAggro.tickLiveActors(world, 22000);
assert.strictEqual(startupNpc.combats, 1, 'the shared ticker must aggro a stationary hot bot after the initial-spawn grace period too');

const playerNpc = hostileNpcAt(0);
const player = actorAt(10001, 100);
world.npc.spawns = [playerNpc];
world.user.sessions = [{ accountId: 'player_stationary', actor: player }];
NpcAggro.armSpawnGrace(playerNpc, 20000);
NpcAggro.tickLiveActors(world, 30000);
assert.strictEqual(playerNpc.target, player, 'the shared ticker must also aggro a stationary player after initial-spawn grace');

const shadowedActor = actorAt(10004, 100);
EffectStore.apply(shadowedActor, {
    key: 'dance_of_shadow', id: 366, name: 'Dance of Shadow', durationMs: 120000,
    stats: { runSpdMul: 0.5, silentMoving: true }
});
assert.strictEqual(
    NpcAggro.canEngage(hostileNpcAt(0), shadowedActor),
    false,
    'Dance of Shadow SilentMove must suppress ordinary hostile NPC auto-aggro'
);
const raidNpc = hostileNpcAt(0);
raidNpc.fetchIsRaidBoss = () => true;
assert.strictEqual(
    NpcAggro.canEngage(raidNpc, shadowedActor),
    true,
    'SilentMove must not suppress raid-boss aggro'
);

const crumaFirstFloorNpc = hostileNpcAt(23741, 117274, -12089);
const crumaSecondFloorActor = actorAt(10002, 23765, 117288, -9047);
assert.deepStrictEqual(
    NpcAggro.engageNearby({ actor: crumaSecondFloorActor }, crumaSecondFloorActor, {
        npcs: [crumaFirstFloorNpc],
        now: Date.now()
    }),
    [],
    'a hostile NPC must not auto-aggro a target on another Cruma floor even when their XY positions overlap'
);

const hiddenNpc = hostileNpcAt(0, 0, 0);
const hiddenActor = actorAt(10003, 100, 0, 0);
GeodataEngine.hasLineOfSight = () => false;
assert.strictEqual(
    NpcAggro.canEngage(hiddenNpc, hiddenActor),
    false,
    'a hostile NPC must not auto-aggro a target hidden behind geodata'
);

GeodataEngine.hasLineOfSight = originalHasLineOfSight;

console.log('NPC hot-bot aggro regression checks passed');

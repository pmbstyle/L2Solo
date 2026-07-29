const assert = require('assert');

require('../src/Global');

const NpcAggro = invoke('GameServer/Npc/NpcAggro');

function actorAt(id, x, y = 0) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { fetchDead: () => false }
    };
}

function hostileNpcAt(x, y = 0) {
    const npc = {
        combats: 0,
        fetchHostile: () => true,
        fetchLocX: () => x,
        fetchLocY: () => y,
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

console.log('NPC hot-bot aggro regression checks passed');

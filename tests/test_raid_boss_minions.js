const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const MinionManager = invoke('GameServer/World/RaidBossMinionManager');

DataCache.init();

const world = {
    user: { sessions: [] },
    npc: { spawns: [], nextId: 3000000 },
    indexSpawnsInGrid() {}
};
const bossTemplate = DataCache.npcs.find((npc) => npc.selfId === 10001);
const boss = new Npc(world.npc.nextId++, {
    ...utils.crushOb(bossTemplate),
    locX: 1000,
    locY: 1000,
    locZ: 0,
    head: 0
});
world.npc.spawns.push(boss);

const state = MinionManager.attachBoss(world, boss);
assert(state && state.groups.length > 0, 'boss with a sourced minion group must attach a manager state');
const initialMinions = state.groups.flatMap((group) => group.members);
assert(initialMinions.length > 0);
assert(initialMinions.every((minion) => minion.minionBossObjectId === boss.fetchId()));

const attacker = {
    fetchId: () => 4000001,
    fetchLocX: () => 1000,
    fetchLocY: () => 1000,
    fetchLocZ: () => 0,
    isDead: () => false,
    state: { fetchDead: () => false }
};
const combatSession = { dataSendToMeAndOthers() {}, dataSendToMe() {} };
const alerted = MinionManager.onBossAttacked(world, boss, attacker, combatSession);
assert(alerted > 0, 'a raid boss hit must call its live minions into combat');
assert(initialMinions.every((minion) => minion.fetchDestId() === attacker.fetchId()),
    'called minions must target the attacker');

const dead = initialMinions[0];
dead.state.setDead(true);
MinionManager.onMinionDeath(world, dead);
MinionManager.maintain(world, Date.now() + MinionManager.MINION_RESPAWN_DELAY_MS + 1);
const aliveAfterReplacement = state.groups.flatMap((group) => group.members)
    .filter((minion) => minion.state.fetchDead() !== true);
assert(aliveAfterReplacement.length >= initialMinions.length,
    'the manager must restore a dead minion after the native maintenance delay');

const removed = MinionManager.onBossDeath(world, boss, { dataSendToMeAndOthers() {}, dataSendToMe() {} });
assert(removed > 0);
assert.strictEqual(boss.minionState, null);
assert.strictEqual(world.npc.spawns.some((npc) => npc.minionBossObjectId === boss.fetchId()), false);
console.log('Raid boss minions ok');

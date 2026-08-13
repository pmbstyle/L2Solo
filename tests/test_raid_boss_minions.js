const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const MinionManager = invoke('GameServer/World/RaidBossMinionManager');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const ReceivedHit = invoke('GameServer/Npc/Generics/ReceivedHit');
const RuntimeWorld = invoke('GameServer/World/World');
const ActorGenerics = invoke(path.actor);

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
assert.strictEqual(
    RaidEntityIndex.entitiesForRaid(world, { bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId() }).length,
    initialMinions.length + 1,
    'spawned raid minions must be indexed under their authoritative boss'
);

const attacker = {
    fetchId: () => 4000001,
    fetchName: () => 'RaidTester',
    fetchLevel: () => 1,
    fetchExp: () => 0,
    fetchSp: () => 0,
    setExpSp() {},
    fetchKarma: () => 0,
    setKarma() {},
    fetchPvp: () => 0,
    fetchPk: () => 0,
    fetchIsOnline: () => true,
    fetchLocX: () => 1000,
    fetchLocY: () => 1000,
    fetchLocZ: () => 0,
    effects: {},
    isDead: () => false,
    state: { fetchDead: () => false, setCombats() {} },
    automation: { abortAll() {} }
};
const combatSession = { dataSendToMeAndOthers() {}, dataSendToMe() {} };
const telemetryBefore = MinionManager.stats();
const alerted = MinionManager.onBossAttacked(world, boss, attacker, combatSession);
assert(alerted > 0, 'a raid boss hit must call its live minions into combat');
const telemetryAfter = MinionManager.stats();
assert.strictEqual(telemetryAfter.engagements, telemetryBefore.engagements + 1,
    'the first raid hit must record one engagement');
assert.strictEqual(telemetryAfter.minionsAlerted, telemetryBefore.minionsAlerted + alerted,
    'raid telemetry must expose the number of socially alerted minions');
MinionManager.onBossAttacked(world, boss, attacker, combatSession);
assert.strictEqual(MinionManager.stats().engagements, telemetryAfter.engagements,
    'repeated hits in the same encounter must not spam engagement telemetry');
assert(initialMinions.every((minion) => minion.fetchDestId() === attacker.fetchId()),
    'called minions must target the attacker');

// Reset the first encounter, then exercise the actual NPC damage path. A hit
// on one minion must pull its idle leader and the rest of the live group.
boss.abortCombatState(combatSession);
initialMinions.forEach((minion) => minion.abortCombatState(combatSession));
combatSession.actor = attacker;
const originalWorldNpc = RuntimeWorld.npc;
const originalWorldUser = RuntimeWorld.user;
RuntimeWorld.npc = world.npc;
RuntimeWorld.user = world.user;
try {
    ReceivedHit(combatSession, attacker, initialMinions[0], 1);
} finally {
    RuntimeWorld.npc = originalWorldNpc;
    RuntimeWorld.user = originalWorldUser;
}
assert.strictEqual(boss.state.fetchCombats(), true,
    'a minion hit must bring its idle raid boss into combat');
assert.strictEqual(boss.fetchDestId(), attacker.fetchId(),
    'the raid boss must target the minion attacker');
assert(initialMinions.every((minion) => minion.fetchDestId() === attacker.fetchId()),
    'a minion hit must call the rest of the live group to assist');

const dead = initialMinions[0];
dead.state.setDead(true);
MinionManager.onMinionDeath(world, dead);
MinionManager.maintain(world, Date.now() + MinionManager.MINION_RESPAWN_DELAY_MS + 1);
const aliveAfterReplacement = state.groups.flatMap((group) => group.members)
    .filter((minion) => minion.state.fetchDead() !== true);
assert(aliveAfterReplacement.length >= initialMinions.length,
    'the manager must restore a dead minion after the native maintenance delay');

const removed = MinionManager.onBossDeath(world, boss, { dataSendToMeAndOthers() {}, dataSendToMe() {} });
boss.abortCombatState(combatSession);
assert(removed > 0);
assert.strictEqual(boss.minionState, null);
assert.strictEqual(world.npc.spawns.some((npc) => npc.minionBossObjectId === boss.fetchId()), false);
assert.deepStrictEqual(
    RaidEntityIndex.entitiesForRaid(world, { bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId() }),
    [boss],
    'boss-death cleanup must invalidate every removed minion membership'
);

// A lethal hit must notify the group before the minion is removed by die().
const lethalBoss = new Npc(world.npc.nextId++, {
    ...utils.crushOb(bossTemplate),
    locX: 2000,
    locY: 2000,
    locZ: 0,
    head: 0
});
world.npc.spawns.push(lethalBoss);
const lethalState = MinionManager.attachBoss(world, lethalBoss);
const lethalMinions = lethalState.groups.flatMap((group) => group.members);
assert(lethalMinions.length > 1, 'the lethal-hit regression needs a surviving minion to assist');
lethalMinions[0].setHp(1);

const lethalOriginalWorldNpc = RuntimeWorld.npc;
const lethalOriginalWorldUser = RuntimeWorld.user;
const originalNpcDied = ActorGenerics.npcDied;
let dieCallbackReached = false;
RuntimeWorld.npc = world.npc;
RuntimeWorld.user = world.user;
ActorGenerics.npcDied = () => {
    dieCallbackReached = true;
};
try {
    ReceivedHit(combatSession, attacker, lethalMinions[0], 1);
} finally {
    RuntimeWorld.npc = lethalOriginalWorldNpc;
    RuntimeWorld.user = lethalOriginalWorldUser;
    ActorGenerics.npcDied = originalNpcDied;
}
assert.strictEqual(dieCallbackReached, true, 'the lethal hit must still complete the native death path');
assert.strictEqual(lethalMinions[0].state.fetchDead(), true, 'the lethal minion must be marked dead');
assert.strictEqual(lethalBoss.state.fetchCombats(), true,
    'a lethal minion hit must still bring its raid boss into combat');
assert.strictEqual(lethalBoss.fetchDestId(), attacker.fetchId(),
    'the raid boss must target the attacker after a lethal minion hit');
assert(lethalMinions.slice(1).every((minion) => minion.fetchDestId() === attacker.fetchId()),
    'surviving minions must assist after a lethal minion hit');
MinionManager.onBossDeath(world, lethalBoss, combatSession);
lethalBoss.abortCombatState(combatSession);
console.log('Raid boss minions ok');

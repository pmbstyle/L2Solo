const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const MinionManager = invoke('GameServer/World/RaidBossMinionManager');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const DayNightSpawnManager = invoke('GameServer/World/DayNightSpawnManager');
const ReceivedHit = invoke('GameServer/Npc/Generics/ReceivedHit');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const RuntimeWorld = invoke('GameServer/World/World');
const ActorGenerics = invoke(path.actor);

DataCache.init();

const world = {
    user: { sessions: [] },
    npc: { spawns: [], grid: {}, nextId: 3000000, periodMode: 'night', periodRevision: 0, periodDefinitions: [] },
    indexSpawnsInGrid() {}
};
const session = { dataSendToMeAndOthers() {}, dataSendToMe() {} };

function definitionFor(leaderId, period = undefined) {
    const spawn = DataCache.npcSpawns.flatMap((area) => area.spawns)
        .find((entry) => Number(entry.selfId) === leaderId && entry.coords?.length);
    assert.ok(spawn, `group leader ${leaderId} has a spawn`);
    const npc = DataCache.npcs.find((entry) => entry.selfId === leaderId);
    return { npc, spawn: { ...structuredClone(spawn), coords: [spawn.coords[0]], period }, bounds: [] };
}

function members(leader) {
    return leader.minionState.groups.flatMap((group) => group.members);
}

function inWorld(npc) {
    return world.npc.spawns.includes(npc);
}

function withRuntimeWorld(callback) {
    const originalNpc = RuntimeWorld.npc;
    const originalUser = RuntimeWorld.user;
    RuntimeWorld.npc = world.npc;
    RuntimeWorld.user = world.user;
    try {
        return callback();
    } finally {
        RuntimeWorld.npc = originalNpc;
        RuntimeWorld.user = originalUser;
    }
}

const attacker = {
    fetchId: () => 4000001,
    fetchName: () => 'LeaderTester',
    fetchLevel: () => 80,
    fetchExp: () => 0,
    fetchSp: () => 0,
    setExpSp() {},
    fetchKarma: () => 0,
    setKarma() {},
    fetchPvp: () => 0,
    fetchPk: () => 0,
    fetchIsOnline: () => true,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    effects: {},
    isDead: () => false,
    state: { fetchDead: () => false, setCombats() {} },
    automation: { abortAll() {} }
};
session.actor = attacker;

// Varka's Commander leads two Varka's Elite Guards (Lisvus 1369 -> 1370, 2-2).
const definition = definitionFor(1369);
const leader = SpawnNpcs.spawnNpc(world, definition);
const guards = members(leader);
assert.strictEqual(guards.length, 2, 'the leader spawns with its Lisvus group');
assert.ok(guards.every((guard) => guard.fetchSelfId() === 1370 && guard.minionLeader === leader && inWorld(guard)));
assert.ok(guards.every((guard) => !guard.minionBossObjectId && !guard.minionBossTemplateId),
    'ordinary minions carry no raid boss ids');
assert.ok(guards.every((guard) => !BotRaidSafety.isProtectedRaidEntity(guard)
    && RaidEntityIndex.bossFor(world, guard) === null), 'ordinary minions are not raid entities');
assert.deepStrictEqual(RaidEntityIndex.bosses(world), [], 'an ordinary leader is not a raid boss');
assert.deepStrictEqual(MinionManager.leaderGroup(world, leader), [leader, ...guards],
    'a minion clan skill reaches the leader and its minions');

// A hit on the leader calls its minions; raid telemetry stays raid-only.
const telemetry = MinionManager.stats();
withRuntimeWorld(() => ReceivedHit(session, attacker, leader, 1));
assert.ok(guards.every((guard) => guard.fetchDestId() === attacker.fetchId()), 'minions assist their leader');
assert.deepStrictEqual(MinionManager.stats(), telemetry);

// A hit on a minion brings its idle leader and the other minions.
leader.abortCombatState(session);
guards.forEach((guard) => guard.abortCombatState(session));
withRuntimeWorld(() => ReceivedHit(session, attacker, guards[0], 1));
assert.strictEqual(leader.state.fetchCombats(), true, 'the leader answers a minion hit');
assert.strictEqual(leader.fetchDestId(), attacker.fetchId());
assert.strictEqual(guards[1].fetchDestId(), attacker.fetchId());

// Lisvus replaces raid minions only: a killed guard stays dead while its leader lives.
const originalNpcDied = ActorGenerics.npcDied;
ActorGenerics.npcDied = () => {};
try {
    withRuntimeWorld(() => ReceivedHit(session, attacker, guards[0], guards[0].fetchHp()));
    assert.strictEqual(guards[0].state.fetchDead(), true);
    assert.strictEqual(MinionManager.maintain(world, Date.now() + MinionManager.MINION_RESPAWN_DELAY_MS + 1), 0);
    assert.strictEqual(members(leader).filter((guard) => guard.state.fetchDead() !== true).length, 1,
        'no replacement minion while the leader lives');

    // The leader's death leaves the surviving guard in the world.
    withRuntimeWorld(() => ReceivedHit(session, attacker, leader, leader.fetchHp()));
} finally {
    ActorGenerics.npcDied = originalNpcDied;
}
assert.strictEqual(leader.state.fetchDead(), true);
assert.ok(inWorld(guards[1]) && guards[1].state.fetchDead() !== true, 'minions outlive their leader');

// The spawn brings the leader back: the old group gives way to a full new one.
const respawned = SpawnNpcs.spawnNpc(world, definition);
const newGuards = members(respawned);
assert.strictEqual(newGuards.length, 2);
assert.ok(newGuards.every((guard) => guard.minionLeader === respawned && inWorld(guard)));
assert.strictEqual(inWorld(guards[1]), false, 'the surviving minion of the old leader is removed');
assert.strictEqual(world.npc.spawns.filter((npc) => npc.minionLeader === leader).length, 0);

// A night leader's minions leave with it at sunrise.
const nightDefinition = definitionFor(1596, 'night');
const lord = SpawnNpcs.spawnNpc(world, nightDefinition);
const behemoths = members(lord);
assert.deepStrictEqual(behemoths.map((npc) => npc.fetchSelfId()).sort(), [1597, 1598]);
const response = { sunrise: () => ({}), sunset: () => ({}) };
const change = DayNightSpawnManager.changeMode(world, 'day', response);
assert.strictEqual(change.removed, 3, 'the night leader and its two minions leave');
assert.ok(!inWorld(lord) && behemoths.every((npc) => !inWorld(npc)));
assert.ok(newGuards.every(inWorld), 'other groups stay');

// The hunting spot catalogue (cold bots' view) counts minions as spot monsters.
withRuntimeWorld(() => {
    SpotService.reset();
    const spot = SpotService.ensureIndexed().find((entry) => entry.npcEntries.some((row) => row.selfId === 1369));
    assert.ok(spot, 'the leader is in a spot');
    assert.strictEqual(spot.npcEntries.find((row) => row.selfId === 1370)?.count, 2, 'its minions are counted');
    SpotService.reset();
});

newGuards.forEach((guard) => guard.abortCombatState(session));
respawned.abortCombatState(session);
console.log('Group leader minions ok');

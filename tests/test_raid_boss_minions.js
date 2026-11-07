process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const MinionManager = invoke('GameServer/World/RaidBossMinionManager');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const ReceivedHit = invoke('GameServer/Npc/Generics/ReceivedHit');
const RuntimeWorld = invoke('GameServer/World/World');
const ActorGenerics = invoke(path.actor);
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Skill = invoke('GameServer/Model/Skill');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

DataCache.init();

const world = {
    user: { sessions: [] },
    npc: { spawns: [], nextId: 3000000 },
    addNpcToGrid() {},
    removeNpcFromGrid() {}
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

// Hostile casts are attacks on the group even without HP damage or a landed
// effect. Exercise both the leader and a minion with the real C4 NPCs.
RuntimeWorld.npc = world.npc;
RuntimeWorld.user = world.user;
try {
    for (const target of [boss, initialMinions[0]]) {
        for (const [id, name] of [[122, 'Hex'], [115, 'Power Break']]) {
            for (const resisted of [false, true]) {
                boss.abortCombatState(combatSession);
                initialMinions.forEach((minion) => minion.abortCombatState(combatSession));
                const skill = new Skill({ selfId: id, name, level: 1, spell: true });
                const hpBefore = target.fetchHp();
                try {
                    const result = SkillEffects.execute(combatSession, attacker, target, skill,
                        { rng: () => resisted ? 1 : 0, magicSkill: true, attack: { clearLoadedShot() {} } });
                    assert.strictEqual(result.effectResisted, resisted);
                    assert.strictEqual(target.fetchHp(), hpBefore, 'a hostile debuff must call assistance without inventing damage');
                    assert.strictEqual(boss.state.fetchCombats(), true, `${name} must engage the leader even on resist`);
                    assert.strictEqual(boss.fetchCombatTarget(), attacker);
                    assert(initialMinions.every((minion) => minion.state.fetchCombats()
                        && minion.fetchCombatTarget() === attacker), `${name} must call all idle minions even on resist`);
                } finally {
                    EffectTicker.clearAll(target);
                    EffectStore.remove(target, skill.fetchSemantic().effect);
                }
            }
        }
    }
} finally {
    RuntimeWorld.npc = originalWorldNpc;
    RuntimeWorld.user = originalWorldUser;
}

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

// A minion that leaves the world without dying (despawn, corpse removal) must
// reach the refill queue through the index removal, with no death announced,
// and the tick must visit only the groups in that queue.
const gridWorld = {
    user: { sessions: [] },
    npc: { spawns: [], nextId: 5000000 },
    addNpcToGrid(npc) { return RaidEntityIndex.add(this, npc); },
    removeNpcFromGrid(npc) { return RaidEntityIndex.remove(this, npc); }
};
function gridBoss(locX) {
    const raid = new Npc(gridWorld.npc.nextId++, { ...utils.crushOb(bossTemplate), locX, locY: locX, locZ: 0, head: 0 });
    gridWorld.npc.spawns.push(raid);
    gridWorld.addNpcToGrid(raid);
    return { raid, state: MinionManager.attachBoss(gridWorld, raid) };
}
function removeWithoutDeath(minion) {
    gridWorld.removeNpcFromGrid(minion);
    gridWorld.npc.spawns.splice(gridWorld.npc.spawns.indexOf(minion), 1);
}
const shortBoss = gridBoss(3000);
const idleBoss = gridBoss(4000);
const shortGroup = shortBoss.state.groups[0];
const desired = shortGroup.desired;
assert.strictEqual(shortGroup.members.length, desired, 'the group starts full');
const idleGroupCount = idleBoss.state.groups.length;
assert(shortBoss.state.groups.length + idleGroupCount > 1, 'the visit count check needs more groups than the one made short');

const feedsBefore = MinionManager.stats().removalFeeds;
removeWithoutDeath(shortGroup.members[0]);
assert.strictEqual(MinionManager.stats().removalFeeds, feedsBefore + 1,
    'a removal without a death must mark its group short through the index');

const visitsBefore = MinionManager.stats().groupVisits;
assert.strictEqual(MinionManager.maintain(gridWorld, Date.now()), 0, 'the respawn delay has not passed');
assert.strictEqual(MinionManager.stats().groupVisits, visitsBefore + 1,
    'the tick must visit only the group a removal made short, not every group of every boss');

const refillsBefore = MinionManager.stats().refills;
const refilled = MinionManager.maintain(gridWorld, Date.now() + MinionManager.MINION_RESPAWN_DELAY_MS + 1);
assert.strictEqual(refilled, 1, 'the group refills one minion after the respawn delay');
assert.strictEqual(shortGroup.members.length, desired, 'the refilled group is full again');
assert.strictEqual(MinionManager.stats().refills, refillsBefore + 1);
const visitsAfterRefill = MinionManager.stats().groupVisits;
assert.strictEqual(MinionManager.maintain(gridWorld, Date.now() + MinionManager.MINION_RESPAWN_DELAY_MS + 2), 0);
assert.strictEqual(MinionManager.stats().groupVisits, visitsAfterRefill,
    'a refilled group leaves the queue: the next tick visits nothing');

// The refill alarm: one timer on the nearest respawnAt, none while no group is short.
{
    const realSetTimeout = global.setTimeout, realNow = Date.now;
    const armed = [];
    global.setTimeout = (callback, delay) => { armed.push({ callback, delay }); return { unref() {} }; };
    try {
        MinionManager.start(gridWorld);
        assert.strictEqual(armed.length, 0, 'no short group: no alarm');
        removeWithoutDeath(shortGroup.members[0]);
        assert.strictEqual(armed.length, 1, 'a short group arms the alarm');
        assert(armed[0].delay > MinionManager.MINION_RESPAWN_DELAY_MS - 1000 && armed[0].delay <= MinionManager.MINION_RESPAWN_DELAY_MS,
            'the alarm sleeps until the group respawnAt');
        removeWithoutDeath(shortGroup.members[0]);
        assert.strictEqual(armed.length, 1, 'a later loss of the same group keeps the armed alarm');
        const fireAt = realNow() + MinionManager.MINION_RESPAWN_DELAY_MS + 1;
        Date.now = () => fireAt;
        armed[0].callback();
        assert.strictEqual(shortGroup.members.length, desired, 'the alarm refills the group');
        assert.strictEqual(armed.length, 1, 'a refilled queue arms nothing');
    } finally {
        Date.now = realNow;
        global.setTimeout = realSetTimeout;
        MinionManager.stop(gridWorld);
    }
}

// A boss death detaches its state first: its minion removals must not queue the groups.
const feedsBeforeBossDeath = MinionManager.stats().removalFeeds;
MinionManager.onBossDeath(gridWorld, idleBoss.raid, combatSession);
assert.strictEqual(MinionManager.stats().removalFeeds, feedsBeforeBossDeath,
    'removing the minions of a dead boss must not mark their groups short');
MinionManager.onBossDeath(gridWorld, shortBoss.raid, combatSession);

console.log('Raid boss minions ok');

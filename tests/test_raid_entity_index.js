const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');

function actor(id, options = {}) {
    let targetId = options.targetId;
    return {
        selfId: options.selfId,
        minionBossObjectId: options.minionBossObjectId,
        minionBossTemplateId: options.minionBossTemplateId,
        fetchId: () => id,
        fetchSelfId: () => options.selfId,
        fetchLocX: () => options.locX || 0,
        fetchLocY: () => options.locY || 0,
        fetchLocZ: () => options.locZ || 0,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchPDef: () => options.pDef || 10,
        fetchClassId: () => options.classId || 0,
        fetchIsOnline: () => true,
        fetchIsRaidBoss: () => options.raidBoss === true,
        fetchAttackable: () => options.attackable !== false,
        fetchDestId: () => targetId,
        setTargetId: (value) => { targetId = value; },
        isDead: () => false,
        state: {
            fetchDead: () => false,
            fetchCombats: () => options.combats === true
        },
        backpack: { fetchEquippedArmors: () => [] }
    };
}

function companionSession(id, leaderSession) {
    return {
        actor: actor(id),
        partyCompanion: true,
        followPlayerSession: leaderSession
    };
}

const leader = actor(5000);
const leaderSession = { actor: leader };
const companions = Array.from({ length: 8 }, (_, index) => companionSession(5100 + index, leaderSession));
const boss = actor(6000, { selfId: 10001, raidBoss: true });
const minions = [6001, 6002, 6003].map((id, index) => actor(id, {
    selfId: 10002 + index,
    minionBossObjectId: boss.fetchId(),
    minionBossTemplateId: boss.fetchSelfId()
}));
const ordinary = Array.from({ length: 2500 }, (_, index) => actor(10000 + index, { selfId: 20000 + index }));

leader.setTargetId(boss.fetchId());
World.user = { sessions: [leaderSession, ...companions] };
World.npc = { spawns: [boss, ...minions, ...ordinary], grid: {}, gridKeys: new WeakMap() };
RaidEntityIndex.resetStatsForTests();
RaidEntityIndex.ensure(World);

const spawnScanMethods = Object.fromEntries(['find', 'filter', 'some'].map((method) => [method, World.npc.spawns[method]]));
try {
    Object.keys(spawnScanMethods).forEach((method) => {
        World.npc.spawns[method] = () => {
            throw new Error(`unexpected full world ${method} scan`);
        };
    });
    for (let index = 0; index < companions.length; index++) {
        const raid = BotRaidSafety.syncPlayerPartyRaid(leaderSession, 1000 + index);
        assert.strictEqual(raid?.bossId, boss.fetchId(), 'every companion tick must resolve the same authoritative raid');
    }
} finally {
    Object.entries(spawnScanMethods).forEach(([method, implementation]) => {
        World.npc.spawns[method] = implementation;
    });
}

let indexStats = RaidEntityIndex.stats(World);
assert.strictEqual(indexStats.rebuilds, 1,
    'multiple companion ticks over an unchanged world must share one lazy index build');
assert.strictEqual(indexStats.objectsScanned, World.npc.spawns.length,
    'the unchanged world must be scanned once rather than once per companion or minion');
assert.deepStrictEqual(
    new Set(BotRaidSafety.raidEntities(leaderSession.partyRaidEngagement)),
    new Set([boss, ...minions]),
    'the index must return only the selected boss and its linked minions'
);

const addedMinion = actor(6010, {
    selfId: 10020,
    minionBossObjectId: boss.fetchId(),
    minionBossTemplateId: boss.fetchSelfId()
});
World.npc.spawns.push(addedMinion);
World.addNpcToGrid(addedMinion);
assert(BotRaidSafety.raidEntities(leaderSession.partyRaidEngagement).includes(addedMinion),
    'a newly spawned minion must enter raid membership incrementally');
indexStats = RaidEntityIndex.stats(World);
assert.strictEqual(indexStats.rebuilds, 1, 'incremental minion insertion must not rebuild the world index');

World.removeNpcFromGrid(addedMinion);
World.npc.spawns.splice(World.npc.spawns.indexOf(addedMinion), 1);
assert(!BotRaidSafety.raidEntities(leaderSession.partyRaidEngagement).includes(addedMinion),
    'a removed minion must leave raid membership immediately');
assert.strictEqual(RaidEntityIndex.stats(World).rebuilds, 1,
    'incremental minion removal must not rebuild the world index');

World.removeNpcFromGrid(boss);
World.npc.spawns.splice(World.npc.spawns.indexOf(boss), 1);
assert.strictEqual(RaidEntityIndex.bossFor(World, minions[0]), null,
    'object-linked minions must become orphaned when their boss leaves the world');
assert.deepStrictEqual(BotRaidSafety.raidEntities(leaderSession.partyRaidEngagement), [],
    'an orphan minion set must not preserve a non-existent raid engagement');

const replacementBoss = actor(6020, { selfId: boss.fetchSelfId(), raidBoss: true });
World.npc.spawns.push(replacementBoss);
World.addNpcToGrid(replacementBoss);
assert.strictEqual(RaidEntityIndex.bossFor(World, minions[0]), replacementBoss,
    'template fallback must bind surviving minions to an authoritative replacement boss');

const replacementArray = World.npc.spawns.slice();
World.npc.spawns = replacementArray;
assert.strictEqual(RaidEntityIndex.bossByObjectId(World, replacementBoss.fetchId()), replacementBoss,
    'replacing the authoritative spawn array must invalidate and rebuild the index');
indexStats = RaidEntityIndex.stats(World);
assert.strictEqual(indexStats.rebuilds, 2, 'spawn-array replacement must cause exactly one additional rebuild');
assert.strictEqual(indexStats.objectsScanned, 2504 + replacementArray.length,
    'rebuild telemetry must expose the exact number of objects scanned');

console.log('Raid entity index checks passed');

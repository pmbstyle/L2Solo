#!/usr/bin/env node
'use strict';
// Native clan expedition CPU probe. No live SQL, actors, purchases or scheduler.
// node scripts/benchmark-clan-raid-expedition.js --output=/tmp/clan-raid-benchmark.json
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
process.chdir(root);
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require(path.join(root, 'tests/helpers/databaseIsolation'));
require(path.join(root, 'src/Global'));
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Raid = require(path.join(root, 'src/GameServer/Clan/ClanRaidPolicy'));
const Expedition = require(path.join(root, 'src/GameServer/Clan/ClanRaidExpedition'));
const Estimate = require(path.join(root, 'src/GameServer/Clan/ClanRaidEstimate'));
const Forecast = require(path.join(root, 'src/GameServer/Bot/Population/RaidCombatAssessment'));
const Supply = require(path.join(root, 'src/GameServer/Bot/Population/RaidSupplyPolicy'));
const Fixed = require(path.join(root, 'src/GameServer/Bot/Economy/FixedShotOffers'));
Supply.useMarket(() => ({ npcOffersFor: id => Fixed.offers(id), tripFrom: () => () => 0 }));
const at = Date.now(), fixture = require(path.join(root, 'tests/fixtures/raid_priority_world.json'));
const spot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const core = fixture.expected.map(id => {
    const row = fixture.members.find(s => s.characterId === id);
    return { ...row, characterId: id, classId: row.stats.classId, clanId: 77, level: id === 2006587 ? 50 : row.level,
        phase: 'cold', activity: 'hunting', partyId: null, party: {}, adena: 100000000,
        stats: { ...row.stats, clanId: 77, money: [100000000, 0, 0, 0], coldCombat: { ...row.captured,
            skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
        inventory: Life.inventorySummaryFromItems(row.items) };
});
const dd = core.find(s => Raid.raidRole(s) === 'damage');
const mage = { characterId: 990001, classId: 12, clanId: 77, level: 50, phase: 'cold', activity: 'hunting',
    partyId: null, party: {}, stats: { classId: 12, clanId: 77, money: [100000000, 0, 0, 0] }, adena: 100000000, inventory: {} };
mage.stats.coldCombat = Combat.legacySnapshot(mage, Combat.skillRecordsFromTree(12, 50).filter(s => s.selfId === 1230), at);
for (const slot of [7, 14, 6, 9, 10, 11, 12]) {
    if (slot === 14 && Object.values(mage.inventory).some(row => row.slot === 7)) continue;
    const item = Data.items.find(item => item.etc?.slot === slot && item.etc.rank === 'c'
        && Gear.suitable(item, mage, Gear.roleFor(mage), 'c'));
    if (item) mage.inventory[item.selfId] = { selfId: item.selfId, slot, amount: 1, equipped: true };
}
for (const s of [...core, mage]) {
    const plan = Shots.planForState(s);
    if (plan.selfId) s.inventory[plan.selfId] = { selfId: plan.selfId, amount: 100000, stackable: true };
}
const cpuScope = typeof process.threadCpuUsage === 'function' ? 'thread' : 'process';
const cpu = cpuScope === 'thread' ? process.threadCpuUsage.bind(process) : process.cpuUsage.bind(process);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(fn, iterations = 10, batches = 7) {
    for (let i = 0; i < 8; i++) fn();
    const cpuMs = [], wallMs = [];
    let value;
    for (let batch = 0; batch < batches; batch++) {
        const startCpu = cpu(), startWall = performance.now();
        for (let i = 0; i < iterations; i++) value = fn();
        const used = cpu(startCpu);
        cpuMs.push((used.user + used.system) / 1000 / iterations);
        wallMs.push((performance.now() - startWall) / iterations);
    }
    return { cpuMedianMs: median(cpuMs), cpuMinMs: Math.min(...cpuMs), cpuMaxMs: Math.max(...cpuMs),
        wallMedianMs: median(wallMs), samples: iterations * batches, value };
}
const report = { at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, cpuScope,
    scope: 'Native production forecast and combat functions; no live SQL, scheduling, networking, hot AI or renderer.',
    forecast: [], combat: [], hotRoster: [], catalogPlanning: [] };
for (const kind of ['physical', 'mages']) {
    for (const n of [9, 18, 27, 36, 40]) {
        const members = [...structuredClone(core), ...Array.from({ length: n - 9 }, (_, i) => ({
            ...structuredClone(kind === 'mages' ? mage : dd), characterId: 8000000 + i }))];
        const ids = members.map(s => s.characterId), coreIds = core.map(s => s.characterId);
        const options = { timestamp: at, clanId: 77, ...(n > 9 ? { coreMemberIds: coreIds } : {}) };
        const run = cache => Estimate.estimate(members, spot, cache, options);
        const cold = measure(() => run(new Map()));
        const cache = new Map(), cached = measure(() => run(cache));
        assert(cold.value.assessment.ready, JSON.stringify({ kind, n, reasons: cold.value.assessment.reasons }));
        const { value: coldValue, ...coldMetrics } = cold, { value: cachedValue, ...cacheMetrics } = cached;
        report.forecast.push({ kind, members: n, groups: Math.ceil(n / 9), fresh: coldMetrics, cached: cacheMetrics,
            fightSeconds: coldValue.assessment.seconds, grossDps: coldValue.assessment.grossDps,
            resultBytes: Buffer.byteLength(JSON.stringify(coldValue)), inputBytes: Buffer.byteLength(JSON.stringify(members)) });
        const marker = { memberIds: ids, ...(n > 9 ? { coreMemberIds: coreIds } : {}) };
        const preparation = Expedition.groups(marker).map(group => Forecast.prepared(members.filter(s => group.includes(s.characterId)), at));
        assert(preparation.every(p => p.ready));
        const combatAt = Math.max(...preparation.map(p => p.at));
        const prepared = preparation.flatMap(p => p.states).map(s => ({ ...s, stats: { ...s.stats,
            clanPartyObjective: { fullRoster: marker } } }));
        // A durable boss profile isolates combat from target selection and prevents an early victory.
        const npc = Data.npcs.find(npc => npc.selfId === fixture.bossId);
        const mob = { ...Combat.npcCombatStats(npc), maxHp: 1000000000, raidBossMaxHp: 1000000000 };
        const encounter = { version: 1, key: `raid:${fixture.bossId}`, hp: mob.maxHp, at: combatAt, slices: 1, mob };
        const args = { members: prepared, spot, timestamp: combatAt, targetNpcId: fixture.bossId, rng: () => .5,
            encounter, encounterKey: encounter.key, sharedEncounter: true };
        const measured = measure(() => Resolver.resolvePartyFight(args), 5, 5), { value, ...metrics } = measured;
        assert.equal(value.debug.durationMs, 15000);
        assert(!value.debug.actionBound);
        report.combat.push({ kind, members: n, ...metrics, actions: value.debug.actions,
            simulatedMs: value.debug.durationMs, wallScheduleMs: 15000,
            damage: mob.maxHp - value.debug.remainingHp, resultBytes: Buffer.byteLength(JSON.stringify(value)) });
        console.log(`measured ${kind} ${n}`);
    }
}
const Hot = require(path.join(root, 'src/GameServer/Bot/AI/HotBackgroundParty'));
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const previousFind = Parties.find, previousRegistered = World.registeredActorById;
for (const n of [9, 18, 27, 36, 40]) {
    const ids = Array.from({ length: n }, (_, i) => 8000000 + i);
    const marker = { memberIds: ids, ...(n > 9 ? { coreMemberIds: ids.slice(0, 9) } : {}) };
    const party = { partyId: 'bench', leaderId: ids[0], memberIds: ids, status: 'hot', stats: { objective: { fullRoster: marker } } };
    const sessions = ids.map(id => ({ actor: { fetchId: () => id }, hotBackgroundPartyId: 'bench' }));
    const registered = new Map(sessions.map(session => [session.actor.fetchId(), { actor: session.actor, session }]));
    Parties.find = () => party; World.registeredActorById = id => registered.get(id);
    const measured = measure(() => {
        let count = 0;
        for (const session of sessions) { count += Hot.partyRoster(session).length; Hot.partyLeader(session); }
        return count;
    }, 100, 7);
    const { value, ...metrics } = measured;
    assert.equal(value, Expedition.groups(marker).reduce((sum, group) => sum + group.length ** 2, 0));
    report.hotRoster.push({ members: n, scope: 'one partyRoster and partyLeader lookup per actor; stubbed registered actors, no actual AI', ...metrics });
}
Parties.find = previousFind; World.registeredActorById = previousRegistered;
const Demand = require(path.join(root, 'src/GameServer/Clan/ClanRosterDemand'));
const catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').all();
for (const n of [18, 27, 40]) {
    const members = [...structuredClone(core), ...Array.from({ length: n - 9 }, (_, i) => ({ ...structuredClone(dd), characterId: 8000000 + i }))];
    const clan = { id: 77, level: 5, members, physicalMemberCount: n };
    const measured = measure(() => Demand.prepare(clan, catalog, [], null, new Map()), 1, 5);
    const { value, ...metrics } = measured;
    report.catalogPlanning.push({ members: n, catalogBosses: catalog.length, readyBosses: value.raids.length,
        maxRaidMembers: Math.max(0, ...value.raids.map(row => row.raidRosterSize)), ...metrics });
    console.log(`measured catalog ${n}`);
}
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

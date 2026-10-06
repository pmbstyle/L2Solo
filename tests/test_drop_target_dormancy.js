'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-target-dormancy-'));
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const at = 1800000000000;
const base = { characterId: 9601, level: 10, inventory: {}, stats: { classId: 0, role: 'dps' } };
const target = Gear.preferredNoGradeTarget(base);
const plan = { status: 'active', grade: 'none', strategy: 'direct_drop', plannedForLevel: 10,
    startedAt: at, expectedKills: 19, target: { selfId: target.selfId, name: target.template.name },
    next: { npcId: 450, spotId: 'drop-target', itemId: target.selfId },
    targetProgress: { npcId: 450, resolves: 0, targetKills: 0 } };
try {
    for (const targetOnSpot of [0, undefined]) {
        let telemetry = { targetNpcId: 450, resolves: 0, targetKills: 0, populationTargets: {} };
        for (let n = 0; n < 100; n++) telemetry = Life.targetCombatTelemetry(telemetry,
            { targetNpcId: 450, ...(targetOnSpot === undefined ? {} : { targetOnSpot }), foughtNpcIds: [93] }, at + n) || telemetry;
        assert.equal(telemetry.resolves, 0, 'foreign and legacy rounds never consume the drop target');
        assert.deepEqual(telemetry.populationTargets, {});
        assert.equal(Gear.directPlanFailure({ ...base, stats: { ...base.stats, targetCombat: telemetry } }, plan, at + 100), null);
    }
    let telemetry = {};
    for (let n = 0; n < 100; n++) telemetry = Life.targetCombatTelemetry(telemetry,
        { targetNpcId: 450, targetOnSpot: 1, foughtNpcIds: [93] }, at + n);
    assert.equal(telemetry.resolves, 100); assert.equal(telemetry.populationTargets['450'].resolves, 100);
    const state = { ...base, stats: { ...base.stats, targetCombat: telemetry } };
    const failed = Gear.replanContextFor(state, plan, at + 100);
    const dormant = failed.recoveryTargets.find(row => row.targetId === target.selfId);
    assert.equal(dormant.reason, 'combat_unviable'); assert.deepEqual(dormant.wake, [10, -1, 0]);
    assert(dormant.wake.every(Number.isFinite)); assert.equal(dormant.until, undefined);
    const paused = { ...plan, recoveryTargets: failed.recoveryTargets };
    assert(Gear.replanContextFor(state, paused, at + 10 * 3600000).excludedTargetIds.includes(target.selfId));
    assert(!Gear.replanContextFor({ ...state, level: 11 }, paused, at + 101).excludedTargetIds.includes(target.selfId));
    const leveled = { ...state, level: 11 };
    const awakeContext = Gear.replanContextFor(leveled, paused, at + 101);
    const retry = Gear.finalizePlan(leveled, paused, plan, awakeContext, at + 101);
    assert.equal(retry.targetProgress.resolves, 100, 'a woken route starts from the current counter');
    assert.equal(Gear.directPlanFailure(leveled, retry, at + 102), null, 'old failed rounds cannot fail the retry');
    const retried = { ...leveled, stats: { ...leveled.stats, targetCombat: { ...telemetry, resolves: 108 } } };
    assert.equal(Gear.directPlanFailure(retried, retry, at + 103).reason, 'combat_unviable');
    const dWeapon = Data.items.find(item => item.etc?.rank === 'd' && Number(item.etc?.slot) === 7);
    const armed = { ...state, inventory: { [dWeapon.selfId]: { selfId: dWeapon.selfId, amount: 1, equipped: true, slot: 7 } } };
    assert(!Gear.replanContextFor(armed, paused, at + 101).excludedTargetIds.includes(target.selfId));
    assert(!Gear.replanContextFor({ ...state, party: { partyId: 'new-party' } }, paused, at + 101).excludedTargetIds.includes(target.selfId));
    const market = { ...state, stats: { ...state.stats, equipmentPlan: { ...paused, strategy: 'market' } } };
    assert(Gear.abandonAcquisition(market, target.selfId, at + 102).stats.equipmentPlan.recoveryTargets
        .some(row => row.reason === 'combat_unviable' && row.targetId === target.selfId && Array.isArray(row.wake)));
    const four = Array.from({ length: 4 }, (_, n) => ({ targetId: 9900 + n, npcId: 200 + n,
        reason: 'combat_unviable', failedAt: at - 4 + n, wake: [10, -1, 0] }));
    const fifth = Gear.replanContextFor(state, { ...plan, recoveryTargets: four }, at + 103).recoveryTargets;
    assert.equal(fifth.filter(row => row.reason === 'combat_unviable').length, 4);
    assert(!fifth.some(row => row.targetId === 9900));
    const exhausted = Gear.replanContextFor({ ...base, stats: { ...base.stats,
        targetCombat: { targetNpcId: 450, resolves: 100, targetKills: 100 } } }, plan, at + 104);
    assert.equal(exhausted.failure.reason, 'drop_exhausted');
    assert.equal(exhausted.recoveryTargets[0].until, at + 104 + 3600000);
    assert.equal(exhausted.recoveryTargets[0].wake, undefined);

    assert.equal(Cold.spotSpawns({ npcEntries: [{ selfId: 93, count: 1 }] }, 93), true);
    assert.equal(Cold.spotSpawns({ npcEntries: [], npcSelfIds: [93] }, 93), true);
    assert.equal(Cold.spotSpawns({ npcEntries: [{ selfId: 96, count: 1 }] }, 93), false);
    const member = characterId => ({ characterId, level: 15, name: 'Drop hunter', activity: 'hunting',
        vitals: { hp: 2000, maxHp: 2000, mp: 800, maxMp: 800 }, inventory: {},
        stats: { classId: 0, coldCombat: { classId: 0, equipment: { pAtk: 4000, atkSpd: 900,
            accur: 300, critical: 40, pDef: 2000, mDef: 1000, evasion: 200, weaponKind: 'blunt' } } } });
    const spotSpawns = Cold.spotSpawns;
    let spotScans = 0;
    Cold.spotSpawns = (...args) => { spotScans++; return spotSpawns(...args); };
    for (const selfId of [93, 96]) {
        const spot = { id: `drop-fixture-${selfId}`, name: 'Orc camp', avgLevel: 10, density: 3,
            npcEntries: [{ selfId, count: 1 }], npcSelfIds: [selfId], center: { x: 0, y: 0, z: 0 },
            rewards: { exp: 100, sp: 10, adenaMin: 20, adenaMax: 40 }, mob: { hp: 200, damage: 10 } };
        const expected = selfId === 93 ? 1 : 0;
        spotScans = 0;
        const solo = Solo.resolveSolo({ state: member(9601), spot, targetNpcId: 93, elapsedMs: 30000,
            rng: () => .5, timestamp: at });
        assert.equal(solo.debug.targetOnSpot, expected, 'the solo resolver stamps the fought spot');
        assert.equal(spotScans, 1);
        spotScans = 0;
        const party = Party.resolve({ party: { partyId: 'drop-fixture-party', cohesion: 1, risk: 0, roleCoverage: {} },
            members: [member(9601), member(9602)], spot, targetNpcId: 93, elapsedMs: 60000,
            rng: () => .5, timestamp: at });
        assert.equal(party.debug.targetOnSpot, expected, 'the party aggregate stamps the fought spot');
        assert(party.memberResults.every(row => row.result.debug.targetOnSpot === expected));
        assert.equal(spotScans, 1, 'one shared spot scan serves every member and the party aggregate');
    }
    Cold.spotSpawns = spotSpawns;
    console.log('PASS target-only telemetry, event dormancy, four-target cap and unchanged drop exhaustion timer');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

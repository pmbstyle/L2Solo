'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
const { LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const fixture = require('./fixtures/raid_priority_world.json');
const catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const targets = catalog.all().filter(s => s.avgLevel >= 43 && s.avgLevel <= 48);
const at = 1800000000000;
function harness(workMs = 20) {
    let clock = at, hostile = false;
    const pressure = { ready: true, lagMs: 0, utilization: .5, pendingGoals: 0 };
    const states = new Map(fixture.members.map(row => [row.characterId, { ...structuredClone(row),
        accountName: `bot_${row.characterId}`, phase: 'cold', party: {}, updatedAt: at,
        stats: { ...row.stats, coldCombat: { ...row.captured,
            skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId,level]) => ({ selfId,level }))) } },
        inventory: Object.fromEntries(row.items.map(item => [item.selfId, { ...item }])) }]));
    const calls = [];
    const service = new OpportunisticRaidDirector({ now: () => clock,
        config: { opportunisticRaidSearchIntervalMs: 60000, opportunisticRaidIntervalMs: 900000,
            opportunisticRaidMemberCooldownMs: 1800000, opportunisticRaidAliveFraction: .5,
            opportunisticRaidMaxParties: 2, opportunisticRaidExpeditionMs: 2700000 },
        database: { execute: async () => [] },
        life: { cachedState: id => states.get(id), statesByIds: async ids => ids.map(id => states.get(id)),
            subscribePublications: fn => { for (const s of states.values()) fn({ characterId: s.characterId }); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        memory: { ensureMany: async () => {}, assess: () => ({ ready: true,
            disposition: hostile ? 'hostile' : 'neutral', effective: { hostility: hostile ? 20 : 0 } }) },
        canWork: () => true, bossFree: () => true, forecastPressure: () => pressure,
        catalog: { all: () => targets, liveTemplateIds: () => new Set(targets.map(s => s.raidBossTemplateId)) },
        assess: async members => { calls.push({ at: clock, ids: members.map(s => s.characterId) });
            return { ready: false, reason: 'raid_fight_too_long', workMs }; },
        form: async () => assert.fail('rejected forecasts must not form') });
    return { service, states, calls, pressure, hostile: () => { hostile = true; },
        pulse: async ms => { clock = at + ms; await service.pulse(clock); } };
}
(async () => {
    assert.equal(LIMITS.forecastCpuMs, 120);
    assert.equal(LIMITS.forecastWindowMs, 60000);
    const h = harness(); await h.service.start();
    try {
        await h.pulse(0);
        assert.equal(h.calls.length, 1);
        for (const ms of [0,1000,5000,9999]) await h.pulse(ms);
        assert.equal(h.calls.length, 1, 'a 20 ms forecast earns a ten-second spacing, not a burst');
        for (let ms = 10000; ms < 60000; ms += 10000) await h.pulse(ms);
        assert.deepEqual(h.calls.map(c => c.at - at), [0,10000,20000,30000,40000,50000]);
        const report = h.service.snapshot().search;
        assert.equal(report.total.forecastWorkMs, 120);
        assert.equal(report.total.searches, 1, 'rosters are assembled once per minute, not once per forecast');
        assert(report.total.hydratedBots <= 72 && report.total.socialChecks <= 288);
        assert.equal(report.total.revalidatedBots, 54, 'each paced forecast reads the current nine');
        await h.pulse(55000); assert.equal(h.calls.length, 6);
        h.service.wake('raid_opportunity');
        await h.pulse(60000); assert.equal(h.calls.length, 7, 'a new opportunity runs on the refilled allowance');
    } finally { h.service.stop(); }

    const busy = harness(); await busy.service.start();
    try {
        await busy.pulse(0);
        for (const [ms, patch] of [[10000,{lagMs:130}], [15000,{lagMs:0,utilization:.95}],
            [20000,{utilization:.5,pendingGoals:1}], [25000,{pendingGoals:0,ready:false}]]) {
            Object.assign(busy.pressure, patch); await busy.pulse(ms);
            assert.equal(busy.calls.length, 1, 'worker lag, saturation, other party work and unavailable heartbeats defer forecasts');
        }
        const report = busy.service.snapshot().search;
        assert.equal(report.cpuBudget.availableMs, 100, 'load deferrals do not consume CPU tokens');
        assert.equal(report.pacing.loadDeferrals, 4);
        assert.equal(report.total.searches, 1);
        Object.assign(busy.pressure, { ready:true,lagMs:0,utilization:.5,pendingGoals:0 });
        await busy.pulse(50000); assert.equal(busy.calls.length, 2);
        await busy.pulse(50000); assert.equal(busy.calls.length, 2, 'missed slots cannot be caught up in a burst');
    } finally { busy.service.stop(); }

    const stale = harness(); await stale.service.start();
    try {
        await stale.pulse(0);
        for (const state of stale.states.values()) state.phase = 'hot';
        await stale.pulse(10000);
        assert.equal(stale.calls.length, 1, 'a paced queue cannot reuse actors that became unavailable');
        assert(stale.service.snapshot().search.rejections.assembly.raid_members_changed > 0);
    } finally { stale.service.stop(); }
    const hostile = harness(); await hostile.service.start();
    try {
        await hostile.pulse(0); hostile.hostile(); await hostile.pulse(10000);
        assert.equal(hostile.calls.length, 1, 'diplomacy changes invalidate queued rosters before the worker request');
    } finally { hostile.service.stop(); }
    const moderate = harness(); moderate.pressure.utilization = .8; await moderate.service.start();
    try {
        await moderate.pulse(0); await moderate.pulse(10000);
        assert.equal(moderate.calls.length, 1, 'moderate pressure doubles the measured spacing');
        await moderate.pulse(20000); assert.equal(moderate.calls.length, 2);
    } finally { moderate.service.stop(); }
    const oversized = harness(300); await oversized.service.start();
    try {
        await oversized.pulse(0);
        assert.equal(oversized.service.snapshot().search.cpuBudget.debtMs, 180);
        for (const ms of [60000,120000]) await oversized.pulse(ms);
        assert.equal(oversized.calls.length, 1, 'a single overrun is paced and repaid across future windows');
        oversized.service.wake('raid_opportunity');
        await oversized.pulse(180000); assert.equal(oversized.calls.length, 2);
    } finally { oversized.service.stop(); }
    console.log('Raid 120 ms/minute budget, measured pacing, worker pressure, fresh admission and no catch-up bursts passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

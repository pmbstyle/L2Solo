process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects developer action histories.
// Main's competition actions over a worker frame (ColdCompetitionActions): a spot's PvP
// dispute and the grievance meetings, bounded per frame (four applied, eight attempted,
// PvP first, 75 ms of wall time), every skipped forecast handed back to its pair, the
// spot telemetry bounded. The fights themselves: test_cold_pvp, test_cold_party_conflicts.
const assert = require('assert');
require('../src/Global');
const { ColdCompetitionActions } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const now = Date.now();
const participant = id => ({ id, revision: 1, memoryRevision: 0 });
const dispute = { key: 'dispute', at: now, pressure: 2, spotId: 'test', npcId: 10, action: 'contest', pvpIntent: true,
    actor: participant(13), peer: participant(14) };
const quiet = { ...dispute, key: 'quiet', pvpIntent: false };
const revenge = { ...dispute, key: 'revenge', action: 'revenge', pvpIntent: false };
(async () => {
    // Only fights reach the actions: an outcome the spot settles itself (who stays) is no action.
    const offered = new ColdCompetitionActions({ now: () => now, conflictsEnabled: () => true, pvpEnabled: () => true });
    const seen = [];
    offered.apply = async e => { seen.push(e.action); return { ok: true }; };
    offered.submit({ at: now, events: [quiet, { ...quiet, key: 'avoid', action: 'avoid' }, { ...quiet, key: 'offer', action: 'offer_party', accepted: true },
        dispute, revenge].map(e => ({ ...e, at: now })) });
    await offered.running;
    assert.deepStrictEqual(seen, ['contest', 'revenge', 'contest'], 'PvP first, then the other dispute; no departure or party offer');
    assert.strictEqual((await new ColdCompetitionActions({ now: () => now, conflictsEnabled: () => true }).apply({ ...quiet, key: 'solo' })).reason,
        'forecast_only', 'a solo dispute with no fight to carry out is no action');
    assert.strictEqual(offered.snapshot().mode, 'resource_pvp');
    let clock = 0;
    const bounded = new ColdCompetitionActions({ now: () => now, budgetNow: () => clock, conflictsEnabled: () => true });
    const attempts = [];
    bounded.apply = async e => { attempts.push(e.key); return { ok: attempts.length > 2, reason: 'state_changed_or_busy' }; };
    const batch = Array.from({ length: 12 }, (_, i) => ({ ...quiet, key: `batch-${i}`, at: now }));
    batch[11] = { ...dispute, key: 'pvp-first', at: now };
    bounded.submit({ at: now, recent: batch.slice(0, 2), events: batch }); await bounded.running;
    assert.strictEqual(attempts[0], 'pvp-first');
    assert.strictEqual(attempts.length, 6, 'cheap rejected candidates do not consume the four successful-action slots');
    assert.strictEqual(bounded.report.applied, 4);
    assert.strictEqual(bounded.report.budgetSkipped, 6);
    assert.strictEqual(bounded.report.pvpRejected.state_changed_or_busy, 1);
    const failures = new ColdCompetitionActions({ now: () => now, budgetNow: () => 0, conflictsEnabled: () => true });
    failures.apply = async () => ({ ok: false, reason: 'stale' });
    failures.submit({ at: now, recent: batch.slice(0, 11) }); await failures.running;
    assert.strictEqual(failures.report.attempted, 8, 'failed attempts have their own hard bound');
    // Every forecast skipped by the budget is handed back so its pair re-decides at its
    // next meeting; the next frame carries only its own forecasts: no backlog.
    const released = [], order = [];
    const mixed = new ColdCompetitionActions({ now: () => now, budgetNow: () => 0, conflictsEnabled: () => true,
        releaseForecasts: events => released.push(events.map(e => e.key)) });
    mixed.apply = async e => { order.push(e.key); return { ok: true }; };
    const scan = (n, at) => Array.from({ length: 6 }, (_, i) => ({ ...dispute, key: `pvp-${n}-${i}`, at }));
    mixed.submit({ at: now, events: scan(0, now) }); await mixed.running;
    assert.deepStrictEqual(order, ['pvp-0-0', 'pvp-0-1', 'pvp-0-2', 'pvp-0-3']);
    assert.deepStrictEqual(released, [['pvp-0-4', 'pvp-0-5']], 'every forecast skipped by the budget releases its pair');
    mixed.submit({ at: now + 30000, events: [...scan(0, now), ...scan(1, now + 30000)] }); await mixed.running;
    assert.deepStrictEqual(order.slice(4), ['pvp-1-0', 'pvp-1-1', 'pvp-1-2', 'pvp-1-3'], 'skipped forecasts are not replayed on the next frame');
    assert.strictEqual(mixed.report.budgetSkipped, 4, 'the skipped count does not grow across frames');
    const slow = new ColdCompetitionActions({ now: () => now, budgetNow: () => clock, conflictsEnabled: () => true });
    slow.apply = async () => { clock += 80; return { ok: true }; };
    slow.submit({ at: now, recent: batch.slice(0, 11) }); await slow.running;
    assert.strictEqual(slow.report.attempted, 1, 'wall-time budget stops further work after a slow action');
    const telemetry = new ColdCompetitionActions({ now: () => now, budgetNow: () => 0, conflictsEnabled: () => true });
    telemetry.apply = async e => e.key === 'rejected' ? { ok: false, reason: 'party_changed', detail: 'party_travelling', rejectionContext: { characterId: 13, partyId: 'party-13' } }
        : e.key === 'fight' ? { ok: true, pvp: true, encounter: {}, combat: { fighters: [] } }
        : { ok: true, deescalated: true };
    const telemetryBatch = { at: now, events: ['fight', 'peace', 'rejected'].map(key => ({ ...dispute, key, at: now, spotId: 'busy-ground' })) };
    telemetry.submit(telemetryBatch); await telemetry.running;
    telemetry.submit(telemetryBatch); await telemetry.running;
    assert.strictEqual(telemetry.snapshot().spotActivity[0].pvpFights, 1, 'count accepted starts once, not intents or duplicate deliveries');
    assert.strictEqual(telemetry.snapshot().spotActivity[0].applied, 2, 'rejected outcomes are not local activity');
    assert.strictEqual(telemetry.snapshot().spotActivity[0].contests, 1, 'deescalation is not a successful contest');
    assert.strictEqual(telemetry.snapshot().rejectedReasons.party_travelling, 1);
    assert.strictEqual(telemetry.snapshot().pvpRejected.party_travelling, 1);
    assert.strictEqual(telemetry.snapshot().recent.find(e => e.key === 'rejected').rejectionContext.characterId, 13);
    telemetry.recordPvpStep({ encounter: null, outcome: 'pvp_disengaged' });
    assert.strictEqual(telemetry.snapshot().spotActivity[0].pvpFights, 1, 'continuation and completion are not new fights');
    for (let i = 1; i <= 128; i++) {
        telemetry.submit({ at: now + i, events: [{ ...dispute, key: `ground-${i}`, at: now + i, spotId: `ground-${i}` }] });
        await telemetry.running;
    }
    assert.strictEqual(telemetry.snapshot().spotActivity.length, 128, 'spot telemetry stays bounded during long sessions');
    assert.strictEqual(telemetry.snapshot().spotActivityEvicted, 1, 'eviction is explicit rather than silently claiming a complete session history');
    assert.strictEqual(telemetry.snapshot().rejectionExamples[0].detail, 'party_travelling', 'keep diagnostic context after ordinary recent events rotate');
    console.log('Cold competition action bounds and telemetry checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

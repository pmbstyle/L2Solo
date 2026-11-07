'use strict';
const assert = require('node:assert/strict');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
require('../src/Global');
// The author's fixed shot merchant sells shots here (off by default since T116).
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const Priority = require('../src/GameServer/Bot/Population/RaidRosterPriority');
const Work = require('../src/GameServer/Bot/Population/RaidSearchWork');
const { RaidRosterCoverage } = require('../src/GameServer/Bot/Population/RaidRosterCoverage');
const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
const { LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const fixture = require('./fixtures/raid_priority_world.json');
const at = fixture.at;
const pool = fixture.members.map(row => ({ ...row, accountName: `bot_${row.characterId}`,
    phase: 'cold', party: {}, updatedAt: at,
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }));
const byId = new Map(pool.map(state => [state.characterId, state]));
// The Prophet at 50 like the other eight: at 46 its MP no longer carries the golem's
// heals (T106 class kits and regen); the search, not the heal, is tested.
byId.get(2006587).level = 50;
const ids = roster => roster.map(s => s.characterId);
const neutral = () => ({ ready: true, disposition: 'neutral', effective: { hostility: 0 } });
const catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const boss = catalog.findById(`raid:${fixture.bossId}`);

async function run() {
    assert.equal(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botPurchasePrice(1464), 750);
    const before = JSON.stringify(pool);
    const planned = await Work.run(Policy.candidateSteps(pool, new Map(), 0, at, new RaidRosterCoverage()));
    assert.deepEqual(ids(planned.proposals[0]), fixture.expected,
        'the frozen world finds the strong tank, complementary learned support and funded damage immediately');
    const fit = Policy.assessment(planned.proposals[0], boss, { timestamp: at, fundSupplies: true });
    assert(fit.ready && fit.seconds > 500 && fit.seconds < 530, JSON.stringify(fit.reasons));
    assert(fit.supplies.some(s => s.missing > 0 && s.cost > 1000000), 'real x50 supply costs are assessed');
    assert.equal(JSON.stringify(pool), before, 'ranking and forecasting never buy, buff or change a live actor');
    const rich = byId.get(2007126), poor = structuredClone(rich);
    poor.adena = 1; poor.stats.money = [0,0,0,0]; poor.inventory[1464].amount = 0;
    assert(Priority.facts(rich, 'damage').score > Priority.facts(poor, 'damage').score,
        'a current wallet and physical stock affect ordering at the live progression rate');
    const weakened = structuredClone(rich); weakened.stats.hennas = [];
    assert(Priority.facts(rich, 'damage').score > Priority.facts(weakened, 'damage').score,
        'native symbols distinguish otherwise identical weapons');
    const changed = structuredClone(pool);
    changed.find(s => s.characterId === fixture.expected[0]).stats.pk = 1;
    const unsafe = await Work.run(Policy.candidateSteps(changed, new Map(), 0, at, new RaidRosterCoverage()));
    assert(unsafe.proposals.every(r => !ids(r).includes(fixture.expected[0])), 'priority never admits a PK tank');

    let reserved = null;
    const forecasts = [];
    const targets = catalog.all().filter(s => s.avgLevel >= 43 && s.avgLevel <= 48);
    const dependencies = {
        config: { opportunisticRaidSearchIntervalMs: 60000, opportunisticRaidIntervalMs: 900000,
            opportunisticRaidMemberCooldownMs: 1800000, opportunisticRaidAliveFraction: .5,
            opportunisticRaidMaxParties: 2, opportunisticRaidExpeditionMs: 2700000 },
        database: { execute: async () => [] },
        life: { cachedState: id => byId.get(id), statesByIds: async keys => keys.map(key => byId.get(key)),
            subscribePublications: listener => { pool.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        memory: { ensureMany: async () => {}, assess: neutral },
        canWork: () => true, bossFree: () => true,
        catalog: { all: () => targets, liveTemplateIds: () => new Set(targets.map(s => s.raidBossTemplateId)) },
        preparations: { start: async () => {}, stop: () => {}, snapshot: () => [], admitted: () => [], maintain: async () => {},
            reserve: async (members, objective) => {
                reserved = { members, objective };
                return { id: 'fixture-preparation', startedAt: at, memberIds: ids(members) };
            } },
        assess: async (members, spot) => {
            forecasts.push({ ids: ids(members), boss: spot.raidBossTemplateId });
            return { ...Policy.assessment(members, spot, { timestamp: at, fundSupplies: true }), workMs: 30 };
        },
        form: async () => assert.fail('this roster must purchase physical supplies first')
    };
    const service = new OpportunisticRaidDirector(dependencies);
    await service.start();
    try {
        service.rosterCursor = 5;
        service.deferredRosters = planned.proposals.slice(1).map(ids);
        await service.pulse(at);
        assert.deepEqual(forecasts, [{ ids: fixture.expected, boss: fixture.bossId }],
            'a queued search and rotated forecast cursor cannot hide the fresh priority roster or start with the armoured golem');
        assert(reserved && reserved.objective.assessment.ready);
        const report = service.snapshot().search;
        assert(report.lastSearch.rosterAttempts <= 8 && report.lastSearch.hydratedBots <= 72
            && report.lastSearch.socialChecks <= 288 && report.lastSearch.forecasts <= 12);
        assert.equal(report.cpuBudget.debtMs, 18, 'the priority forecast pays the same 12 ms token budget, including overrun debt');
        assert.deepEqual(LIMITS, { rosters: 8, hydratedBots: 72, forecasts: 12, socialChecks: 288, sliceMs: 2, forecastCpuMs: 12 });
    } finally { service.stop(); }
    // These bosses have identical boss-only hints. The native forecast rejects
    // Kraven's guards (their damage outruns the healers' mana) but admits the
    // golem for exactly the same frozen nine.
    const kraven = catalog.findById('raid:10418'), golem = catalog.findById('raid:10431');
    const guardedFit = Policy.assessment(planned.proposals[0], kraven, { timestamp: at, fundSupplies: true });
    const golemFit = Policy.assessment(planned.proposals[0], golem, { timestamp: at, fundSupplies: true });
    assert(!guardedFit.ready && guardedFit.reasons.includes('raid_healing_mana'), JSON.stringify(guardedFit.reasons));
    assert(guardedFit.healingRequired > golemFit.healingRequired, 'the guards are what the healers cannot carry');
    assert(golemFit.ready, JSON.stringify(golemFit.reasons));
    targets.splice(0, targets.length, kraven, golem);
    reserved = null; forecasts.length = 0;
    for (const pass of [0, 1]) {
        reserved = null; forecasts.length = 0;
        const guarded = new OpportunisticRaidDirector(dependencies);
        const score = Priority.targetScore, scoreCalls = new Map();
        await guarded.start();
        try {
            Priority.targetScore = spot => {
                const id = spot.raidBossTemplateId;
                scoreCalls.set(id, (scoreCalls.get(id) || 0) + 1);
                return score(spot);
            };
            guarded.coverage.passes = pass;
            guarded.deferredRosters = [fixture.expected];
            await guarded.pulse(at);
            assert.deepEqual(forecasts, [{ ids: fixture.expected, boss: 10431 }],
                `both priority and coverage pass ${pass} reach the feasible guarded boss before CPU debt stops the search`);
            assert(reserved && reserved.objective.assessment.ready);
            assert.equal(guarded.snapshot().search.cpuBudget.debtMs, 18);
            assert.deepEqual([...scoreCalls.values()], [1, 1], 'all roster queues share one score per boss per search');
        } finally { Priority.targetScore = score; guarded.stop(); }
    }
    console.log('Frozen-world priority recruitment, real x50 funding, learned buff coverage and unchanged admission budgets passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

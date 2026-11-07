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
const Work = require('../src/GameServer/Bot/Population/RaidSearchWork');
const { RaidRosterCoverage } = require('../src/GameServer/Bot/Population/RaidRosterCoverage');
const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
const { LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const fixture = require('./fixtures/raid_adjacent_cohort.json');
const at = fixture.at, ids = roster => roster.map(s => s.characterId);
// Max HP comes from the class template (T109), far over this boss's bar at CON 43; CON 23 puts the
// tank just under it, so only the adjacent support's HP buff carries it over.
fixture.members.find(row => row.characterId === fixture.original[0]).captured.base.con = 23;
const pool = fixture.members.map(row => ({ ...row, accountName: `bot_${row.characterId}`, phase: 'cold', party: {}, updatedAt: at,
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }));
const byId = new Map(pool.map(s => [s.characterId, s]));
const catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const boss = catalog.findById(`raid:${fixture.bossId}`);
const assess = roster => Policy.assessment(roster, boss, { timestamp: at, fundSupplies: true });

async function run() {
    const before = JSON.stringify(pool);
    const coverage = new RaidRosterCoverage();
    const planned = await Work.run(Policy.candidateSteps(pool, new Map(), 0, at, coverage));
    assert.deepEqual(ids(planned.proposals[0]), fixture.original);
    assert.deepEqual(ids(planned.proposals[1]), fixture.adjacent,
        'the adjacent learned support rank is proposed before cycling through other tanks or high-level windows');
    const refused = assess(planned.proposals[0]), accepted = assess(planned.proposals[1]);
    assert.deepEqual(refused.reasons, ['raid_tank_survival']);
    assert(refused.defense.maxHp < refused.defense.requiredHp);
    assert(accepted.ready && accepted.defense.maxHp > accepted.defense.requiredHp);
    assert.equal(refused.defense.pDef, accepted.defense.pDef, 'the same real armour remains equipped');
    assert.equal(refused.defense.requiredHp, accepted.defense.requiredHp, 'the native guard pressure is unchanged');
    assert(accepted.grossDps > refused.grossDps && accepted.seconds < refused.seconds,
        'the learned support loadout improves the native damage forecast as well as tank HP');
    assert(planned.proposals.length <= LIMITS.rosters && planned.candidates.length <= LIMITS.hydratedBots);

    let reserved = null;
    const forecasts = [];
    const targets = [boss, catalog.findById('raid:10418'), catalog.findById('raid:10044')];
    const service = new OpportunisticRaidDirector({
        config: { opportunisticRaidSearchIntervalMs: 60000, opportunisticRaidIntervalMs: 900000,
            opportunisticRaidMemberCooldownMs: 1800000, opportunisticRaidAliveFraction: .5,
            opportunisticRaidMaxParties: 2, opportunisticRaidExpeditionMs: 2700000 },
        database: { execute: async () => [] },
        life: { cachedState: id => byId.get(id), statesByIds: async keys => keys.map(id => byId.get(id)),
            subscribePublications: listener => { pool.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        memory: { ensureMany: async () => {}, assess: () => ({ ready: true, disposition: 'neutral', effective: { hostility: 0 } }) },
        canWork: () => true, bossFree: () => true,
        catalog: { all: () => targets, liveTemplateIds: () => new Set(targets.map(s => s.raidBossTemplateId)) },
        preparations: { start: async () => {}, stop: () => {}, snapshot: () => [], admitted: () => [], maintain: async () => {},
            reserve: async (members, objective) => {
                reserved = { ids: ids(members), objective };
                return { id: 'adjacent-cohort-preparation', startedAt: at + 60000, memberIds: ids(members) };
            } },
        assess: async (members, target) => {
            forecasts.push({ ids: ids(members), boss: target.raidBossTemplateId });
            return { ...Policy.assessment(members, target, { timestamp: at, fundSupplies: true }), workMs: LIMITS.forecastCpuMs };
        },
        form: async () => assert.fail('missing physical shots require native supply preparation')
    });
    await service.start();
    try {
        await service.pulse(at);
        assert.equal(reserved, null, 'a tank short of the same required HP is still refused');
        assert.equal(forecasts.length, 1, 'the same CPU budget prevents a second forecast this pass');
        service.rosterCursor = 1;
        await service.pulse(at + 60000);
        assert.deepEqual(forecasts, [fixture.original, fixture.adjacent].map(ids => ({ ids, boss: fixture.bossId })),
            'the unforecasted adjacent roster survives CPU deferral and is checked first on the next coverage pass');
        assert.deepEqual(reserved.ids, fixture.adjacent);
        assert(reserved.objective.assessment.ready && reserved.objective.assessment.supplies.some(s => s.missing > 0));
        const report = service.snapshot().search;
        assert.equal(report.total.forecasts, 2);
        assert.equal(report.total.preparationsStarted, 1);
        assert(report.lastSearch.hydratedBots <= 72 && report.lastSearch.socialChecks <= 288);
        assert.equal(report.cpuBudget.debtMs, 0);
    } finally { service.stop(); }
    assert.equal(JSON.stringify(pool), before, 'selection never changes native equipment, skills, wallets or stock');
    console.log('Frozen native tank refusal, adjacent learned support, deferred forecast and unchanged admission budgets passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

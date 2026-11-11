'use strict';
const assert = require('node:assert/strict');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const Selection = require('../src/GameServer/Bot/Population/RaidTargetSelection');
const Priority = require('../src/GameServer/Bot/Population/RaidRosterPriority');
const Supply = require('../src/GameServer/Bot/Population/RaidSupplyPolicy');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
const { RaidSearchCounters, LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const fixture = require('./fixtures/raid_priority_world.json');
const at = fixture.at;
Supply.useMarket(() => ({ npcOffersFor: id => invoke('GameServer/Bot/Economy/FixedShotOffers').offers(id), tripFrom: () => () => 0 }));
const members = fixture.expected.map(id => {
    const row = fixture.members.find(s => s.characterId === id);
    return { ...structuredClone(row), level: id === 2006587 ? 50 : row.level, accountName: `bot_${id}`,
        phase: 'cold', party: {}, updatedAt: at,
        stats: { ...row.stats, coldCombat: { ...row.captured,
            skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId,level]) => ({ selfId,level }))) } },
        inventory: Object.fromEntries(row.items.map(item => [item.selfId, { ...item }])) };
});
const golem = Catalog.findById('raid:10431'), kraven = Catalog.findById('raid:10418'), tree = Catalog.findById('raid:10099');
const options = { timestamp: at, fundSupplies: true };
(async () => {
    const original = JSON.stringify(members), raw = Data.npcs;
    const native = Policy.assessment(members, golem, options);
    assert(native.ready, JSON.stringify(native.reasons));
    let preparations = 0;
    const prepare = Policy.prepared;
    Policy.prepared = (...args) => { preparations++; return prepare(...args); };
    let result;
    try { result = Selection.assess(members, [tree, kraven, golem], options); }
    finally { Policy.prepared = prepare; }
    assert.equal(preparations, 1, 'all candidate bosses share one real party preparation');
    assert.equal(result.targetSelection.bossId, golem.raidBossTemplateId);
    const { targetSelection, ...checked } = result;
    assert.deepEqual(checked, native, 'full admission retains its native heal, defense, shot and duration verdict');
    assert.equal(targetSelection.seconds, native.seconds, 'screening and full admission use the same attack and guard-wave formulas');
    const limit = native.seconds;
    assert(Selection.assess(members, [golem], { ...options, maxFightSeconds: limit }).targetSelection.fullForecast,
        'the exact duration boundary remains eligible for native admission');
    const tooLong = Selection.assess(members, [golem], { ...options, maxFightSeconds: limit - .01 });
    assert.equal(tooLong.targetSelection.fullForecast, false);
    assert.equal(tooLong.targetSelection.rejected.raid_fight_too_long, 1);

    try {
        Data.npcs = raw.map(n => n.selfId === kraven.raidBossTemplateId
            ? { ...n, vitals: { ...n.vitals, maxHp: 3000, revHp: 300 } }
            : n.selfId === golem.raidBossTemplateId ? { ...n, vitals: { ...n.vitals, maxHp: 20000, revHp: 0 } } : n);
        assert(Priority.targetScore(kraven) < Priority.targetScore(golem), 'the old boss-only hint favours the small regenerating boss');
        const strong = Selection.assess(members, [kraven,golem], options);
        const weak = structuredClone(members);
        for (const s of weak) if (Policy.role(s) === 'damage')
            s.stats.coldCombat.base = { ...s.stats.coldCombat.base, str: 10 };
        const weaker = Selection.assess(weak, [kraven,golem], options);
        assert.equal(strong.targetSelection.bossId, kraven.raidBossTemplateId, 'strong damage can exploit the smaller high-regen boss');
        assert.equal(weaker.targetSelection.bossId, golem.raidBossTemplateId, 'the same targets produce a different choice for weaker DDs');
        assert(weaker.targetSelection.rejected.raid_damage_below_regeneration > 0);
        assert(!weaker.reasons.includes('raid_damage_below_regeneration'), 'a rejected candidate cannot poison the selected target verdict');
        Data.npcs = raw.map(n => [golem.raidBossTemplateId,kraven.raidBossTemplateId].includes(n.selfId)
            ? { ...n, vitals: { ...n.vitals, revHp: 1000000 } } : n);
        const impossible = Selection.assess(members, [kraven,golem], options);
        assert.equal(impossible.reason, 'raid_no_fast_target');
        assert.equal(impossible.targetSelection.fullForecast, false);
        assert.equal(impossible.targetSelection.rejected.raid_damage_below_regeneration, 2);
    } finally { Data.npcs = raw; }
    try {
        Data.npcs = raw.filter(n => n.selfId !== 10432);
        const unknown = Selection.assess(members, [golem], options);
        assert.equal(unknown.targetSelection.unknown, 1);
        assert(unknown.targetSelection.fullForecast, 'missing guard data cannot become a speculative early rejection');
    } finally { Data.npcs = raw; }
    const bounded = Selection.assess(members, Catalog.all(), options);
    assert(bounded.targetSelection.considered <= LIMITS.targetCandidates);
    assert.equal(JSON.stringify(members), original, 'screening never consumes stock, mana or mutates native actors');
    const counters = new RaidSearchCounters(); counters.begin(at); counters.forecast(tooLong,0);
    assert.equal(counters.total.fullForecasts,0);
    assert.equal(counters.total.skippedTargets,1);
    assert.equal(counters.rejections.target.raid_fight_too_long,1);

    // Exercise native main-side routing: the selected boss can differ from
    // the first generic hint, and its exact ID must reach reservation.
    let requested, reserved;
    const score = Priority.targetScore;
    Priority.targetScore = s => s.raidBossTemplateId === tree.raidBossTemplateId ? 0 : 1;
    const byId = new Map(members.map(s => [s.characterId,s]));
    const targets = [tree,kraven,golem];
    const service = new OpportunisticRaidDirector({ now: () => at,
        config: { opportunisticRaidSearchIntervalMs:60000,opportunisticRaidIntervalMs:900000,
            opportunisticRaidMemberCooldownMs:1800000,opportunisticRaidAliveFraction:.5,
            opportunisticRaidMaxParties:2,opportunisticRaidExpeditionMs:2700000 },
        database:{ execute:async()=>[] },
        life:{ cachedState:id=>byId.get(id), statesByIds:async ids=>ids.map(id=>byId.get(id)),
            subscribePublications:fn=>{ members.forEach(s=>fn({characterId:s.characterId}));return()=>{}; } },
        parties:{ admitted:()=>[],subscribeChanges:()=>()=>{} },
        memory:{ ensureMany:async()=>{},assess:()=>({ready:true,disposition:'neutral',effective:{hostility:0}}) },
        canWork:()=>true,bossFree:()=>true,
        catalog:{ all:()=>targets,liveTemplateIds:()=>new Set(targets.map(s=>s.raidBossTemplateId)) },
        assess:async (roster,spot,now,terms)=>{ requested=spot.raidBossTemplateId;
            return {...Selection.assess(roster,terms.targets,{...options,timestamp:now}),workMs:20}; },
        preparations:{ start:async()=>{},stop:()=>{},snapshot:()=>[],admitted:()=>[],maintain:async()=>{},
            reserve:async (roster,objective)=>{ reserved=objective;return{id:'target-prep',memberIds:roster.map(s=>s.characterId),startedAt:at}; } },
        form:async (_roster,objective)=>{reserved=objective;return{partyId:'target-party',memberIds:members.map(s=>s.characterId),startedAt:at};} });
    try {
        await service.start(); await service.pulse(at);
        assert.equal(requested,tree.raidBossTemplateId);
        assert.equal(reserved.raidBossTemplateId,golem.raidBossTemplateId);
        assert.equal(reserved.spotId,golem.id);
        assert.equal(service.snapshot().search.lastForecast.bossId,golem.raidBossTemplateId);
    } finally { service.stop(); Priority.targetScore=score; }
    console.log('Roster damage, boss regeneration, native guard waves, safe duration pruning and selected-target admission passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

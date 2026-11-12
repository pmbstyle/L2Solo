'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Supply = require('../src/GameServer/Bot/Population/RaidSupplyPolicy');
const Fixed = require('../src/GameServer/Bot/Economy/FixedShotOffers');
const Raid = require('../src/GameServer/Clan/ClanRaidPolicy');
const Estimate = require('../src/GameServer/Clan/ClanRaidEstimate');
const Expedition = require('../src/GameServer/Clan/ClanRaidExpedition');
const Roster = require('../src/GameServer/Clan/ClanRaidRoster');
const Casualty = require('../src/GameServer/Bot/Population/RaidCasualtyPolicy');
Supply.useMarket(() => ({ npcOffersFor: id => Fixed.offers(id), tripFrom: () => () => 0 }));
const fixture = require('./fixtures/raid_priority_world.json'), timestamp = Date.now();
const core = fixture.expected.map(id => {
    const row = fixture.members.find(s => s.characterId === id);
    return { ...row, characterId: id, classId: row.stats.classId, clanId: 77, level: id === 2006587 ? 50 : row.level,
        phase: 'cold', activity: 'hunting', partyId: null, party: {}, adena: 100000000,
        stats: { ...row.stats, clanId: 77, money: [100000000,0,0,0], coldCombat: { ...row.captured,
            skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId,level]) => ({selfId,level}))) } },
        inventory: Life.inventorySummaryFromItems(row.items) };
});
const spot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const clan = members => ({ id: 77, members });
const normal = Raid.assessment(clan(core), spot, null, { timestamp, desiredMembers: 9 });
assert(normal.ready, JSON.stringify(normal.raidAssessment));
const dd = core.find(member => Raid.raidRole(member) === 'damage');
const helpers = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(dd), characterId: 8000000+i }));
const limit = normal.raidAssessment.seconds * .85;
const input = { timestamp, desiredMembers: 9, maxFightSeconds: limit };
assert.equal(Raid.assessment(clan(core), spot, null, input).reason, 'raid_fight_too_long');
const expanded = Raid.assessment(clan([...core,...helpers]), spot, null, input);
assert(expanded.ready, JSON.stringify(expanded.raidAssessment));
assert.equal(expanded.eligible.length, 18, 'one extra party is the fixed work bound');
assert.equal(expanded.coreMemberIds.length, 9);
assert(expanded.raidAssessment.seconds < normal.raidAssessment.seconds);
assert.equal(expanded.raidAssessment.defense.tankId, normal.raidAssessment.defense.tankId);
const purchased = expanded.eligible.map(state => {
    const next = structuredClone(state);
    next.adena = 0; next.stats.money = [0,0,0,0];
    const plan = expanded.raidAssessment.shotPlans.find(plan => plan.id === next.characterId);
    if (plan) next.inventory[plan.selfId] = { selfId: plan.selfId, amount: plan.required, stackable: true };
    return next;
});
const physical = Estimate.estimate(purchased, spot, new Map(), { timestamp, clanId: 77,
    coreMemberIds: expanded.coreMemberIds, unchargedHelperIds: expanded.unchargedHelperIds, fundSupplies: false, maxFightSeconds: limit });
assert(physical.assessment.ready, JSON.stringify(physical.assessment.reasons));
assert.equal(physical.assessment.grossDps, expanded.raidAssessment.grossDps,
    'spending the wallet on the planned stock cannot downgrade charged helpers at physical opening');
const marker = { clanId: 77, ownerSection: 'goal', goalKey: 'raid:test', generation: 'test',
    sourceId: spot.id, npcId: spot.raidBossTemplateId, raidInstanceId: 'instance',
    memberIds: expanded.eligible.map(s => s.characterId), coreMemberIds: expanded.coreMemberIds, minPartySize: 18, maxPartySize: 18 };
assert(Roster.valid(marker));
assert(!Roster.valid({ ...marker, coreMemberIds: marker.coreMemberIds.slice(1) }));
assert(!Roster.same(marker, { ...marker, coreMemberIds: [...marker.coreMemberIds.slice(1),helpers[0].characterId] }));
const helper = expanded.eligible.find(member => !marker.coreMemberIds.includes(member.characterId));
const owned = expanded.eligible.map(s => ({ ...s, stats: { ...s.stats, clanPartyObjective: { fullRoster: marker } } }));
assert.equal(Expedition.partyMembers(owned, marker, helper).length, 9);
assert.equal(Expedition.partyMembers(owned, marker, core[0]).length, 9);
assert(Expedition.partyMembers(owned, marker, helper).every(s => !marker.coreMemberIds.includes(s.characterId)));
const helperHealer = { ...owned.find(s => s.characterId === helper.characterId), classId: 16,
    stats: { ...owned.find(s => s.characterId === helper.characterId).stats, classId: 16 } };
assert.equal(Casualty.disposition(helperHealer, { previousDamageCasualties: 50 }), 'continue');
assert.equal(Casualty.disposition(owned.find(s => Raid.raidRole(s) === 'tank')), 'fail_critical_role');
const poor = helpers.slice(0,2).map(s => ({ ...s, adena: 0, inventory: {}, stats: { ...s.stats, money: [0,0,0,0] } }));
const poorEstimate = Estimate.estimate([...core,...poor], spot, new Map(), { timestamp, clanId: 77, coreMemberIds: core.map(s => s.characterId) });
assert(poorEstimate.assessment.ready, JSON.stringify(poorEstimate.assessment.reasons));
assert(!poorEstimate.assessment.reasons.includes('raid_equipment'), 'helper armor is optional');
assert(!poorEstimate.assessment.reasons.includes('raid_consumables_funds'), 'uncharged helper attacks need no purchase authority');
assert(!poorEstimate.assessment.shotPlans?.some(plan => poor.some(s => s.characterId === plan.id)));
const tooHigh = helpers.map(s => ({ ...s, level: spot.avgLevel+9 }));
assert.equal(Raid.assessment(clan([...core,...tooHigh]), spot, null, input).reason, 'raid_fight_too_long');
const foreign = helpers.map(s => ({ ...s, clanId: 88 }));
assert.equal(Raid.assessment(clan([...core,...foreign]), spot, null, input).reason, 'raid_fight_too_long');
const Recovery = require('../src/GameServer/Clan/ClanRaidHelperRecovery');
const ColdCombat = invoke('GameServer/Bot/Population/BackgroundResolver').combat;
const controller = { profile: { level: 50, mAtk: 1000, skills: [{ selfId: 1201, level: 1, mp: 1, spell: true }] },
    vitals: { hp: 100, mp: 100 } };
const guarded = { raidMinionCount: 1, level: 50, mDef: 100 };
assert(ColdCombat.coldRaidControlCapacity([controller], guarded) > 0);
controller.vitals.hp = 0;
assert.equal(ColdCombat.coldRaidControlCapacity([controller], guarded), 0, 'fallen helpers provide no imaginary minion control');
const nativeHelper = owned.find(s => s.characterId === helper.characterId);
const profile = Combat.profileFor(nativeHelper, timestamp);
const dead = { ...nativeHelper, vitals: { hp: 0, maxHp: profile.maxHp, mp: 0, maxMp: profile.maxMp } };
const first = Recovery.recover(marker, [core[0],dead], timestamp, 15000).get(dead.characterId);
assert.equal(first.nextResolveAt, timestamp + Recovery.RESTART_MS);
const waiting = { ...dead, stats: first.patch.stats };
const recovered = Recovery.recover(marker, [core[0],waiting], first.nextResolveAt, 15000);
assert.equal(recovered.size, 1, 'helper recovery never rests/heals the core for free');
const restarted = recovered.get(dead.characterId);
assert.equal(restarted.patch.clearDeathExperience, 'restart_to_town');
assert(restarted.patch.vitals.hp > 0);
let returning = { ...waiting, ...restarted.patch }, previousAt = first.nextResolveAt, at = restarted.nextResolveAt;
for (let step = 0; step < 20 && returning.stats.raidHelperRecovery; step++) {
    const rested = Recovery.recover(marker, [returning], at, at - previousAt).get(dead.characterId);
    returning = { ...returning, ...rested.patch };
    previousAt = at; at = Math.max(at + 15000, rested.nextResolveAt);
}
assert.equal(returning.stats.raidHelperRecovery, null, 'native rest and preparation return the helper to combat');
const RaidCombat = require('../src/GameServer/Bot/AI/PartyRaidCombat');
const mainTank = { actor: { fetchId: () => core.find(s => Raid.raidRole(s) === 'tank').characterId, fetchClassId: () => 4 } };
const helperTank = { actor: { fetchId: () => helper.characterId, fetchClassId: () => 4 } };
assert.equal(RaidCombat.mainRaidTank([helperTank,mainTank], { leaderId: helper.characterId, stats: { objective: { fullRoster: marker } } }), mainTank);
const lifecycle = require('node:child_process').spawnSync(process.execPath, ['--require', require.resolve('./helpers/databaseIsolation'),
    require.resolve('./test_clan_full_raid_roster'), '--helpers'], { stdio: 'inherit', env: process.env });
assert.equal(lifecycle.status, 0, 'the expanded native roster passes atomic cold/hot opening and single reward regressions');
const forming = require('node:child_process').spawnSync(process.execPath, ['--require', require.resolve('./helpers/databaseIsolation'),
    require.resolve('./test_clan_full_raid_roster'), '--forms'], { stdio: 'inherit', env: process.env });
assert.equal(forming.status, 0, 'an expedition of eighteen far members forms through the worker');
console.log('PASS clan helper selection, party scope, ordinary attacks, recovery, main tank and expanded native lifecycle');

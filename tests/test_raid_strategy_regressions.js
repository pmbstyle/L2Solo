const assert = require('node:assert/strict');
require('../src/Global');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Skill = invoke('GameServer/Model/Skill');
const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const Heal = invoke('GameServer/Bot/AI/PartyHealPolicy');
const Cold = require('../src/GameServer/Bot/Population/ColdRaidEncounter');
const Scope = invoke('GameServer/RaidBoss/RaidEncounterScope');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Index = invoke('GameServer/World/RaidEntityIndex');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
function actor(id, classId, hp = 1000) {
    const a = { hp, effects: {}, skills: [], fetchId: () => id, fetchClassId: () => classId,
        fetchClanId: () => 7, fetchHp: () => a.hp, fetchMaxHp: () => 1000,
        fetchMp: () => 1000, fetchMaxMp: () => 1000, fetchLocX: () => 0, fetchLocY: () => 0,
        canUseSkill: () => true, state: { fetchDead: () => false },
        skillset: { get skills() { return a.skills; }, fetchSkill: id => a.skills.find(s => s.fetchSelfId() === id) } };
    return a;
}
for (const [classId, id] of [[52, 1229], [51, 1256]]) {
    const orc = actor(1, classId), tank = actor(2, 33, 200);
    const skill = new Skill({ selfId: id, level: 1, passive: false, mp: 50 });
    orc.skills = [skill];
    assert.equal(Capabilities.healSkills(orc).length, 1);
    const owner = {}, casts = [];
    const context = { owner, raid: true, members: [orc, tank].map(actor => ({ actor })), threats: [] };
    assert(Tactics.support({ actor: orc, hotBackgroundPartyId: 'raid' }, orc, context,
        { skillExec: (_s, _a, data) => casts.push(data) }, 1000));
    assert.equal(casts[0].selfId, id, 'real WC/OL periodic healing is dispatched at critical tank HP');
    tank.effects.hot = { id, key: skill.fetchSemantic().effect, level: 1, type: 'buff', expiresAt: Date.now() + 15000 };
    assert.equal(Tactics.support({ actor: orc, hotBackgroundPartyId: 'raid' }, orc, context,
        { skillExec() { throw Error('must not refresh active HoT'); } }, 5000), false);
    if (classId === 51) {
        tank.effects = {}; tank.fetchClanId = () => 8;
        assert.equal(Tactics.support({ actor: orc, hotBackgroundPartyId: 'raid' }, orc, context,
            { skillExec() { throw Error('foreign clan cannot receive this heal'); } }, 6000), false);
    }
}
const economical = { missingHp: 300, maxHp: 1000, power: 300, cost: 30, castMs: 1000 };
const singer = actor(20, 21);
singer.skills = [new Skill({ selfId: 264, level: 1, passive: false, mp: 20, buff: 120000 })];
singer.state.fetchHits = () => true;
const musicOptions = { musicOnly: true, allowAttackInterrupt: true };
const songAction = Support.nextPartyAction([{ actor: singer }], [singer], musicOptions);
assert(songAction, 'real buff planner must renew music during a native melee cycle');
assert.equal(songAction.skill.fetchSelfId(), 264);
assert.equal(Support.nextPartyAction([{ actor: singer }], [singer], { musicOnly: true }), null,
    'ordinary preparation still respects busy actors');
singer.state.fetchCasts = () => true;
assert.equal(Support.nextPartyAction([{ actor: singer }], [singer], musicOptions), null,
    'music never interrupts another cast');
const buffer = actor(30, 17);
buffer.skills = [1040, 1068, 1086, 1085, 1059].map(selfId => new Skill({ selfId, level: 1,
    passive: false, mp: 20, buff: 1200000, distance: 600 }));
const recoveryOptions = { raidRecovery: true, allowAttackInterrupt: true };
const giveBuff = (target, selfId) => {
    const skill = buffer.skills.find(skill => skill.fetchSelfId() === selfId);
    const key = skill.fetchSemantic().effect;
    target.effects[key] = { id: selfId, key, type: 'buff', level: 1, expiresAt: Date.now() + 60000 };
};
for (const [classId, expected] of [[9, [1068, 1086]], [21, [1068, 1086]], [11, [1085, 1059]]]) {
    const dd = actor(30 + classId, classId), members = [{ actor: dd }];
    assert.equal(Support.nextPartyAction(members, [buffer]).skill.fetchSelfId(), 1040,
        'full preparation may prioritize shield');
    buffer.state.fetchCasts = () => true;
    assert(Support.hasPendingAction(members, [buffer], recoveryOptions), 'briefly busy buffer keeps the bounded wait');
    buffer.state.fetchCasts = () => false;
    const first = Support.nextPartyAction(members, [buffer], recoveryOptions);
    assert(expected.includes(first.skill.fetchSelfId()), 'recovery must not request the full preparation package');
    giveBuff(dd, first.skill.fetchSelfId());
    const second = Support.nextPartyAction(members, [buffer], recoveryOptions);
    assert(expected.includes(second.skill.fetchSelfId()) && second.skill.fetchSelfId() !== first.skill.fetchSelfId());
    giveBuff(dd, second.skill.fetchSelfId());
    dd.supportReservations = { might: { expiresAt: Date.now() + 5000 }, empower: { expiresAt: Date.now() + 5000 } };
    assert.equal(Support.nextPartyAction(members, [buffer], recoveryOptions), null);
    assert.equal(Support.hasPendingAction(members, [buffer], recoveryOptions), false,
        'landed minimal buffs release DD immediately without stronger/longer buffs or old reservations');
}
const remoteDd = actor(70, 9); remoteDd.fetchLocX = () => 2000;
assert.equal(Support.hasPendingAction([{ actor: remoteDd }], [buffer], recoveryOptions), false);
assert.equal(Support.nextPartyAction([{ actor: remoteDd }], [buffer], recoveryOptions), null);
const chantingOrc = actor(71, 52), physicalDd = actor(72, 9);
chantingOrc.skills = [1007, 1251].map(selfId => new Skill({ selfId, level: 1, passive: false, mp: 20, buff: 1200000 }));
const chant = Support.nextPartyAction([{ actor: physicalDd }], [chantingOrc], recoveryOptions);
assert(chant && [1007, 1251].includes(chant.skill.fetchSelfId()), 'native orc equivalents satisfy the minimal physical package');
assert(Heal.score(economical) > Heal.score({ ...economical, power: 1000, cost: 150 }), 'overhealing is not useful power');
assert(Heal.score({ ...economical, missingHp: 900 }) > Heal.score({ ...economical, missingHp: 900, castMs: 5000 }), 'emergencies prefer fast healing');
assert(Heal.score({ ...economical, missingHp: 900 }) > Heal.score({ ...economical, missingHp: 900, periodic: true, ticks: 15 }));

const recharger = actor(10, 43), archer = actor(11, 9), secondHealer = actor(12, 16);
recharger.skills = [new Skill({ selfId: 1013, level: 1, passive: false, mp: 100, distance: 600 })];
archer.fetchMp = secondHealer.fetchMp = () => 10;
let recharges = 0;
const rechargeContext = { owner: {}, raid: true, threats: [], members: [recharger, archer].map(actor => ({ actor })) };
const castRecharge = { skillExec() { recharges++; } };
assert.equal(Tactics.support({ actor: recharger }, recharger, rechargeContext, castRecharge, 1000), false,
    'a raid healer must not spend the healing reserve on archer mana');
rechargeContext.members.push({ actor: secondHealer });
assert(Tactics.support({ actor: recharger }, recharger, rechargeContext, castRecharge, 1100));
assert.equal(recharges, 1);
recharger.fetchMp = () => 650;
assert.equal(Tactics.support({ actor: recharger }, recharger, rechargeContext, castRecharge, 1200), false,
    'recharge cannot cross the raid healing reserve after paying its cost');

const a = { partyId: 'a' }, b = { partyId: 'b' }, spot = { raidBossTemplateId: 10484, raidInstanceId: 'spawn-one' };
let shared = Cold.begin(a, spot, 10484, 100);
shared = Cold.record(a, shared, { encounter: { hp: 600, mob: { maxHp: 1000 } } }, 200);
shared = Cold.record(b, Cold.begin(b, spot, 10484, 210), { encounter: { hp: 400, mob: { maxHp: 1000 } } }, 220);
Cold.fail(a, shared, 230);
assert.equal(Cold.begin(b, spot, 10484, 240).hp, 400, 'one defeated clan cannot heal a contested boss');
Cold.fail(b, shared, 250);
assert.equal(Cold.begin(a, spot, 10484, 260).hp, 1000, 'the last departing clan resets the boss');
const defeated = Cold.record(a, Cold.begin(a, spot, 10484, 270), { won: true }, 280);
assert.equal(Cold.begin(b, spot, 10484, 290).status, 'defeated');
const respawn = Cold.begin({ ...a, stats: { raidEncounter: defeated } }, { ...spot, raidInstanceId: 'spawn-two' }, 10484, 300);
assert.equal(respawn.status, 'active', 'a new spawn invalidates both shared and persisted death state');
assert.equal(respawn.hp, null);
assert.equal(Cold.record(a, defeated, { won: true }, 310).status, 'active', 'stale work cannot kill the new generation');
Cold.resetForTests();

const oldEntities = Index.entitiesForRaid;
const boss = { fetchId: () => 90, fetchSelfId: () => 10484, fetchDestId: () => 1 };
try {
    Index.entitiesForRaid = () => [boss];
    const outsider = actor(8, 9); outsider.fetchDestId = () => 90; outsider.state.fetchHits = () => true;
    const world = { user: { sessions: [{ actor: outsider }] } };
    assert(Scope.otherParticipants(world, boss, [1, 2]), 'an attacking player protects the shared fight');
    outsider.state.fetchHits = () => false;
    assert.equal(Scope.otherParticipants(world, boss, [1, 2]), false, 'an observer merely selecting the boss does not block reset');
    boss.fetchDestId = () => 8;
    assert(Scope.otherParticipants(world, boss, [1, 2]), 'a player being attacked remains a participant between swings');
} finally { Index.entitiesForRaid = oldEntities; }

const source = { sourceKind: 'raid', raidRosterSize: 9, expectedYield: 1,
    raidEstimate: { fightSeconds: 120, preparationSeconds: 90, recoverySeconds: 60, successChance: 0.9 } };
const cheap = Gear.sourceEffort(source);
assert(Gear.sourceEffort({ ...source, raidEstimate: { ...source.raidEstimate, fightSeconds: 300 } }) > cheap);
assert(Gear.sourceEffort({ ...source, raidEstimate: { ...source.raidEstimate, successChance: 0.3 } }) > cheap);
assert(Gear.sourceEffort({ ...source, raidEstimate: { ...source.raidEstimate, preparationSeconds: 300 } }) > cheap);

const ColdCombat = invoke('GameServer/Bot/Population/BackgroundResolver').combat;
const caster = { state: { characterId: 1, clanId: 7 }, now: 10000,
    profile: { skills: [{ selfId: 1229, level: 1, mp: 50 }], effects: [] }, vitals: { hp: 1000, maxHp: 1000 } };
const injured = { state: { characterId: 2, clanId: 7 }, profile: { effects: [] }, vitals: { hp: 200, maxHp: 1000 } };
const periodic = ColdCombat.chooseHeal(caster.profile, [caster, injured], 1000, {}, 10000, caster);
assert(periodic, 'cold WC can also select its periodic heal');
ColdCombat.applyAllyHeal(caster, [caster, injured], periodic);
assert.equal(injured.vitals.hp, 200, 'periodic healing must not be granted instantly');
ColdCombat.applyPartyHotTicks(injured, 11000);
assert.equal(injured.vitals.hp, 212);
assert.equal(ColdCombat.chooseHeal(caster.profile, [caster, injured], 1000, {}, 11000, caster), null, 'cold HoTs are not repeatedly reapplied');
injured.vitals.hp = 0;
ColdCombat.applyPartyHotTicks(injured, 12000);
assert.equal(injured.vitals.hp, 0, 'periodic healing cannot resurrect a corpse');

const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Estimate = invoke('GameServer/Clan/ClanRaidEstimate');
// Clan economics now consume an admitted shared forecast, rather than the
// old soft estimate made from incomplete synthetic combat profiles. Actual
// damage/cache/shot parity is exercised in test_clan_raid_assessment; native
// mage cast speed/reuse/MP/shot budgets in test_clan_raid_mage_offense, and
// native healing cast timing and HoT budgets in test_raid_healing_estimate.
invoke('GameServer/DataCache').init();
const actualSpot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById('raid:10372');
// Owned characters fight with their learned kit only (113e1791); the roster
// carries the database-learned skills a level 40 member of each class has.
const actualEstimate = Estimate.estimate([4, 15, 52, 9, 21, 34, 2].map((classId, index) => {
    const state = { characterId: index + 100, level: 40, stats: { classId }, inventory: {} };
    state.stats.coldCombat = Combat.legacySnapshot(state, Combat.skillRecordsFromTree(classId, 40));
    return state;
}), actualSpot);
assert.equal(actualEstimate.assessment.ready, false, 'learned skills do not manufacture missing worn equipment');
assert(actualEstimate.assessment.reasons.includes('raid_equipment'));
assert.equal(actualEstimate.estimate, null, 'a rejected native roster has no profitable raid route');
console.log('Raid strategy: native orc healing, heal economy, contested resets, respawn generations and opportunity cost passed');

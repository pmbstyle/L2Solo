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
const savedProfile = Combat.profileFor, savedNpc = Combat.npcForSpot;
let profilesRead = 0;
try {
    Combat.profileFor = member => { profilesRead++; return { pAtk: member.pAtk, pDef: 500, maxHp: 5000,
        maxMp: 1000, atkSpd: 400, skills: [], effects: [] }; };
    Combat.npcForSpot = () => ({ maxHp: 50000, pAtk: 500, pDef: 300, atkSpd: 300 });
    const roster = [{ characterId: 1, classId: 33, pAtk: 500 }, { characterId: 2, classId: 9, pAtk: 500 }];
    const cache = new Map();
    const estimate = Estimate.estimate(roster, spot, cache);
    assert(Number.isFinite(estimate.fightSeconds) && estimate.fightSeconds > 0);
    Estimate.estimate(roster, spot, cache);
    assert.equal(profilesRead, 2, 'combat profiles are cached across the planning pass');
    assert(Estimate.estimate(roster.map(m => ({ ...m, pAtk: 1000 })), spot).fightSeconds < estimate.fightSeconds,
        'the economic estimate responds to real damage rather than just levels');
} finally { Combat.profileFor = savedProfile; Combat.npcForSpot = savedNpc; }
try {
    Combat.profileFor = member => ({ pAtk: 500, mAtk: 1000, pDef: 500, maxHp: 5000,
        maxMp: 20000, atkSpd: 400, castSpd: 333, skills: [], effects: [], ...member.profile });
    Combat.npcForSpot = () => ({ maxHp: 150000, pAtk: 2000, pDef: 300, mDef: 200, atkSpd: 300 });
    const tank = { characterId: 1, classId: 33 };
    const heal = { selfId: 1011, level: 1, spell: true, power: 1000, mp: 20, hitTime: 1000 };
    const healer = { characterId: 2, classId: 16, profile: { skills: [heal] } };
    const quickHeal = Estimate.estimate([tank, healer], spot);
    const slowHeal = Estimate.estimate([tank, { ...healer, profile: { skills: [{ ...heal, hitTime: 10000 }] } }], spot);
    assert.equal(quickHeal.healingBudget, slowHeal.healingBudget);
    assert(quickHeal.healingPerSecond > slowHeal.healingPerSecond);
    assert(quickHeal.successChance > slowHeal.successChance, 'equal MP budgets cannot hide insufficient healing throughput');
    const nuke = { selfId: 1230, level: 1, spell: true, power: 100, mp: 10, hitTime: 3000, reuse: 0 };
    const mage = { characterId: 3, classId: 12, profile: { pAtk: 10, skills: [nuke], castSpd: 300 } };
    const slow = Estimate.estimate([tank, healer, mage], spot);
    const fast = Estimate.estimate([tank, healer, { ...mage, profile: { ...mage.profile, castSpd: 900 } }], spot);
    assert(fast.damagePerSecond > slow.damagePerSecond && fast.fightSeconds < slow.fightSeconds,
        'mage damage follows learned spell casting speed, not melee attack speed');
    const reused = Estimate.estimate([tank, healer, { ...mage, profile: { ...mage.profile,
        skills: [{ ...nuke, reuse: 12000 }] } }], spot);
    assert(reused.damagePerSecond < slow.damagePerSecond, 'spell reuse limits damage');
    const exhausted = Estimate.estimate([tank, healer, { ...mage, profile: { ...mage.profile, maxMp: 50 } }], spot);
    assert(exhausted.damagePerSecond < slow.damagePerSecond, 'a mage cannot cast indefinitely without MP');
    const bowProfile = { equipment: { weaponKind: 'Weapon.Bow', attackReuseDelay: 1500 } };
    const bow = Estimate.estimate([{ characterId: 4, classId: 9, profile: bowProfile }], spot);
    const Formulas = invoke('GameServer/Formulas');
    const expected = Formulas.calcPhysicalDamage(500, 0, 300, 0) * 1000 / Formulas.calcBowAttackTimes(400, 1500).cycleMs;
    assert.equal(bow.damagePerSecond, expected, 'archer damage includes the native bow reuse cycle');
    const slowerBow = Estimate.estimate([{ characterId: 4, classId: 9,
        profile: { equipment: { weaponKind: 'Weapon.Bow', attackReuseDelay: 3000 } } }], spot);
    assert(slowerBow.damagePerSecond < bow.damagePerSecond);
} finally { Combat.profileFor = savedProfile; Combat.npcForSpot = savedNpc; }
invoke('GameServer/DataCache').init();
const actualSpot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById('raid:10372');
const actualEstimate = Estimate.estimate([4, 15, 52, 9, 21, 34, 2].map((classId, index) => ({
    characterId: index + 100, level: 40, stats: { classId }, inventory: {}
})), actualSpot);
assert(actualEstimate && Object.values(actualEstimate).every(Number.isFinite),
    'real NPC, class and learned-skill profiles produce a finite economic estimate');
assert(actualEstimate.healingBudget > 0 && actualEstimate.damagePerSecond > 0);
console.log('Raid strategy: native orc healing, heal economy, contested resets, respawn generations and opportunity cost passed');

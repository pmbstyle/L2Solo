const assert = require('assert');

require('../src/Global');

const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const World = invoke('GameServer/World/World');

function skill(id, name, level, effect, stats, target = 'friendly', type = null) {
    return {
        fetchSelfId: () => id,
        fetchName: () => name,
        fetchLevel: () => level,
        fetchPassive: () => false,
        fetchConsumedMp: () => 5,
        fetchTargetKind: () => target,
        fetchSkillType: () => type,
        fetchSemantic: () => ({ effectType: 'buff', effect, stats, target })
    };
}

let nextActorId = 1;
function actor(name, classId, skills = [], mp = 100, maxMp = 100, busy = false) {
    const id = nextActorId++;
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchClassId: () => classId,
        fetchMp: () => mp,
        fetchMaxMp: () => maxMp,
        skillset: { fetchSkills: () => skills },
        state: {
            fetchDead: () => false,
            fetchTowards: () => busy,
            fetchHits: () => false,
            fetchCasts: () => false
        }
    };
}

const shieldOne = skill(1040, 'Shield', 1, 'shield', { pDefMul: 1.08 });
const chantOfLife = skill(1229, 'Chant of Life', 1, 'chant_of_life', {}, 'friendly', 'hot');
const kissOfEva = skill(1073, 'Kiss of Eva', 2, 'kiss_of_eva', { breath: 7 });
const soulShieldTwo = skill(1010, 'Soul Shield', 2, 'soul_shield', { pDefMul: 1.12 });
const empower = skill(1059, 'Empower', 1, 'empower', { mAtkMul: 1.2 });
const shaman = actor('Noren', 49, [soulShieldTwo]);
const mage = actor('Saren', 25, [shieldOne]);
const target = actor('Slava', 0);

const policyProvider = actor('PolicyProvider', 25, [shieldOne, empower]);
policyProvider.session = { actor: policyProvider };
HotBotPolicyOverlay.set(policyProvider.session, {
    // This is a legacy persisted allow-list. It must not make support
    // rotation exclusive after the policy semantics changed to deny-only.
    buffPolicy: { allowed: ['shield'], excluded: [] }
}, { ownerId: 1 });
assert.strictEqual(BotSupportPlanner.supportSkills(policyProvider).length, 2, 'allowing one buff must not disable the other useful party buffs');
HotBotPolicyOverlay.clear(policyProvider.session, 'test_reset');

assert.deepStrictEqual(
    BotSupportPlanner.supportSkills(actor('ChantBuffer', 49, [chantOfLife])),
    [],
    'a short heal-over-time effect must not enter the persistent party-buff planner'
);
assert.deepStrictEqual(
    BotSupportPlanner.supportSkills(actor('EvaBuffer', 15, [kissOfEva])),
    [],
    'Kiss of Eva must not enter the ordinary party-buff planner'
);

target.activeBuffs = { shield: Date.now() + (10 * 60 * 1000) };
assert.strictEqual(
    BotSupportPlanner.needsSkill(target, shieldOne),
    true,
    'a legacy UI marker without a structured effect must not block a rebuff'
);

EffectStore.apply(target, { key: 'shield', id: 1040, level: 2, type: 'buff', durationMs: 10 * 60 * 1000 });
assert.strictEqual(
    BotSupportPlanner.needsSkill(target, shieldOne),
    false,
    'a legacy structured newbie Shield without stats must still block a lower-level recast'
);
EffectStore.remove(target, 'shield');

EffectStore.apply(target, { key: 'legacy_mental_shield', id: 1035, level: 1, type: 'buff', durationMs: 10 * 60 * 1000 });
const mentalShield = skill(1035, 'Mental Shield', 1, 'mental_shield', { rootResist: 20, sleepResist: 20, mentalResist: 20 });
assert.strictEqual(
    BotSupportPlanner.needsSkill(target, mentalShield),
    false,
    'an active buff with the same native skill id must block duplicate support casts even when its legacy key differs'
);
EffectStore.remove(target, 'legacy_mental_shield');

EffectStore.apply(target, { key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
assert.strictEqual(BotSupportPlanner.needsSkill(target, shieldOne), false, 'do not overwrite an equal-level active buff');
assert.strictEqual(BotSupportPlanner.needsSkill(target, soulShieldTwo), true, 'upgrade an active defensive buff when the party has a higher level');

EffectStore.apply(target, { key: 'shield', id: 1040, level: 3, type: 'buff', stats: { pDefMul: 1.2 }, durationMs: 10 * 60 * 1000 });
const rejectedDowngrade = EffectStore.apply(target, { key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
assert.strictEqual(rejectedDowngrade, null, 'runtime effect storage must report a lower-level buff as rejected');
assert.strictEqual(EffectStore.list(target).find((effect) => effect.key === 'shield').level, 3, 'a rejected lower-level buff must not replace the active stronger level');
EffectStore.remove(target, 'shield');

let action = BotSupportPlanner.nextAction(mage, [{ actor: target, leader: true }], [shaman, mage]);
assert.strictEqual(action, null, 'a non-orc caster should defer an equivalent upgrade to the shaman');
action = BotSupportPlanner.nextAction(shaman, [{ actor: target, leader: true }], [shaman, mage]);
assert.strictEqual(action.skill.fetchSelfId(), 1010, 'the shaman should take the defensive-buff upgrade first');

EffectStore.remove(target, 'shield');
const request = BotSupportPlanner.rebuffRequest(target, [mage, shaman]);
assert.strictEqual(request.provider, shaman, 'expired buffs should ask the highest-priority party provider first');
assert.strictEqual(request.effect, 'soul_shield');

const sharedShield = skill(2040, 'Shared Shield', 2, 'shield', { pDefMul: 1.12 });
const lowManaMage = actor('LowManaMage', 25, [sharedShield], 30);
const highManaMage = actor('HighManaMage', 25, [sharedShield], 80);
const unbuffedTarget = actor('Unbuffed', 0);
assert.strictEqual(
    BotSupportPlanner.nextAction(lowManaMage, [{ actor: unbuffedTarget, leader: true }], [lowManaMage, highManaMage]),
    null,
    'only the higher-MP owner should cast an identical missing buff'
);
action = BotSupportPlanner.nextAction(highManaMage, [{ actor: unbuffedTarget, leader: true }], [lowManaMage, highManaMage]);
assert.strictEqual(action.skill.fetchSelfId(), 2040, 'the higher-MP owner should cast the shared buff');
BotSupportPlanner.reserve(action);
assert.strictEqual(
    BotSupportPlanner.nextAction(highManaMage, [{ actor: unbuffedTarget, leader: true }], [lowManaMage, highManaMage]),
    null,
    'the same effect should stay reserved until the first caster finishes'
);

const partyShield = skill(3040, 'Party Shield', 1, 'party_shield', { pDefMul: 1.08 }, 'party');
const partyCaster = actor('PartyCaster', 25, [partyShield], 40);
const singleCaster = actor('SingleCaster', 25, [sharedShield], 100);
const partyTarget = actor('PartyTarget', 0);
assert.strictEqual(
    BotSupportPlanner.nextAction(singleCaster, [{ actor: partyTarget, leader: true }], [singleCaster, partyCaster]),
    null,
    'a mass buff should take priority over an individual buff in the same support pass'
);
action = BotSupportPlanner.nextAction(partyCaster, [{ actor: partyTarget, leader: true }], [singleCaster, partyCaster]);
assert.strictEqual(action.skill.fetchSelfId(), 3040, 'the mass buff provider should be selected first');

EffectStore.apply(partyTarget, { key: 'party_shield', id: 3040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
const newPartyMember = actor('NewPartyMember', 0);
action = BotSupportPlanner.nextAction(
    partyCaster,
    [{ actor: partyTarget, leader: true }, { actor: newPartyMember, leader: false }],
    [partyCaster]
);
assert.strictEqual(action.target, newPartyMember, 'a newly added unbuffed member should start the next party-buff pass');

const might = skill(1068, 'Might', 2, 'might', { pAtkMul: 1.12 });
const concentration = skill(1078, 'Concentration', 3, 'concentration', { cancelAdd: -36 });
const berserkerSpirit = skill(1062, 'Berserker Spirit', 2, 'berserker_spirit', { pAtkMul: 1.08, pDefMul: 0.92 });
const blessShield = skill(1243, 'Bless Shield', 1, 'bless_shield', { rShldMul: 1.05 });
const roleAwareBuffer = actor('RoleAwareBuffer', 49, [might, concentration]);
const roleMage = actor('RoleMage', 25);
const roleArcher = actor('RoleArcher', 9);
const roleTank = actor('RoleTank', 4);
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleMage, might), false, 'Might should not be assigned to a mage');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleArcher, might), true, 'Might should be assigned to an archer');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleArcher, concentration), false, 'Concentration should not be assigned to a physical fighter');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleMage, concentration), true, 'Concentration should be assigned to a caster');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleTank, berserkerSpirit), false, 'Berserker Spirit should not lower a tank\'s defences');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleMage, berserkerSpirit), false, 'Berserker Spirit should not be assigned to a caster');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleArcher, berserkerSpirit), true, 'Berserker Spirit should be assigned to a damage dealer');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleMage, blessShield), true, 'defensive shield buffs should remain available to casters');
const physicalBuffer = actor('PhysicalBuffer', 49, [might]);
action = BotSupportPlanner.nextAction(physicalBuffer, [
    { actor: roleMage, leader: true },
    { actor: roleArcher, leader: false }
], [physicalBuffer]);
assert.strictEqual(action.target, roleArcher, 'the next individual physical buff should skip the mage and target the archer');
assert.strictEqual(action.skill.fetchSelfId(), 1068, 'the physical buff should be chosen for the physical target');
assert.strictEqual(BotSupportPlanner.isUsefulForTarget(roleMage, partyShield), true, 'party buffs should remain available to every party role');

const fullPackageBuffer = actor('FullPackageBuffer', 49, [might, concentration]);
const packageArcher = actor('PackageArcher', 9);
const packageMage = actor('PackageMage', 25);
action = BotSupportPlanner.nextAction(fullPackageBuffer, [
    { actor: packageArcher, leader: true },
    { actor: packageMage, leader: false }
], [fullPackageBuffer]);
assert.strictEqual(action.skill.fetchSelfId(), 1068, 'an autonomous buffer should start its full package with the first eligible member');
EffectStore.apply(packageArcher, { key: 'might', id: 1068, level: 2, type: 'buff', stats: { pAtkMul: 1.12 }, durationMs: 10 * 60 * 1000 });
action = BotSupportPlanner.nextAction(fullPackageBuffer, [
    { actor: packageArcher, leader: true },
    { actor: packageMage, leader: false }
], [fullPackageBuffer]);
assert.strictEqual(action.skill.fetchSelfId(), 1078, 'after a successful cast, the autonomous buffer should advance to the next needed party buff without another request');
assert.strictEqual(action.target, packageMage, 'the next planned buff should target its eligible party member');

const pullPriorityBuffer = actor('PullPriorityBuffer', 49, [sharedShield]);
const ordinaryLeader = actor('OrdinaryLeader', 0);
const designatedPuller = actor('DesignatedPuller', 4);
action = BotSupportPlanner.nextAction(pullPriorityBuffer, [
    { actor: ordinaryLeader, leader: true },
    { actor: designatedPuller, leader: false, puller: true }
], [pullPriorityBuffer]);
assert.strictEqual(action.target, designatedPuller, 'a designated puller should receive missing individual buffs before the party leader');
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: designatedPuller, puller: true }], [pullPriorityBuffer]),
    true,
    'party pull should wait while a support action remains for its designated puller'
);

const exhaustedPullBuffer = actor('ExhaustedPullBuffer', 49, [sharedShield], 30, 100);
const exhaustedPuller = actor('ExhaustedPuller', 4);
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: exhaustedPuller, puller: true }], [exhaustedPullBuffer]),
    false,
    'party pull should not wait forever for a buff the provider will decline below its support MP reserve'
);

const silencedPullBuffer = actor('SilencedPullBuffer', 49, [sharedShield]);
const silencedPuller = actor('SilencedPuller', 4);
EffectStore.apply(silencedPullBuffer, { key: 'silence', id: 116, type: 'debuff', durationMs: 30000 });
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: silencedPuller, puller: true }], [silencedPullBuffer]),
    false,
    'party pull should not wait for a support cast while its only provider is silenced'
);

const travellingPullBuffer = actor('TravellingPullBuffer', 49, [sharedShield], 100, 100, true);
const travellingPuller = actor('TravellingPuller', 4);
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: travellingPuller, puller: true }], [travellingPullBuffer]),
    false,
    'party pull should not wait for a buff while its provider is still moving and cannot cast it'
);

const queuedSupportSession = {};
const queuedSupportTarget = actor('QueuedSupportTarget', 4);
const queuedSupportBuffer = actor('QueuedSupportBuffer', 49, [sharedShield]);
queuedSupportBuffer.session = queuedSupportSession;
action = BotSupportPlanner.nextAction(queuedSupportBuffer, [{ actor: queuedSupportTarget, leader: true }], [queuedSupportBuffer]);
assert.strictEqual(BotSupportPlanner.queueSupportCast(queuedSupportSession, action), true, 'support selection should queue the intended native cast');
assert.strictEqual(queuedSupportTarget.supportReservations, undefined, 'a queued movement/action must not masquerade as an accepted support cast');
queuedSupportBuffer.state.fetchTowards = () => true;
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: queuedSupportTarget, puller: true }], [queuedSupportBuffer]),
    true,
    'party pull should keep waiting while a selected support cast is walking into range'
);
queuedSupportBuffer.state.fetchTowards = () => false;
assert.strictEqual(BotSupportPlanner.beginSupportCast(queuedSupportSession, queuedSupportBuffer, queuedSupportTarget, action.skill), true, 'the reservation should begin only when the native cast starts');
assert(queuedSupportTarget.supportReservations, 'an accepted cast should reserve its target effect');
queuedSupportSession.currentTargetId = queuedSupportTarget.fetchId();
assert.strictEqual(BotSupportPlanner.finishSupportCast(queuedSupportSession, queuedSupportBuffer, action.skill), true, 'support cast completion should clear its lifecycle marker');
assert.strictEqual(queuedSupportSession.currentTargetId, undefined, 'a completed support cast must not leave a stale combat target behind');
assert.strictEqual(BotSupportPlanner.queueSupportCast(queuedSupportSession, action), true, 'a subsequent support cast should be queued normally');
assert.strictEqual(
    BotSupportPlanner.cancelPendingSupportCast(queuedSupportSession, queuedSupportBuffer, queuedSupportTarget, partyShield),
    false,
    'an unrelated rejected skill must not clear a queued support cast'
);
assert(queuedSupportSession.pendingSupportCast, 'an unrelated rejection should leave the selected support cast intact');
assert.strictEqual(
    BotSupportPlanner.cancelPendingSupportCast(queuedSupportSession, queuedSupportBuffer, queuedSupportTarget, action.skill),
    true,
    'a native rejection of the queued support skill must release its pending marker immediately'
);
assert.strictEqual(queuedSupportSession.pendingSupportCast, undefined, 'a rejected queued support cast must not pause party pulling until timeout');
assert.strictEqual(BotSupportPlanner.queueSupportCast(queuedSupportSession, action), true, 'a later retry should queue the support cast again');
assert.strictEqual(BotSupportPlanner.beginSupportCast(queuedSupportSession, queuedSupportBuffer, queuedSupportTarget, action.skill), true, 'the subsequent cast should enter its active lifecycle');
queuedSupportSession.currentTargetId = queuedSupportTarget.fetchId();
assert.strictEqual(BotSupportPlanner.cancelSupportCast(queuedSupportSession, queuedSupportBuffer), true, 'an interrupted support cast should be cancellable');
assert.strictEqual(queuedSupportSession.currentTargetId, undefined, 'a cancelled support cast must also clear its stale target');

const auraSkill = {
    ...partyShield,
    fetchDistance: () => -1,
    fetchSemantic: () => ({ effectType: 'buff', effect: 'party_shield', stats: { pDefMul: 1.08 }, target: 'party', radius: 1000 })
};
const auraBuffer = actor('AuraBuffer', 49, [auraSkill]);
auraBuffer.fetchLocX = () => 0;
auraBuffer.fetchLocY = () => 0;
const distantAuraPuller = actor('DistantAuraPuller', 4);
distantAuraPuller.fetchLocX = () => 1200;
distantAuraPuller.fetchLocY = () => 0;
assert.strictEqual(
    BotSupportPlanner.partyAuraCanReach(auraBuffer, distantAuraPuller, auraSkill),
    false,
    'a caster-centred party aura must not claim a puller beyond its native effect radius'
);
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: distantAuraPuller, puller: true }], [auraBuffer]),
    false,
    'a distant puller must not be frozen in approach for an aura that cannot reach it'
);
const auraSession = {};
auraBuffer.session = auraSession;
BotSupportPlanner.queueSupportCast(auraSession, { provider: auraBuffer, target: distantAuraPuller, skill: auraSkill });
assert.strictEqual(
    BotSupportPlanner.cancelPendingSupportCast(auraSession, auraBuffer, auraBuffer, auraSkill, 'reuse'),
    true,
    'a rejected caster-centred aura must clear the logical recipient reservation'
);

const cooldownBuffer = actor('CooldownBuffer', 49, [sharedShield]);
cooldownBuffer.canUseSkill = () => false;
assert.strictEqual(
    BotSupportPlanner.hasPendingAction([{ actor: actor('CooldownTarget', 4), puller: true }], [cooldownBuffer]),
    false,
    'a support skill on native reuse must not pause pulling or produce retry spam'
);

assert.strictEqual(BotSupportPlanner.situationalBuffUseful('holy_weapon', { undead: false }), false, 'Holy Weapon should stay out of a living-mob field package');
assert.strictEqual(BotSupportPlanner.situationalBuffUseful('holy_weapon', { undead: true }), true, 'Holy Weapon should enter an undead encounter package');
assert.strictEqual(BotSupportPlanner.situationalBuffUseful('resist_poison', { poison: true }), true, 'Resist Poison should enter a poison encounter package');
assert.strictEqual(BotSupportPlanner.situationalBuffUseful('decrease_weight', {}), false, 'Decrease Weight should remain on-demand without authoritative load pressure');

const originalNpcWorld = World.npc;
const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const holyWeapon = skill(1043, 'Holy Weapon', 1, 'holy_weapon', { holyAttack: 20 });
const holyBuffer = actor('HolyBuffer', 17, [holyWeapon]);
holyBuffer.fetchLocX = () => 0;
holyBuffer.fetchLocY = () => 0;
const holyTarget = actor('HolyTarget', 0);
holyTarget.fetchLocX = () => 10;
holyTarget.fetchLocY = () => 0;
const corruptedKnight = {
    fetchId: () => 9001,
    fetchName: () => 'Corrupted Knight',
    fetchAttackable: () => true,
    fetchUndead: () => true,
    fetchDestId: () => holyTarget.fetchId(),
    fetchLocX: () => 50,
    fetchLocY: () => 0,
    isDead: () => false,
    skillset: { fetchSkills: () => [] }
};
World.npc = { grid: {}, spawns: [corruptedKnight] };
World.fetchNpcsInRadius = () => [corruptedKnight];
action = BotSupportPlanner.nextAction(holyBuffer, [{ actor: holyTarget, leader: true }], [holyBuffer]);
assert.strictEqual(action?.skill.fetchSelfId(), 1043, 'authoritative undead metadata must enable Holy Weapon even when the NPC name has no undead token');

const positionlessTarget = actor('PositionlessTarget', 0);
positionlessTarget.fetchLocX = () => 20;
positionlessTarget.fetchLocY = () => 0;
const positionlessUndead = {
    fetchId: () => 9002,
    fetchName: () => 'Positionless Undead',
    fetchAttackable: () => true,
    fetchUndead: () => true,
    fetchDestId: () => 0,
    isDead: () => false,
    skillset: { fetchSkills: () => [] }
};
World.fetchNpcsInRadius = () => [positionlessUndead];
action = BotSupportPlanner.nextAction(holyBuffer, [{ actor: positionlessTarget, leader: true }], [holyBuffer]);
assert.strictEqual(action, null, 'an NPC without position accessors must not be treated as adjacent to the party');

const cachedTarget = actor('CachedTarget', 0);
cachedTarget.fetchLocX = () => 30;
cachedTarget.fetchLocY = () => 0;
let encounterScans = 0;
World.fetchNpcsInRadius = () => {
    encounterScans += 1;
    return [corruptedKnight];
};
BotSupportPlanner.nextAction(holyBuffer, [{ actor: cachedTarget, leader: true }], [holyBuffer]);
BotSupportPlanner.nextAction(holyBuffer, [{ actor: cachedTarget, leader: true }], [holyBuffer]);
assert.strictEqual(encounterScans, 1, 'companion planning passes must reuse the same short-lived party encounter scan');
World.npc = originalNpcWorld;
World.fetchNpcsInRadius = originalFetchNpcsInRadius;

console.log('Bot support planner checks passed');

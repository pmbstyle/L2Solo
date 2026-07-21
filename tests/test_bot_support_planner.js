const assert = require('assert');

require('../src/Global');

const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function skill(id, name, level, effect, stats, target = 'friendly') {
    return {
        fetchSelfId: () => id,
        fetchName: () => name,
        fetchLevel: () => level,
        fetchPassive: () => false,
        fetchConsumedMp: () => 5,
        fetchTargetKind: () => target,
        fetchSemantic: () => ({ effectType: 'buff', effect, stats, target })
    };
}

let nextActorId = 1;
function actor(name, classId, skills = [], mp = 100) {
    const id = nextActorId++;
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchClassId: () => classId,
        fetchMp: () => mp,
        skillset: { fetchSkills: () => skills },
        state: { fetchDead: () => false }
    };
}

const shieldOne = skill(1040, 'Shield', 1, 'shield', { pDefMul: 1.08 });
const soulShieldTwo = skill(1010, 'Soul Shield', 2, 'soul_shield', { pDefMul: 1.12 });
const shaman = actor('Noren', 49, [soulShieldTwo]);
const mage = actor('Saren', 25, [shieldOne]);
const target = actor('Slava', 0);

target.activeBuffs = { shield: Date.now() + (10 * 60 * 1000) };
assert.strictEqual(
    BotSupportPlanner.needsSkill(target, shieldOne),
    true,
    'a legacy UI marker without a structured effect must not block a rebuff'
);

EffectStore.apply(target, { key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
assert.strictEqual(BotSupportPlanner.needsSkill(target, shieldOne), false, 'do not overwrite an equal-level active buff');
assert.strictEqual(BotSupportPlanner.needsSkill(target, soulShieldTwo), true, 'upgrade an active defensive buff when the party has a higher level');

EffectStore.apply(target, { key: 'shield', id: 1040, level: 3, type: 'buff', stats: { pDefMul: 1.2 }, durationMs: 10 * 60 * 1000 });
const rejectedDowngrade = EffectStore.apply(target, { key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
assert.strictEqual(rejectedDowngrade.level, 3, 'runtime effect storage must reject a lower-level buff over a stronger one');
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

console.log('Bot support planner checks passed');

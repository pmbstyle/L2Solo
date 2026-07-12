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

EffectStore.apply(target, { key: 'shield', id: 1040, level: 1, type: 'buff', stats: { pDefMul: 1.08 }, durationMs: 10 * 60 * 1000 });
assert.strictEqual(BotSupportPlanner.needsSkill(target, shieldOne), false, 'do not overwrite an equal-level active buff');
assert.strictEqual(BotSupportPlanner.needsSkill(target, soulShieldTwo), true, 'upgrade an active defensive buff when the party has a higher level');

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

console.log('Bot support planner checks passed');

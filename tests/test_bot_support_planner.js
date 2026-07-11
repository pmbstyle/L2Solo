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

function actor(name, classId, skills = []) {
    return {
        fetchName: () => name,
        fetchClassId: () => classId,
        fetchMp: () => 100,
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

console.log('Bot support planner checks passed');

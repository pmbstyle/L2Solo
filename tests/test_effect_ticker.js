const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const target = {
    hp: 50,
    effectTimers: {},
    fetchHp() { return this.hp; },
    setHp(value) { this.hp = value; },
    statusUpdateVitals() {}
};

const effect = EffectStore.apply(target, {
    key: 'poison',
    id: 129,
    level: 1,
    type: 'debuff',
    dot: {
        damage: 3,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyDot(null, null, target, effect), true, 'Poison DoT should start a ticker');

const hotTarget = {
    hp: 40,
    maxHp: 45,
    effectTimers: {},
    fetchHp() { return this.hp; },
    fetchMaxHp() { return this.maxHp; },
    setHp(value) { this.hp = value; },
    statusUpdateVitals() {}
};

const hotEffect = EffectStore.apply(hotTarget, {
    key: 'chant_of_life',
    id: 1229,
    level: 1,
    type: 'buff',
    hot: {
        heal: 4,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyHot(null, null, hotTarget, hotEffect), true, 'Heal-over-time should start a ticker');

setTimeout(() => {
    assert.strictEqual(target.fetchHp(), 44, 'Poison DoT should apply datapack damage on each tick');
    assert.strictEqual(target.effectTimers.poison, undefined, 'DoT ticker should clear itself after its count');
    assert.strictEqual(hotTarget.fetchHp(), 45, 'Heal-over-time should heal each tick and clamp at max HP');
    assert.strictEqual(hotTarget.effectTimers.chant_of_life, undefined, 'Heal-over-time ticker should clear itself after its count');
    console.log('Effect ticker checks passed');
}, 40);

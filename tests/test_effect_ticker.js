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

const manaTarget = {
    mp: 25,
    effectTimers: {},
    fetchMp() { return this.mp; },
    setMp(value) { this.mp = value; },
    statusUpdateVitals() {}
};

const manaEffect = EffectStore.apply(manaTarget, {
    key: 'seal_of_gloom',
    id: 1210,
    level: 4,
    type: 'debuff',
    manaDot: {
        damage: 12,
        count: 2,
        intervalMs: 5
    },
    durationMs: 100
});

assert.strictEqual(EffectTicker.applyManaDot(null, null, manaTarget, manaEffect), true, 'Mana damage-over-time should start a ticker');

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

const expiringTarget = {
    effects: {},
    activeBuffs: {},
    effectTimers: {},
    effectExpiryTimers: {},
    fetchId() { return 9001; }
};
const expiringSession = {
    actor: expiringTarget,
    packets: [],
    dataSendToMe(packet) {
        this.packets.push(packet);
    }
};
expiringTarget.session = expiringSession;
expiringTarget.activeBuffs.shield = Date.now() + 15;
const expiringEffect = EffectStore.apply(expiringTarget, {
    key: 'shield',
    id: 1040,
    level: 1,
    type: 'buff',
    durationMs: 15
});
assert.strictEqual(EffectTicker.scheduleExpiry(expiringSession, expiringTarget, expiringEffect), true, 'Timed buff should schedule an expiry refresh');

setTimeout(() => {
    assert.strictEqual(target.fetchHp(), 44, 'Poison DoT should apply datapack damage on each tick');
    assert.strictEqual(target.effectTimers.poison, undefined, 'DoT ticker should clear itself after its count');
    assert.strictEqual(manaTarget.fetchMp(), 1, 'Mana damage-over-time should reduce MP on each tick and clamp above zero');
    assert.strictEqual(manaTarget.effectTimers.seal_of_gloom, undefined, 'Mana damage-over-time ticker should clear itself after its count');
    assert.strictEqual(hotTarget.fetchHp(), 45, 'Heal-over-time should heal each tick and clamp at max HP');
    assert.strictEqual(hotTarget.effectTimers.chant_of_life, undefined, 'Heal-over-time ticker should clear itself after its count');
    assert.strictEqual(EffectStore.list(expiringTarget).length, 0, 'Expired buff should be pruned from EffectStore');
    assert.strictEqual(expiringTarget.activeBuffs.shield, undefined, 'Expired buff should be removed from legacy activeBuffs');
    const expiryPacket = expiringSession.packets.find((packet) => packet[0] === 0x7f);
    assert(expiryPacket, 'Expired buff should send an abnormal status refresh');
    assert.strictEqual(expiryPacket.readInt16LE(1), 0, 'Expired buff refresh should remove the icon from the client');
    console.log('Effect ticker checks passed');
}, 70);

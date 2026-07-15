const assert = require('assert');

require('../src/Global');

const CharacterStatus = invoke('GameServer/Actor/CharacterStatus');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const actor = {
    model: { cp: 23 },
    hp: 67,
    mp: 31,
    maxHp: 100,
    maxMp: 80,
    cp: 23,
    maxCp: 50,
    fetchHp() { return this.hp; },
    fetchMp() { return this.mp; },
    fetchCp() { return this.cp; },
    fetchMaxHp() { return this.maxHp; },
    fetchMaxMp() { return this.maxMp; },
    fetchMaxCp() { return this.maxCp; },
    setHp(value) { this.hp = value; },
    setMp(value) { this.mp = value; },
    setCp(value) { this.cp = value; }
};

EffectStore.apply(actor, {
    key: 'might', id: 1068, level: 3, type: 'buff', stats: { pAtkMul: 1.15 }, durationMs: 60000
});
EffectStore.apply(actor, {
    key: 'poison', id: 129, level: 1, type: 'debuff', durationMs: 60000
});
EffectStore.apply(actor, {
    key: 'vampiric_rage', id: 1268, level: 1, type: 'buff', toggle: true, durationMs: 60000
});

const stored = CharacterStatus.persistenceRecord(actor);
assert.deepStrictEqual(JSON.parse(stored.effects).map((effect) => effect.key), ['might'], 'only non-toggle buffs should survive a logout');
assert.deepStrictEqual({ hp: stored.hp, mp: stored.mp, cp: stored.cp }, { hp: 67, mp: 31, cp: 23 }, 'all three vital values should be persisted');

const restored = {
    model: { cp: stored.cp },
    activeBuffs: {},
    effects: {},
    hp: stored.hp,
    mp: stored.mp,
    cp: stored.cp,
    maxHp: 100,
    maxMp: 80,
    maxCp: 50,
    fetchHp() { return this.hp; },
    fetchMp() { return this.mp; },
    fetchCp() { return this.cp; },
    fetchMaxHp() { return this.maxHp; },
    fetchMaxMp() { return this.maxMp; },
    fetchMaxCp() { return this.maxCp; },
    setHp(value) { this.hp = value; },
    setMp(value) { this.mp = value; },
    setCp(value) { this.cp = value; }
};

assert.strictEqual(CharacterStatus.restoreEffects({}, restored, stored.effects).length, 1, 'active buffs should be restored before recalculating stats');
assert.strictEqual(EffectStore.list(restored)[0].key, 'might', 'restored effect should retain its key and stat payload');
assert.ok(restored.activeBuffs.might > Date.now(), 'legacy buff tracking should remain in sync after restore');

const hotEffect = {
    key: 'chant_of_life',
    id: 1229,
    level: 1,
    type: 'buff',
    hot: { heal: 4, count: 2, intervalMs: 1000 },
    expiresAt: Date.now() + 60000
};
const originalApplyHot = EffectTicker.applyHot;
let resumedHot = 0;
EffectTicker.applyHot = (...args) => {
    resumedHot += 1;
    return originalApplyHot(...args);
};
CharacterStatus.restoreEffects({}, restored, JSON.stringify([hotEffect]));
EffectTicker.applyHot = originalApplyHot;
assert.strictEqual(resumedHot, 1, 'restoring a periodic buff should resume its ticker');

const vitals = CharacterStatus.savedVitals(restored);
restored.maxHp = 60;
restored.maxMp = 20;
restored.maxCp = 10;
CharacterStatus.restoreVitals(restored, vitals);
assert.deepStrictEqual({ hp: restored.hp, mp: restored.mp, cp: restored.cp }, { hp: 60, mp: 20, cp: 10 }, 'restored vitals should clamp to the recalculated maximums');

restored.model.cp = null;
restored.cp = restored.maxCp;
CharacterStatus.restoreVitals(restored, CharacterStatus.savedVitals(restored));
assert.strictEqual(restored.cp, restored.maxCp, 'a NULL CP column should leave the initial full CP untouched');

EffectTicker.clearAll(restored);
console.log('Character status persistence checks passed');

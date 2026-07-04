const assert = require('assert');

require('../src/Global');

const ProgressionRates = invoke('GameServer/ProgressionRates');
const originalRate = process.env.L2NODE_PROGRESSION_RATE;

process.env.L2NODE_PROGRESSION_RATE = 'x10';
let profile = ProgressionRates.profile();
assert.strictEqual(profile.preset, 'x10');
assert.strictEqual(profile.exp, Number(options.default.General.expRate) * 10);
assert.strictEqual(profile.sp, Number(options.default.General.expRate) * 10);
assert.strictEqual(profile.adena, Number(options.default.General.adenaRate) * 10);
assert.strictEqual(profile.drop, Number(options.default.General.dropChanceRate) * 10);

assert.strictEqual(ProgressionRates.normalizePreset('x50'), 'x50');
assert.strictEqual(ProgressionRates.normalizePreset('bad-rate'), 'x1');

const adenaGroup = { overall: 70, items: [{ selfId: 57, min: 100, max: 100, chance: 100 }] };
assert.strictEqual(ProgressionRates.groupRate(adenaGroup, 'drop'), profile.adena);

const saturated = ProgressionRates.rollGroup(70, profile.adena, () => 0.99);
assert.strictEqual(saturated.hit, true);
assert.strictEqual(saturated.amountMultiplier, 7);
assert.strictEqual(ProgressionRates.scaleAmount(100, saturated.amountMultiplier, () => 0.99), 700);

const rareHit = ProgressionRates.rollGroup(0.5, profile.drop, () => 0.049);
assert.strictEqual(rareHit.hit, true);
assert.strictEqual(rareHit.amountMultiplier, 1);

const rareMiss = ProgressionRates.rollGroup(0.5, profile.drop, () => 0.051);
assert.strictEqual(rareMiss.hit, false);

const originalDropChanceRate = options.default.General.dropChanceRate;
options.default.General.dropChanceRate = 0;
profile = ProgressionRates.profile();
assert.strictEqual(profile.drop, 0);
const disabledDrop = ProgressionRates.rollGroup(100, profile.drop, () => 0);
assert.strictEqual(disabledDrop.hit, false);
options.default.General.dropChanceRate = originalDropChanceRate;

process.env.L2NODE_PROGRESSION_RATE = 'x50';
profile = ProgressionRates.profile();
assert.strictEqual(profile.preset, 'x50');
assert.strictEqual(profile.exp, Number(options.default.General.expRate) * 50);

if (originalRate === undefined) {
    delete process.env.L2NODE_PROGRESSION_RATE;
} else {
    process.env.L2NODE_PROGRESSION_RATE = originalRate;
}

console.log('progression rates ok');

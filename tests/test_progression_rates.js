const assert = require('assert');

require('../src/Global');

const ProgressionRates = invoke('GameServer/ProgressionRates');
const DataCache = invoke('GameServer/DataCache');
const ExperienceReward = invoke('GameServer/Actor/Generics/ExperienceReward');
const SendPacket = invoke('Packet/Send');
const originalRate = process.env.L2NODE_PROGRESSION_RATE;

DataCache.init();
assert.strictEqual(options.default.General.maxLevel, 80, 'C4 progression must allow the third-class cap of level 80');
assert.strictEqual(ExperienceReward.resolveLevel(DataCache.experience.at(-1), options.default.General.maxLevel, DataCache.experience), 80, 'the final experience threshold must award level 80');
const level80Packet = new SendPacket(0x04).writeD(4200000000n).fetchBuffer(false);
assert.strictEqual(level80Packet.readUInt32LE(1), 4200000000, 'C4 packets must serialize the level-80 experience threshold as an unsigned D value');

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

const noDeepBlue = ProgressionRates.deepBlueRule({ npcLevel: 20, killerLevel: 28, attackerLevels: [27] });
assert.strictEqual(noDeepBlue.active, false);
assert.strictEqual(noDeepBlue.chanceMultiplier, 1);

const deepBlue = ProgressionRates.deepBlueRule({ npcLevel: 20, killerLevel: 29, attackerLevels: [25] });
assert.strictEqual(deepBlue.active, true);
assert.strictEqual(deepBlue.penaltyPercent, 9);
assert.strictEqual(deepBlue.chanceMultiplier, 0.91 / 3);

const highContributor = ProgressionRates.deepBlueRule({ npcLevel: 20, killerLevel: 20, attackerLevels: [30] });
assert.strictEqual(highContributor.levelGap, 10);
assert.strictEqual(highContributor.penaltyPercent, 18);

process.env.L2NODE_PROGRESSION_RATE = 'x10';
const deepBlueAdena = ProgressionRates.rewardGroupRoll(adenaGroup, 'drop', { npcLevel: 20, killerLevel: 29 }, () => 0.2);
assert.strictEqual(deepBlueAdena.rule.active, true);
assert.strictEqual(deepBlueAdena.amountMultiplier, 7);
assert.strictEqual(deepBlueAdena.hit, true);

const deepBlueItem = ProgressionRates.rewardGroupRoll({ overall: 100, items: [{ selfId: 1000 }] }, 'drop', { npcLevel: 20, killerLevel: 29 }, () => 0.31);
assert.strictEqual(deepBlueItem.hit, true);
assert.strictEqual(deepBlueItem.amountMultiplier, 10);

const summonOwner = ProgressionRates.deepBlueRule({ npcLevel: 20, killerLevel: 40, attackerLevels: [10] });
assert.strictEqual(summonOwner.highestLevel, 40);
assert.strictEqual(summonOwner.active, true);

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

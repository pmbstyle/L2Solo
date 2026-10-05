const assert = require('assert');
const path = require('path');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
// The hand-made table of test_spot_value_table: on spot S a dps at 24 kills 200 per hour with half the hour
// in combat and recovery (400 per busy hour), a spoiler at 24 kills 150 with half the hour busy (300).
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
process.env.L2NODE_PROGRESSION_RATE = 'x1';

// Spot S holds 3 Scavenger Wererats (39) and 1 Sukar Wererat (40), level 18.
const spots = [{ id: 'S', avgLevel: 18, density: 30, npcEntries: [
    { selfId: 39, name: 'Scavenger Wererat', level: 18, count: 3 },
    { selfId: 40, name: 'Sukar Wererat', level: 18, count: 1 }] }];
const reward = DataCache.npcRewards.find((entry) => Number(entry.selfId) === 39);
const dropIds = new Set((reward.rewards || []).flatMap((group) => (group.items || []).map((item) => Number(item.selfId))));
const itemId = 1924;
assert(dropIds.has(itemId), 'the fixture monster drops the test item');
const basePrice = Number(DataCache.items.find((item) => Number(item.selfId) === itemId).template.price);
const yieldPerKill = Planner.itemDropYield(reward, itemId, 'drop', { npcLevel: 18, killerLevel: 24 }).expectedYield;
const hours = 1 / (350 * 0.75 * yieldPerKill);
Efficiency.resetLevelBands();
const defaultHour = Efficiency.hourValue({ level: 24, stats: {} }).perHour;
const first = FirstPrice.firstPrice(itemId, { spots });
assert.strictEqual(first.spotId, 'S');
assert.strictEqual(first.npcId, 39, 'the monster with the larger share of the spot wins');
assert.strictEqual(first.level, 24);
near(first.hours, hours, 'hours to obtain = 1 / (kills per busy hour x share x yield)');
const expected = Math.min(basePrice, Math.max(NpcSellRules.npcBuyPrice(basePrice), hours * defaultHour));
assert.strictEqual(first.price, Math.round(expected), 'price = hours x hour of the level, inside the NPC walls');
assert(first.price >= NpcSellRules.npcBuyPrice(basePrice) && first.price <= basePrice, 'first price within the NPC walls');

// The hour of the level comes from the bots' measured band: a rich band hits the NPC price, a poor one the buy-back.
function band(level, perKill) {
    let bot = { characterId: 7000 + perKill, level, stats: { classId: 1 }, inventory: { 1: { selfId: 1, equipped: true } } };
    for (let i = 0; i < 3; i++) {
        bot = { ...bot, stats: { ...bot.stats, huntEfficiency: Efficiency.record(bot, { spotId: 'x', exp: 100, combatMs: 60000,
            adena: perKill * 10, loot: 0, kills: 10, timestamp: 1000 }) } };
    }
}
Efficiency.resetLevelBands();
band(24, 1e7);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, basePrice, 'capped at the NPC price');
Efficiency.resetLevelBands();
band(24, 0.001);
assert.strictEqual(FirstPrice.firstPrice(itemId, { spots, timestamp: 1000 }).price, NpcSellRules.npcBuyPrice(basePrice),
    'never below the NPC buy-back');
Efficiency.resetLevelBands();

const notDropped = DataCache.items.find((item) => Number(item.template?.price) > 0 && !dropIds.has(Number(item.selfId))
    && !(DataCache.npcRewards.find((entry) => Number(entry.selfId) === 40)?.rewards || [])
        .some((group) => (group.items || []).some((entry) => Number(entry.selfId) === Number(item.selfId))));
assert.strictEqual(FirstPrice.firstPrice(notDropped.selfId, { spots }), null, 'no hunting source (crafted, NPC, quest): no first price yet');
assert.strictEqual(FirstPrice.firstPrice(57, { spots }), null, 'adena has no price');

Table.useFile();
console.log('First price of drops: hours to obtain x hour of the level, inside the NPC walls, passed');

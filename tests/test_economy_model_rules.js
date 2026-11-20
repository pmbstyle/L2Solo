'use strict';
// The economy model's drop rule on inline fixtures: what a kill yields at a rate.
const assert = require('node:assert/strict');
const { dropRule, npcKind, DESIGN_RATES } = require('../scripts/economy-model/rules/dropRule');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} vs ${expected}`);
const x1 = DESIGN_RATES.x1, x50 = DESIGN_RATES.x50;

// A material group with a 0.14 % recipe among common materials (overall 40 %),
// an adena group and a spoil group.
const materials = { overall: 40, items: [
    { selfId: 1867, chance: 59.86, min: 1, max: 1 },
    { selfId: 1872, chance: 40, min: 1, max: 3 },
    { selfId: 2255, chance: 0.14, min: 1, max: 1 }
] };
const adena = { overall: 70, items: [{ selfId: 57, chance: 100, min: 166, max: 299 }] };
const spoil = { overall: 100, items: [{ selfId: 1804, chance: 1.4651, min: 1, max: 1 }, { selfId: 1926, chance: 3.7, min: 1, max: 2 }] };

// Every item's expected yield scales by its kind's rate exactly once: the rare
// recipe as much as the common material (today's capped weights lift a 0.14 %
// recipe to several % of the group at x50).
const one = dropRule({ group: materials, rates: x1 }), fifty = dropRule({ group: materials, rates: x50 });
near(one[2255], 0.4 * 0.0014, 'the recipe at x1: group chance times its weight');
for (const id of [1867, 1872, 2255]) near(fifty[id], x50.drop * one[id], `item ${id} at x50 is 15 x its x1 yield`);
near(fifty[2255] / Object.values(fifty).reduce((sum, count) => sum + count, 0), one[2255] / Object.values(one).reduce((sum, count) => sum + count, 0),
    'the recipe keeps its share of the group');
// A chance over 100 % becomes extra rolls: 40 % x 15 = 6 rolls a kill.
near(fifty[1872], 6 * 0.4 * 2, '6 rolls, each picks the material 40 % of the time, 2 on average');
near(dropRule({ group: adena, rates: x50 })[57], 50 * dropRule({ group: adena, rates: x1 })[57], 'adena at the adena rate 50');
assert.deepStrictEqual([DESIGN_RATES.x10.adena, DESIGN_RATES.x50.adena], [10, 50], 'adena follows the exp rate');
assert.deepStrictEqual([DESIGN_RATES.x10.drop, DESIGN_RATES.x10.spoil, DESIGN_RATES.x10.raid, DESIGN_RATES.x10.epic, DESIGN_RATES.x50.drop, DESIGN_RATES.x50.spoil, DESIGN_RATES.x50.raid, DESIGN_RATES.x50.epic], [4, 4, 3, 1, 15, 10, 5, 1], 'other rates unchanged');
near(dropRule({ group: adena, rates: x1 })[57], 0.7 * 232.5, 'adena at x1: chance times the mean amount');
const spoiled = dropRule({ group: spoil, kind: 'spoil', rates: x50 }), spoiledOne = dropRule({ group: spoil, kind: 'spoil', rates: x1 });
for (const id of [1804, 1926]) near(spoiled[id], 10 * spoiledOne[id], `spoil row ${id} at the spoil rate 10`);
near(spoiledOne[1926], 0.037 * 1.5, 'each spoil row on its own chance');
// The deep-blue penalty divides the rolls; adena under it is divided by the drop rate too, as in Lisvus.
const blue = { active: true, chanceMultiplier: 0.1, minimumChance: 0.0001 };
near(dropRule({ group: materials, rates: x50, penalty: blue })[2255], 0.1 * fifty[2255], 'deep blue drops at a tenth');
near(dropRule({ group: adena, rates: x50, penalty: blue })[57], 0.7 * 50 * 0.1 / 15 * 232.5, 'deep blue adena');
// A group listed above 100 % rolls more than once a kill at x1 too (Tirak's 149 %).
const listed = { overall: 149.3, items: [{ selfId: 955, chance: 60, min: 1, max: 1 }, { selfId: 2026, chance: 40, min: 1, max: 1 }] };
near(dropRule({ group: listed, rates: x1, of: 'raid' })[955], 1.493 * 0.6, '1.49 rolls a kill at x1');
// A raid boss's and an epic boss's item drops roll at their own rates (x10: 3 and 1; x50: 5 and 1); adena at the adena rate.
for (const [preset, raid] of [['x10', 3], ['x50', 5]]) {
    near(dropRule({ group: materials, rates: DESIGN_RATES[preset], of: 'raid' })[2255], raid * one[2255], `a raid boss's recipe at ${preset}`);
    near(dropRule({ group: materials, rates: DESIGN_RATES[preset], of: 'epic' })[2255], one[2255], `an epic boss's recipe at ${preset}`);
    near(dropRule({ group: adena, rates: DESIGN_RATES[preset], of: 'raid' })[57], DESIGN_RATES[preset].adena * dropRule({ group: adena, rates: x1 })[57], `raid adena at ${preset}`);
}
assert.equal(npcKind({ selfId: 12211, template: { kind: 'Boss' } }), 'epic', 'Antharas is an epic boss');
assert.equal(npcKind({ selfId: 10038, template: { kind: 'Boss', raidBoss: true } }), 'raid', 'Tirak is a raid boss');
assert.equal(npcKind({ selfId: 51, template: { kind: 'Monster' } }), 'normal');
assert.throws(() => dropRule({ group: materials, rates: x1, of: 'boss' }), /unknown NPC kind/);

// The drop rule at x1 is today's expected yield (SpotRewardExpectation) on a
// real normal NPC: Skeleton Bowman (level 20, three drop groups, three spoil
// rows), killed and spoiled by a level-20 killer with Spoil level 3.
{
    const Boot = require('../scripts/economy-model/boot');
    const Data = Boot.boot('x1');
    const Index = require('../src/GameServer/Item/ItemTemplateIndex');
    const Sell = require('../src/GameServer/Items/NpcSellRules');
    const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
    const Drops = require('../src/GameServer/Bot/Population/BackgroundDropResolver');
    const Formulas = invoke('GameServer/Formulas');
    const npc = Index.find(Data.npcs, 51), level = 20, spoilSkill = 3;
    assert.equal(npcKind(npc), 'normal');
    const spot = { id: 'rule-check-51', npcEntries: [{ selfId: 51, count: 1 }], rewards: { adenaMin: 0, adenaMax: 0 } };
    const reward = Drops.rewardDataForSpot({ ...spot, npcNames: [npc.template.name] }, () => 0, 51);
    assert.ok(reward.rewards.length >= 3 && reward.spoils.length >= 2, 'the NPC drops and spoils');
    const price = id => { const item = Index.find(Data.items, id); return item.template.kind === 'Other.Quest' ? 0 : Sell.npcBuyPrice(Number(item.template.price || 0)); };
    const rule = { adena: 0, drop: 0, spoil: 0 };
    for (const group of reward.rewards) for (const [id, count] of Object.entries(dropRule({ group, rates: x1 }))) rule[Number(id) === 57 ? 'adena' : 'drop'] += count * (Number(id) === 57 ? 1 : price(id));
    const landed = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: spoilSkill, attackerLevel: level, targetLevel: npc.template.level });
    for (const group of reward.spoils) for (const [id, count] of Object.entries(dropRule({ group, kind: 'spoil', rates: x1 }))) rule.spoil += count * price(id) * landed;
    const today = Rewards.value(spot, level, { spoilSkillLevel: spoilSkill });
    for (const part of ['adena', 'drop', 'spoil']) near(rule[part], today[part], `${part} per kill: the rule at x1 against today`);
    assert.ok(today.drop > 0 && today.spoil > 0 && today.adena > 0);
}

console.log('test_economy_model_rules: ok');

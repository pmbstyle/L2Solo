'use strict';
// Each item of a landed spoil group rolls on its own chance (C4), so one sweep
// can give several items of a group: the hot sweep (SpoilSweep.rollSpoils) and
// the cold fight (BackgroundDropResolver.rollSpoilForFight) roll it, the
// planner's units per kill and the spot value count it the same way.
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const Drops = require('../src/GameServer/Bot/Population/BackgroundDropResolver');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const original = { npcs: Data.npcs, rewards: Data.npcRewards, items: Data.items, rate: process.env.L2NODE_PROGRESSION_RATE };
const npcId = 990281, aloneNpcId = 990284, firstItem = 990282, secondItem = 990283;
const close = (a, b, message) => assert(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${message}: ${a} != ${b}`);
const spoilReward = (items) => ({ selfId: npcId, rewards: [], spoils: [{ overall: 100, items }] });
const crowded = spoilReward([
    { selfId: firstItem, chance: 60, min: 1, max: 1 },
    { selfId: secondItem, chance: 60, min: 2, max: 4 }
]);
const alone = { ...spoilReward([{ selfId: secondItem, chance: 60, min: 2, max: 4 }]), selfId: aloneNpcId };
const firstAloneNpcId = 990285;
const firstAlone = { ...spoilReward([{ selfId: firstItem, chance: 60, min: 1, max: 1 }]), selfId: firstAloneNpcId };
const spotOf = (id, selfId) => ({ id, avgLevel: 20, npcEntries: [{ selfId, count: 1 }] });
const originalRandom = Math.random;
try {
    useRate('x1');
    Data.npcs = [...Data.npcs,
        { selfId: npcId, template: { level: 20, name: 'Spoil Pair Mob', kind: 'Monster' } },
        { selfId: aloneNpcId, template: { level: 20, name: 'Spoil Single Mob', kind: 'Monster' } },
        { selfId: firstAloneNpcId, template: { level: 20, name: 'Spoil First Mob', kind: 'Monster' } }];
    Data.items = [...Data.items,
        { selfId: firstItem, template: { price: 0, kind: 'Other.Material' } },
        { selfId: secondItem, template: { price: 10, kind: 'Other.Material' } }];

    const second = Planner.itemDropYield(crowded, secondItem, 'spoil');
    close(second.chance, .6, 'the second item lands on its own 60 chance after a 60 first item');
    close(second.expectedYield, .6 * 3, 'the second item yield is its chance times the mean amount');

    Data.npcRewards = [...Data.npcRewards, crowded, alone, firstAlone];
    const crowdedValue = Rewards.value(spotOf('spoil-pair', npcId), 20, { spoilSkillLevel: 1 }).spoil;
    const aloneValue = Rewards.value(spotOf('spoil-alone', aloneNpcId), 20, { spoilSkillLevel: 1 }).spoil;
    assert(aloneValue > 0, 'the spoiler earns from the item');
    const firstValue = Rewards.value(spotOf('spoil-first', firstAloneNpcId), 20, { spoilSkillLevel: 1 }).spoil;
    close(crowdedValue, aloneValue + firstValue, 'the spot value counts each item at its own chance, as the planner');

    const both = [firstItem, secondItem];
    const cold = Drops.rollSpoilForFight({ spot: spotOf('spoil-pair', npcId), killerLevel: 20, npcSelfId: npcId, rng: () => 0 });
    assert.deepStrictEqual(cold.map((item) => item.selfId), both, 'a cold fight can land both items of one group');

    Math.random = () => 0;
    const hot = SpoilSweep.rollSpoils({
        model: { level: 20, dropAttackerLevels: [] },
        fetchSelfId: () => npcId,
        fetchLevel: () => 20
    });
    assert.deepStrictEqual(hot.map((item) => item.selfId), both, 'a hot sweep can land both items of one group');
    console.log('PASS spoil selection: every item of a landed group rolls on its own chance');
} finally {
    Math.random = originalRandom;
    Data.npcs = original.npcs; Data.npcRewards = original.rewards; Data.items = original.items;
    useRate(original.rate);
}

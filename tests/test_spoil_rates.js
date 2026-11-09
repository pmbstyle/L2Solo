'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const { useRate, useGeneral } = require('./helpers/progressionRate');
const Data = invoke('GameServer/DataCache'); Data.init();
const Rates = invoke('GameServer/ProgressionRates');
const Sweep = invoke('GameServer/Npc/SpoilSweep');
const Drops = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const original = { rate: process.env.L2NODE_PROGRESSION_RATE, general: { ...options.default.General },
    npcs: Data.npcs, rewards: Data.npcRewards, random: Math.random };
const npcId = 990891;
const rare = { selfId: 1, chance: 1, min: 1, max: 1 };
const common = { selfId: 19, chance: 5, min: 1, max: 1 };
const group = { overall: 100, items: [rare, common] };
try {
    useGeneral({ dropChanceRate: 1, spoilRate: 1 });
    useRate('x50');
    const plan = Rates.spoilItemPlan(group, rare);
    assert.equal(plan.chance, .5, '1% on x50 becomes a 50% chance');
    assert.equal(plan.expectedYield, .5);
    assert.deepEqual([plan.minAmount, plan.maxAmount], [1, 1], 'a rare success gives one sword, not fifty');
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [rare] }, {}, () => .499).map(row => row.amount), [1]);
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [rare] }, {}, () => .5), []);
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [common] }, {}, () => .499).map(row => row.amount), [3]);
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [common] }, {}, () => .5).map(row => row.amount), [2]);
    assert.deepEqual(Rates.rollSpoilGroup({ overall: 20, items: [{ ...rare, chance: 10 }] }, {}, () => .999)
        .map(row => row.amount), [1], 'group chance and item chance combine before applying x50');

    const blue = Rates.spoilItemPlan(group, rare, { npcLevel: 20, killerLevel: 29 });
    assert.equal(blue.chance, .151667, 'Deep Blue applies to the item chance before Lisvus rounds it');
    assert.equal(blue.maxAmount, 1);
    assert.equal(Rates.spoilItemPlan(group, rare, { npcLevel: 20, killerLevel: 40 }).chance, .000001,
        'a positive spoil rate retains the sourced minimum chance after the full Deep Blue penalty');
    assert.equal(Rates.rollSpoilGroup({ ...group, items: [rare] }, { npcLevel: 20, killerLevel: 40 }, () => 0)[0].amount, 1);
    const variable = { ...common, min: 2, max: 4 };
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [variable] }, {}, () => 0).map(row => row.amount), [6]);
    assert.deepEqual(Rates.rollSpoilGroup({ ...group, items: [variable] }, {}, () => .999).map(row => row.amount), [8]);

    Data.npcs = [...Data.npcs, { selfId: npcId, template: { level: 20, kind: 'Monster', name: 'Spoil Rates Probe' } }];
    const reward = { selfId: npcId, rewards: [], spoils: [group] };
    Data.npcRewards = [...Data.npcRewards, reward];
    const npc = { model: {}, fetchSelfId: () => npcId, fetchLevel: () => 20 };
    const spot = { id: 'spoil-rate-probe', avgLevel: 20, npcEntries: [{ selfId: npcId, count: 1 }] };
    for (const preset of ['x1', 'x10', 'x50']) {
        useRate(preset);
        const rate = Rates.profile().spoil;
        assert.equal(Planner.itemDropYield(reward, 1, 'spoil').chance, Math.min(1, rate / 100));
        assert.equal(Planner.itemDropYield(reward, 1, 'spoil').expectedYield, rate / 100);
        for (const roll of [0, .49, .5, .99]) {
            Math.random = () => roll;
            const hot = Sweep.rollSpoils(npc).map(row => [row.selfId, row.amount]);
            const cold = Drops.rollSpoilForFight({ spot, npcSelfId: npcId, killerLevel: 20, rng: () => roll })
                .map(row => [row.selfId, row.amount]);
            assert.deepEqual(hot, cold, `${preset} hot and cold spoil agree`);
        }
    }
    assert(Drops.rollSpoilForFight({ spot, npcSelfId: npcId, killerLevel: 20, rng: () => 0 })
        .every(item => item.stackable === false), 'cold equipment rewards retain non-stackable template metadata');
    useGeneral({ spoilRate: 0 });
    assert.deepEqual(Rates.rollSpoilGroup(group, {}, () => 0), [], 'disabled spoil awards nothing');
    console.log('PASS spoil rates: per-item chance, overflow, Deep Blue, planner and hot/cold parity');
} finally {
    Math.random = original.random;
    Data.npcs = original.npcs; Data.npcRewards = original.rewards;
    useGeneral({ dropChanceRate: original.general.dropChanceRate, spoilRate: original.general.spoilRate });
    useRate(original.rate);
}

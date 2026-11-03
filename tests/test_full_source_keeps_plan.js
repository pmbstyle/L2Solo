// A full source stays the plan's source: the crowd is read at arrival, not on
// every step of a bot standing elsewhere (design rules, decision 11-02).
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const timestamp = 1793485080000;
const inventory = {};
for (const [id, slots] of [[43, [6]], [50, [9]], [274, [14]], [390, [10]], [412, [11]],
    [847, [1, 2]], [890, [4, 5]], [907, [3]], [1122, [12]]]) {
    inventory[id] = { selfId: id, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot: slots[0] };
}
const key = 'power:45:6';
const base = { characterId: 990501, phase: 'cold', activity: 'hunting', level: 29,
    stats: { classId: 35, role: 'archer', wishFocus: [key, 1, 100000] },
    inventory, spotId: 'source-home', loc: {}, vitals: { hp: 1000, mp: 500 }, timing: {} };
base.stats.coldCombat = Cold.legacySnapshot(base, Cold.skillRecordsFromTree(35, 29), timestamp);
const watcher = { selfId: 67, level: 25, count: 11, pulls: [[1, 1]] };
const field = (id, entries) => ({ id, name: id, avgLevel: 26, minLevel: 25, maxLevel: 28,
    density: entries.reduce((sum, e) => sum + e.count, 0), levelCounts: { 25: 11, 28: 2 },
    center: { locX: -45000, locY: 180000, locZ: -3000 }, tags: [], tagsAuthoritative: true,
    npcEntries: entries, npcSelfIds: entries.map(e => e.selfId) });
const alternative = field('source-other-species', [{ selfId: 208, level: 26, count: 5, pulls: [[1, 1]] }]);
const home = field('source-home', [watcher]);
const spots = [alternative, home];
Spots.cache = spots;
let room = false;
// All bots of the world on the source, the bot itself elsewhere.
Spots.useOccupancy(() => ({ physicalSize: id => room || id !== alternative.id ? 0 : 99 }));
const economy = { network: { queue: [{ key, funded: true, object: { itemId: 45, slot: 6 } }], plans: new Map(),
    activity: { rootKey: key, activity: 'hunting', key: 'leaf', kind: 'drop', funding: false, spotId: alternative.id, npcId: 208 }, focus: [key] },
    statsPacket: {}, projection: { nodes: [] } };
let plan = { status: 'active', strategy: 'direct_drop', target: { selfId: 45, slot: 6 },
    next: { spotId: alternative.id, npcId: 208, itemId: 45, amount: 1 } };
for (let step = 0; step < 8; step++) {
    if (step === 6) room = true;
    const state = { ...base, stats: { ...base.stats, equipmentPlan: plan } };
    const viable = Planner.isPlanSourceViableForState(state, plan, { spots, timestamp: timestamp + step });
    const replan = Planner.replanContextFor(state, plan, timestamp + step);
    const { acquisitionPlan } = Selection.selectAcquisitionPlan(state, plan, { spots, timestamp: timestamp + step,
        preparedEconomy: economy, preparedReplanContext: replan, planningOptions: { findMarketOffer: () => null } });
    assert.equal(viable, true, 'room is no check of a held source');
    assert.equal(acquisitionPlan.status, 'active', 'a full source does not end the plan');
    assert.equal(acquisitionPlan.next?.spotId, alternative.id);
    plan = acquisitionPlan;
}
console.log('PASS a full source keeps the plan');

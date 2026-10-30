'use strict';
// Crowded spots (user 10-29, T106 audit): a bot choosing a spot shares the
// production of the spawns it may fight with the bots already there, as the
// fight does (BackgroundResolver.soloShareMobs): kills at most production
// over the hunters with it, the hour's fields following the kills.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Occupancy = require('../src/GameServer/Bot/Population/SpotOccupancyIndex');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const offline = require('../data/Bots/spot-reward-npcs.json');

const state = HuntCycle.referenceState(1, 30, { gear: invoke('GameServer/Bot/AI/BotGear'), profile: invoke('GameServer/Bot/Population/ColdCombatProfile') });
const role = Table.roleFor(state);
const spotId = Table.rankedSpotIds(role, 30, { shots: 0, potions: 0 })[0];
const [, entries, adenaMin, adenaMax] = offline.rows.find(row => row[0] === spotId);
// 6 mobs per hour per spawn: a small spot one bot could empty.
const spot = { id: spotId, npcEntries: entries.map(([selfId, count]) => ({ selfId, count, production: count * 6 })), rewards: { adenaMin, adenaMax } };
Table.useSpots([spot]);
// The thread's hunters count (SpotOccupancyIndex.huntersOn): n others plus the bot.
const hunters = n => ({ spotHunters: () => n + 1 });
const near = (actual, expected, message) => assert(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
try {
    const alone = Economics.create(state, hunters(0))(spot, true);
    const production = Table.production(spotId, role, 30, true);
    assert(alone && production > 0, 'the spot has its row and its production');
    assert(alone.kills <= production + 1e-9, 'one hunter: at most the production');
    const crowd = Economics.create(state, hunters(3))(spot, true);
    const expected = Math.min(alone.kills, production / 4);
    assert(Math.abs(crowd.kills - expected) < 1e-6 * expected, `four hunters share it: ${crowd.kills} vs ${expected}`);
    assert(Math.abs(crowd.exp / crowd.kills - alone.exp / alone.kills) < 1e-6 * alone.exp / alone.kills, 'exp follows the kills');
    assert(crowd.valueHours < alone.valueHours, 'a crowded spot is worth less');
    assert(crowd.crowdFactor < 1, 'the crowd cuts the row');
    // A bot whose own hunts gave twice the table's exp (calibration 2) still
    // keeps at most its share of the production: the crowd is cut once, after
    // the calibration.
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
    const sampled = Table.rankedSpotIds(role, 30, { shots: 0, potions: 0 }).find(id => id !== spotId);
    const sampleBase = Table.value(sampled, role, 30, true, { spoilSkillLevel: Rewards.spoilSkillLevel(state) });
    const now = Date.now();
    const keen = { ...state, stats: { ...state.stats, huntEfficiency: [{ spotId: sampled, signature: Hunt.signature(state),
        samples: 3, at: now, exp: 2 * sampleBase.exp, cycleMs: 3600000, kills: sampleBase.kills, adena: 0, loot: 0, costs: 0 }] } };
    const keenAlone = Economics.create(keen, { timestamp: now, ...hunters(0) })(spot, true);
    near(keenAlone.kills, Math.min(2 * alone.kills, production), 'alone: the calibrated kills');
    const keenCrowd = Economics.create(keen, { timestamp: now, ...hunters(3) })(spot, true);
    near(keenCrowd.kills, Math.min(2 * alone.kills, production / 4), 'four hunters: at most a quarter of the production');
    // A party search: each routed member takes its own share; a member
    // indexed on the spot is among the hunters already.
    const member = (characterId, spotId) => ({ characterId, activity: 'hunting', spotId, level: 30 });
    const party = Economics.create(state, { ...hunters(0), members: [state, member(91, 'elsewhere'), member(92, 'elsewhere')] })(spot, true);
    near(party.kills, Math.min(alone.kills, production / 3), 'a party of three away: three hunters');
    assert(party.kills < alone.kills, 'the party\'s own members crowd the spot');
    const arrived = Economics.create(state, { ...hunters(1), members: [state, member(91, spotId), member(92, 'elsewhere')] })(spot, true);
    near(arrived.kills, Math.min(alone.kills, production / 3), 'one member there already: still three');
    // The route search passes its party (capacityStates) to the same count.
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const routed = capacityStates => Routes.scoreSpot(spot, state, { timestamp: Date.now(), capacityStates }).efficiencyAdjustment;
    assert(routed([state, member(91, 'elsewhere'), member(92, 'elsewhere')]) < routed(undefined),
        'a party\'s route search values the spot at its members\' share');
    // One count of hunters (huntersOn): the bot counted once, whether it
    // stands on the spot or weighs a move there; the fight's count without a
    // state is the bots there, at least one.
    const index = new Occupancy.SpotOccupancyIndex();
    const on = (characterId, spotId) => ({ characterId, activity: 'hunting', spotId });
    index.update(on(1, spotId)); index.update(on(2, spotId)); index.update(on(3, 'elsewhere'));
    assert.equal(Occupancy.huntersOn(index, spotId, on(1, spotId)), 2, 'a bot on the spot: itself and the other');
    assert.equal(Occupancy.huntersOn(index, spotId, on(3, 'elsewhere')), 3, 'a bot weighing a move: the two there and itself');
    assert.equal(Occupancy.huntersOn(index, spotId), 2, 'the fight: the bots there');
    assert.equal(Occupancy.huntersOn(index, 'empty'), 1, 'an empty spot: one hunter');
    // A caller that passes no count (EquipmentIncomeRoute, PartyIncomeComparison)
    // reads the thread's occupancy: a cold worker's kernel index once registered.
    index.update(on(4, spotId)); index.update(on(5, spotId));
    SpotProfiles.useOccupancy(() => index);
    const fromThread = Economics.create(state)(spot, true);
    assert(Math.abs(fromThread.kills - Math.min(alone.kills, production / 5)) < 1e-6 * alone.kills,
        `the thread's four others share it with a caller that passes no count: ${fromThread.kills}`);
} finally {
    SpotProfiles.useOccupancy(null);
    Table.useSpots([]);
}
console.log('PASS spot crowd share');

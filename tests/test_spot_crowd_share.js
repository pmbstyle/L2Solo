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
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const previousDiagnostics = Config.developerDiagnostics;
try {
    const alone = Economics.create(state, hunters(0))(spot, true);
    const production = Table.production(spotId, role, 30, true);
    assert(alone && production > 0, 'the spot has its row and its production');
    assert(alone.kills <= production + 1e-9, 'one hunter: at most the production');
    Config.developerDiagnostics = true;
    const cuts = () => Diagnostics.metrics().counts['spot_value:crowd:cut'] || 0;
    const before = cuts();
    const crowd = Economics.create(state, hunters(3))(spot, true);
    const expected = Math.min(alone.kills, production / 4);
    assert(Math.abs(crowd.kills - expected) < 1e-6 * expected, `four hunters share it: ${crowd.kills} vs ${expected}`);
    assert(Math.abs(crowd.exp / crowd.kills - alone.exp / alone.kills) < 1e-6 * alone.exp / alone.kills, 'exp follows the kills');
    assert(crowd.valueHours < alone.valueHours, 'a crowded spot is worth less');
    assert(crowd.crowdFactor < 1, 'the crowd cuts the row');
    assert.equal(cuts(), before + 1, 'the cut is counted for developers');
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
} finally {
    Config.developerDiagnostics = previousDiagnostics;
    Table.useSpots([]);
}
console.log('PASS spot crowd share');

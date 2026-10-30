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
const others = n => Occupancy.usePlanningIndex({ physicalCount: () => n });
try {
    others(0);
    const alone = Economics.create(state)(spot, true);
    const production = Table.production(spotId, role, 30, true);
    assert(alone && production > 0, 'the spot has its row and its production');
    assert(alone.kills <= production + 1e-9, 'one hunter: at most the production');
    others(3);
    const crowd = Economics.create(state)(spot, true);
    const expected = Math.min(alone.kills, production / 4);
    assert(Math.abs(crowd.kills - expected) < 1e-6 * expected, `four hunters share it: ${crowd.kills} vs ${expected}`);
    assert(Math.abs(crowd.exp / crowd.kills - alone.exp / alone.kills) < 1e-6 * alone.exp / alone.kills, 'exp follows the kills');
    assert(crowd.valueHours < alone.valueHours, 'a crowded spot is worth less');
} finally {
    Occupancy.usePlanningIndex(null);
    Table.useSpots([]);
}
console.log('PASS spot crowd share');

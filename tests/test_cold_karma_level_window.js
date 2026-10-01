const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');

// A karma bot washes on spots of its level window (minLevel <= level,
// maxLevel >= level - 8); the solo matchup check runs only for those spots.
const originals = [Spots.arrivalPointForState, Routes.bestSpot, Routes.isSpotAllowedForState, utils.isInPeaceZone];
const spot = (id, minLevel, maxLevel, locX) => ({ id, name: id, minLevel, maxLevel,
    npcEntries: [{ selfId: 204, level: minLevel }], center: { locX, locY: 0, locZ: 0 } });
const spots = [
    spot('too-high', 31, 36, 10000),
    spot('too-low', 10, 21, 20000),
    spot('window-low-edge', 15, 22, 30000),
    spot('window', 25, 30, 40000),
    spot('window-unsafe', 26, 30, 50000),
    spot('town', 25, 30, 0)
];
const state = { characterId: 7, name: 'Chaotic', phase: 'cold', level: 30, activity: 'hunting',
    loc: { locX: 90000, locY: 0, locZ: 0 }, timing: {}, stats: { karma: 120 } };
try {
    const judged = [];
    Spots.arrivalPointForState = (_state, target) => target.center;
    Routes.bestSpot = (candidates) => ({ spot: candidates[0], candidates });
    Routes.isSpotAllowedForState = (candidate) => {
        judged.push(candidate.id);
        return candidate.id !== 'window-unsafe';
    };
    utils.isInPeaceZone = (x) => x === 0;
    let offered = null;
    const bestSpot = Routes.bestSpot;
    Routes.bestSpot = (candidates, planned) => { offered = candidates.map((entry) => entry.id); return bestSpot(candidates, planned); };

    const planned = Policy.plan(state, spots, 1000);
    assert.deepStrictEqual(judged, ['window-low-edge', 'window', 'window-unsafe'],
        'spots outside the level window and in town must not reach the matchup check');
    assert.deepStrictEqual(offered, ['window-low-edge', 'window'],
        'candidates stay the level window minus unsafe spots');
    assert.strictEqual(planned.spot.id, 'window-low-edge');
    assert.strictEqual(planned.plannedState.activity, 'traveling');

    judged.length = 0;
    assert.strictEqual(Policy.plan({ ...state, stats: { karma: 0 } }, spots, 1000), null);
    assert.deepStrictEqual(judged, [], 'a bot without karma judges no spots');
} finally {
    [Spots.arrivalPointForState, Routes.bestSpot, Routes.isSpotAllowedForState, utils.isInPeaceZone] = originals;
}
console.log('cold karma level window ok');

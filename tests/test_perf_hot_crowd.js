'use strict';

const assert = require('node:assert/strict');
const { crowdLocation, crowdLocations } = require('../src/Perf/HotCrowd');

const bot = (phase, activity, locX, locY) => ({ phase, activity, loc: { locX, locY, locZ: -3000 } });

// Three cold hunters near Gludio, two elsewhere, and bots that do not count (hot, resting, no loc).
const states = [
    bot('cold', 'hunting', -12000, 122000), bot('cold', 'hunting', -11500, 122500), bot('cold', 'hunting', -11000, 121500),
    bot('cold', 'hunting', 80000, 140000), bot('cold', 'hunting', 80500, 140200),
    bot('hot', 'hunting', 80100, 140100), bot('hot', 'hunting', 80200, 140300),
    bot('cold', 'resting', 80300, 140100), { phase: 'cold', activity: 'hunting', loc: null }
];
assert.deepEqual(crowdLocation(states), { locX: -12000, locY: 122000, locZ: -3000, bots: 3 },
    'the player stands by a bot of the fullest cell of cold hunters');
assert.equal(crowdLocation([bot('hot', 'hunting', 0, 0)]), null);
// Several players: the fullest places, each two activation radii (here 18000) from the others, so
// their crowds do not merge; a full cell too close to a taken one is passed over.
const spread = [...states, bot('cold', 'hunting', -5000, 122000), bot('cold', 'hunting', -5100, 122100)];
assert.deepEqual(crowdLocations(spread, 3, 18000).map(place => [place.locX, place.bots]), [[-12000, 3], [80000, 2]],
    'the pair 7000 from Gludio is too close; only two places are that far apart');
assert.equal(crowdLocations(spread, 3, 0).length, 3);

console.log('test_perf_hot_crowd passed');

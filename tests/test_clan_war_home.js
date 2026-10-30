'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Home = require('../src/GameServer/Bot/Population/ClanWarHome');
const original = Geo.getHeight;
const home = { locX: 106474, locY: -2128, locZ: -3239 };
const spot = { id: '17_-1', center: home };
let queries = 0;
try {
    Geo.getHeight = (x, _y, reference) => {
        queries++;
        const ground = -3400 - (x - home.locX), upstairs = ground + 2000;
        return Math.abs(reference - ground) <= Math.abs(reference - upstairs) ? ground : upstairs;
    };
    const point = Home.point({ homeLoc: home }, spot);
    assert.deepEqual(point, { ...home, locZ: -3400 }, 'the retained anchor is grounded before it is used');
    assert.deepEqual(Home.point({ homeLoc: point }, spot), point, 'normalization is stable across ticks');
    assert(Spots.containsLocation(spot, point));
    const downhill = { locX: home.locX + 600, locY: home.locY, locZ: -4000 };
    assert(Home.reached(downhill, point), 'same-layer arrival on a slope can differ from the anchor by more than 200 Z');
    assert(!Home.reached({ ...downhill, locZ: -2000 }, point), 'standing on another floor cannot finish a return');
    assert(!Home.reached({ ...downhill, locZ: -3799 }, point), 'the local-ground height tolerance remains 200');
    const before = queries;
    assert(!Home.reached({ ...downhill, locX: home.locX + 901 }, point));
    assert(!Home.reached({ ...downhill, locZ: NaN }, point));
    assert.equal(queries, before, 'distant or invalid positions do not query geodata');
    Geo.getHeight = () => NaN;
    assert.equal(Home.point({ homeLoc: home }, spot), null, 'invalid ground cannot become a completion anchor');
    assert(!Home.reached(downhill, point));
    console.log('Clan war home: grounded stable anchor, sloped arrival, wrong-floor rejection, bounded lookups and invalid geometry passed');
} finally { Geo.getHeight = original; }

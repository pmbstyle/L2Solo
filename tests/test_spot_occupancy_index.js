const assert = require('assert');
require('../src/Global');

// The occupancy kept at every state write must equal occupancySnapshot, the
// full rebuild over the same states, after any sequence of writes, deletes,
// expiring capacity backoffs, reservations and catalog changes.
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const { SpotOccupancyIndex } = require('../src/GameServer/Bot/Population/SpotOccupancyIndex');
const LifeStateCache = require('../src/GameServer/Bot/Population/LifeStateCache');

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;

let seed = 11;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (values) => values[Math.floor(random() * values.length)];

const catalog = (ids) => ids.map((id, index) => ({ id, minLevel: 10, maxLevel: 20, avgLevel: 15, density: 10,
    capacity: 2 + (index % 3) }));
let profiles = catalog(['a', 'b', 'c', 'd', 'e', 'f']);
const spotIds = ['a', 'b', 'c', 'd', 'e', 'f', 'gone', null];

function randomState(characterId) {
    const activity = pick(['hunting', 'hunting', 'resting', 'grouped', 'traveling', 'merchant', 'crafting', 'dead', 'shopping']);
    const intentSpot = pick(spotIds);
    const stats = {};
    if (activity === 'traveling' && random() < 0.8) stats.travel = { spotId: pick(spotIds) };
    const intent = random();
    if (intent < 0.2) {
        stats.clanPartyObjective = { spotId: intentSpot, status: pick(['open', 'deferred', 'completed']),
            clanOperation: pick(['equipment', 'raid']), clanId: pick([1, 2, 3]), clanGoalKey: pick(['g1', 'g2']) };
    } else if (intent < 0.4) {
        stats.partyRequest = { spotId: intentSpot, status: pick(['open', 'deferred', 'closed']) };
    } else if (intent < 0.6) {
        stats.equipmentPlan = { status: 'active', strategy: pick(['direct_drop', 'craft', 'market']), next: { spotId: intentSpot } };
    }
    if (random() < 0.4) {
        stats.capacityBackoffs = [{ spotId: intentSpot, until: clock + Math.floor(random() * 3000) - 1000 }];
    }
    return { characterId, activity, spotId: pick(spotIds), updatedAt: clock - Math.floor(random() * 50),
        party: random() < 0.3 ? { partyId: pick(['p1', 'p2', 'p3']) } : {}, stats };
}

function assertSame(actual, expected, message) {
    assert.deepStrictEqual(actual, expected, message);
}

// Worker form: a bare index and the list of its states.
const index = new SpotOccupancyIndex();
const states = new Map();
for (let step = 0; step < 4000; step++) {
    clock += Math.floor(random() * 400);
    const id = 1 + Math.floor(random() * 60);
    if (random() < 0.08) {
        if (states.has(id)) index.remove(String(id));
        states.delete(id);
    } else {
        const state = randomState(id);
        states.set(id, state);
        index.update(state);
    }
    if (step % 50 === 0) profiles = catalog(pick([['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c'], ['b', 'd', 'f', 'h']]));
    if (step % 7 === 0) {
        const snapshot = SpotProfiles.indexedOccupancy(index, profiles, clock);
        assertSame(snapshot, SpotProfiles.occupancySnapshot(profiles, [...states.values()]), `worker form, step ${step}`);
        // A reservation changes only the snapshot it was made in.
        const spot = profiles[0];
        SpotProfiles.reserveCapacity(snapshot, spot, [{ characterId: 999 }], { maxOverflowUnits: 1000 });
        assert(snapshot[spot.id].reservedKeys.has('999'));
    }
}

// Main form: LifeStateCache keeps the index; states beyond the most recent
// `limit` are left out, as occupancySnapshot's default allStates(limit) list.
const cache = new LifeStateCache();
for (let step = 0; step < 4000; step++) {
    clock += Math.floor(random() * 400);
    const id = 1 + Math.floor(random() * 60);
    if (random() < 0.08) cache.delete(id);
    else cache.set(id, randomState(id));
    if (step % 7 === 0) {
        const limit = 1 + Math.floor(random() * 60);
        const excluded = new Set(cache.beyondRecent(limit).map((state) => String(state.characterId)));
        assertSame(SpotProfiles.indexedOccupancy(cache.occupancy, profiles, clock, excluded),
            SpotProfiles.occupancySnapshot(profiles, cache.recent(limit)), `main form, step ${step}, limit ${limit}`);
    }
}
cache.clear();
assertSame(SpotProfiles.indexedOccupancy(cache.occupancy, profiles, clock, new Set()), {}, 'cleared');

Date.now = realNow;
console.log('Spot occupancy index matches the full rebuild');

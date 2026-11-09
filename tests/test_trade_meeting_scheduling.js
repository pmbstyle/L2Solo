'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { ColdSimulationKernel, priorityForResult, DueHeap } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
function state(id, dueAt, meeting = false) {
    return { characterId: id, phase: 'cold', activity: meeting ? 'traveling' : 'hunting', level: 20,
        stats: meeting ? { tradeMeeting: [7, 1], travel: { arrivalAt: dueAt } } : {},
        timing: { nextResolveAt: dueAt }, simulation: { revision: 3 } };
}
function kernel() {
    return new ColdSimulationKernel({ now: () => 100000, resolveSolo: () => null });
}
const first = kernel();
first.upsert({ state: state(1, 1000) });
first.upsert({ state: state(30, 99000, true) });
first.upsert({ state: state(31, 99000, true) });
assert.deepEqual(first.dueCandidates(100000, 2).map(row => row.characterId), [30, 1],
    'one paid arrival precedes the old hunt backlog while ordinary work retains a slot');
const future = kernel();
future.upsert({ state: state(1, 1000) });
future.upsert({ state: state(30, 101000, true) });
assert.equal(future.dueCandidates(100000, 1)[0].characterId, 1, 'arrival priority does not shorten travel');
// The player's waits come from the 'meetings' table; its row arriving
// reschedules the bot (the worker's watch calls ensureScheduled).
function playerKernel(waits) {
    const built = new ColdSimulationKernel({ now: () => 100000, resolveSolo: () => null, playerWaiting: id => waits.has(id) });
    built.upsert({ state: state(30, 99000, true) });
    built.upsert({ state: state(31, 99500, true) });
    return built;
}
assert.equal(playerKernel(new Set()).dueCandidates(100000, 1)[0].characterId, 30, 'no wait: the earlier arrival goes first');
const waits = new Set();
const player = playerKernel(waits);
waits.add(31);
player.ensureScheduled(31);
assert.equal(player.dueCandidates(100000, 1)[0].characterId, 31, 'a waiting player keeps first priority');
// A bot within a real player's activation ring ('player_rings') goes ahead of an older
// backlog: it may go hot at the next scan. The ring's arrival reschedules the bots inside
// it (playerRingMoved); a ring that goes leaves them in plain due order again.
function ringKernel(rings) {
    const built = new ColdSimulationKernel({ now: () => 100000, resolveSolo: () => null, playerRings: () => rings });
    built.upsert({ state: { ...state(1, 1000), loc: { locX: 90000, locY: 90000, locZ: 0 } } });
    built.upsert({ state: { ...state(2, 99000), loc: { locX: 1000, locY: 1000, locZ: 0 } } });
    return built;
}
const rings = new Map(), ring = { characterId: 9, locX: 0, locY: 0, radius: 9000 };
assert.equal(ringKernel(rings).dueCandidates(100000, 1)[0].characterId, 1, 'no player: the oldest due goes first');
const ringed = ringKernel(rings);
rings.set(9, ring);
assert.equal(ringed.playerRingMoved(ring), 1, 'the ring reschedules the bot inside it');
assert.equal(ringed.dueCandidates(100000, 1)[0].characterId, 2, 'a bot near a player goes ahead of the older backlog');
const left = ringKernel(rings);
rings.delete(9);
left.playerRingMoved(ring);
assert.equal(left.dueCandidates(100000, 1)[0].characterId, 1, 'a ring that goes leaves plain due order');
const changed = kernel(), travelling = state(30, 99000, true);
changed.upsert({ state: travelling });
changed.upsert({ state: { ...travelling, stats: { ...travelling.stats, tradeMeeting: null } } });
assert.equal(changed.heap.peekMeeting(), null, 'released custody leaves no derived priority node');
const heap = new DueHeap(), rows = [];
for (let id = 1; id <= 120; id++) {
    const entry = { characterId: id, dueAt: (id * 47) % 121, meetingTravel: id % 7 === 0 };
    rows.push(entry); heap.push(entry);
}
for (const entry of rows.filter(row => row.characterId % 3 === 0)) heap.remove(entry);
assert.equal(heap.peekMeeting(), rows.filter(row => row.meetingTravel && row.characterId % 3 !== 0)
    .sort((a, b) => heap.compare(a, b))[0], 'indexed removal preserves the derived paid-arrival minimum');
// Every head after each push and removal equals a brute-force minimum over the live entries (the
// heads are refreshed once per sift along its path, not per moved level).
const mixed = new DueHeap(), live = new Set();
const brute = flag => [...live].filter(row => row[flag]).sort((a, b) => mixed.compare(a, b))[0] || null;
const checkHeads = label => {
    assert.equal(mixed.peek(), [...live].sort((a, b) => mixed.compare(a, b))[0] || null, `${label}: due head`);
    assert.equal(mixed.peekPlayer(), brute('forPlayer'), `${label}: player head`);
    assert.equal(mixed.peekMeeting(), brute('meetingTravel'), `${label}: meeting head`);
    assert.equal(mixed.peekLead(), brute('lead'), `${label}: lead head`);
};
let seed = 7;
const roll = n => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
for (let round = 0; round < 600; round++) {
    if (live.size && roll(3) === 0) {
        const entry = [...live][roll(live.size)];
        live.delete(entry); mixed.remove(entry);
    } else {
        const entry = { characterId: round + 1, dueAt: roll(500), forPlayer: roll(9) === 0,
            meetingTravel: roll(7) === 0, lead: roll(5) === 0 };
        live.add(entry); mixed.push(entry);
    }
    checkHeads(`round ${round}`);
}
while (live.size) { const first = mixed.pop(); live.delete(first); checkHeads(`pop ${first.characterId}`); }
assert.equal(priorityForResult(travelling, { patch: { activity: 'shopping' }, events: [] }), 'P1',
    'completed paid arrival is published promptly without waiting for a background batch');
assert.equal(priorityForResult(travelling, { patch: { activity: 'dead' }, events: [] }), 'P0',
    'death remains the highest commit priority');
const Trip = invoke('GameServer/Bot/Population/ColdTrip'), Towns = require('../src/GameServer/World/TownRespawn');
const giran = Towns.towns.giran_town, heine = Towns.towns.innadril_town;
const returning = { ...state(50, 101000, true), loc: giran, adena: 1000000, inventory: { 736: { amount: 9 } },
    stats: { travel: { to: heine, arrivalAt: 101000 } } };
const captured = structuredClone(returning);
assert.equal(Trip.townPlan(returning, giran).route.fee, 0, 'old position would underreserve the next fare');
const expected = Trip.townPlan({ ...returning, loc: heine }, giran);
assert(expected.route.fee > 0);
assert.deepEqual(Trip.meetingTownPlan(returning, giran), expected,
    'meeting fare starts after the previously paid journey, avoiding an unbudgeted walk');
assert.deepEqual(returning, captured, 'quoting the next route pays neither fare nor another scroll');
assert.deepEqual(Trip.meetingTownPlan({ ...returning, activity: 'shopping' }, giran),
    Trip.townPlan(returning, giran), 'a stale travel field cannot change a stationary departure');
console.log('Meeting scheduling: paid arrival, player ring, ordinary progress, future deadline, player priority and prompt commit passed');

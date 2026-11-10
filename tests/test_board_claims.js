'use strict';
// Board line claims: a bot that decides a trip for board lines (an errand, a gear
// purchase's town visit) claims the units it will buy of them; another bot's purchase
// decision reads those units as gone, the claimant does not; the claim lives while its
// trip does in the bot's state (taken at the write that holds the trip; bought, refused or
// replaced: released at the write that drops it; lapsed: at once) and ends with the
// bot's death, its going near or its removal.
// First come wins: the units left stay on the board for others.
const assert = require('node:assert/strict');
require('../src/Global');
const Claims = invoke('GameServer/Bot/Economy/BoardClaims');
const CombinedErrands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
const Situations = invoke('GameServer/Bot/Situations');

const now = Date.now();
const line = (lineId, count, price = 100, ownerId = 9) => ({ recordId: 50, lineId, count, selfId: 1864, price, ownerId });
const errand = { selfId: 1864, amount: 7, town: 'Giran', purpose: 'wealth_craft', tag: [5], at: now };
const holding = (...errands) => ({ characterId: 1, phase: 'cold', activity: 'traveling',
    stats: errands.reduce((state, next) => CombinedErrands.enqueue(state, next, now), { stats: {} }).stats });
const holder = holding(errand);
Claims.claimErrand(1, errand, [{ line: line(1, 5), count: 5 }, { line: line(2, 9), count: 2 }]);
assert.equal(Claims.unclaimed(line(1, 5), 2), 0, 'a line claimed whole is gone for another buyer');
assert.equal(Claims.unclaimed(line(1, 5), 1), 5, 'the claimant still buys it');
assert.equal(Claims.unclaimed(line(2, 9), 2), 7, 'the units left stay for others');
// A buyer's purchase plan reads the units left (OfferQuery countOf): the claimed line holds
// nothing for it, the other line its unclaimed part.
const Query = invoke('GameServer/Bot/Economy/OfferQuery');
const plan = Query.fill([line(1, 5), line(2, 9)], 9, { countOf: row => Claims.unclaimed(row, 2) });
assert.deepEqual(plan.lines.map(entry => [entry.line.lineId, entry.count]), [[2, 7]], 'only the unclaimed units are planned');
Claims.ownerChanged(1, holder);
assert.equal(Claims.unclaimed(line(1, 5), 2), 0, 'the errand still held: the claim stands');
Claims.ownerChanged(1, { ...holder, activity: 'dead' });
assert.equal(Claims.unclaimed(line(1, 5), 2), 5, 'the claimant died: released');
Claims.claimErrand(1, errand, [{ line: line(1, 5), count: 5 }]);
Claims.ownerChanged(1, { ...holder, stats: CombinedErrands.complete(holder, errand, now).stats });
assert.equal(Claims.unclaimed(line(1, 5), 2), 5, 'the errand ended: released');
// Two errands of one decision (one timestamp) on one line: the end of one keeps the other's units.
const other = { ...errand, purpose: 'supply', amount: 3 };
const both = holding(errand, other);
Claims.claimErrand(1, errand, [{ line: line(2, 9), count: 2 }]);
Claims.claimErrand(1, other, [{ line: line(2, 9), count: 3 }]);
assert.equal(Claims.unclaimed(line(2, 9), 2), 4);
Claims.ownerChanged(1, { ...both, stats: CombinedErrands.complete(both, errand, now).stats });
assert.equal(Claims.unclaimed(line(2, 9), 2), 6, 'the other errand still claims its units');
// A lapsed errand (past its life) leaves the state at the next write: released there.
Claims.ownerChanged(1, holding({ ...other, at: now - CombinedErrands.ERRAND_MS - 1 }));
assert.equal(Claims.unclaimed(line(2, 9), 2), 9, 'a lapsed errand holds nothing');
// Its claim ends the moment it lapses, before any write of its owner.
const lapsing = { ...errand, at: now - CombinedErrands.ERRAND_MS + 1000 };
Claims.claimErrand(1, lapsing, [{ line: line(1, 5), count: 5 }]);
assert.equal(Claims.unclaimed(line(1, 5), 2, now), 0, 'the errand still lives: the claim stands');
assert.equal(Claims.unclaimed(line(1, 5), 2, now + 1000), 5, 'the errand lapsed: its claim holds nothing');
Claims.ownerChanged(1, holding(errand));
// A removed bot (retired, deleted) or one gone near releases everything.
Claims.claimErrand(1, errand, [{ line: line(1, 5), count: 5 }]);
Claims.ownerChanged(1, { ...holder, phase: 'hot' });
assert.equal(Claims.unclaimed(line(1, 5), 2), 5, 'a bot gone near holds no claim');
Claims.claimErrand(1, errand, [{ line: line(1, 5), count: 5 }]);
Claims.ownerChanged(1, null);
assert.equal(Claims.unclaimed(line(1, 5), 2), 5, 'a removed bot holds no claim');
// A gear purchase's visit claims the cheapest lines of its item in its town at most the
// goal's price, as many units as it orders, past its own lines and others' claims.
const board = { *lines(itemId, storeType, town) {
    assert.deepEqual([itemId, storeType, town], [1864, 1, 'Giran']);
    yield line(3, 1, 80, 1); yield line(4, 1, 90); yield line(5, 4, 95); yield line(6, 5, 200);
} };
Claims.claimErrand(7, { ...errand, selfId: 1864 }, [{ line: line(4, 1, 90), count: 1 }]);
const visit = { town: 'Giran', startedAt: now, reason: 'upgrade_gear' };
const travel = { characterId: 1, phase: 'cold', activity: 'traveling', stats: { townVisit: visit } };
const gearGoal = { type: 'upgrade_gear', target: { itemId: 1864, adena: 150, amount: 2 } };
// The trip's write did not land (the bot's next write holds no such visit): nothing claimed.
Claims.claimVisit(travel, gearGoal, board);
assert.equal(Claims.unclaimed(line(5, 4, 95), 2), 4, 'a visit not yet written claims nothing');
Claims.ownerChanged(1, { ...travel, activity: 'hunting', stats: {} });
Claims.ownerChanged(1, travel);
assert.equal(Claims.unclaimed(line(5, 4, 95), 2), 4, 'a visit whose write was dropped never claims');
Claims.claimVisit(travel, gearGoal, board);
Claims.ownerChanged(1, travel);
assert.equal(Claims.unclaimed(line(5, 4, 95), 2), 2, 'the visit written claims what it will buy of the first line left to it');
assert.equal(Claims.unclaimed(line(6, 5, 200), 2), 5, 'a line above the goal\'s price is not claimed');
Claims.ownerChanged(1, travel);
assert.equal(Claims.unclaimed(line(5, 4, 95), 2), 2, 'the visit still open: the claim stands');
Claims.ownerChanged(1, { ...travel, activity: 'hunting', stats: { townVisit: { ...visit, completed: true } } });
assert.equal(Claims.unclaimed(line(5, 4, 95), 2), 4, 'the visit completed: released');
Claims.ownerChanged(7, null);
assert.deepEqual(Claims.size(), { lines: 0, owners: 0, decided: 0, trips: 0 }, 'nothing left behind');
const counted = Situations.counts().raised;
assert.equal(counted['board:claim:taken'], counted['board:claim:released'], 'every claim taken was released');
console.log('board claims: PASS (claimed units gone for others, released with the trip, a death or a removal)');
process.exit(0);

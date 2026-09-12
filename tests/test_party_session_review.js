const assert = require('assert');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const at = 1800000000000, minute = 60000;
const members = [1, 2, 3].map(id => ({ characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'grouped',
    party: { partyId: 'p', leaderId: 1 }, stats: { equipmentPlan: { status: 'active', next: { spotId: 's', npcId: 10 } } },
    persona: { traits: { commitment: 0.5, sociability: 0.5, empathy: 0.5, caution: 0.5 } }, timing: {} }));
const party = { partyId: 'p', status: 'active', leaderId: 1, memberIds: [1, 2, 3], spotId: 's',
    startedAt: at - 60 * minute, stats: { sessionExpiresAt: at - 1, fightsWon: 10, lastProgressAt: at - minute,
        objective: { npcId: 10 }, sessionReview: { at: at - 5 * minute, nextAt: at, wins: 9, noProgressSince: at - 10 * minute } } };
const successful = Lifecycle.review(party, members, at);
assert.strictEqual(successful.party.status, 'active');
assert.strictEqual(successful.leaving.size, 0, 'productive parties outlive the old fixed session');
assert(!Lifecycle.sessionExpired(successful.party, at + 1000));
const redirected = members.map(s => s.characterId === 1 ? { ...s, stats: { equipmentPlan: { status: 'active', partyNeed: 'required', next: { spotId: 'elsewhere', npcId: 99 } } } } : s);
const first = Lifecycle.review(party, redirected, at);
assert.strictEqual(first.leaving.size, 0, 'a transient goal change gets a grace period');
const later = Lifecycle.review(first.party, redirected, at + 5 * minute);
assert.deepStrictEqual([...later.leaving.keys()], [1]);
assert.strictEqual(later.party.status, 'active');
assert.strictEqual(later.party.leaderId, 2);
assert.strictEqual(later.states[0].party.partyId, null);
assert(later.states.slice(1).every(s => s.party.leaderId === 2 && s.stats.leaderId === 2));
const resting = Lifecycle.review({ ...first.party, stats: { ...first.party.stats, restUntil: at + 60 * minute } }, redirected, at + 20 * minute);
assert.strictEqual(resting.leaving.size, 0, 'recovery is not evidence of a failed hunt');
const stalledParty = { ...party, stats: { ...party.stats, lastProgressAt: 0,
    sessionReview: { at: at - 5 * minute, nextAt: at, wins: 10, attemptsSinceProgress: 4, noProgressSince: at - 40 * minute } } };
const stalled = Lifecycle.review(stalledParty, members, at);
assert.strictEqual(stalled.party.status, 'dissolved', 'sustained lack of progress gives every member a reason to leave');
const stalledRest = Lifecycle.review({ ...stalledParty, stats: { ...stalledParty.stats, restUntil: at + minute } }, members, at);
assert.strictEqual(stalledRest.party.status, 'dissolved', 'repeated failed fights cannot hide behind the next recovery period');
const noAttemptsRest = Lifecycle.review({ ...stalledParty, stats: { ...stalledParty.stats, restUntil: at + minute,
    sessionReview: { ...stalledParty.stats.sessionReview, attemptsSinceProgress: 0 } } }, members, at);
assert.strictEqual(noAttemptsRest.leaving.size, 0, 'elapsed recovery without failed attempts must not invent failure');
const briefRest = Lifecycle.review({ ...first.party, stats: { ...first.party.stats, restUntil: at + 3 * minute } }, redirected, at + 2 * minute);
assert.strictEqual(briefRest.party.stats.sessionReview.concerns[1].since, at + 2 * minute,
    'recovery suspends an existing concern rather than resetting its history');
const resumed = Lifecycle.review({ ...briefRest.party, stats: { ...briefRest.party.stats, restUntil: null } }, redirected, at + 6 * minute);
assert(resumed.leaving.has(1), 'the concern must reach its grace period after recovery');
const friends = Lifecycle.review(first.party, redirected, at + 5 * minute, {
    personaFor: () => ({ traits: { commitment: 1, empathy: 1 } }),
    assessRelationship: () => ({ ready: true, disposition: 'friendly' }) });
assert.strictEqual(friends.leaving.size, 0, 'committed friends can stay to help despite a different personal goal');
const hostileOptions = { assessRelationship: (a, b) => ({ ready: true, disposition: a.id === 1 && b.id === 2 ? 'hostile' : 'unknown' }) };
const conflict = Lifecycle.review(party, members, at, hostileOptions);
assert.deepStrictEqual([...Lifecycle.review(conflict.party, members, at + 5 * minute, hostileOptions).leaving.keys()], [1]);
assert.strictEqual(JSON.parse(JSON.stringify(successful.party)).stats.sessionReview.nextAt, at + 5 * minute);
console.log('Party reviews: progress, individual departure, leadership, recovery, friendship and conflict checks passed');

const unequal = members.map((m, i) => ({ ...m, level: i === 0 ? 1 : 20 }));
const observed = Lifecycle.review(party, unequal, at);
assert.strictEqual(observed.leaving.size, 0, 'new or temporary XP exclusion needs observed evidence');
const rested = Lifecycle.review({ ...observed.party, stats: { ...observed.party.stats, restUntil: at + 60 * minute } }, unequal, at + 30 * minute);
assert.strictEqual(rested.leaving.size, 0, 'time without additional wins is not evidence of missed XP');
const gainedParty = { ...observed.party, stats: { ...observed.party.stats, fightsWon: 15,
    fightsResolved: 20, lastProgressAt: at + 29 * minute, restUntil: at + 31 * minute } };
const missed = Lifecycle.review(gainedParty, unequal, at + 30 * minute, {
    personaFor: () => ({ traits: { commitment: 1, empathy: 1, sociability: 1 } }),
    assessRelationship: () => ({ ready: true, disposition: 'friendly' })
});
assert.deepStrictEqual([...missed.leaving.keys()], [1], 'friends and group wins cannot hide sustained XP exclusion');
assert.strictEqual(missed.decisions[0].reason, 'party_no_experience');
assert.strictEqual(missed.states[0].activity, 'hunting', 'an excluded hunter must resume solo decisions');
assert.strictEqual(missed.party.leaderId, 2);
const recovered = Lifecycle.review(gainedParty, unequal.map(m => ({ ...m, level: 20 })), at + 30 * minute);
assert.strictEqual(recovered.leaving.size, 0, 'a roster change restoring XP eligibility clears the concern');
assert.deepStrictEqual(recovered.party.stats.sessionReview.experience, {});

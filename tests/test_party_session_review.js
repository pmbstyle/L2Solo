const assert = require('assert');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const at = 1800000000000, minute = 60000;
const members = [1, 2, 3].map(id => ({ characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'grouped',
    party: { partyId: 'p', leaderId: 1 }, stats: { equipmentPlan: { status: 'active', next: { spotId: 's', npcId: 10 } } },
    persona: { traits: { commitment: 0.5, sociability: 0.5, empathy: 0.5, caution: 0.5 } }, timing: {} }));
const party = { partyId: 'p', status: 'active', leaderId: 1, memberIds: [1, 2, 3], spotId: 's',
    startedAt: at - 60 * minute, stats: { fightsWon: 10, lastProgressAt: at - minute,
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
// No fixed cadence: a review runs when its inputs move or one of its clocks runs out.
const settled = JSON.parse(JSON.stringify(successful.party));
assert.strictEqual(settled.stats.sessionReview.nextAt, 0, 'a party with nothing pending has no review deadline');
assert(!Lifecycle.sessionExpired({ ...settled, stats: { ...settled.stats, fightsResolved: 500, fightsWon: 400,
    lastProgressAt: at + 24 * 60 * minute - minute } }, at + 24 * 60 * minute, {}, members),
'a winning party with unchanged inputs is not reviewed again, however long');
const movedPlan = members.map(s => s.characterId === 2
    ? { ...s, stats: { equipmentPlan: { status: 'active', next: { spotId: 'elsewhere', npcId: 99 } } } } : s);
assert(Lifecycle.sessionExpired(settled, at + 1000, {}, movedPlan), 'a moved plan target is reviewed at once');
assert(Lifecycle.sessionExpired(settled, at + 1000, {}, members.map(s => s.characterId === 3
    ? { ...s, stats: { ...s.stats, clanPartyObjective: { status: 'open', clanGoalKey: 'kit' } } } : s)),
'a moved clan objective is reviewed at once');
assert(Lifecycle.sessionExpired(settled, at + 1000, {}, [members[0], members[1]]), 'a roster change is reviewed at once');
const hostileTo = (a, b) => ({ ready: true, disposition: a.id === 2 && b.id === 3 ? 'hostile' : 'unknown' });
const keyed = Lifecycle.review(party, members, at, { assessRelationship: () => ({ ready: true, disposition: 'unknown' }) }).party;
assert(!Lifecycle.sessionExpired(keyed, at + 1000, { assessRelationship: () => ({ ready: true, disposition: 'unknown',
    personal: { lastHuntAt: at } }) }, members), 'a memory event the review does not read (a shared hunt) is no review');
assert(Lifecycle.sessionExpired(keyed, at + 1000, { assessRelationship: hostileTo }, members),
    'a relation between members turning hostile is reviewed at once');
assert(Lifecycle.sessionExpired({ ...settled, stats: { ...settled.stats, objective: { npcId: 11 } } }, at + 1000, {}, members),
    'a moved party objective is reviewed at once');
// Patience is a clock: three fights with no win, then the least patience (8 min + 4 - 1 = 11 min here).
const fought = { ...settled, stats: { ...settled.stats, fightsResolved: 3 } };
assert(!Lifecycle.sessionExpired(fought, at - minute + 10 * minute, {}, members), 'patience still holds');
assert(Lifecycle.sessionExpired(fought, at - minute + 11 * minute, {}, members), 'patience ends after fights with no win');
assert(!Lifecycle.sessionExpired({ ...settled, stats: { ...settled.stats, fightsResolved: 2 } }, at + 60 * minute, {}, members),
    'elapsed time alone, without failed fights, is no reason to review');
const winning = { ...fought, stats: { ...fought.stats, fightsWon: 12, lastProgressAt: at + 9 * minute } };
assert(!Lifecycle.sessionExpired(winning, at + 15 * minute, {}, members), 'a new win restarts the patience clock');
// No fight at all is a clock too: since the review that last saw a fight
// (here the one before, at - 5 min), past a rest's end; patience 11 min.
assert(!Lifecycle.sessionExpired(settled, at + 6 * minute - 1, {}, members), 'idle patience still holds');
assert(Lifecycle.sessionExpired(settled, at + 6 * minute, {}, members), 'a party with no fight over its patience is reviewed');
assert(!Lifecycle.sessionExpired({ ...settled, stats: { ...settled.stats, restUntil: at + 3 * minute } }, at + 6 * minute, {}, members),
    'elapsed recovery alone is no idleness');
const idle = Lifecycle.review(settled, members, at + 6 * minute);
assert.strictEqual(idle.party.status, 'dissolved', 'no fight over everyone\'s patience gives every member a reason to leave');
assert(idle.decisions.every(decision => decision.reason === 'party_no_progress'));
// A member kept only by a recent win keeps its clock through a pause.
const elsewhere = members.map(s => s.characterId === 3
    ? { ...s, stats: { equipmentPlan: { status: 'active', next: { spotId: 'elsewhere', npcId: 99 } } } } : s);
const pausedReview = Lifecycle.review({ ...party, stats: { ...party.stats, restUntil: at + 2 * minute } }, elsewhere, at).party;
assert(pausedReview.stats.sessionReview.pauseHolds, 'a pause holds back the member kept by recent progress');
assert(!Lifecycle.sessionExpired(pausedReview, at + minute, {}, elsewhere));
assert(Lifecycle.sessionExpired(pausedReview, at + 2 * minute, {}, elsewhere), 'the pause\'s end reviews it again');
const keptReview = Lifecycle.review(pausedReview, elsewhere, at + 2 * minute).party;
assert(keptReview.stats.sessionReview.profitHeld && keptReview.memberIds.length === 3);
assert(Lifecycle.sessionExpired({ ...keptReview, stats: { ...keptReview.stats, fightsResolved: 1 } }, at - minute + 10 * minute, {}, elsewhere),
    'the recent progress ending reviews the member kept by it');
// A concern's grace is a fixed deadline.
assert.strictEqual(first.party.stats.sessionReview.nextAt, at + 4 * minute, 'a concern wakes its review at the end of its grace');
assert(!Lifecycle.sessionExpired(first.party, at + 4 * minute - 1, {}, redirected));
assert(Lifecycle.sessionExpired(first.party, at + 4 * minute, {}, redirected));
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
const bridgeMembers = members.map(member => member.characterId === 1
    ? { ...member, activity: 'party_wait' }
    : member);
const bridgeReview = Lifecycle.review(party, bridgeMembers, at, {
    requiresWeaponBridge: member => member.characterId === 1
});
assert.deepStrictEqual([...bridgeReview.leaving.keys()], [1],
    'a member with an incompatible weapon must leave immediately to buy its bridge');
assert.strictEqual(bridgeReview.decisions[0].reason, 'weapon_bridge');
assert.strictEqual(bridgeReview.states[0].party.partyId, null);
assert.strictEqual(bridgeReview.states[0].activity, 'hunting',
    'weapon bridge release must not preserve a stale party-wait state');
assert.strictEqual(bridgeReview.states[0].timing.nextResolveAt, at + 1000,
    'weapon bridge shopping must be scheduled without an ordinary party cooldown');
const armorBridgeReview = Lifecycle.review(party, bridgeMembers, at, {
    equipmentBridgeReason: member => member.characterId === 1 ? 'class_armor_bridge' : null
});
assert.deepStrictEqual([...armorBridgeReview.leaving.keys()], [1],
    'an affordable class armor replacement must not remain behind a permanent party goal');
assert.strictEqual(armorBridgeReview.states[0].activity, 'hunting');
assert.strictEqual(armorBridgeReview.states[0].stats.partyBreakReason, 'class_armor_bridge');
assert.strictEqual(armorBridgeReview.states[0].timing.nextResolveAt, at + 1000);

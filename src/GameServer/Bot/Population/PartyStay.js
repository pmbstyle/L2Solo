'use strict';
// party_stay: does a party member stay in its party now? One member's decision
// (Situations: woken by its own death, a full bag, its weapon bridge funded, karma, a
// new grade, the party outleveling it), taken on the worker at the party's step (ColdSimulationKernel.partyStay) for a far party, a
// hot party at its first cold step; held until the next of those. Pure: the member's
// facts read now, as a C4 player in a party leaves when he must, never on a clock.
// Answers { answer: 'stay' | 'leave' | 'trip', reason }: a leave is released by the
// party step (party_left raised), a trip is a leave with a return ticket in a clan
// duty party (main starts it, PartyMarketBreak.departure), a leave otherwise; a clan
// duty member unloads only a bag at its floor (no slot, overweight). Shots or potions
// under their line take no trip of their own (as a solo bot's: its build buys them on a
// visit only where the road pays, else it hunts on without); the member restocks on its
// bag's trip or its respawn.
const MarketBreak = require('./PartyMarketBreak');
const FLOOR = new Set(MarketBreak.FLOOR_REASONS);
const Karma = require('./ColdKarmaPolicy');

const STAY = Object.freeze({ answer: 'stay', reason: 'stay' });
// member: its state; reads: { bridgeReason(member) (a funded weapon or armour bridge
// the member goes to buy, GearAcquisitionPlanner.equipmentBridgeReason), outleveled
// (the party's XP share excludes it, PartyRewardMath), soloSooner() (its held solo
// answer brings it to its next level sooner than its party share, its persona weighing
// it, PartyProgressComparison), clanDuty, now }.
function decide(member, reads = {}) {
    // Dead: the party's rescue rule holds it (a party revives or carries its dead).
    if (Number(member.vitals?.hp) <= 0 || member.activity === 'dead') return STAY;
    // Karma: the wash is a solo hunt (its earning spot's choice).
    if (Karma.active(member)) return { answer: 'leave', reason: 'karma' };
    const bridge = reads.bridgeReason?.(member);
    if (bridge) return { answer: 'leave', reason: bridge };
    if (reads.outleveled) return { answer: 'leave', reason: 'party_outleveled' };
    // The bag at its floor or a cleanup count.
    const bag = MarketBreak.cleanupNeed(member, reads.now);
    if (bag && (!reads.clanDuty || FLOOR.has(bag.reason))) return { answer: 'trip', reason: 'bag_full' };
    // A new grade (or any other wake): the held solo answer against its party share.
    if (reads.soloSooner?.()) return { answer: 'leave', reason: 'solo_sooner' };
    return STAY;
}

// Whether a candidate stays in a party it would join now (forming's verdict, a recruit
// check): the stay read on its own facts only (karma, the bag; no share or bridge read
// before it is in a party). A candidate that would leave
// at once is not taken: forming builds no party to dissolve.
function joins(member, now = Date.now()) {
    return decide(member, { now }).answer === 'stay';
}

module.exports = { decide, joins };

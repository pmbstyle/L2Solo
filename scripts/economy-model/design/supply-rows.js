'use strict';

// The supply table as data: each row names the words of its condition (all
// must hold) and the action maker it runs (supply.js WORDS and MAKERS), so a
// new row made of existing words is data, not code.
//   FIELD  in the field: the first row that holds answers; none holds, the bot
//          keeps hunting (a full bag alone always has surplus: its drop).
//   TOWN   in town: every row that holds runs, in order, each on the state
//          the rows before it left (the sale's adena pays the purchase).
// A reserved row keeps its place for a rule not registered yet: the reader
// accepts it and skips it.

const FIELD = Object.freeze([
    // Out of its shots or its bag full, with adena or something to sell: to the nearest town that sells them.
    Object.freeze({ id: 'F1', when: Object.freeze(['outOrBag', 'walletOrSurplus']), then: 'goNearestSeller' }),
    // Out of its shots with no adena and nothing to sell: it stays (stuck where it kills nothing bare).
    Object.freeze({ id: 'F2', when: Object.freeze(['out', 'noWalletNoSurplus']), then: 'stay' })
]);

const TOWN = Object.freeze([
    // Sell everything it can spare to the NPC.
    Object.freeze({ id: 'T1', when: Object.freeze(['surplus']), then: 'sellAllNpc' }),
    // Buy its consumable up to the outing's target with what it has (part of it when short).
    Object.freeze({ id: 'T2', when: Object.freeze(['belowTarget']), then: 'buyToTarget' }),
    // A kit part bought here is worn here (no rule yet: nothing in an NPC world buys one).
    Object.freeze({ id: 'T3', reserved: 'kit' }),
    // Walk back to the held spot.
    Object.freeze({ id: 'T4', when: Object.freeze([]), then: 'back' })
]);

module.exports = { FIELD, TOWN };

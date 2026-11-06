// What a far bot hears where it stands (Situations): a change waits for its player's moment.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Situations = invoke('GameServer/Bot/Situations');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');

const hunter = { characterId: 7, activity: 'hunting', spotId: 's', stats: {} };
const leaf = { activity: 'hunting', spotId: 's' };

const at = activity => Situations.place({ phase: 'cold', activity, stats: {} });
// The clan's call (its demand moved) and its clan changing wait for the bot's next stop.
const raiseAt = (name, activity) => Situations.raise({ woken: 0, wishSections: {}, equipmentPlan: {}, earning: {} }, name, null, at(activity));
assert(!Situations.woken(raiseAt('clan_call', 'hunting'), 'build') && Situations.woken(raiseAt('clan_call', 'resting'), 'build'),
    'a rest reads the clan\'s demand');
assert(Situations.woken(raiseAt('clan_changed', 'resting'), 'build'));
// The build and the gear plan wake on their own situations only (situations.md §14): the
// money's crossings of its thresholds, not its drift; a new level or gear waits for its stop.
for (const name of ['arrived_town', 'died', 'goal_failed', 'goal_done:goal', 'bag_full', 'stock_low:shots', 'source_stalled',
    'goal_affordable:focus', 'out_of_money'])
    assert(Situations.woken(raiseAt(name, 'hunting'), 'build'), `${name} wakes the build at once`);
for (const name of ['bag', 'party_joined', 'moved_by_world'])
    assert(!Situations.woken(raiseAt(name, 'shopping'), 'build'), `${name} wakes no build`);
assert(!Situations.woken(raiseAt('level_up', 'hunting'), 'build') && Situations.woken(raiseAt('level_up', 'resting'), 'build'), 'a level waits for the rest');
assert(Situations.woken(raiseAt('level_up', 'resting'), 'gear_plan') && !Situations.woken(raiseAt('goal_affordable:focus', 'hunting'), 'gear_plan'),
    'the gear plan wakes on the kit, not the purse');
// The wallet against the decision's thresholds (F3, B7): its goal in reach as the budget stands
// at or past it, out of money as it falls below the held leaf's funded row; a drift is nothing.
// Each once per baseline (the mark), the next build re-arms it.
const baseline = { at: 100, affordAt: { at: 5000, kind: 'focus' }, fundedAt: 800 };
const crossed = (now, given = baseline, raised = null) => Sections.moneyCrossings(now, given, raised);
assert.deepEqual(crossed(1500).names, [], 'a drift is no event');
const reached = crossed(6000);
assert.deepEqual(reached.names, ['goal_affordable:focus'], 'its goal in reach is');
assert.deepEqual(crossed(7000, baseline, reached.raised).names, [], 'once per baseline');
assert.deepEqual(crossed(7000, { ...baseline, at: 200 }, reached.raised).names, ['goal_affordable:focus'], 'the next build re-arms it');
assert.deepEqual(crossed(700, baseline, reached.raised).names, ['out_of_money'], 'the held leaf unfunded is');
assert.deepEqual(crossed(6000, { at: 100, affordAt: { at: 3000, kind: 'potions' } }).names, ['goal_affordable:potions'],
    'a broke bot\'s survival potions name their kind');
assert(Situations.DECISIONS.earning_spot.includes('goal_affordable:potions'), 'they wake the earning spot');
// A far step's money comes from its own diff (detect): no per-step soft point. Money main added
// between steps (a sale paid: the state before already holds it) is heard at the next step.
const purse = (adena, stats = {}) => ({ ...hunter, phase: 'cold', adena, stats: { wishSections: baseline, ...stats } });
assert(Situations.detect(purse(1000), purse(6000)).includes('goal_affordable:focus'), 'a far step hears its goal in reach');
assert(Situations.detect(purse(6000), purse(6000)).includes('goal_affordable:focus'), 'and money main added between steps');
const seen = {};
Situations.detect(purse(6000), purse(6000), { out: seen });
assert(!Situations.detect(purse(6000), purse(6100, { moneyRaised: seen.raised })).some(name => name.startsWith('goal_affordable')),
    'raised once: the mark holds it');
assert(!Situations.detect(purse(1000), purse(1500)).some(name => name.startsWith('goal_affordable')), 'and nothing on a drift');
// Its goal in reach clears its failed buy's retry stamp (debt 24).
assert.equal(Situations.raise({ woken: 0, marketRetryAfter: 99 }, 'goal_affordable:focus').marketRetryAfter, null, 'it may buy again');
// The one table: what a bot hears where it stands.
const cold = (activity, extra = {}) => ({ ...hunter, phase: 'cold', activity, ...extra });
const waitsFor = (state, ...links) => links.every(link => !Situations.hears(link, Situations.place(state)));
const hearsAll = (state, ...links) => links.every(link => Situations.hears(link, Situations.place(state)));
assert(waitsFor(cold('hunting'), 'bag', 'clan_call', 'clan_changed'), 'at work the links wait');
assert(waitsFor(cold('hunting'), 'level_up', 'gear_changed') && hearsAll(cold('resting'), 'level_up', 'gear_changed'), 'a new level waits for the rest');
assert(hearsAll(cold('hunting'), 'died', 'spot_dangerous', 'recovered', 'moved_by_world', 'shots_out', 'stock_low:shots', 'stock_low:potions', 'bag_full',
    'goal_affordable:focus', 'out_of_money'), 'its fight, its place, a condition and its money thresholds do not');
assert(waitsFor(cold('resting'), 'bag') && hearsAll(cold('resting'), 'clan_changed', 'clan_call'), 'a rest reads the clan');
assert(waitsFor(cold('shopping'), 'bag', 'clan_call', 'level_up', 'gear_changed', 'recipe_learned', 'clan_changed'), 'a visit works down its list');
assert.equal(Situations.place({ ...cold('shopping') }, cold('traveling')), 0, 'arriving hears all that waited');
assert(Situations.readsFacts(cold('traveling'), cold('shopping')), 'the step that arrives in town reads its facts');
assert(!Situations.readsFacts(cold('shopping'), cold('shopping')) && !Situations.readsFacts(cold('traveling'), cold('traveling')), 'and only that step');
assert(Situations.readsFacts(cold('grouped', { partyId: 'p' }), cold('grouped', { partyId: 'p' })), 'a party reads its round');
assert(hearsAll(cold('hunting', { stats: { tradeMeeting: [1] } }), 'clan_changed'), 'nor on the way to a meeting');
assert(waitsFor(cold('grouped', { partyId: 'p' }), 'level_up'), 'a party fight waits as a hunt');
assert(hearsAll(cold('resting', { partyId: 'p' }), 'level_up', 'clan_changed'), 'and a party reads at its rest');
assert(hearsAll(cold('grouped', { partyId: 'p' }), 'party_joined', 'party_left', 'died', 'moved_by_world'), 'a join, a role, a death do not wait');
assert(hearsAll(cold('hunting'), 'goal_failed', 'goal_done:goal', 'goal_failed:visit'), 'what its execution proved goes at once');
assert.equal(Situations.placeName(Situations.place(cold('traveling'))), 'work', 'a hunt or the road is work');
// Own trips: the bot's way out and back is no event far from a player; the world's push is.
const trip = (travel, extra = {}) => cold('traveling', { stats: { travel }, ...extra });
const back = { reason: 'return_after_market', spotId: 'other', townName: 'Giran', arrivalActivity: 'hunting' };
assert.equal(Sections.occupationPlanned(trip(back), leaf), true, 'the way back from town is its own');
assert.equal(Sections.occupationPlanned(trip({ reason: 'market_sale_inventory', townName: 'Giran' }), leaf), true, 'so is a trip to sell');
assert.equal(Sections.occupationPlanned(trip({ reason: 'level_replan', spotId: 'x' }), null), true, 'and its own route with no leaf');
assert.equal(Sections.occupationPlanned(trip({ reason: 'unsafe_ground_evacuation' }), leaf), false, 'a flight stays an event');
assert.equal(Sections.occupationPlanned(trip({ reason: 'death_pressure_replan', cause: 'death_pressure' }), leaf), false, 'and a death pressure');
assert.equal(Sections.occupationPlanned(trip({ reason: 'party_spot_replan' }, { partyId: 'p' }), leaf), false, 'a party\'s call stays an event');
assert.equal(Sections.occupationPlanned(cold('hunting', { spotId: 'x' }), { activity: 'shopping' }), true, 'reaching its ground is no second event');
assert.equal(Sections.occupationPlanned(cold('grouped', { spotId: 'x', partyId: 'p' }), { activity: 'shopping' }), true, 'nor a party\'s fight');
assert.equal(Sections.occupationPlanned(cold('shopping'), leaf), false, 'and town is a moment');
assert.equal(Sections.occupationPlanned({ ...trip(back), phase: 'hot' }, leaf), false, 'nor a near bot');
console.log('player moment ok');
process.exit(0);

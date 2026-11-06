// What a far bot hears where it stands (Situations): a change waits for its player's moment.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Situations = invoke('GameServer/Bot/Situations');

const hunter = { characterId: 7, activity: 'hunting', spotId: 's', stats: {} };
const leaf = { activity: 'hunting', spotId: 's' };

const at = activity => Situations.place({ phase: 'cold', activity, stats: {} });
// The clan's call (its demand moved) and its clan changing wait for the bot's next stop.
const raiseAt = (name, activity) => Situations.raise({ woken: 0, wishSections: {}, equipmentPlan: {}, earning: {} }, name, null, at(activity));
assert(!Situations.woken(raiseAt('clan_call', 'hunting'), 'build') && Situations.woken(raiseAt('clan_call', 'resting'), 'build'),
    'a rest reads the clan\'s demand');
assert(Situations.woken(raiseAt('clan_changed', 'resting'), 'build'));
assert.equal(Situations.hears('warehouse', at('resting')), false, 'its own deposit and take raise nothing on a rest');
assert.equal(Situations.hears('warehouse', at('shopping')), false, 'nor on a town visit');
assert.equal(Situations.hears('warehouse', Situations.place({ phase: 'cold', activity: 'shopping', stats: {} }, { activity: 'traveling' })), true, 'it is read as the bot arrives in town');
// The build and the gear plan wake on their own situations only (situations.md §14): money
// drift, samples and the bot's own doing wake nothing; a new level or gear waits for its stop.
for (const name of ['arrived_town', 'died', 'goal_failed', 'goal_done:goal', 'bag_full', 'stock_low:shots', 'source_stalled', 'goal_affordable:focus'])
    assert(Situations.woken(raiseAt(name, 'hunting'), 'build'), `${name} wakes the build at once`);
for (const name of ['money', 'observation', 'market', 'own_move', 'own_preparation', 'warehouse', 'supply', 'bag', 'party_joined', 'moved_by_world'])
    assert(!Situations.woken(raiseAt(name, 'shopping'), 'build'), `${name} wakes no build`);
assert(!Situations.woken(raiseAt('level_up', 'hunting'), 'build') && Situations.woken(raiseAt('level_up', 'resting'), 'build'), 'a level waits for the rest');
assert(Situations.woken(raiseAt('level_up', 'resting'), 'gear_plan') && !Situations.woken(raiseAt('goal_affordable:focus', 'hunting'), 'gear_plan'),
    'the gear plan wakes on the kit, not the purse');
// Away on a solo hunt only the next wish within reach raises money; in reach of town the drift does too.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const moneyBaseline = { wallet: 1000, moneyError: 100, cashBounds: [0, 5000], affordAt: { at: 5000, kind: 'focus' }, funding: 0 };
const hunting = adena => ({ characterId: 7, phase: 'cold', activity: 'hunting', adena, stats: {} });
const soft = state => Sections.softEvents(state, moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 });
assert(!soft(hunting(1500)).includes('money'), 'a drift away on the hunt is no event');
assert(soft(hunting(6000)).includes('goal_affordable:focus'), 'its goal in reach is');
// A broke bot's survival potions come first: their threshold names its kind (situations.md B7).
assert.deepEqual([...Sections.softEvents(hunting(6000), { ...moneyBaseline, affordAt: { at: 3000, kind: 'potions' } },
    { buyOrderEscrow: 0, timestamp: 1 })], ['goal_affordable:potions'], 'the potions it can afford again');
assert(Situations.DECISIONS.earning_spot.includes('goal_affordable:potions'), 'they wake the earning spot');
// A baseline from before the threshold keeps its focus budget.
assert(Sections.softEvents(hunting(6000), { ...moneyBaseline, affordAt: undefined, goalBudget: 5000 },
    { buyOrderEscrow: 0, timestamp: 1 }).includes('goal_affordable:focus'));
assert(!soft({ ...hunting(1500), partyId: 'bgp_1' }).includes('money'), 'a party member holds its plan too');
assert.deepEqual(Sections.softEvents(hunting(1000), { ...moneyBaseline, share: 0.5, incomeError: 0 }, { buyOrderEscrow: 0, timestamp: 1 }), [],
    'nor does the income reach it on the hunt');
// The one table: what a bot hears where it stands.
const cold = (activity, extra = {}) => ({ ...hunter, phase: 'cold', activity, ...extra });
const waitsFor = (state, ...links) => links.every(link => !Situations.hears(link, Situations.place(state)));
const hearsAll = (state, ...links) => links.every(link => Situations.hears(link, Situations.place(state)));
assert(waitsFor(cold('hunting'), 'funding', 'money', 'supply', 'bag', 'clan_call', 'clan_changed', 'observation'), 'at work the links wait');
assert(waitsFor(cold('hunting'), 'level_up', 'gear_changed') && hearsAll(cold('resting'), 'level_up', 'gear_changed'), 'a new level waits for the rest');
assert(hearsAll(cold('hunting'), 'died', 'spot_dangerous', 'recovered', 'moved_by_world', 'shots_out', 'stock_low:shots', 'stock_low:potions', 'bag_full', 'goal_affordable:focus', 'market'), 'its fight, its place and a condition do not');
assert(waitsFor(cold('resting'), 'supply', 'bag') && hearsAll(cold('resting'), 'funding', 'clan_changed', 'clan_call'), 'a rest reads the money and the clan');
assert(waitsFor(cold('shopping'), 'funding', 'money', 'supply', 'bag', 'clan_call', 'level_up', 'gear_changed', 'recipe_learned', 'clan_changed'), 'a visit works down its list');
assert.equal(Situations.place({ ...cold('shopping') }, cold('traveling')), 0, 'arriving hears all that waited');
assert(hearsAll(cold('crafting'), 'funding', 'money', 'supply'), 'a craft has no check for its end');
assert(waitsFor(cold('resting'), 'money') && hearsAll(cold('resting'), 'funding', 'clan_changed', 'clan_call', 'level_up'), 'a rest is no review of the purse');
assert(Situations.readsFacts(cold('traveling'), cold('shopping')), 'the step that arrives in town reads its facts');
assert(!Situations.readsFacts(cold('shopping'), cold('shopping')) && !Situations.readsFacts(cold('traveling'), cold('traveling')), 'and only that step');
assert(Situations.readsFacts(cold('grouped', { partyId: 'p' }), cold('grouped', { partyId: 'p' })), 'a party reads its round');
assert.deepEqual(Sections.softEvents(cold('shopping', { adena: 1500 }), moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 }, cold('traveling')), ['money'], 'town reads the purse on arrival');
assert.deepEqual(Sections.softEvents(cold('shopping', { adena: 1500 }), moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 }), [], 'and not again on the visit');
assert(hearsAll(cold('merchant'), 'funding', 'money'), 'a stall hears its money');
assert(waitsFor(cold('crafting'), 'own_move', 'own_preparation'), 'its own doing is no event anywhere');
assert(hearsAll(cold('hunting', { stats: { tradeMeeting: [1] } }), 'funding', 'supply', 'clan_changed'), 'nor on the way to a meeting');
assert(waitsFor(cold('grouped', { partyId: 'p' }), 'level_up', 'money', 'own_move'), 'a party fight waits as a hunt');
assert(hearsAll(cold('resting', { partyId: 'p' }), 'level_up', 'clan_changed'), 'and a party reads at its rest');
assert(hearsAll(cold('grouped', { partyId: 'p' }), 'party_joined', 'party_left', 'died', 'moved_by_world'), 'a join, a role, a death do not wait');
assert(hearsAll({ ...hunter, phase: 'hot' }, 'funding', 'own_move'), 'nor near a player');
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
// At work money speaks when it reaches the goal, not at each price the last review read.
const purse = adena => cold('hunting', { adena, stats: {} });
const wallet = { wallet: 50, moneyError: -1, cashBounds: [0, 100], budgetBounds: [0, 100], affordAt: { at: 500, kind: 'focus' } };
const moneyHeard = state => Sections.softEvents(state, wallet, { board: null });
assert.deepEqual([...moneyHeard(purse(150))], [], 'a next price is no event at work');
assert.deepEqual([...moneyHeard(purse(500))], ['goal_affordable:focus'], 'the goal within reach is');
assert.deepEqual([...moneyHeard({ ...purse(150), activity: 'resting' })], [], 'nor at a rest');
assert.deepEqual([...moneyHeard({ ...purse(500), activity: 'resting' })], ['goal_affordable:focus'], 'there the goal speaks too');
// The bot's own craft preparation asks no review far from a player; it stands in its state.
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const preparing = cold('crafting', { stats: { decisionSeq: 3 } });
assert.deepEqual(Events.applyOwnRaise(preparing), preparing.stats, 'its own preparation raises nothing');
assert(!Situations.woken(Events.applyOwnRaise({ ...preparing, phase: 'hot', stats: { ...preparing.stats, woken: 0, wishSections: {} } }), 'build'),
    'near a player neither: own outputs wake no decision');
console.log('player moment ok');
process.exit(0);

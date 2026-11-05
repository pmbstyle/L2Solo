// What a far bot hears where it stands (Situations): a change waits for its player's moment.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Situations = invoke('GameServer/Bot/Situations');

const hunter = { characterId: 7, activity: 'hunting', spotId: 's', stats: {} };
const leaf = { activity: 'hunting', spotId: 's' };

const at = activity => Situations.place({ phase: 'cold', activity, stats: {} });
assert.equal(Situations.hears('stores', at('resting')), true, 'a rest reads the clan\'s demand');
assert.equal(Situations.hears('warehouse', at('resting')), false, 'its own deposit and take raise nothing on a rest');
assert.equal(Situations.hears('warehouse', at('shopping')), false, 'nor on a town visit');
assert.equal(Situations.hears('warehouse', Situations.place({ phase: 'cold', activity: 'shopping', stats: {} }, { activity: 'traveling' })), true, 'it is read as the bot arrives in town');
// A bot at work weighs only the gear it follows; a real review weighs every candidate.
const far = { ...hunter, phase: 'cold' };
assert.equal(Situations.quiet(far, 'wish_dirty'), true, 'a soft event on the spot');
assert.equal(Situations.quiet({ ...far, activity: 'traveling' }, 'refresh'), true, 'and on the road');
assert.equal(Situations.quiet({ ...far, activity: 'resting' }, 'wish_dirty'), true, 'a rest reads no gear');
assert.equal(Situations.quiet({ ...far, activity: 'shopping' }, 'wish_dirty'), false, 'so is the town');
assert.equal(Situations.quiet({ ...far, activity: 'grouped', partyId: 3 }, 'wish_dirty'), true, 'a party fight is work too');
assert.equal(Situations.quiet(far, 'check:short'), false, 'a failed goal chooses again');
assert.equal(Situations.quiet(far, 'goal'), false, 'a goal main moved too');
assert.equal(Situations.quiet(far, undefined), false, 'no card stood: no held build to follow');
// Away on a solo hunt only the next wish within reach raises money; in reach of town the drift does too.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const moneyBaseline = { wallet: 1000, moneyError: 100, cashBounds: [0, 5000], goalBudget: 5000, funding: 0 };
const hunting = adena => ({ characterId: 7, phase: 'cold', activity: 'hunting', adena, stats: {} });
const soft = state => Sections.softEvents(state, moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 });
assert(!soft(hunting(1500)).includes('money'), 'a drift away on the hunt is no event');
assert(soft(hunting(6000)).includes('money'), 'its goal in reach is');
assert(!soft({ ...hunting(1500), partyId: 'bgp_1' }).includes('money'), 'a party member holds its plan too');
assert.deepEqual(Sections.softEvents(hunting(1000), { ...moneyBaseline, share: 0.5, incomeError: 0 }, { buyOrderEscrow: 0, timestamp: 1 }), [],
    'nor does the income reach it on the hunt');
// The one table: what a bot hears where it stands.
const cold = (activity, extra = {}) => ({ ...hunter, phase: 'cold', activity, ...extra });
const waitsFor = (state, ...links) => links.every(link => !Situations.hears(link, Situations.place(state)));
const hearsAll = (state, ...links) => links.every(link => Situations.hears(link, Situations.place(state)));
assert(waitsFor(cold('hunting'), 'funding', 'money', 'supply', 'bag', 'quantity', 'stores', 'relations', 'observation'), 'at work the links wait');
assert(waitsFor(cold('hunting'), 'level_up', 'gear_changed') && hearsAll(cold('resting'), 'level_up', 'gear_changed'), 'a new level waits for the rest');
assert(hearsAll(cold('hunting'), 'died', 'spot_dangerous', 'recovered', 'moved_by_world', 'shots_out', 'stock_low:potions', 'stock_low', 'bag_full', 'goal', 'market'), 'its fight, its place and a condition do not');
assert(waitsFor(cold('resting'), 'supply', 'bag', 'quantity') && hearsAll(cold('resting'), 'funding', 'relations', 'stores'), 'a rest reads the money, the people and the clan');
assert(waitsFor(cold('shopping'), 'funding', 'money', 'supply', 'bag', 'quantity', 'stores', 'level_up', 'gear_changed', 'recipe_learned', 'relations', 'income_moved'), 'a visit works down its list');
assert(hearsAll(cold('shopping'), 'filled', 'short', 'offer_gone'), 'its list\'s end does not wait');
assert(hearsAll(cold('resting'), 'income_moved') && waitsFor(cold('resting'), 'income_later'), 'a better spot reaches a rest on a hunt, not one on another job');
assert(waitsFor(cold('resting'), 'offer_gone') && waitsFor(cold('traveling'), 'offer_gone'), 'who sells what is read at the market');
assert.equal(Situations.place({ ...cold('shopping') }, cold('traveling')), 0, 'arriving hears all that waited');
assert(hearsAll(cold('crafting'), 'funding', 'money', 'supply', 'quantity'), 'a craft has no check for its end');
assert(waitsFor(cold('resting'), 'money', 'short') && hearsAll(cold('resting'), 'funding', 'relations', 'stores', 'level_up'), 'a rest is no review of the purse');
assert(Situations.readsFacts(cold('traveling'), cold('shopping')), 'the step that arrives in town reads its facts');
assert(!Situations.readsFacts(cold('shopping'), cold('shopping')) && !Situations.readsFacts(cold('traveling'), cold('traveling')), 'and only that step');
assert(Situations.readsFacts(cold('grouped', { partyId: 'p' }), cold('grouped', { partyId: 'p' })), 'a party reads its round');
assert.deepEqual(Sections.softEvents(cold('shopping', { adena: 1500 }), moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 }, cold('traveling')), ['money'], 'town reads the purse on arrival');
assert.deepEqual(Sections.softEvents(cold('shopping', { adena: 1500 }), moneyBaseline, { buyOrderEscrow: 0, timestamp: 1 }), [], 'and not again on the visit');
assert(hearsAll(cold('merchant'), 'funding', 'money'), 'a stall hears its money');
assert(waitsFor(cold('crafting'), 'own_move', 'own_preparation'), 'its own doing is no event anywhere');
assert(hearsAll(cold('hunting', { stats: { tradeMeeting: [1] } }), 'funding', 'supply', 'relations'), 'nor on the way to a meeting');
assert(waitsFor(cold('grouped', { partyId: 'p' }), 'level_up', 'money', 'quantity', 'own_move'), 'a party fight waits as a hunt');
assert(hearsAll(cold('resting', { partyId: 'p' }), 'level_up', 'relations'), 'and a party reads at its rest');
assert(hearsAll(cold('grouped', { partyId: 'p' }), 'party_joined', 'party_left', 'died', 'moved_by_world'), 'a join, a role, a death do not wait');
assert(hearsAll({ ...hunter, phase: 'hot' }, 'funding', 'quantity', 'own_move'), 'nor near a player');
assert(hearsAll(cold('hunting'), 'threat', 'excluded', 'material_done', 'filled', 'sale', 'craft', 'target'), 'a failed check goes at once');
assert(waitsFor(cold('hunting'), 'short', 'money') && waitsFor(cold('crafting'), 'short') && hearsAll(cold('shopping'), 'short'), 'short of a price it earns on: the shop reads its purse');
assert(waitsFor(cold('hunting'), 'income_moved') && hearsAll(cold('resting'), 'income_moved'), 'a better spot waits for the rest');
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
const wallet = { wallet: 50, moneyError: -1, cashBounds: [0, 100], budgetBounds: [0, 100], goalBudget: 500 };
const moneyHeard = state => Sections.softEvents(state, wallet, { board: null });
assert.deepEqual([...moneyHeard(purse(150))], [], 'a next price is no event at work');
assert.deepEqual([...moneyHeard(purse(500))], ['money'], 'the goal within reach is');
assert.deepEqual([...moneyHeard({ ...purse(150), activity: 'resting' })], [], 'nor at a rest');
assert.deepEqual([...moneyHeard({ ...purse(500), activity: 'resting' })], ['money'], 'there the goal speaks too');
// The bot's own craft preparation asks no review far from a player; it stands in its state.
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const preparing = cold('crafting', { stats: { decisionSeq: 3 } }), bits = Sections.sectionMask(['sources', 'benefits', 'money']);
assert.deepEqual(Events.applyOwnRaise(preparing), preparing.stats, 'its own preparation raises nothing');
assert.equal(Events.applyOwnRaise({ ...preparing, phase: 'hot' }).wishDirty, bits, 'a near bot raises');
console.log('player moment ok');
process.exit(0);

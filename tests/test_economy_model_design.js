'use strict';

// The economy model design's decision layer on plain fixtures: a bot out of
// shots goes to the town that sells them when it can pay, stays when it
// has nothing; in town it sells what it can spare to the NPC, buys up to its
// outing's target with what it has and walks back. The formula variant goes
// only when the trip prevents more loss than it costs. Facts raised on the
// road are heard on arrival with the town's, a death decides nothing, and the
// shadow names the table row where the two variants answer differently.
const assert = require('node:assert/strict');
const Engine = require('../scripts/economy-model/engine');
const Catalog = require('../scripts/economy-model/design/catalog');
const Attention = require('../scripts/economy-model/design/attention');
const Needs = require('../scripts/economy-model/design/needs');
const Value = require('../scripts/economy-model/design/value');
const Supply = require('../scripts/economy-model/design/supply');

const SHOT = 1835, DROP = 200;
// The fixtures' spots' mean mob level (the outing spot rule's level gap): level 1, within the gap of every level they reach.
const AVG_LEVEL = { s1: 1, s2: 1, s3: 1, sE: 1, sM: 1, '-12_43': 1, cut: 1 };
const viewOf = snapshot => Engine.viewOf({ spotAvgLevel: AVG_LEVEL, ...snapshot });
const out = [{ kind: 'out', who: 7, at: 3 }], bag = [{ kind: 'bag', who: 7, at: 3 }], town = [{ kind: 'town', who: 7, at: 4 }];
// A level-1 bot out of its 200-shot target in the field, its spot's town selling the shots at 7.
// Its bag fills 2 h after the visit (need.hours, the formula's horizon).
const field = (over = {}) => ({ place: 'hunt', town: null, spotTown: 'TownA', need: { id: SHOT, perHour: 100, hours: 2, target: 200, held: 0, short: 200 },
    surplus: [], npcBuy: { [DROP]: 5, [SHOT]: 2 }, wallet: 2000, roadMoney: 0, toHours: 0.1, backHours: 0.1, horizon: 2,
    offers: { town: 'TownA', price: 7 }, fightsBare: true, variant: 'table',
    value: { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 2, outHours: 2, M: 25000, moneyWeight: 0.5 }, ...over });
const inTown = over => field({ place: 'town', town: 'TownA', ...over });
const brief = actions => actions.map(({ kind, town, id, count, price, reason, row }) => ({ kind, town, id, count, price, reason, row }));

// Table: out of shots with adena, to the town that sells them; with nothing it stays, stuck only where it kills nothing bare.
assert.deepEqual(brief(Supply.supplyChoice(out, field())), [{ kind: 'go', town: 'TownA', id: undefined, count: undefined, price: undefined, reason: undefined, row: 'F1' }]);
assert.deepEqual(brief(Supply.supplyChoice(out, field({ wallet: 0 }))).map(a => [a.kind, a.reason, a.row]), [['stay', 'no_money', 'F2']]);
assert.deepEqual(brief(Supply.supplyChoice(out, field({ wallet: 0, fightsBare: false }))).map(a => [a.kind, a.reason, a.row]), [['stay', 'no_bare_hour', 'F2']]);
// Its bag full with shots held: to the nearest town (where no NPC sells its shots, the held spot's town).
const bagFull = field({ need: { id: SHOT, perHour: 100, target: 200, held: 150, short: 50 }, surplus: [[DROP, 40]] });
assert.deepEqual(brief(Supply.supplyChoice(bag, bagFull)).map(a => [a.kind, a.town, a.row]), [['go', 'TownA', 'F1']]);
assert.deepEqual(brief(Supply.supplyChoice(bag, { ...bagFull, offers: null, spotTown: 'TownB' })).map(a => [a.kind, a.town]), [['go', 'TownB']]);
// A death or nothing to act on in the field: it keeps hunting.
assert.deepEqual(Supply.supplyChoice([{ kind: 'died', who: 7, at: 3 }], field()), []);

// Table in town with 0 adena and 40 drop: sells all at the NPC's buy price, buys
// with the 200 adena the sale brought (28 of 200: partial), walks back, in that order.
const broke = inTown({ wallet: 0, surplus: [[DROP, 40]] });
assert.deepEqual(brief(Supply.supplyChoice(town, broke)).map(a => [a.kind, a.id, a.count, a.price, a.row]),
    [['sell', DROP, 40, 5, 'T1'], ['buy', SHOT, 28, 7, 'T2'], ['back', undefined, undefined, undefined, 'T4']]);
// With enough adena it buys exactly up to the target.
assert.deepEqual(brief(Supply.supplyChoice(town, inTown({ wallet: 10000 }))).map(a => [a.kind, a.count]), [['buy', 200], ['back', undefined]]);
// A reserved kit row is accepted and does nothing; a row naming an action outside the closed set throws by name.
assert.deepEqual(Supply.table(town, broke, { FIELD: [], TOWN: [{ id: 'T3', reserved: 'kit' }] }), []);
assert.throws(() => Supply.table(out, field(), { FIELD: [{ id: 'X1', when: ['out'], then: 'teleport' }], TOWN: [] }), /row X1: action 'teleport' is not in the closed set/);
assert.throws(() => Supply.supplyChoice(out, field({ variant: 'guess' })), /no supply variant 'guess'/);

// Formula: out of shots, the road's price below the loss of 2 bare hours: it goes.
const formula = over => field({ variant: 'formula', ...over });
assert.deepEqual(brief(Supply.supplyChoice(out, formula())).map(a => [a.kind, a.town, a.row]), [['go', 'TownA', 'formula']]);
// A near-full stock and a long road: the trip costs more than the drop it would save.
const nearFull = formula({ need: { id: SHOT, perHour: 100, target: 200, held: 190, short: 10 }, surplus: [[DROP, 40]], toHours: 1, backHours: 1,
    value: { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 2, outHours: 1.9, M: 25000, moneyWeight: 0.5 } });
assert.deepEqual(brief(Supply.supplyChoice(bag, nearFull)).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// A partial wallet scales the loss the trip prevents: 70 adena buys 10 of 200 shots, and the same trip no longer pays.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ wallet: 70 }))).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// With 0 adena and 400 drop the trip spends what the drop sells for there (2000 adena: the whole target), as the town rows
// do: it goes under both variants, and the shadow sees no difference.
const dropOnly = field({ wallet: 0, surplus: [[DROP, 400]] });
assert.deepEqual(brief(Supply.supplyChoice(out, { ...dropOnly, variant: 'formula' })).map(a => [a.kind, a.town]), [['go', 'TownA']]);
assert.equal(Supply.shadow(out, dropOnly).differ, null);
// Out of shots with nothing to pay with, both variants stay for the same reason: stuck only where it kills nothing bare.
for (const fightsBare of [true, false]) {
    const broke = field({ wallet: 0, fightsBare, value: { ...field().value, bare: fightsBare ? 0.2 : 0 } });
    const both = Supply.shadow(out, broke);
    assert.equal(both.differ, null);
    assert.deepEqual(brief(both.other).map(a => [a.kind, a.reason]), [['stay', fightsBare ? 'no_money' : 'no_bare_hour']]);
    assert.equal(Supply.stuck(broke), !fightsBare);
}
// In town the formula takes the same levers in the same order.
assert.deepEqual(brief(Supply.supplyChoice(town, { ...broke, variant: 'formula' })).map(a => [a.kind, a.count]), [['sell', 40], ['buy', 28], ['back', undefined]]);

// The shadow names the table row where the variants differ, and nothing where they agree.
const differ = Supply.shadow(bag, nearFull);
assert.deepEqual(brief(differ.actions).map(a => a.kind), ['stay']);
assert.deepEqual(differ.differ, { row: 'F1', reason: 'table go / formula stay:trip_costs_more' });
assert.equal(Supply.shadow(out, field()).differ, null);

// The hour value on a view: a row whose line fights nothing without shots is
// worth nothing bare, and with a long road the formula goes there all the same
// (the bag never fills bare: its loss is the whole outing).
const row = (spotId, exp, adena, extra = {}) => ({ spotId, kills: 10, exp, adena, shots: 30, dropLoot: 50, spoilLoot: 0, loot: 50, potions: 0, busyShare: 1, deaths: 0, ...extra });
const near = row('s1', 100, 200, { deaths: 0.1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } }), far = row('s2', 60, 100);
const drops = { town: 'TownA', drop: { 57: 10, [DROP]: 0.5 }, spoil: {} };
const view = viewOf({ header: { levels: [1, 2] }, exp: [0, 100], hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } } },
    kits: { 9: { 1: [] } }, yields: { 's1@1': drops, 's2@1': drops }, items: { [DROP]: { kind: 'Other.Material', npcBuy: 5 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2 } },
    npcOffers: { preset: {} }, deathExp: [15, 30] });
const main = { line: 9, level: 1, spot: null, shots: {}, bag: {} };
const kit = deaths => ({ bare: { kills: 1, deaths }, shots: { kills: 1, deaths }, blessed: { kills: 1, deaths } });
const persona = { primaryDrive: 'progression', traits: { caution: 0 } };
// Exp 100 of the best 100 and income 250 (200 adena + 50 drop) of the best 250, half each; no road and no deaths in it.
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona) - (100 / 100 * 0.5 + 0.5)) < 1e-9);
assert.ok(Math.abs(Value.hourValue(view, main, 'shots', kit(1), persona, { withoutDrop: true }) - (100 / 100 * 0.5 + 200 / 250 * 0.5)) < 1e-9);
assert.equal(Value.hourValue(view, main, 'shots', kit(1), persona), Value.hourValue(view, main, 'shots', kit(2), persona), 'the kit\'s deaths do not move the hour');
assert.equal(Value.hourValue(view, main, 'bare', kit(1), persona), 0);
// The formula's death price: a death costs 15 exp of 100 and the way back from its respawn town (0.3 h), no respawn
// wait (the row's death rate holds it); the worn kit's death factor scales it.
const risk = 0.1 * (0.3 + 15 / 100);
assert.ok(Math.abs(Value.deathCost(view, main, 'shots', kit(1), 0.3) - risk) < 1e-9);
assert.ok(Math.abs(Value.deathCost(view, main, 'shots', kit(2), 0.3) - 2 * risk) < 1e-9);
// A wealth-driven, cautious-free persona weighs money above exp.
assert.ok(Value.moneyWeight({ primaryDrive: 'wealth', traits: { caution: 0 } }) > Value.moneyWeight(persona));
const hourOf = form => Value.hourValue(view, main, form, kit(1), persona) - Value.deathCost(view, main, form, kit(1), 0.3);
assert.throws(() => Value.deathCost(view, main, 'shots', kit(1), undefined), /no trip hours for the way back/);
const zeroBare = { hour: hourOf('shots'), bare: hourOf('bare'), withoutDrop: 0, bagHoursBare: Infinity, outHours: 0, M: Value.bestOf(view, main).npc, moneyWeight: Value.moneyWeight(persona) };
// Shots at a tenth of an adena against the view's best income of 250 an hour.
const longRoad = { toHours: 0.4, backHours: 0.4, offers: { town: 'TownA', price: 0.1 } };
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ ...longRoad, value: zeroBare }))).map(a => a.kind), ['go']);
// An out fact with the bag already full (its fact declined earlier; bagHoursBare 0) is both at once: the outing's hours of
// each loss, not a 0-hour out loss, so the bare shortfall over the outing beats the trip's price.
const standingFull = { hour: 0.8, bare: 0.2, withoutDrop: 0.7, bagHoursBare: 0, outHours: 2, M: 25000, moneyWeight: 0.5 };
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ value: { ...standingFull, bagFull: true } }))).map(a => a.kind), ['go']);
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ value: { ...standingFull, bagFull: false } }))).map(a => [a.kind, a.reason]), [['stay', 'trip_costs_more']]);
// The same road where the bare hour keeps 0.6 of it and the bag fills in an hour: it stays.
assert.deepEqual(brief(Supply.supplyChoice(out, formula({ ...longRoad, value: { ...zeroBare, bare: zeroBare.hour * 0.6, bagHoursBare: 1 } }))).map(a => a.kind), ['stay']);

// Needs: the game's stock rule on the shots it fires (ConsumableTarget): its use over the hours to a full bag after the
// sale plus a tenth; it spares its bag and the shots it does not fire; the shots it fires are kept whole (the game's
// ShotStock.keptAmounts: the target bounds purchases).
// slotsIn2: its slots fill in 2 h, nothing weighs (massless shots, no drop load).
const slotsIn2 = { slotHours: 2, freeLoad: 1000, loadPerHour: 0, mass: 0 };
const holder = { shots: { [SHOT]: 250, 1463: 5 }, bag: { [DROP]: 4 } };
assert.deepEqual(Needs.consumable(holder, { id: SHOT, perHour: 99.5 }, slotsIn2), { id: SHOT, perHour: 99.5, hours: 2, target: 219, held: 250, short: -31 });
assert.equal(Needs.consumable(holder, null, slotsIn2), null);
assert.deepEqual(Needs.surplus(holder, Needs.consumable(holder, { id: SHOT, perHour: 100 }, slotsIn2)), [[DROP, 4], [1463, 5]]);
// 500 fired shots over a 120 target: none spare; 300 of another grade (the weapon fires SHOT): all 300 spare.
const overTarget = { shots: { [SHOT]: 500 }, bag: {} };
assert.deepEqual(Needs.surplus(overTarget, { ...Needs.consumable(overTarget, { id: SHOT, perHour: 100 }, slotsIn2), target: 120 }), [], 'the fired shots above the target are kept');
const olderGrade = { shots: { 1463: 300 }, bag: {} };
assert.deepEqual(Needs.surplus(olderGrade, Needs.consumable(olderGrade, { id: SHOT, perHour: 100 }, slotsIn2)), [[1463, 300]], 'a grade it does not fire is spare');
assert.deepEqual(Needs.surplus({ shots: { [SHOT]: 120 }, bag: {} }, Needs.consumable({ shots: { [SHOT]: 120 } }, { id: SHOT, perHour: 100 }, slotsIn2)), []);
// The drop's load sets the hours: 100 load an hour beside shots of mass 4 in 1000 free load (one shot kept free for the
// whole count), 996 / (100 + 440) h, not the slots' 10.
const dropBound = Needs.consumable({ shots: {}, bag: {} }, { id: SHOT, perHour: 100 }, { slotHours: 10, freeLoad: 1000, loadPerHour: 100, mass: 4 });
assert.ok(Math.abs(dropBound.hours - 996 / 540) < 1e-9);
assert.equal(dropBound.target, 203);
// The stock's own weight sets the hours: mass 5 in 1100 free load, no drop load: 1095 / 550 h, 219 shots weighing 1095.
const stockBound = Needs.consumable({ shots: {}, bag: {} }, { id: SHOT, perHour: 100 }, { slotHours: 10, freeLoad: 1100, loadPerHour: 0, mass: 5 });
assert.ok(Math.abs(stockBound.hours - 1095 / 550) < 1e-9);
assert.deepEqual([stockBound.target, stockBound.short], [219, 219]);
// No load left below the first weight step: no hours, it keeps the line (an hour's use).
assert.equal(Needs.consumable({ shots: {}, bag: {} }, { id: SHOT, perHour: 100 }, { slotHours: 10, freeLoad: 0, loadPerHour: 0, mass: 5 }).target, 100);
// Nothing bounds the stock (no slot forecast, nothing weighs): a model bug, not a world state.
assert.throws(() => Needs.consumable(holder, { id: SHOT, perHour: 100 }, { slotHours: Infinity, freeLoad: 1000, loadPerHour: 0, mass: 0 }), /no bag fact bounds/);
// The beginner shots that charge the shot it fires count as held of it; they are never spare (no sale, trade or drop).
const starterHolder = { shots: { 5789: 150, [SHOT]: 20 }, bag: {} };
assert.deepEqual(Needs.consumable(starterHolder, { id: SHOT, perHour: 100, beginner: 5789 }, slotsIn2), { id: SHOT, perHour: 100, hours: 2, target: 220, held: 170, short: 50 });
assert.deepEqual(Needs.surplus(starterHolder, null), [[SHOT, 20]], 'the beginner shots are never surplus');

// Attention: a stock run out on the road waits and is heard on arrival in one chain with the town fact.
let account = { id: 1, led: 7, place: 'road', queue: [] };
account = Attention.push(account, out[0]);
const onRoad = Attention.heard(account);
assert.deepEqual(onRoad.chain, []);
account = Attention.push({ ...onRoad.account, place: 'town' }, town[0]);
const arrived = Attention.heard(account);
assert.deepEqual(arrived.chain.map(fact => fact.kind), ['out', 'town']);
assert.deepEqual(arrived.account.queue, []);
assert.deepEqual(Catalog.woken(arrived.chain), ['supply']);
// Out of shots while hunting is heard at once.
assert.deepEqual(Attention.heard(Attention.push({ id: 1, led: 7, place: 'hunt', queue: [] }, out[0])).chain.map(fact => fact.kind), ['out']);
// A death is heard at once and wakes no decision.
const died = Attention.heard(Attention.push({ id: 1, led: 7, place: 'hunt', queue: [] }, { kind: 'died', who: 7, at: 5 }));
assert.deepEqual(died.chain.map(fact => fact.kind), ['died']);
assert.deepEqual(Catalog.woken(died.chain), []);
// The same fact twice is one entry; the led character is the beneficiary; an unknown fact throws by name.
const twice = Attention.push(Attention.push({ id: 1, led: 7, place: 'road', queue: [] }, out[0]), { ...out[0], at: 4 });
assert.equal(twice.queue.length, 1);
assert.equal(Attention.ledOf({ id: 1, led: 8, place: 'hunt', queue: [] }, [{ id: 7 }, { id: 8 }]).id, 8);
assert.throws(() => Attention.push(twice, { kind: 'rumour', who: 7, at: 1 }), /no situation 'rumour'/);

// The design plane on the engine, one town and a fixture world: line 9 hunts s1 (adena and drop with shots, nothing
// bare), line 10 hunts s3 (exp only: no adena, no drop, nothing bare). Both spots' town is TownA: 0.2 h to it, 0.3 h back.
const Plane = require('../scripts/economy-model/design/plane');
// The fixture weights: the drop weighs 2, the no-grade Soulshot 4 (its datapack weight), Spiritshot 5; a bag of 2840 turns
// overweight at 1420 (the first weight step). At a row that drops 5 DROP and fires 30 shots an hour the stock rule's hours
// to a full bag are 1420 / (5 x 2 + 30 x 4 x 1.1) = 10 h, its target 30 x 10 x 1.1 = 330 shots.
const ITEMS = { [DROP]: { kind: 'Other.Material', npcBuy: 5, weight: 2 }, [SHOT]: { kind: 'Other.Shot', npcBuy: 2, weight: 4 } }, LOAD = 2840;
const quiet = row('s3', 100, 0, { shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 }, dropLoot: 0, loot: 0 });
// Line 10's other candidate, s2, is worth less to it than s3 (nothing bare either).
const dull = row('s2', 10, 100, { shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } });
const world = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] }, 10: { 1: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } }, 10: { 1: { classId: 10, shotId: SHOT, best: quiet, top: [quiet, dull] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's3@1': { town: 'TownA', drop: {}, spoil: {} } },
    items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD }, 10: { slots: 80, maxLoad: LOAD } } });
const freshBot = (line, over = {}) => ({ id: 1, station: false, line, level: 1, exp: 0, money: 0, spot: null, shots: {}, held: [], worn: {},
    persona: { primaryDrive: 'progression', traits: { caution: 0.5, commitment: 0.5 } }, ...over });
// The kit's factors (the reference kit's: 1), deaths times dies.
const kitAt = dies => ({ spotFactors: () => ({ bare: { kills: 1, shots: 1, deaths: dies }, shots: { kills: 1, shots: 1, deaths: dies }, blessed: { kills: 1, shots: 1, deaths: dies } }), shotScale: () => 1, stats: { spotUnstated: 0 } });
// One run through the plane, its visits seen as the engine calls them.
function run(account, supply, hours, dies = 0, view = world, gear = null) {
    const visits = [], levels = [], made = Plane.plane({ view, kitHours: kitAt(dies), variant: supply, accounts: [account], gear });
    const seen = { ...made, start: context => {
        const hooks = made.start(context);
        return { ...hooks, visit: (main, now, info) => { const done = hooks.visit(main, now, info); visits.push({ now, info, before: main, ...done }); return done; },
            levelUp: (main, now) => { const done = hooks.levelUp(main, now); levels.push({ now, before: main, main: done }); return done; } };
    } };
    const result = Engine.simulate({ view, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours, seed: 3, plane: seen });
    return { result, visits, levels };
}
const close = (a, b) => Math.abs(a - b) < 1e-6;
// The world with SHOT as the no-grade Soulshot: Soulshots for Beginners (5789) charge it; a bot fires it with the
// no-grade Squire's Sword in hand (a bot with no weapon fires no shot), weightless here so the load above stays.
const BEGINNER = 5789, SWORD = 2369, armed = { worn: { 7: SWORD } }, swordItem = { kind: 'Weapon.Sword', grade: 'NONE', npcBuy: 0, weight: 0 };
const taught = { ...world, items: { ...world.items, [SWORD]: swordItem }, shotFamilies: { grades: ['NONE'], ids: [[SHOT]] } };
// Holding both, a hunt fires the beginner shots first, then the bought ones.
{
    const both = Engine.mainOf(freshBot(9, { ...armed, shots: { [BEGINNER]: 20, [SHOT]: 60 } }), 0, taught, [['all', 1]]);
    const firing = { id: SHOT, perHour: 30, beginner: Engine.beginnerOf(taught, SHOT) };
    assert.deepEqual(Engine.hunt(both, taught, 0.5, () => 0.5, firing).main.shots, { [BEGINNER]: 5, [SHOT]: 60 }, 'half an hour spends beginner shots only');
    assert.deepEqual(Engine.hunt(both, taught, 1, () => 0.5, firing).main.shots, { [BEGINNER]: 0, [SHOT]: 50 }, 'an hour spends the beginner shots, then 10 bought');
}
// Both variants from one simulate call, only the variant changed.
for (const supply of ['table', 'formula']) {
    // a fresh bot that runs out of shots walks to its spot's town, sells its drop, buys toward its target, walks back:
    // born with 60 shots (two hours at 30 an hour) and no adena, it walks out 0.3 h, hunts 2 h (its bag fills in 10 h, so
    // the shots end first), walks 0.2 h to town, sells its drop, buys what the money pays of its 330-shot target (7 a shot)
    // and walks 0.3 h back; by 3 h it has hunted 2 + 0.2 hours (road hours = to + back).
    const { result, visits } = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3);
    assert.deepEqual(visits.map(visit => [visit.info.born === true, visit.delta.towns[0], close(visit.afterHours, 0.3)]), [[true, 'TownA', true], [false, 'TownA', true]], supply);
    const trip = visits[1];
    assert.ok(close(trip.now, 0.3 + 2 + 0.2), `${supply}: it arrives the walk to town after its shots ran out (${trip.now})`);
    assert.equal(trip.before.shots[SHOT], 0);
    assert.ok(trip.before.bag[DROP] > 0 && !trip.main.bag[DROP], `${supply}: it sells its drop at the NPC`);
    assert.equal(trip.delta.flows.npcSales, trip.before.bag[DROP] * 5);
    const wallet = trip.before.money + trip.delta.flows.npcSales, bought = trip.main.shots[SHOT];
    assert.ok(bought > 60 && bought < 330, `${supply}: it buys more than its old two hours, short of its target (${bought})`);
    assert.equal(bought, Math.floor(wallet / 7), `${supply}: it buys what its money pays toward its 330-shot target`);
    assert.equal(trip.main.money, wallet - bought * 7);
    assert.ok(close(result.huntHours.ownSpot + result.huntHours.bestSpot, 2.2), `${supply}: hunted ${result.huntHours.ownSpot + result.huntHours.bestSpot} h`);
    assert.equal(result.money.closureGap, 0);
    // a fresh bot born with 45 beginner shots and none bought hunts with them first (1.5 h at 30 an hour), never sells
    // them, and only when they run out walks to town and buys no-grade shots with what its drop sold for.
    const starter = run(freshBot(9, { ...armed, shots: { [BEGINNER]: 45 } }), supply, 3, 0, taught);
    const restock = starter.visits[1];
    assert.ok(restock && close(restock.now, 0.3 + 1.5 + 0.2), `${supply}: it hunts its beginner shots first and walks to town when they run out (${restock?.now})`);
    assert.deepEqual([restock.before.shots[BEGINNER], restock.main.shots[SHOT] > 0], [0, true], `${supply}: it buys its no-grade shots once the beginner shots are spent`);
    assert.ok(starter.visits.every(visit => !visit.delta.shotsSoldNpc), `${supply}: it never sells a beginner shot`);
    // with no money, nothing to sell and a zero bare hour it stays and stuck counts 1 with reason no_bare_hour
    const broke = run(freshBot(10, { shots: { [SHOT]: 60 } }), supply, 10);
    assert.equal(broke.visits.length, 1, `${supply}: it never goes to town`);
    assert.equal(broke.result.counters.stuckNoBareHour, 1, `${supply}: stuck once`);
    // a death puts the bot in its respawn town where the town chain runs; the death fact alone moves no money (s1 its
    // only row: it would not hold a spot that kills it so often where a safe one is)
    const dying = run(freshBot(9, { shots: { [SHOT]: 60 }, money: 1000 }), supply, 3, 40, { ...world, hours: { ...world.hours, 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near] } } } });
    const death = dying.visits.find(visit => visit.info.died);
    assert.ok(death && death.delta.towns[0] === 'TownA' && close(death.afterHours, 0.3), `${supply}: the respawn town runs the town chain and walks back`);
    assert.equal(death.main.money - death.before.money, death.delta.flows.npcSales + death.delta.flows.npcBuys, `${supply}: only the town chain moves money`);
}

// A held spot that still fits at a new level is kept, although its row is no longer the one worth most there: s1's mobs
// (mean level 1) stay within C4's gap of level 2.
const richer = row('s2', 300, 400);
const growth = viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] }, 2: { classId: 9, shotId: SHOT, best: richer, top: [richer, near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops },
    items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
for (const supply of ['table', 'formula']) {
    const grown = run(freshBot(9, { shots: { [SHOT]: 600 } }), supply, 1, 0, growth);
    assert.ok(grown.result.progress.stageBands.all.levelUps >= 1, `${supply}: it reached level 2`);
    assert.equal(grown.result.counters.leftOwnSpot, 0, `${supply}: the held row still exists at level 2`);
    const levelled = grown.levels.find(level => level.main.level === 2);
    assert.deepEqual([levelled.before.spot, levelled.main.spot], ['s1', 's1'], `${supply}: it keeps the spot that still fits at the new level`);
}
// climb: line 9 at levels 6 and 7 (level 7 at 300 exp); s1 (mean mob level s1Level) is the best at 6, s2 (mean 7) worth
// more at 7. A bot born at level 6 with 30 shots walks out 0.3 h, reaches level 7 after half an hour (100 exp an hour),
// runs out of shots at 1.3 h and its town chain ends at 1.5 h.
const climb = s1Level => viewOf({ header: { levels: [1, 7] }, exp: [0, 50, 100, 150, 200, 250, 300], kits: { 9: { 6: [], 7: [] } },
    hours: { 9: { 6: { classId: 9, shotId: SHOT, best: near, top: [near, far] }, 7: { classId: 9, shotId: SHOT, best: richer, top: [richer, near] } } },
    yields: { 's1@6': drops, 's2@6': drops, 's1@7': drops, 's2@7': drops },
    items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: Array(7).fill(15),
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } },
    spotAvgLevel: { s1: s1Level, s2: 7 } });
const climber = persona => freshBot(9, { level: 6, exp: 250, shots: { [SHOT]: 30 }, ...(persona ? { persona } : {}) });
const MIN_MAXER = { primaryDrive: 'progression', traits: { caution: 0.5, commitment: 0.5, ambition: 0.9 } };
for (const supply of ['table', 'formula']) {
    const spotsOf = (s1Level, persona) => {
        const climbed = run(climber(persona), supply, 2, 0, climb(s1Level));
        const levelled = climbed.levels.find(level => level.main.level === 7), chainEnd = climbed.visits.find(visit => !visit.info.born);
        assert.ok(levelled && chainEnd && chainEnd.now > levelled.now, `${supply}: it reaches level 7 before its town chain`);
        return [climbed.visits[0].main.spot, levelled.main.spot, chainEnd.main.spot];
    };
    // Past the gap (level 7 is 8 above s1's mobs, mean level -1) it keeps s1 until its town chain ends and takes s2 there, not at the level.
    assert.deepEqual(spotsOf(-1), ['s1', 's1', 's2'], `${supply}: out of the gap it moves at the next chain end`);
    // Within the gap (s1's mobs at 3) it keeps s1 through the chain end, although s2 is worth more.
    assert.deepEqual(spotsOf(3), ['s1', 's1', 's1'], `${supply}: a spot that fits is kept at the chain end`);
    // A min-maxer takes the spot worth most at the chain end, not at the level.
    assert.deepEqual(spotsOf(3, MIN_MAXER), ['s1', 's1', 's2'], `${supply}: a min-maxer re-picks at the chain end`);
}
// The same climb where s1 leaves the top at level 7 but stays in its range (the level's others) and s2, the top, is out of
// the gap (mean mob level -1): s1 is still a candidate, kept through the chain end and taken by a bot born at level 7; no
// hour is hunted at the line's best by default.
{
    const inRange = climb(3), level7 = { classId: 9, shotId: SHOT, best: richer, top: [richer], others: [near] };
    const leftTop = { ...inRange, hours: { 9: { ...inRange.hours[9], 7: level7 } }, spotAvgLevel: { s1: 3, s2: -1 } };
    for (const supply of ['table', 'formula']) {
        const climbed = run(climber(), supply, 2, 0, leftTop), chainEnd = climbed.visits.find(visit => !visit.info.born);
        assert.ok(chainEnd && chainEnd.before.level === 7, `${supply}: its town chain ends at level 7`);
        assert.deepEqual([climbed.visits[0].main.spot, chainEnd.main.spot], ['s1', 's1'], `${supply}: the held spot out of the top is kept while it fits`);
        const born = run(freshBot(9, { level: 7, exp: 300, shots: { [SHOT]: 30 } }), supply, 2, 0, leftTop);
        assert.equal(born.visits[0].main.spot, 's1', `${supply}: born at level 7 it takes the fitting spot out of the top`);
        for (const each of [climbed, born]) assert.equal(each.result.huntHours.bestSpot, 0, `${supply}: no hour at the line's best by default`);
    }
}
// The same climb where s2, worth more at level 6 and within the gap at 6 and 7 (mean mob level 7), is deathless at 6 but
// dies 0.2 an hour at 7, and s1 (mean 3, nothing killed bare) is deathless at both, at the reference kit: the bot born at 6,
// whose outing reaches level 7, holds s1 at birth, at level 7 and at its chain end (a spot deadly at a level the outing
// reaches is not held), and never dies. Where level 7 is out of the outing's reach (its exp far above), s2 is taken at birth.
{
    const inRange = climb(3), safe = row('s1', 100, 200, { shotless: near.shotless }), deadlyUp = row('s2', 300, 400, { deaths: 0.2 });
    const turns = { ...inRange, hours: { 9: { 6: { classId: 9, shotId: SHOT, best: richer, top: [richer, safe] }, 7: { classId: 9, shotId: SHOT, best: deadlyUp, top: [deadlyUp, safe] } } } };
    for (const supply of ['table', 'formula']) {
        const climbed = run(climber(), supply, 2, 1, turns);
        const levelled = climbed.levels.find(level => level.main.level === 7), chainEnd = climbed.visits.find(visit => !visit.info.born);
        assert.ok(levelled && chainEnd && chainEnd.now > levelled.now, `${supply}: it reaches level 7 before its town chain`);
        assert.deepEqual([climbed.visits[0].main.spot, levelled.main.spot, chainEnd.main.spot], ['s1', 's1', 's1'], `${supply}: the spot deadly a level up is never held`);
        assert.equal(climbed.result.counters.deaths, 0, `${supply}: it never dies`);
        const unreached = run(climber(), supply, 2, 1, { ...turns, exp: [0, 50, 100, 150, 200, 250, 1e6] });
        assert.equal(unreached.visits[0].main.spot, 's2', `${supply}: deadly only past the levels the outing reaches, s2 is taken`);
    }
}
// A spot worth more whose expected deaths over the outing exceed the bound (0.05 an hour over an outing of hours to a full
// bag) is never held, though its death price is far below its value lead; the safe spot is.
{
    const safe = row('s1', 100, 200), risky = row('s2', 300, 400, { deaths: 0.05 });
    const danger = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: risky, top: [risky, safe] } } },
        yields: { 's1@1': drops, 's2@1': drops }, items: ITEMS,
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
    for (const supply of ['table', 'formula']) {
        const held = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3, 1, danger);
        assert.ok(held.visits.length >= (supply === 'table' ? 2 : 1), `${supply}: born (the table variant also back from a town chain)`);
        assert.ok(held.visits.every(visit => visit.main.spot === 's1'), `${supply}: the unsafe spot is never held (${held.visits.map(visit => visit.main.spot)})`);
    }
}

// A death that drops a level respawns in the town of the spot it died at (C4: the region town of the death place), not in the
// town of the spot it takes at the lower level: born at level 2 just past its start, it holds s2 (TownB) and dies there (40x the
// row's deaths); the loss takes it to level 1, where s1 (TownA) is worth most, whether s2 has a level-1 row or not.
const bareNone = { shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0, deaths: 0 } };
const rich1 = row('s1', 300, 400, bareNone), s2at1 = row('s2', 60, 100, bareNone), s2at2 = row('s2', 100, 200, { ...bareNone, deaths: 0.1 });
const dropsB = { ...drops, town: 'TownB' };
for (const [variant, top1] of [['s2 has a level-1 row', [rich1, s2at1]], ['s2 has no level-1 row', [rich1]]]) {
    const regions = viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: rich1, top: top1 }, 2: { classId: 9, shotId: SHOT, best: s2at2, top: [s2at2] } } },
        yields: { 's1@1': drops, 's2@1': dropsB, 's2@2': dropsB },
        items: ITEMS,
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }, { town: 'TownB', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3, TownB: 0.9 }, s2: { TownB: 0.3, TownA: 0.9 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
    for (const supply of ['table', 'formula']) {
        const fell = run(freshBot(9, { level: 2, exp: 55, money: 1000, shots: { [SHOT]: 600 } }), supply, 3, 40, regions);
        const death = fell.visits.find(visit => visit.info.died);
        assert.ok(death && death.before.level === 1, `${supply}, ${variant}: it dies and drops to level 1`);
        assert.equal(death.delta.towns[0], 'TownB', `${supply}, ${variant}: it respawns in the town of the spot it died at`);
    }
}

// A bot with no shots, no adena and a bag of one slot that fills: it hunts bare at a row that kills bare, and the table goes to town
// for the shots at the bag fact. The formula stays: a one-slot bag holds the shots or the drop, so the hours to a full bag after
// the visit are 0 (the stock rule's slot forecast) and the trip buys no hunting hour.
const bare = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } }, hours: { 9: { 1: { classId: 9, shotId: SHOT, best: far, top: [far] } } },
    yields: { 's2@1': drops }, items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s2: 0.02 }, back: { s2: { TownA: 0.03 } } }, bags: { 9: { slots: 1, maxLoad: LOAD } } });
// heavyBag: the same world where the slots never bind and a heavy drop (200 a unit, 1000 load an hour) fills the bag by weight
// in about 1.4 h: the hours to a full bag after a visit are as many, so the formula's visit buys hunting hours.
const heavyBag = { ...bare, items: { ...bare.items, [DROP]: { ...bare.items[DROP], weight: 200 } }, bags: { 9: { slots: 80, maxLoad: LOAD } } };
assert.equal(run(freshBot(9), 'formula', 3, 0, bare).visits.find(visit => !visit.info.born), undefined,
    'formula: no trip that gains no hour before the bag is full again');
for (const supply of ['table', 'formula']) {
    const filled = run(freshBot(9), supply, 3, 0, supply === 'table' ? bare : heavyBag);
    const trip = filled.visits.find(visit => !visit.info.born);
    assert.ok(trip && trip.before.bag[DROP] > 0, `${supply}: it goes to town when its bag is full with no shots`);
    assert.ok(trip.main.shots[SHOT] > 0, `${supply}: it buys shots with what its drop sold for`);
}

// A bot stuck out of shots is counted once: its death and respawn visit change neither its shots, its money nor its bag.
// Its bare hour carries no deaths of its own (the game spot table's shape), so it dies at the row's. No spot is safe: it holds
// the least deadly, s3.
const mortal = row('s3', 100, 0, { deaths: 1, shotless: { kills: 0, exp: 0, adena: 0, dropLoot: 0, loot: 0 }, dropLoot: 0, loot: 0 });
const mortalWorld = { ...world, hours: { ...world.hours, 10: { 1: { classId: 10, shotId: SHOT, best: mortal, top: [mortal, { ...dull, deaths: 2 }] } } } };
const stuckDying = run(freshBot(10, { shots: { [SHOT]: 20 } }), 'table', 10, 2, mortalWorld);
assert.ok(stuckDying.visits.filter(visit => visit.info.died && visit.before.shots[SHOT] === 0).length >= 3, 'the stuck bot dies and respawns several times after it stands');
assert.equal(stuckDying.result.counters.stuckNoBareHour, 1, 'stuck once for the one run-out');

// Stuck is the bot's state, not the fact that woke it: a fresh bot born with no shots and no adena at a row that kills nothing bare
// stands from birth and counts once, and its deaths and respawn visits do not count it again.
for (const supply of ['table', 'formula']) {
    const fresh = run(freshBot(10), supply, 4, 0, mortalWorld);
    assert.equal(fresh.result.counters.stuckNoBareHour, 1, `${supply}: stuck from birth counts once`);
    const dies = run(freshBot(10), supply, 10, 2, mortalWorld);
    assert.ok(dies.visits.filter(visit => visit.info.died).length >= 3, `${supply}: the standing bot dies and respawns`);
    assert.equal(dies.result.counters.stuckNoBareHour, 1, `${supply}: its deaths do not count it again`);
}
assert.equal(Supply.stuck({ ...field({ wallet: 0, fightsBare: false }), need: { ...field().need, held: 5 } }), false, 'a bot that holds shots is not stuck');

// The held spot is taken in the form it can hunt: line 9's best row s1 kills nothing without shots, its bare best is s2.
// A bot born holding none of its shots takes s2 and hunts there bare; after the town chain that bought shots it keeps s2,
// which still fits (it hunts there with shots), although s1 is worth more with shots.
// bareBest is an hour row of the shape the extract writes: the spot's hour with shots at the top level (shots 30), the bare reading in shotless.
const farBare = row('s2', 60, 100, { shotless: { kills: 10, exp: 60, adena: 40, dropLoot: 20, loot: 20, deaths: 0 } });
const bareWorld = { ...world, tripHours: { to: { ...world.tripHours.to, s2: 0.2 }, back: { ...world.tripHours.back, s2: { TownA: 0.3 } } }, hours: { ...world.hours, 9: { 1: { classId: 9, shotId: SHOT, best: near, bareBest: farBare, top: [near, far] } } } };
for (const supply of ['table', 'formula']) {
    const poor = run(freshBot(9), supply, 4, 0, bareWorld);
    assert.equal(poor.visits[0].main.spot, 's2', `${supply}: born with no shots it holds its bare best`);
    assert.equal(poor.result.counters.stuckNoBareHour, 0, `${supply}: it hunts bare, not stuck`);
    assert.ok(poor.result.huntHours.ownSpot + poor.result.huntHours.bestSpot > 3.5 && poor.result.progress.stageBands.all.expPerBotHour > 0, `${supply}: it hunts and gains exp`);
    const funded = run(freshBot(9, { money: 5000 }), supply, 4, 0, bareWorld);
    assert.equal(funded.visits[0].before.spot, null);
    assert.ok(funded.visits[0].main.shots[SHOT] > 0, `${supply}: the birth chain buys its shots`);
    assert.equal(funded.visits[0].main.spot, 's2', `${supply}: after the chain that bought shots it keeps the spot that fits`);
}

// At a level where the held bare best has no row the bot takes the new level's bare best (the form it can hunt now), not the line's
// best row with shots: line 9 holds s2 bare at level 1; at level 2 its rows are s1 (kills nothing bare) and the bare best s3.
const farBare2 = row('s3', 150, 100, { shotless: { kills: 10, exp: 60, adena: 40, dropLoot: 20, loot: 20, deaths: 0 } });
const stepWorld = viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, bareBest: farBare, top: [near, far] }, 2: { classId: 9, shotId: SHOT, best: near, bareBest: farBare2, top: [near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops, 's3@2': drops },
    items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
for (const supply of ['table', 'formula']) {
    const levelled = [], made = Plane.plane({ view: stepWorld, kitHours: kitAt(0), variant: supply, accounts: [freshBot(9)] });
    const seen = { ...made, start: context => {
        const hooks = made.start(context);
        return { ...hooks, levelUp: (main, now) => { const next = hooks.levelUp(main, now); levelled.push({ level: main.level, before: main.spot, spot: next.spot }); return next; } };
    } };
    const result = Engine.simulate({ view: stepWorld, accounts: [freshBot(9)], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 4, seed: 3, plane: seen });
    assert.ok(result.progress.stageBands.all.levelUps >= 1 && levelled.length >= 1, `${supply}: it reached level 2`);
    assert.deepEqual([levelled[0].level, levelled[0].before, levelled[0].spot], [2, null, 's3'], `${supply}: the level's bare best, not the shots best s1`);
    assert.equal(result.counters.stuckNoBareHour, 0, `${supply}: not stuck`);
}

// A level that changes the shot it fires to one it holds none of is the run-out the hunt raises when it spends the last shot: line 9
// (Squire's Sword in hand) fires the no-grade Spiritshot 2509 at level 1 (Spiritshots for Beginners 5790 charge it, 600 held) and the no-grade Soulshot 1835 at
// level 2 (5789 charges it, none held). Rooms are roomy so no bag fact comes in the run.
const classWorld = (shotAtTwo) => viewOf({ header: { levels: [1, 2] }, exp: [0, 50], kits: { 9: { 1: [], 2: [] } },
    shotFamilies: { grades: ['NONE'], ids: [[1835], [2509]] },
    hours: { 9: { 1: { classId: 9, shotId: 2509, best: near, bareBest: farBare, top: [near, far] }, 2: { classId: 9, shotId: shotAtTwo, best: near, bareBest: farBare2, top: [near] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops, 's3@2': drops },
    items: { ...ITEMS, 2509: { kind: 'Other.Shot', npcBuy: 2, weight: 5 }, [SWORD]: swordItem },
    npcOffers: { preset: { 1835: [{ town: 'TownA', price: 7 }], 2509: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2, s3: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 }, s3: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
{
    const changed = run(freshBot(9, { ...armed, shots: { 5790: 600 } }), 'table', 4, 0, classWorld(1835));
    assert.ok(changed.result.progress.stageBands.all.levelUps >= 1, 'it reached level 2');
    const trip = changed.visits.find(visit => !visit.info.born && visit.before.level >= 2);
    // a. at level 2 it holds none of the Soulshot it now fires: it goes to town and buys it (old code: no fact, no visit)
    assert.ok(trip && trip.delta.shotsBoughtNpc > 0 && trip.main.shots[1835] > 0, 'the level that changed its shot sends it to town to buy the new shot');
    assert.equal(changed.result.design.bareBeforeFirstBuy[0].bought, 1, 'its first buy is counted');
    // b. a level that keeps the shot (still 2509, 600 held) sends it nowhere
    const kept = run(freshBot(9, { ...armed, shots: { 5790: 600 } }), 'table', 4, 0, classWorld(2509));
    assert.ok(kept.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(kept.visits.filter(visit => !visit.info.born).length, 0, 'a level that keeps the shot sends it nowhere');
    // c. a level whose row fires no shot sends it nowhere (nothing to buy)
    const none = run(freshBot(9, { ...armed, shots: { 5790: 600 } }), 'table', 4, 0, classWorld(0));
    assert.ok(none.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(none.visits.filter(visit => !visit.info.born).length, 0, 'a level that fires no shot sends it nowhere');
    // d. it held none of the shot before the level: the level is no run-out (it hunts bare, adena 1 buys nothing at birth)
    const bareBefore = run(freshBot(9, { ...armed, shots: {}, money: 1 }), 'table', 4, 0, classWorld(1835));
    assert.ok(bareBefore.result.progress.stageBands.all.levelUps >= 1, 'control: it reached level 2');
    assert.equal(bareBefore.visits.filter(visit => !visit.info.born).length, 0, 'a main that held none before the level goes nowhere at it');
}

// The first held spot is the one worth most to the bot by its persona's weights (exp against money), not
// the most income: line 9 at level 1 has sE (exp 200, 20 adena an hour) and sM (exp 50, 300 adena; the line's best by
// income). A bot driven by progression and cautious (money weight 1/3) holds sE; one driven by wealth (2/3) holds sM.
{
    const keen = row('sE', 200, 20), rich = row('sM', 50, 300);
    const choice = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: rich, top: [rich, keen] } } }, yields: { 'sE@1': drops, 'sM@1': drops },
        items: ITEMS,
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { sE: 0.2, sM: 0.2 }, back: { sE: { TownA: 0.3 }, sM: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
    const levelling = { primaryDrive: 'progression', traits: { caution: 1 } }, earning = { primaryDrive: 'wealth', traits: { caution: 0 } };
    assert.deepEqual([Value.moneyWeight(levelling), Value.moneyWeight(earning)].map(weight => weight.toFixed(3)), ['0.333', '0.667']);
    for (const supply of ['table', 'formula']) {
        const heldBy = persona => run(freshBot(9, { shots: { [SHOT]: 60 }, persona }), supply, 1, 0, choice).visits[0].main.spot;
        assert.deepEqual([heldBy(levelling), heldBy(earning)], ['sE', 'sM'], `${supply}: two personas hold different spots on the same line and level`);
    }
}

// The run report (finish().design): trips, road hours and wall hours are counted at levels 1-19 and 20+ apart, an empty trip is
// one that bought none of the need it went for, and the shadow names the rows where the two variants answer differently.
// levelWorld: line 9 at levels first..last (a level starts every 50 exp; the row gives 100 exp an hour with shots), its shots
// sold at price, the road to town and back as given.
const levelWorld = (first, last, price = 7, road = { to: 0.2, back: 0.3 }) => {
    const levels = Array.from({ length: last - first + 1 }, (_, at) => first + at), per = fill => Object.fromEntries(levels.map(level => [level, fill(level)]));
    return viewOf({ header: { levels: [1, last] }, exp: Array.from({ length: last }, (_, at) => at * 50), kits: { 9: per(() => []) },
        hours: { 9: per(() => ({ classId: 9, shotId: SHOT, best: near, top: [near, far] })) },
        yields: Object.fromEntries(levels.flatMap(level => [[`s1@${level}`, drops], [`s2@${level}`, drops]])),
        items: ITEMS,
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price }] } }, deathExp: Array(last).fill(15),
        tripHours: { to: { s1: road.to, s2: road.to }, back: { s1: { TownA: road.back }, s2: { TownA: road.back } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
};
for (const supply of ['table', 'formula']) {
    // a trip that buys its shots is not empty: the born walk 0.3 h, the walk to town 0.2 h and the walk back 0.3 h are the road
    const bought = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(1, 3)).result.design.levels;
    assert.deepEqual([bought.low.consumableTrips, bought.low.emptyTrips], [1, 0], `${supply}: one trip, it bought`);
    assert.ok(close(bought.low.roadHours, 0.8) && close(bought.low.wallHours, 3) && close(bought.low.roadShare, 0.8 / 3), `${supply}: road ${bought.low.roadHours} of ${bought.low.wallHours}`);
    // shots no adena buys: the table's trips are all empty (the formula sees the trip buys nothing and stays)
    const empty = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 6, 0, levelWorld(1, 3, 1e9)).result.design.levels;
    if (supply === 'table') {
        assert.ok(empty.low.consumableTrips >= 1 && empty.low.emptyTrips === empty.low.consumableTrips, `table: it bought none of its need (${empty.low.emptyTrips} of ${empty.low.consumableTrips})`);
        assert.equal(empty.low.emptyShare, 1);
    } else assert.equal(empty.low.consumableTrips, 0, 'formula: no trip for shots it cannot buy');
    // a bot at level 20 is in the 20+ numbers only
    const high = run(freshBot(9, { level: 20, exp: 950, shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(20, 25)).result.design.levels;
    assert.deepEqual([high.low.wallHours, high.low.roadHours, high.low.consumableTrips, high.low.emptyTrips], [0, 0, 0, 0], `${supply}: nothing at 1-19`);
    assert.ok(high.high.consumableTrips >= 1 && close(high.high.wallHours, 3), `${supply}: its trips and hours are 20+`);
    // a bot that crosses level 20 splits its hours at the crossing (0.3 h walk out, 0.5 h to its 50 exp)
    const crossing = run(freshBot(9, { level: 19, exp: 900, shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(19, 25)).result.design.levels;
    assert.ok(Math.abs(crossing.low.wallHours - 0.8) < 1e-3 && close(crossing.low.wallHours + crossing.high.wallHours, 3), `${supply}: low ${crossing.low.wallHours} h, high ${crossing.high.wallHours} h`);
    // its walk out is the only road at level 19; the trip it makes after its shots run out starts at level 20+ and is counted there
    assert.ok(close(crossing.low.roadHours, 0.3) && crossing.low.consumableTrips === 0 && crossing.high.consumableTrips === 1, `${supply}: the walk out at 19, the trip at 20+`);
}
// A trip is counted by the facts in its chain: a bot hunting bare (no shot to run out, so no out fact; its need is short) with a
// bag of one slot goes to town for its bag (`bare`: a bag trip, not a consumable trip, and not an empty trip however little it buys); a bot whose shots end goes for its need.
for (const supply of ['table', 'formula']) {
    const bagOnly = (supply === 'table' ? run(freshBot(9), supply, 0.5, 0, bare) : run(freshBot(9), supply, 3, 0, heavyBag)).result.design.levels.low;
    assert.deepEqual([bagOnly.consumableTrips, bagOnly.bothTrips, bagOnly.emptyTrips], [0, 0, 0], `${supply}: no out fact, so no consumable trip`);
    assert.ok(bagOnly.bagTrips >= 1, `${supply}: the full bag sends it to town (${bagOnly.bagTrips} bag trips)`);
    if (supply === 'formula') assert.equal(run(freshBot(9), supply, 0.5, 0, bare).result.design.levels.low.bagTrips, 0, 'formula: no trip that gains no hour');
    const needed = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 3, 0, levelWorld(1, 3)).result.design.levels.low;
    assert.deepEqual([needed.consumableTrips, needed.bagTrips, needed.bothTrips], [1, 0, 0], `${supply}: the out fact is a consumable trip only`);
}
// Two variants on the same facts: where they agree the shadow lists nothing, where the table goes and the formula stays on a
// road of 3 h each way the differ row names the table's row and both answers, whichever variant runs.
const agree = run(freshBot(9, { shots: { [SHOT]: 60 } }), 'table', 3, 0, levelWorld(1, 3)).result.design.shadow;
assert.ok(agree.decisions >= 1 && agree.differ.length === 0, 'the variants agree on a short road');
for (const supply of ['table', 'formula']) {
    const shadow = run(freshBot(9, { shots: { [SHOT]: 60 } }), supply, 8, 0, levelWorld(1, 3, 7, { to: 3, back: 3 })).result.design.shadow;
    assert.ok(shadow.decisions >= 1 && shadow.differ.length >= 1, `${supply}: the variants disagree on a long road`);
    assert.match(shadow.differ[0].reason, /^table go \/ formula stay:trip_costs_more$/, supply);
    assert.ok(shadow.differ[0].count >= 1 && typeof shadow.differ[0].row === 'string' && shadow.differ[0].row.length > 0, supply);
}
// The bare hours before a line's first purchase: a funded bot buys at birth (0 h), an unfunded one hunts bare until it can pay.
for (const supply of ['table', 'formula']) {
    const funded = run(freshBot(9, { money: 5000 }), supply, 3, 0, bareWorld).result.design.bareBeforeFirstBuy;
    assert.deepEqual([funded[0].line, funded[0].bought, funded[0].meanHoursBeforeFirstBuy], [9, 1, 0], `${supply}: bought at birth`);
    const poor = run(freshBot(9), supply, 3, 0, bareWorld).result.design.bareBeforeFirstBuy;
    assert.equal(poor[0].bought, 0, `${supply}: no purchase yet`);
    assert.ok(poor[0].meanHoursNeverBought > 2, `${supply}: it hunted ${poor[0].meanHoursNeverBought} h bare`);
}

// A main whose level has no spot row for its line stands: one stuck episode with its own reason and its hours, and the road share
// is over the wall hours of the mains that hold a row (line 9 has rows from level 2 only; line 11 hunts and walks to town).
const noRow = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [], 2: [] }, 11: { 1: [] } },
    hours: { 9: { 2: { classId: 9, shotId: SHOT, best: near, top: [near, far] } }, 11: { 1: { classId: 11, shotId: SHOT, best: near, top: [near, far] } } },
    yields: { 's1@1': drops, 's2@1': drops, 's1@2': drops, 's2@2': drops },
    items: ITEMS,
    npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
    tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD }, 11: { slots: 80, maxLoad: LOAD } } });
for (const supply of ['table', 'formula']) {
    const accounts = [freshBot(9, { id: 1 }), freshBot(11, { id: 2, shots: { [SHOT]: 60 } })];
    const { design, counters } = Engine.simulate({ view: noRow, accounts, bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 3, seed: 3,
        plane: Plane.plane({ view: noRow, kitHours: kitAt(0), variant: supply, accounts }) });
    const low = design.levels.low;
    assert.deepEqual(low.stuckEpisodes, { no_spot_row: 1 }, `${supply}: the main with no row is one stuck episode`);
    assert.ok(close(low.stuckHoursByReason.no_spot_row, 3) && close(low.stuckHours, 3), `${supply}: it stands its 3 hours`);
    assert.equal(counters.stuckNoBareHour, 0, `${supply}: the no-bare-hour counter is the supply rule's`);
    assert.ok(close(low.wallHours, 6) && close(low.decidingHours, 3), `${supply}: ${low.decidingHours} h of mains with a row`);
    assert.ok(close(low.roadShare, 0.8 / 3) && close(low.roadShareAllMains, 0.8 / 6), `${supply}: the road share leaves its hours out (${low.roadShare}, all ${low.roadShareAllMains})`);
}

// A bag at the game's full rule takes no item drop: the hunt credits its exp and adena as usual and counts the drop it did not take
// at the NPC's price (hunt's full).
{
    const hunter = freshBot(9, { shots: {}, bag: {}, spot: 's2' });
    const start = Engine.mainOf(hunter, 0, bare, [['all', 1]]);
    const open = Engine.hunt(start, bare, 2, () => 0.5), shut = Engine.hunt(start, bare, 2, () => 0.5, null, null, true);
    assert.ok(open.main.bag[DROP] > 0, 'an open bag takes the drop');
    assert.equal(shut.main.exp, open.main.exp, 'a full bag gains the exp of the hunt');
    assert.equal(shut.main.money, open.main.money, 'a full bag gains the adena of the hunt');
    assert.ok(!shut.main.bag[DROP] && shut.delta.drops.length === 0, 'a full bag takes no item');
    assert.equal(open.delta.lostDrop, 0, 'an open bag loses none');
    assert.ok(Math.abs(shut.delta.lostDrop - 2 * Engine.rowItems(bare, start, far, 'bare').loot) < 1e-6, 'the drop it left is counted at the NPC buy price');
}

// The design plane tells the engine its bag is full from the hunt that fills it until a town visit: a bot that is read every half
// hour and never goes keeps its filled bag as it was and loses the drop of the hours after.
{
    const hunted = hours => {
        const made = Plane.plane({ view: bare, kitHours: kitAt(0), variant: 'formula', accounts: [freshBot(9)] });
        const lingering = { ...made, start: context => ({ ...made.start(context), nextArrival: (main, { now }) => ({ at: now + 0.5, read: true }) }) };
        return Engine.simulate({ view: bare, accounts: [freshBot(9)], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours, seed: 3, plane: lingering });
    };
    const short = hunted(3), long = hunted(6);
    assert.ok(short.counters.fullBagHuntHours > 0 && short.counters.fullBagLostDrop > 0, 'a full bag hunts and loses the drop');
    assert.equal(long.drops.byItem[DROP], short.drops.byItem[DROP], 'a full bag takes no item in the later hours');
    assert.ok(long.counters.fullBagLostDrop > short.counters.fullBagLostDrop, 'each later hour loses more drop');
}

// A bag that filled goes to town (the table variant at once), sells its drop there and takes drop again after the visit: the
// drops grow past what it held at the visit, and it never hunted with the bag full. Two slots: the shots' stack and the first
// drop fill it, so a visit gives 0.2 h before the next fill (the stock rule's slot forecast) and the formula, which weighs those
// hours against the road, stays; on the heavy bag (above) a visit buys hours and it goes.
const roomy = { ...bare, bags: { 9: { slots: 2, maxLoad: LOAD } } };
const stays = run(freshBot(9, { shots: { [SHOT]: 40 } }), 'formula', 6, 0, roomy);
assert.ok(stays.visits.filter(visit => !visit.info.born).length === 0 && stays.result.counters.fullBagHuntHours > 0,
    'formula: 0.2 h of drop buy less than the road: it hunts on full');
for (const supply of ['table', 'formula']) {
    const trips = run(freshBot(9, { shots: { [SHOT]: 40 } }), supply, 6, 0, supply === 'table' ? roomy : heavyBag), visits = trips.visits.filter(visit => !visit.info.born);
    assert.ok(visits.length >= 2 && !visits[0].main.bag[DROP], `${supply}: it visits town and leaves with its bag emptied`);
    assert.ok(trips.result.drops.byItem[DROP] > visits[0].before.bag[DROP], `${supply}: it takes drop again after the visit`);
    if (supply === 'table') assert.ok(trips.result.counters.fullBagHuntHours < 1e-9, 'the table variant goes at the fill: no hour hunted full');
}

// The model's hunting table at level 1 (run.js tableHours over rules/hunt-rows.js), cells as measured: a level-1 orc
// mystic (line 51, key 49), for which the game's spot table has no row at level 1, holds the gremlin spot (-12_43) and
// hunts it at its measured kills; a level-1 human mystic (line 12, key 10) without spiritshots holds its bare best and
// hunts it at the bare cell's kills, its bare hour with the bare cell's own deaths (not the shots hour's). A spot whose
// only species dies over the kill-death limit is cut (SPOT.6) and counted; a table of another stamp is refused by name.
{
    const Run = require('../scripts/economy-model/run');
    const GREMLIN = '5198', DEADLY = '20001', SPIRIT = 2509;
    const fields = ['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull'];
    const orc = [41.5, 0.04819, 11.86, 51.53, 22.52, 0.8434, 29, 0, 0.1687, 1];
    const humanBare = [106.5, 0.02, 7.039, 15.59, 10.6, 0.581, 29, 0, 0, 1], humanShots = [149.5, 0, 6.632, 11.18, 5.69, 0.581, 29, 1.027, 0.003344, 1];
    const deadly = [20, 0.5, 30, 60, 90, 1, 40, 0, 0, 1];
    const body = classId => ({ classId, runSpd: 121.2, reach: 40, point: { attack: 7, defence: 54 } });
    const file = { stamp: 'abc', range: [1, 1], fields, forms: ['bare', 'shots'], bodies: { '49|1|7/54': body(49), '10|1|7/54': body(10) },
        spots: { '-12_43': { area: 488157, density: 10, species: { [GREMLIN]: { level: 1, count: 10, production: 2400 } } },
            cut: { area: 488157, density: 10, species: { [DEADLY]: { level: 3, count: 10, production: 2400 } } } },
        cells: { '49|1|7/54': { '-12_43': { [GREMLIN]: [orc, orc] }, cut: { [DEADLY]: [deadly, deadly] } },
            '10|1|7/54': { '-12_43': { [GREMLIN]: [humanBare, humanShots] }, cut: { [DEADLY]: [deadly, deadly] } } } };
    const gameRow = row('s1', 100, 200);
    const snapshot = { header: { levels: [1, 2], rates: { exp: 1 }, huntTable: { name: 'hunt-1-1-abc.json', stamp: 'abc', range: [1, 1], spots: ['-12_43', 'cut'] } },
        exp: [0, 1e9], kits: { 51: { 1: [] }, 12: { 1: [] } },
        hours: { 51: { 1: { classId: 49, shotId: SPIRIT, best: null, bareBest: null, top: [] }, 2: { classId: 49, shotId: SPIRIT, best: gameRow, top: [gameRow] } },
            12: { 1: { classId: 10, shotId: SPIRIT, best: gameRow, top: [gameRow] } } },
        speciesYields: { [`${GREMLIN}@1@0`]: { drop: { 57: 4, [DROP]: 0.1 }, spoil: {} }, [`${DEADLY}@1@0`]: { drop: { 57: 9 }, spoil: {} } },
        yields: { '-12_43@1': { town: 'TownA', drop: { 57: 4, [DROP]: 0.1 }, spoil: {} }, 's1@2': drops },
        items: { [DROP]: ITEMS[DROP], [SPIRIT]: { kind: 'Other.Shot', npcBuy: 2, weight: 5 } },
        npcOffers: { preset: { [SPIRIT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { '-12_43': 0.2 }, back: { '-12_43': { TownA: 0.3 } } }, bags: { 51: { slots: 80, maxLoad: LOAD }, 12: { slots: 80, maxLoad: LOAD } } };
    const read = (over = {}) => Run.tableHours({ snapshot, file, name: 'test table', lines: ['51', '12'], keyOf: line => (line === '51' ? '49' : '10'),
        spoilLevelOf: () => 0, gapFactor: () => 1, ...over });
    assert.throws(() => read({ file: { ...file, stamp: 'other' } }), /hunt table test table: stamp other, but the snapshot was built with hunt-1-1-abc\.json \(stamp abc\)/, 'another table stamp is refused by name');
    assert.throws(() => read({ file: { ...file, range: [1, 2] } }), /hunt table test table: levels 1-2, but the snapshot was built with hunt-1-1-abc\.json \(levels 1-1\)/, 'another level range is refused by name');
    const { cut, ...onlyGremlin } = file.spots;
    assert.throws(() => read({ file: { ...file, spots: onlyGremlin } }), /hunt table test table: 1 spots, but the snapshot was built with hunt-1-1-abc\.json \(2 spots, not the same set\)/, 'a table of fewer spots (a pick) is refused by name');
    assert.throws(() => read({ file: { ...file, spots: { ...onlyGremlin, other: cut } } }), /hunt table test table: 2 spots, but the snapshot was built with .* not the same set/, 'a table of as many other spots is refused too');
    const table = read();
    assert.deepEqual(table.cannot, { shots: 2, bare: 2 }, 'the spot whose species dies over the limit is cut in both forms for both lines, and counted');
    assert.equal(snapshot.hours[51][1].best, null, 'the snapshot\'s hours are not edited');
    assert.equal(table.hours[51][2], snapshot.hours[51][2], 'above the table\'s range the game\'s row stays');
    const orcHour = table.hours[51][1], humanHour = table.hours[12][1];
    assert.deepEqual([orcHour.top.map(held => held.spotId), orcHour.bareTop.map(held => held.spotId)], [['-12_43'], ['-12_43']], 'the candidates per form: the cut spot is none');
    assert.deepEqual(humanHour.bareTop.map(held => held.spotId), ['-12_43']);
    assert.equal(orcHour.best, undefined, 'no line-wide best: each bot ranks the candidates by its own hour value');
    const tableView = viewOf({ ...snapshot, hours: table.hours });
    // The game's kit readers: no factor at the table's levels, and the game's shot scale has no row there (null).
    const kitsOf = { spotFactors: () => assert.fail('the table\'s levels read no game kit factor'), shotScale: () => null, stats: { spotUnstated: 0 } };
    const creation = { range: [1, 1], creation: () => ({}) };
    const firedBy = {}, diedBy = {};
    for (const [line, cell, spiritshots] of [['51', orc, { [SPIRIT]: 100 }], ['12', humanBare, {}], ['12', humanBare, { [SPIRIT]: 1000 }]]) {
        const account = freshBot(line, { shots: spiritshots }), visits = [];
        const made = Plane.plane({ view: tableView, kitHours: kitsOf, variant: 'table', accounts: [account], table: creation });
        // The bot is placed at the gremlin spot whatever the held spot's choice answers (its hunt and deaths are read here;
        // the choice's first answer is kept in chosen).
        let held = null, chosen;
        const seen = { ...made, start: context => { const hooks = held = made.start(context); return { ...hooks, visit: (main, now, info) => {
            const done = hooks.visit(main, now, info), placed = { ...done, main: { ...done.main, spot: '-12_43' } };
            if (chosen === undefined) chosen = done.main.spot;
            visits.push({ ...placed, died: info.died === true });
            return placed;
        } }; } };
        const result = Engine.simulate({ view: tableView, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 3, seed: 3, plane: seen });
        // Its choice: the gremlin spot kills it some 2 times an hour (0.048 and 0.02 a kill) over an outing of many hours, over
        // the safe outing bound, yet it is the only spot: the bot hunts it as the least deadly it has (it never stops playing);
        // firing spiritshots the human mystic dies none there and takes it as its first fitting spot.
        const safe = line === '12' && !!spiritshots[SPIRIT], answers = result.design.spotChoice;
        assert.equal(chosen, '-12_43', `line ${line}: the only spot is held, safe or not`);
        assert.deepEqual([answers.first, answers.fallback.least_risk > 0], safe ? [1, false] : [0, true],
            `line ${line}: taken as fitting only where it is safe (first ${answers.first}, least risk ${answers.fallback.least_risk})`);
        const main = { ...visits[0].main, shots: {} }, hunted = Engine.hunt(main, tableView, 1, () => 0.5, null).delta;
        const kills = 3600 / (cell[2] + cell[3] + cell[4] + cell[5]);
        assert.ok(Math.abs(hunted.exp - kills * 29) < 1e-6, `line ${line} hunts bare at its cell's kills (${hunted.exp / 29} vs ${kills})`);
        assert.equal(result.design.offGrid, 0, 'the creation kit is the measured point');
        firedBy[`${line}:${Object.keys(spiritshots).length}`] = held.firing(visits[0].main)?.perHour || 0;
        diedBy[`${line}:${Object.keys(spiritshots).length}`] = visits.filter(visit => visit.died).length;
    }
    // The human mystic dies at the form it hunts in: bare (0.02 a kill, some 2 an hour) it dies within 3 h, firing its
    // spiritshots (1000 last over 6 h; no death a kill) it does not.
    assert.ok(diedBy['12:0'] > 0, `the bare human mystic dies at its bare hour's deaths (${diedBy['12:0']} deaths)`);
    assert.equal(diedBy['12:1'], 0, 'firing its spiritshots it dies at its shots hour\'s (none)');
    const shotsKills = 3600 / (6.632 + 11.18 + 5.69 + 0.581);
    assert.ok(Math.abs(firedBy['12:1'] - shotsKills * 1.027) < 1e-9, `the human mystic with spiritshots fires its shots cell's count (${firedBy['12:1']})`);
    assert.ok(Math.abs(humanHour.bareTop[0].shotless.deaths - 3600 / (7.039 + 15.59 + 10.6 + 0.581) * 0.02) < 1e-9, 'the bare hour carries the bare cell\'s own deaths');
    assert.equal(humanHour.bareTop[0].deaths, 0, 'the shots hour its own (none)');
    // The creation kit is the measured point: a main wearing exactly it (non-empty) is on the grid, one wearing another piece is counted off it.
    {
        const worn = viewOf({ ...snapshot, hours: table.hours, kits: { 51: { 1: [{ slot: 6, selfId: 1001 }] }, 12: { 1: [] } }, items: { ...snapshot.items, 1001: { kind: 'Armor.Chest', npcBuy: 1 } } });
        const offGrid = measured => {
            const account = freshBot('51', { held: [1001] });
            const made = Plane.plane({ view: worn, kitHours: kitsOf, variant: 'table', accounts: [account], table: { range: [1, 1], creation: () => measured } });
            return Engine.simulate({ view: worn, accounts: [account], bands: [['all', 1]], rates: { default: { huntShare: 1 } }, hours: 1, seed: 3, plane: made }).design.offGrid;
        };
        assert.equal(offGrid({ 6: 1001 }), 0, 'wearing exactly the creation kit counts no main off the grid');
        assert.equal(offGrid({ 6: 1002 }), 1, 'wearing another piece counts the main off the grid');
    }
}

// The held spot's candidates are the line's best row and its top: a game best outside top is held when its value is the
// highest, and a best that kills its bot loses to a safe top row under the risk term.
{
    const bestOut = row('s1', 400, 800), safe = row('s2', 60, 100), deadly = row('s1', 400, 800, { deaths: 200 });
    const outside = (best, top) => viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best, top } } }, yields: { 's1@1': drops, 's2@1': drops },
        items: ITEMS,
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }] } }, deathExp: [15, 30],
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
    for (const supply of ['table', 'formula']) {
        const held = best => run(freshBot(9, { shots: { [SHOT]: 600 } }), supply, 1, 1, outside(best, [safe])).visits[0].main.spot;
        assert.equal(held(bestOut), 's1', `${supply}: the best outside top is held when it is worth most`);
        assert.equal(held(deadly), 's2', `${supply}: a best that kills its bot loses to the safe top row`);
    }
}

// The town chain buys gear after its sales and decides its supply again on what the gear left: a bot born in TownA
// with the no-grade sword, 3000 no-grade shots and 1M adena, where a stub gear rule sells a D sword (100k) to a wallet
// that pays it above the reserve: it wears the D sword, sells the 3000 no-grade shots (spare now: its weapon fires the
// D shot) and buys D shots toward its target, all in the same chain. A stub that buys nothing leaves the chain as it is
// without a gear rule (the same main and delta at every visit of a bot born with 60 shots that walks to town for more).
{
    const DSWORD = 2499, DSHOT = 1463;
    const graded = viewOf({ header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } } }, yields: { 's1@1': drops, 's2@1': drops },
        items: { ...ITEMS, [DSHOT]: { kind: 'Other.Shot', npcBuy: 5, weight: 4 }, [SWORD]: swordItem, [DSWORD]: { kind: 'Weapon.Sword', grade: 'D', npcBuy: 0, weight: 0 } },
        shotFamilies: { grades: ['NONE', 'D'], ids: [[SHOT, DSHOT]] },
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }], [DSHOT]: [{ town: 'TownA', price: 20 }] } }, deathExp: [15, 30],
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3 }, s2: { TownA: 0.3 } } }, bags: { 9: { slots: 80, maxLoad: LOAD } } });
    const dSword = { next: (main, town, reserve) =>
        (main.weapon === SWORD && main.money - reserve >= 100000 ? { selfId: DSWORD, slot: 7, price: 100000, weapon: true, town: 'TownA', fare: 0 } : null) };
    const bot = () => freshBot(9, { ...armed, money: 1000000, shots: { [SHOT]: 3000 } });
    for (const supply of ['table', 'formula']) {
        const born = run(bot(), supply, 1, 0, graded, dSword).visits[0];
        assert.equal(born.main.weapon, DSWORD, `${supply}: it wears the D sword bought at the visit`);
        assert.deepEqual([born.main.kit[7], born.delta.gearBought], [DSWORD, 1]);
        assert.equal(born.delta.shotsSoldNpc, 3000, `${supply}: the no-grade shots are spare after the swap and sold`);
        assert.ok(!born.main.shots[SHOT] && born.main.shots[DSHOT] > 0, `${supply}: it buys the D shots its new weapon fires in the same chain`);
        assert.equal(born.main.money, 1000000 + 3000 * 2 - 100000 - born.main.shots[DSHOT] * 20, `${supply}: money = before + sales - weapon - D shots`);
        // The gear spends only what is above the stock target at the town price: a wallet that pays the sword only
        // without that reserve keeps its no-grade sword and buys its shots.
        const short = run(freshBot(9, { ...armed, money: 100100, shots: { [SHOT]: 60 } }), supply, 1, 0, graded, dSword).visits[0];
        assert.deepEqual([short.main.weapon, short.delta.gearBought, short.main.shots[SHOT] > 60], [SWORD, 0, true],
            `${supply}: the reserve keeps the shot money from the sword`);
        const none = { next: () => null };
        const poor = () => freshBot(9, { ...armed, shots: { [SHOT]: 60 } });
        const plain = run(poor(), supply, 6, 0, graded), stub = run(poor(), supply, 6, 0, graded, none);
        const seen = visits => visits.map(visit => ({ now: visit.now, main: visit.main, delta: visit.delta, afterHours: visit.afterHours }));
        assert.ok(plain.visits.length > 1, `${supply}: the control run visits a town after its birth`);
        assert.deepEqual(seen(stub.visits), seen(plain.visits), `${supply}: a gear rule that buys nothing leaves every chain as it is`);
    }
}

// One onward hop per town chain, by gatekeeper: TownA's NPC sells only no-grade shots; the D shots are sold only by a
// configured city store in TownB (a fixed seller, 500 each), 3000 away; the walk back from TownB is 0.9 h (0.3 from
// TownA). A gear rule that sells a D sword in TownB takes the bot there: it pays the fare, wears the sword, sells its
// no-grade shots (spare now), buys D shots from the store, all booked, and walks back from TownB; a second piece sold
// in TownC is not bought (one hop). A bot that already holds the D sword and buys no gear goes to TownB for its shots
// when the wallet pays the fare and one shot, else it stays in TownA and buys none. At a 0 fare to TownB it buys the
// D shots in TownA when TownA sells them, though TownB sells them cheaper; with none in TownA it hops to TownB.
{
    const DSWORD = 2499, DSHOT = 1463, DSHIRT = 391;
    const hopSnapshot = { spotAvgLevel: AVG_LEVEL, header: { levels: [1, 2] }, exp: [0, 1e9], kits: { 9: { 1: [] } },
        hours: { 9: { 1: { classId: 9, shotId: SHOT, best: near, top: [near, far] } } }, yields: { 's1@1': drops, 's2@1': drops },
        items: { ...ITEMS, [DSHOT]: { kind: 'Other.Shot', npcBuy: 5, weight: 4 }, [SWORD]: swordItem, [DSWORD]: { kind: 'Weapon.Sword', grade: 'D', npcBuy: 0, weight: 0 },
            [DSHIRT]: { kind: 'Armor.Leather', grade: 'D', npcBuy: 0, weight: 0 } },
        shotFamilies: { grades: ['NONE', 'D'], ids: [[SHOT, DSHOT]] },
        npcOffers: { preset: { [SHOT]: [{ town: 'TownA', price: 7 }, { town: 'TownB', price: 7 }] } }, deathExp: [15, 30],
        fares: { TownA: { TownB: 3000, TownC: 5000 }, TownB: { TownA: 3000, TownC: 4000 }, TownC: { TownA: 5000, TownB: 4000 } },
        tripHours: { to: { s1: 0.2, s2: 0.2 }, back: { s1: { TownA: 0.3, TownB: 0.9, TownC: 1.2 }, s2: { TownA: 0.3, TownB: 0.9, TownC: 1.2 } } },
        bags: { 9: { slots: 80, maxLoad: LOAD } } };
    const hopWorld = Engine.viewOf(hopSnapshot, { market: { sell: { TownB: { [DSHOT]: 500 } } } });
    const freeOf = sell => Engine.viewOf({ ...hopSnapshot, fares: { TownA: { TownB: 0 }, TownB: { TownA: 0 } } }, { market: { sell } });
    const swordInB = { next: (main, town, reserve) => (main.weapon === SWORD && main.money - reserve >= 103000
        ? { selfId: DSWORD, slot: 7, price: 100000, weapon: true, town: 'TownB', fare: 3000 }
        : main.weapon === DSWORD && !main.kit[10] ? { selfId: DSHIRT, slot: 10, price: 1000, weapon: false, town: 'TownC', fare: town === 'TownC' ? 0 : 4000 } : null) };
    for (const supply of ['table', 'formula']) {
        const born = run(freshBot(9, { ...armed, money: 1000000, shots: { [SHOT]: 3000 } }), supply, 1, 0, hopWorld, swordInB).visits[0];
        const bought = born.main.shots[DSHOT];
        assert.deepEqual([born.delta.towns, born.delta.flows.fares, born.main.weapon, born.delta.gearBought], [['TownA', 'TownB'], -3000, DSWORD, 1],
            `${supply}: one hop to the sword's town, the fare paid, the sword worn`);
        assert.ok(!born.main.kit[10], `${supply}: the piece sold in a third town is not bought`);
        assert.equal(born.delta.shotsSoldNpc, 3000, `${supply}: the no-grade shots are spare after the swap and sold`);
        assert.ok(bought > 0 && born.delta.shotsBoughtFixed === bought && !born.delta.shotsBoughtNpc, `${supply}: the D shots are bought from the store in TownB (${bought})`);
        assert.deepEqual([born.delta.flows.fixedSellers, born.delta.flows.npcBuys], [-500 * bought, -100000], `${supply}: booked as a fixed seller's sale at its price`);
        assert.equal(born.main.money, 1000000 + 3000 * 2 - 100000 - 3000 - 500 * bought, `${supply}: money = before + sales - weapon - fare - D shots`);
        assert.ok(close(born.afterHours, 0.9), `${supply}: it walks back from TownB (${born.afterHours})`);
        const none = { next: () => null };
        const shooter = run(freshBot(9, { worn: { 7: DSWORD }, money: 1000000 }), supply, 1, 0, hopWorld, none).visits[0];
        assert.deepEqual([shooter.delta.towns, shooter.delta.flows.fares, shooter.main.shots[DSHOT] > 0, shooter.delta.shotsBoughtFixed === shooter.main.shots[DSHOT]],
            [['TownA', 'TownB'], -3000, true, true], `${supply}: a D-sword bot goes to TownB for its shots`);
        assert.ok(close(shooter.afterHours, 0.9), `${supply}: and walks back from there`);
        const poor = run(freshBot(9, { worn: { 7: DSWORD }, money: 3400 }), supply, 1, 0, hopWorld, none).visits[0];
        assert.deepEqual([poor.delta.towns, poor.delta.flows.fares, poor.main.shots[DSHOT] || 0], [['TownA'], 0, 0], `${supply}: a wallet short of the fare and one shot stays`);
        for (const [sell, towns, price] of [[{ TownA: { [DSHOT]: 600 }, TownB: { [DSHOT]: 500 } }, ['TownA'], 600], [{ TownB: { [DSHOT]: 500 } }, ['TownA', 'TownB'], 500]]) {
            const near = run(freshBot(9, { worn: { 7: DSWORD }, money: 1000000 }), supply, 1, 0, freeOf(sell), none).visits[0], held = near.main.shots[DSHOT] || 0;
            assert.deepEqual([near.delta.towns, near.delta.flows.fares, held > 0, near.delta.shotsBoughtFixed === held, near.delta.flows.fixedSellers], [towns, 0, true, true, -price * held],
                `${supply}: at a 0 fare the D shots are bought in ${towns.at(-1)} at ${price}`);
        }
    }
}

// The gear step is the game's NPC gear rule (staticNpcUpgradePlan through gear.js): line 9 at level 20 (an archer there)
// wearing the no-grade Squire's Sword in a town that sells a D bow (1,214,267) and a D leather shirt (185,851): with
// 300k it buys the shirt (an unfunded weapon does not block armour); with 2M and 100k kept the bow, worn in its own
// two-handed slot; with 1M kept the bow is not funded (the wallet above the reserve), the shirt is. The rule reads the
// NPCs of every town: in Orc Village, which sells neither, the answer is the shirt of the town the fewest fare away
// (Gludin, 3000), funded only when the wallet above the reserve pays the price and the fare; a town with no route to a
// seller gives nothing.
{
    const Boot = require('../scripts/economy-model/boot');
    Boot.boot('x50');
    const Gear = require('../scripts/economy-model/gear');
    const BOW = 274, SHIRT = 391;
    const shop = { offers: new Map([[BOW, [{ town: 'Giran', price: 1214267, channel: 'npc_buy' }]],
        [SHIRT, [{ town: 'Gludin', price: 185851, channel: 'npc_buy' }, { town: 'Giran', price: 185851, channel: 'npc_buy' }]]]),
        items: { [BOW]: { kind: 'Weapon.Bow', grade: 'D' }, [SHIRT]: { kind: 'Armor.Leather', grade: 'D' } },
        fares: { 'Orc Village': { Gludin: 3000, Giran: 11000 }, Gludio: { Gludin: null, Giran: null } } };
    const gear = Gear.npcGear({ snapshot: { gearLadder: { slots: {} } }, view: shop });
    const archer = money => ({ line: 9, level: 20, money, kit: { 7: SWORD }, weapon: SWORD });
    assert.deepEqual(gear.next(archer(300000), 'Giran', 0), { selfId: SHIRT, slot: 10, price: 185851, weapon: false, town: 'Giran', fare: 0, channel: 'npc_buy' }, 'the affordable armour before the unfunded weapon');
    assert.deepEqual(gear.next(archer(2000000), 'Giran', 100000), { selfId: BOW, slot: 14, price: 1214267, weapon: true, town: 'Giran', fare: 0, channel: 'npc_buy' }, 'the D weapon when the wallet pays it');
    assert.equal(gear.next(archer(2000000), 'Giran', 1000000).selfId, SHIRT, 'the reserve kept holds the weapon back');
    assert.deepEqual(gear.next(archer(300000), 'Orc Village', 0), { selfId: SHIRT, slot: 10, price: 185851, weapon: false, town: 'Gludin', fare: 3000, channel: 'npc_buy' },
        'in a village that sells no D piece: the D shirt of the town the fewest fare away');
    assert.equal(gear.next(archer(188000), 'Orc Village', 0), null, 'the fare is paid from the same wallet: price and fare above it, not funded');
    assert.equal(gear.next(archer(2000000), 'Gludio', 0), null, 'a town with no route to a seller gives nothing');
}

// The C/B/A reserve stub: the line's reference kit at the main's level, the pieces of grade C+ the main wears at a
// lower grade, weapon first, from the reserve store (channel fixed_wts) when the wallet above the reserve pays the
// price and the fare (a weapon not paid is saved for: nothing else of the kit is bought); nothing for a piece an NPC sells, one already worn at its grade or a wallet that does not pay.
{
    const Gear = require('../scripts/economy-model/gear');
    const CBOW = 9001, CSHIRT = 9002, DSHIRT = 391;
    const view = { kits: { 9: { 50: [{ selfId: CBOW, slot: 14 }, { selfId: CSHIRT, slot: 10 }] } },
        offers: new Map([[CBOW, [{ town: 'Giran', price: 2000000, channel: 'fixed_wts' }]], [CSHIRT, [{ town: 'Giran', price: 900000, channel: 'fixed_wts' }]]]),
        items: { [CBOW]: { kind: 'Weapon.Bow', grade: 'C' }, [CSHIRT]: { kind: 'Armor.Leather', grade: 'C' }, [DSHIRT]: { kind: 'Armor.Leather', grade: 'D' }, 274: { kind: 'Weapon.Bow', grade: 'D' } },
        fares: {} };
    const reader = Gear.kitReserve({ snapshot: { gearLadder: { slots: {} } }, view });
    const main = money => ({ line: 9, level: 50, money, kit: { 14: 274, 10: DSHIRT }, weapon: 274 });
    assert.equal(reader.next(main(5000000), 'Giran', 1000000).selfId, CBOW, 'the weapon first');
    assert.equal(reader.next(main(2500000), 'Giran', 1000000), null, 'the weapon is saved for: the funded shirt is not bought before it');
    assert.equal(reader.next({ ...main(2500000), kit: { 14: CBOW, 10: DSHIRT }, weapon: CBOW }, 'Giran', 1000000).selfId, CSHIRT, 'with the weapon worn the shirt is next');
    assert.equal(reader.next(main(1500000), 'Giran', 1000000), null, 'nothing is funded above the reserve');
    assert.equal(reader.next({ ...main(5000000), kit: { 14: CBOW, 10: CSHIRT }, weapon: CBOW }, 'Giran', 0), null, 'the kit is worn');
    assert.equal(reader.next({ ...main(5000000), level: 49 }, 'Giran', 0), null, 'no kit row of that level');
    // The weapon steps by grade: the B kit weapon of this level, else the C one of the level below.
    const BBOW = 9003, steps = { ...view, kits: { 9: { 49: [{ selfId: CBOW, slot: 14 }], 50: [{ selfId: BBOW, slot: 14 }] } },
        offers: new Map([...view.offers, [BBOW, [{ town: 'Giran', price: 9000000, channel: 'fixed_wts' }]]]), items: { ...view.items, [BBOW]: { kind: 'Weapon.Bow', grade: 'B' } } };
    const stepper = Gear.kitReserve({ snapshot: { gearLadder: { slots: {} } }, view: steps });
    assert.equal(stepper.next(main(9500000), 'Giran', 0).selfId, BBOW, 'the B when the wallet pays it');
    assert.equal(stepper.next(main(3000000), 'Giran', 0).selfId, CBOW, 'the C of the level below when the B is not paid');
    assert.equal(stepper.next(main(1000000), 'Giran', 0), null, 'neither paid: it saves');
}

console.log('economy model design: ok');

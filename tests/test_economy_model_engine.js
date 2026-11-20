'use strict';

// The economy model's engine on an inline snapshot: a run is reproducible
// from its seed, the money stock moves by exactly the flows' net, and one
// hunting main levels, sells its loot, and travels to the town that sells
// its next kit piece while a craft station holds still. Items come in the
// amount of the hour's loot, spoils only to a line with Spoil, a main hunts
// the spot its bot stood at while that spot has an hour, fires the shots of
// its weapon's grade, and comes to town when the run's arrival rule says.
const assert = require('node:assert/strict');
const Engine = require('../scripts/economy-model/engine');
const Today = require('../scripts/economy-model/today');

// Loot 30 an hour: the per-kill yields below at the NPC's price (10 kills x (0.5 x 5 + 0.01 x 50)).
const hour = (adena, exp, shots, loot = 30) => ({ classId: 9, shotId: 1463,
    best: { spotId: 's1', kills: 10, exp, adena, shots, dropLoot: loot, spoilLoot: 0, loot, potions: 0, busyShare: 1, deaths: 0 }, top: [] });
const yields = { town: 'TownA', drop: { 57: 10, 200: 0.5, 300: 0.01 }, spoil: {} };
const snapshot = {
    header: { levels: [1, 4], rates: { adena: 1 } },
    exp: [0, 100, 300, 600],
    hours: { 9: { 1: hour(100, 50, 20), 2: hour(100, 50, 20), 3: hour(100, 50, 20), 4: hour(100, 50, 20) } },
    kits: { 9: { 1: [{ selfId: 100, slot: 7 }], 2: [{ selfId: 101, slot: 7 }], 3: [{ selfId: 101, slot: 7 }], 4: [{ selfId: 101, slot: 7 }] } },
    yields: { 's1@1': yields, 's1@2': yields, 's1@3': yields, 's1@4': yields },
    items: {
        100: { kind: 'Weapon.Sword', grade: 'NONE', ref: 1000, npcBuy: 500 },
        101: { kind: 'Weapon.Sword', grade: 'D', ref: 2000, npcBuy: 1000 },
        200: { kind: 'Other.Material', grade: 'NONE', ref: 10, npcBuy: 5 },
        300: { kind: 'Other.Recipe', grade: 'NONE', ref: 100, npcBuy: 50 },
        1463: { kind: 'Other.Shot', grade: 'NONE', ref: 10, npcBuy: 5 },
        1835: { kind: 'Other.Shot', grade: 'NONE', ref: 5, npcBuy: 2 }
    },
    shotFamilies: { grades: ['NONE', 'D', 'C', 'B', 'A', 'S'], ids: [[1835, 1463, 1464, 1465, 1466, 1467]] },
    npcOffers: { preset: { 101: [{ town: 'TownB', price: 3000 }] }, x1: {} },
    recipes: [{ recipeItemId: 300, productId: 101 }],
    fares: { TownA: { TownA: 0, TownB: 5000 }, TownB: { TownA: 5000, TownB: 0 } }
};
const bands = [['low', 1], ['high', 2]];
const rates = { default: { huntShare: 1, visitsPerBotHour: 1 } };
// Once an hour, the first at a seeded share of the hour.
const hourly = (main, { event, now, pending, roll }) => (event === 'level_up' ? pending : now + (event === 'start' ? roll : 1));
const accounts = [
    { id: 1, station: false, classId: 9, line: '9', level: 1, exp: 0, money: 10000, shots: {}, held: [100], worn: { 7: 100 } },
    { id: 2, station: true, classId: 57, line: null, level: 40, exp: 0, money: 777, shots: {}, held: [], worn: {} }
];
// Today's plane with the test's arrival rule: every main hunts its row's own kit and fires the hour's shot
// (Today.hunter) unless a hunter is given.
const planeWith = (view, nextArrival, hunter = Today.hunter(view)) => {
    const today = Today.plane({ view, hunter });
    return { ...today, start: context => ({ ...today.start(context), nextArrival }) };
};
const plainRun = ({ view, nextArrival, ...options }) => Engine.simulate({ view, plane: planeWith(view, nextArrival), ...options });
const run = (seed, hours = 3) => plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours, seed, nextArrival: hourly });

// The design mode leaves the plain and today's ledger as they were: this
// fixture's 40-hour ledger hashes to the value recorded before the design
// mode existed, moved once since: a level is read when the exp reaches the
// level's exp, as levelOf counts it, no longer one exp later.
const crypto = require('node:crypto');
// The failure counters added since are left out of the hash: every other number is as before.
const pinned = out => { const { arrivalNotAhead, unlevelableMains, deaths, deathExpLost, ...counters } = out.counters; return { ...out, counters }; };
assert.equal(crypto.createHash('sha256').update(JSON.stringify(pinned(run(3, 40)))).digest('hex'), '235d189ec6043f27bdde6516124894160c9d1da098497ae6537ffc9e3947ccfd',
    'the ledger without the design mode is unchanged');

// The same seed gives the same ledger; another seed rolls other drops.
const first = run(7);
assert.deepEqual(run(7), first, 'a run is a function of its seed');
assert.notDeepEqual(run(4, 40), run(3, 40), 'another seed draws other drops');

// The money stock moves by the flows' net, to the adena.
for (const out of [first, run(3, 40)]) {
    assert.equal(out.money.delta, out.flows.net, 'money delta equals faucets plus sinks');
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.flows.net, out.flows.faucets + out.flows.sinks);
}

// The hunting main: 3 h at 100 adena and 50 exp an hour, level 2 at 100 exp
// and 3 at 300 (6 h, beyond the run).
const hunter = first.progress.stageBands.low;
assert.equal(hunter.bots, 1);
assert.equal(hunter.levelUps, 1, 'level 2 after 2 hunting hours');
assert.equal(hunter.bandExits, 1, 'the main leaves its start band at level 2');
assert.ok(Math.abs(first.flows.totals.huntCold - 300) <= 3, `hunt adena ${first.flows.totals.huntCold} is the hour's adena times the hours, to a rounding per situation`);
assert.equal(hunter.expPerBotHour, 50);
// At level 2 its plan names piece 101, which only TownB's NPC sells: it pays
// the gatekeeper fare from its spot's town, buys the piece and sells the old one to the NPC.
assert.equal(first.flows.totals.fares, -5000);
assert.equal(first.flows.totals.npcBuys, -3000);
assert.equal(first.gear.boughtNpcUnits, 1);
assert.ok(first.gear.toNpcUnits >= 1, 'the replaced piece goes to the NPC');
assert.deepEqual(first.visits.towns.map(row => row.town).sort(), ['TownA', 'TownB']);
// The seller is the town the main stands in when it sells the piece, at any price: TownA's own 9000 beats TownB's
// 3000, with a 5000 fare and with none. With no offer in TownA it is TownB's, and a 0 fare to it is still a hop.
for (const fare of [5000, 0]) {
    const fares = { TownA: { TownA: 0, TownB: fare }, TownB: { TownA: fare, TownB: 0 } };
    const priced = Engine.viewOf({ ...snapshot, fares, npcOffers: { preset: { 101: [{ town: 'TownA', price: 9000 }, { town: 'TownB', price: 3000 }] }, x1: {} } });
    assert.deepEqual([Engine.sellerOf(priced, 101, 'TownA').town, Engine.hopSeller(priced, [101], 'TownA', 1e6)], ['TownA', null], `fare ${fare}: bought in TownA`);
    const elsewhere = Engine.viewOf({ ...snapshot, fares });
    assert.deepEqual(Engine.hopSeller(elsewhere, [101], 'TownA', 1e6), { town: 'TownB', price: 3000, channel: 'npc_buy', fare }, `fare ${fare}: a hop to TownB`);
}
// Loot goes to the NPC at its buy price; nobody sells the hour's shots, so the restock stays open.
assert.ok(first.flows.totals.npcSales >= 500, 'the old piece and the materials sold');
assert.ok(first.counters.missingShots >= 1);
assert.equal(first.shots.used, 0, 'no shots held, none fired');
// The station hunts nothing and keeps its money.
assert.equal(first.progress.stageBands.station.money.meanEnd, 777);
assert.equal(first.population.botHours, 6);

// A recipe drop counts under its product's grade.
const long = run(3, 40);
assert.ok(long.recipes.droppedTotal > 0 && long.recipes.dropped.d === long.recipes.droppedTotal, 'recipes by product grade');

// Rare items arrive whole at their mean rate.
let sum = 0;
for (let i = 0; i < 20000; i++) sum += Engine.wholeCount(0.3, (() => { let s = i * 7919 + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })());
assert.ok(Math.abs(sum / 20000 - 0.3) < 0.02, `mean whole count ${sum / 20000}`);

// Item amounts follow the hour's loot: twice the loot, twice the items.
const view = Engine.viewOf(snapshot);
const lootOf = loot => {
    const richer = { ...snapshot, hours: { 9: { ...snapshot.hours[9], 1: hour(100, 50, 20, loot) } } };
    return Engine.hunt(Engine.mainOf(accounts[0], 0, Engine.viewOf(richer), bands), Engine.viewOf(richer), 100, () => 0.5).main.bag[200];
};
assert.equal(lootOf(30), 500, '0.5 per kill x 10 kills x 100 h');
assert.equal(lootOf(60), 1000);
assert.equal(lootOf(0), undefined, 'an hour without loot drops nothing');

// A party member hunts by the game's party rule: its exp is its share of what
// the party kills (one member's row exp for each member, the 3-member bonus
// 1.39, the split by squared level), its adena and drops a solo bot's per kill;
// a member far under the party's level gets no exp.
const partied = party => Engine.hunt({ ...Engine.mainOf(accounts[0], 0, view, bands), party }, view, 100, () => 0.5);
const solo = partied(null), trio = partied({ levels: [1, 1, 1], self: 0 });
assert.equal(solo.delta.exp, 5000);
assert.equal(trio.delta.exp, 6950, 'three equal members: 1.39 x a solo bot\'s exp');
assert.equal(trio.delta.flows.huntCold, solo.delta.flows.huntCold, 'adena stays a solo bot\'s');
assert.deepEqual(trio.main.bag, solo.main.bag, 'drops stay a solo bot\'s');
assert.equal(partied({ levels: [1, 50], self: 0 }).delta.exp, 0, 'under the squared-level cut: no exp');
// The hunt is the worn kit's: a kit making half the row's kills
// gains half its exp, adena and drops an hour.
{
    const main = Engine.mainOf(accounts[0], 0, view, bands), full = Engine.hunt(main, view, 100, () => 0.5);
    const half = Engine.hunt(main, view, 100, () => 0.5, null, { bare: 0.5, shots: 0.5, blessed: 0.5 });
    assert.equal(half.delta.exp, 2500, 'half the row\'s exp');
    assert.ok(Math.abs(half.delta.flows.huntCold - full.delta.flows.huntCold / 2) <= 1, `half the row's adena: ${half.delta.flows.huntCold} of ${full.delta.flows.huntCold}`);
    assert.ok(Math.abs((half.main.bag[200] || 0) - (full.main.bag[200] || 0) / 2) <= 1, `half the row's drops: ${half.main.bag[200]} of ${full.main.bag[200]}`);
}

// A main with a no-grade weapon fires no-grade shots where the hour names D
// shots; with the D weapon it restocks D shots.
const plain = { ...Engine.mainOf(accounts[0], 0, view, bands), shots: { 1835: 1000 } };
assert.equal(plain.weapon, 100);
assert.equal(Engine.hunt(plain, view, 1, () => 0.5, Today.hunter(view).firing(plain)).main.shots[1835], 980, 'no-grade shots fired');
const armed = { ...plain, weapon: 101, shots: {} };
assert.deepEqual(Today.errands(armed, view, { outingHours: 0.5, firing: Today.hunter(view).firing(armed) }).find(errand => errand.kind === 'shots'),
    { kind: 'shots', id: 1463, amount: 20 }, 'D shots, one hour of use');
// The weapon in hand is the one grade source: the D sword fires the D shot of the hour's kind, the no-grade sword the
// no-grade one, no weapon none; a held weapon the snapshot does not grade is a model bug.
const hourAt = Engine.hourOf(view, plain);
assert.deepEqual([armed, plain, { ...plain, weapon: 0 }].map(main => Engine.shotOf(view, main, hourAt)), [1463, 1835, 0]);
assert.throws(() => Engine.shotOf(view, { ...plain, weapon: 999 }, hourAt), /no shot grade/);

// A spot's spoils (written at the highest Spoil level of any line there)
// reach only a row with spoil loot, at that loot.
const spoiled = { ...snapshot, yields: { ...snapshot.yields, 's1@1': { ...yields, spoil: { 201: 1 } } },
    items: { ...snapshot.items, 201: { kind: 'Other.Material', grade: 'NONE', ref: 20, npcBuy: 10 } } };
const bagOf = row => {
    const richer = { ...spoiled, hours: { 9: { ...spoiled.hours[9], 1: { ...hour(100, 50, 20), best: { ...hour(100, 50, 20).best, ...row } } } } };
    const at = Engine.viewOf(richer);
    return Engine.hunt(Engine.mainOf(accounts[0], 0, at, bands), at, 100, () => 0.5).main.bag;
};
assert.equal(bagOf({}).hasOwnProperty(201), false, 'a line without Spoil gets no spoil');
assert.equal(bagOf({ spoilLoot: 50, loot: 80 })[201], 500, 'spoil loot 50 an hour at 10 kills x 1 x 10 adena: half of the spawn mix\'s spoils');
assert.equal(bagOf({ spoilLoot: 50, loot: 80 })[200], 500, 'the drops follow the drop loot alone');

// A main hunts the spot its bot stood at while the snapshot has that spot's
// hour for its line and level, and moves to its line's best when a level-up
// leaves it without one.
const own = { spotId: 's2', kills: 10, exp: 50, adena: 1000, shots: 20, dropLoot: 0, spoilLoot: 0, loot: 0, potions: 0, busyShare: 1, deaths: 0 };
const placed = { ...snapshot, spotHours: { rows: { 9: { 1: { s2: own }, 2: { s2: null } } } },
    yields: { ...snapshot.yields, 's2@1': { town: 'TownA', drop: { 57: 100 }, spoil: {} } } };
const atOwn = plainRun({ view: Engine.viewOf(placed), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 3, seed: 7, nextArrival: () => null });
assert.equal(atOwn.counters.startAtOwnSpot, 1);
assert.equal(atOwn.counters.leftOwnSpot, 1, 'level 2 has no hour at s2');
// Level 2 at 100 exp: 2 h at s2 (1000 an hour), the rest at the best spot (100 an hour).
assert.ok(Math.abs(atOwn.flows.totals.huntCold - (2 * 1000 + 1 * 100)) <= 3, `hunt adena ${atOwn.flows.totals.huntCold}`);
assert.deepEqual(atOwn.huntHours, { ownSpot: 2, bestSpot: 1 });

// The time of an arrival is nextArrival's alone: the band's visit rate does
// not send a main to town. The rule is asked at the start and again after each
// committed event that changes the main, a visit and a level-up, on the main as
// it is then (a visit has emptied the bag), and its answer is the one pending arrival.
const asked = [];
const at = times => (main, state) => { asked.push({ ...state, bag: Object.keys(main.bag).length, level: main.level }); return times.find(time => time > state.now) ?? null; };
const silent = { default: { huntShare: 1, visitsPerBotHour: 0 } }, busy = { default: { huntShare: 1, visitsPerBotHour: 100 } };
const ruled = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: silent, hours: 3, seed: 7, nextArrival: at([0.5, 2.5]) });
assert.equal(ruled.counters.visits - ruled.counters.onwardHops, 2, 'arrivals at 0.5 h and 2.5 h at a visit rate of 0');
assert.deepEqual(asked.map(state => [state.now, state.event]), [[0, 'start'], [0.5, 'visit'], [2, 'level_up'], [2.5, 'visit']]);
assert.equal(asked[2].pending, 2.5, 'the level-up is asked with the arrival pending');
assert.equal(asked[2].level, 2);
assert.ok(asked.filter(state => state.event === 'visit').every(state => state.bag === 0), 'asked after the visit committed: the bag is sold');
assert.equal(asked[1].hour.exp, 50, 'the rule reads the main\'s hour row');
assert.equal(asked[1].shotsPerHour, snapshot.hours[9][1].best.shots);

// A level-up asks again and its answer replaces the pending arrival: the main
// levels at 2 h; the start answered 1.5, the level-up moves it to 2.9.
const levelAsked = [];
const replaced = plainRun({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 3, seed: 7,
    nextArrival: (main, state) => { levelAsked.push([state.event, state.now, state.pending]); return state.event === 'start' ? 1.5 : state.event === 'level_up' ? 2.9 : null; } });
assert.deepEqual(levelAsked.map(row => row[0]), ['start', 'visit', 'level_up', 'visit'], 'asked after the visit at 1.5 h, the level-up and the visit at 2.9 h');
assert.equal(replaced.counters.visits - replaced.counters.onwardHops, 2, 'arrivals at 1.5 h and 2.9 h');
assert.equal(plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: busy, hours: 3, seed: 7, nextArrival: () => null }).counters.visits, 0,
    'a visit rate of 100 an hour sends nobody when the rule says never');
assert.throws(() => Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3 }), /simulate needs a plane/);

// A spot row with spoil loot where the snapshot holds no spoil yields loses
// that loot: the kills are counted, not dropped silently.
const lossy = { ...snapshot, spotHours: { rows: { 9: { 1: { s2: { ...own, spoilLoot: 40 } } } } }, yields: { ...snapshot.yields, 's2@1': { town: 'TownA', drop: { 57: 100 }, spoil: {} } } };
const lost = plainRun({ view: Engine.viewOf(lossy), accounts: [{ ...accounts[0], spot: 's2' }], bands, rates, hours: 1, seed: 7, nextArrival: () => null });
assert.equal(lost.counters.spoilUnyielded, 10, 'ten kills with spoil loot and no spoil yields');
assert.equal(atOwn.counters.spoilUnyielded, 0, 'no spoil loot, nothing lost');

// A main out of its hour's shot hunts the row's hour without shots (fewer
// kills, less exp and adena) and counts the shots it wanted; a worn kit
// making half the reference kit's kills and firing half its shots earns half
// the adena and fires half the shots.
{
    const row = { ...hour(100, 50, 20).best, shotless: { kills: 5, exp: 25, adena: 50 } }, line = { ...hour(100, 50, 20), best: row };
    const dry = { ...snapshot, hours: { 9: { 1: line, 2: line, 3: line, 4: line } } }, at = Engine.viewOf(dry);
    const out = Engine.simulate({ view: at, accounts: [accounts[0]], bands, rates: silent, hours: 2, seed: 7, plane: planeWith(at, () => null) });
    assert.ok(Math.abs(out.flows.totals.huntCold - 100) <= 1, `the shotless hour's adena, 2 x 50: ${out.flows.totals.huntCold}`);
    assert.equal(out.progress.stageBands.low.expPerBotHour, 25, 'the shotless hour\'s exp');
    assert.deepEqual([out.shots.used, out.shots.wanted], [0, 40], 'none fired, 2 hours of 20 wanted');
    const stocked = [{ ...accounts[0], shots: { 1835: 1000 } }];
    const worn = factors => Engine.simulate({ view: at, accounts: stocked, bands, rates: silent, hours: 2, seed: 7, plane: planeWith(at, () => null, Today.hunter(at, () => factors)) });
    const full = worn(null), half = worn({ shots: { kills: 0.5, shots: 0.5 } });
    assert.deepEqual([full.flows.totals.huntCold, full.shots.used], [200, 40], 'the row\'s kit: its adena and shots');
    assert.deepEqual([half.flows.totals.huntCold, half.shots.used], [100, 20], 'half the kills and shots: half the adena and shots');
}

// A spot its occupation chose (the design mode's, one of its line's top
// spots at its level) is where the main hunts; without one, its own spot or
// its line's best.
{
    const top = { ...own, spotId: 's3', adena: 5000 };
    const ranked = { ...snapshot, hours: { 9: { ...snapshot.hours[9], 1: { ...snapshot.hours[9][1], top: [top] } } } };
    const at = Engine.viewOf(ranked), base = Engine.mainOf(accounts[0], 0, at, bands);
    assert.equal(Engine.spotRowOf(at, { ...base, occupied: 's3' }).spotId, 's3');
    assert.equal(Engine.spotRowOf(at, base).spotId, 's1', 'no occupation: the line\'s best');
    assert.equal(Engine.spotRowOf(at, { ...base, occupied: 's9' }).spotId, 's1', 'a spot with no hour at its level is not hunted');
}

// A bot is in one state at a time: an arrival answered { at, away } leaves
// the spot at at - away, and the way is not hunted (adena, exp, shots
// wanted); an arrival it has left for is not decided again by a later
// event; a visit's onward stops keep it in town their hours. A plane that
// fires 20 shots an hour and visits as the plain mode does (its hunt
// credits no adena on this snapshot: the adena is read from the plain mode).
{
    const planeOf = (rule, { afterHours = 0, onHour = null } = {}) => {
        const seen = { hunts: [], visits: [], asked: [], levels: [] };
        const design = { sinks: [], start: context => ({
            hunt: (main, delta, now) => seen.hunts.push({ now, exp: delta.exp, wanted: delta.shotsWanted, spot: delta.spotHours, way: delta.wayHours }),
            visit: (main, now, options) => { seen.visits.push(now); return { ...Today.visit(main, Engine.viewOf(snapshot), options), afterHours }; },
            nextArrival: (main, ev) => { seen.asked.push([ev.event, ev.now]); return rule(main, ev); },
            firing: () => ({ id: 1463, perHour: 20 }), kills: () => null, levelUp: (main, now) => { seen.levels.push([Math.round(now * 100) / 100, main.level]); return main; }, event() {},
            hour: now => { if (onHour) onHour(context, now); return 0; },
            finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
        return { design, seen };
    };
    const total = (seen, field) => seen.hunts.reduce((sum, row) => sum + row[field], 0);
    const once = answer => (main, ev) => (ev.event === 'visit' ? null : answer);

    const trip = planeOf(once({ at: 10, away: 2 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, plane: trip.design });
    assert.deepEqual(trip.seen.visits, [10]);
    const plainTrip = plainRun({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, nextArrival: once({ at: 10, away: 2 }) });
    assert.ok(Math.abs(plainTrip.flows.totals.huntCold - 800) <= 3, `8 hours of hunt adena, not 10: ${plainTrip.flows.totals.huntCold}`);
    assert.ok(Math.abs(total(trip.seen, 'exp') - 400) <= 1, `8 hours of exp: ${total(trip.seen, 'exp')}`);
    assert.ok(Math.abs(total(trip.seen, 'wanted') - 160) <= 2, `8 hours of shots wanted: ${total(trip.seen, 'wanted')}`);
    assert.ok(Math.abs(total(trip.seen, 'way') - 2) < 1e-9, 'the 2 hours away are the way\'s');

    // A line raised at 9 h (after it left at 8 h) asks nothing: the arrival at 10 h holds.
    const held = planeOf((main, ev) => (ev.event === 'visit' ? null : ev.now >= 9 ? { at: 9.5, away: 0.1 } : { at: 10, away: 2 }),
        { onHour: (context, now) => { if (now === 9) context.rearrive(0, now, 'offer_posted'); } });
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 10, seed: 7, plane: held.design });
    assert.deepEqual(held.seen.visits, [10], 'the departed arrival is kept');
    assert.ok(!held.seen.asked.some(([event]) => event === 'offer_posted'), 'not decided again on its way');

    // One onward stop (0.2 h): it hunts again 0.2 h after the arrival at 2.5 h.
    const onward = planeOf(once(2.5), { afterHours: 0.2 });
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 4, seed: 7, plane: onward.design });
    assert.ok(Math.abs(total(onward.seen, 'exp') - 190) <= 1, `3.8 hours of exp over 4 h: ${total(onward.seen, 'exp')}`);
    assert.deepEqual(onward.seen.asked.find(([event]) => event === 'visit'), ['visit', 2.7], 'asked again from the hour it hunts again');

    // Level 3 (300 exp) would come at 6 h, inside the way from 5 h to 7 h: at
    // 5 h it has 250 exp, so it reaches level 3 50 exp after its arrival
    // (8 h), read once then; no level-up is read on its way.
    const level = planeOf(once({ at: 7, away: 2 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 9, seed: 7, plane: level.design });
    assert.deepEqual(level.seen.levels, [[2, 2], [8, 3]], 'level 2 at 2 h, level 3 once after the arrival, none on the way');

    // A departure set after the level was scheduled: level 2 was due at 2 h,
    // the situation read at 0.5 h sends it away from 1 h to 3 h, so it has 50
    // exp when it leaves and reaches level 2 50 exp after its arrival (4 h).
    const late = planeOf((main, ev) => (ev.event === 'start' ? { at: 0.5, read: true } : ev.event === 'situation' ? { at: 3, away: 2 } : null));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 5, seed: 7, plane: late.design });
    assert.deepEqual(late.seen.levels, [[4, 2]], 'the level moves after the arrival when the departure comes after it was scheduled');

    // A level due on the spot before the departure is read there: the
    // situation read at 1.9 h sends it away at 2.1 h, level 2 comes at 2 h.
    const before = planeOf((main, ev) => (ev.event === 'start' ? { at: 1.9, read: true } : ev.event === 'visit' ? null : { at: 3, away: 0.9 }));
    Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates: silent, hours: 5, seed: 7, plane: before.design });
    assert.deepEqual(before.seen.levels, [[2, 2]], 'a level reached on the spot before it leaves is read once, on the spot');
}

// A level crossed at a large exp is read once although the float credit to
// its hour falls short: the main hunts to 4 ulps under level 2 (1e9 exp) by
// its visit at 0.5 h, whose onward stops keep it in town to 100.5 h, so the
// crossing's hour rounds to 100.5 and the hunt to it credits nothing. The
// plane stops the run after 100 reads, so a read that does not reach the
// level fails here instead of hanging.
{
    const T = 1e9, rate = 2 * (T - 4 * 2 ** -23), row = hour(100, rate, 20);
    const big = { ...snapshot, exp: [0, T, 4 * T, 9 * T], hours: { 9: { 1: row, 2: row, 3: row, 4: row } } }, at = Engine.viewOf(big), levels = [];
    const design = { sinks: [], start: () => ({ hunt() {}, visit: (main, now, options) => ({ ...Today.visit(main, at, options), afterHours: 100 }),
        nextArrival: (main, ev) => (ev.event === 'start' ? 0.5 : null), firing: () => null, kills: () => null, event() {}, hour: () => 0,
        levelUp: (main, now) => { levels.push([now, main.level]); if (levels.length > 100) throw new Error(`100 level reads, level ${main.level} at ${now} h`); return main; },
        finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
    Engine.simulate({ view: at, accounts: [accounts[0]], bands, rates: silent, hours: 101, seed: 7, plane: design });
    assert.deepEqual(levels, [[100.5, 2]], 'level 2 read once, at the hour it hunts again');
}

// The level is read when the exp the hunt credits reaches it: the main fires
// its 40 shots (20 an hour) at 50 exp an hour, then hunts bare at 25; its row
// has a blessed hour of 100 exp it does not fire. Level 2 (100 exp) comes at
// 2 h, level 3 (300 exp) 8 bare hours later; no read comes before its level,
// and a read gains only the level it hunted.
{
    const row = { ...hour(100, 50, 20).best, shotless: { exp: 25 }, blessed: { exp: 100 } }, line = { ...hour(100, 50, 20), best: row };
    const fired = { ...snapshot, hours: { 9: { 1: line, 2: line, 3: line, 4: line } } }, at = Engine.viewOf(fired), levels = [];
    const design = { sinks: [], start: () => ({ hunt() {}, visit: (main, now, options) => Today.visit(main, at, options), nextArrival: () => null,
        firing: () => ({ id: 1463, perHour: 20 }), kills: () => ({ shots: 1, bare: 1, blessed: 1 }), event() {}, hour: () => 0,
        levelUp: (main, now) => { levels.push([Math.round(now * 1e6) / 1e6, main.level, Math.round(main.exp * 1e6) / 1e6]); return main; },
        finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
    Engine.simulate({ view: at, accounts: [{ ...accounts[0], shots: { 1463: 40 } }], bands, rates: silent, hours: 11, seed: 7, plane: design });
    assert.deepEqual(levels, [[2, 2, 100], [10, 3, 300]], 'each level read once, at the hour its hunted exp reaches it, with that exp');
}

// A worn two-handed weapon is carried in the slot it is worn in: a fresh orc
// fighter's Training Gloves (slot 14), where its line's level kit names a
// one-handed weapon (slot 7) it does not hold, are worn in 14 and read there
// by the kit factors (kitInHand); while the kit holds a weapon of its own the
// worn one does not take a second hand.
{
    const KitHours = require('../scripts/economy-model/kit-hours');
    const gloved = { ...snapshot, items: { ...snapshot.items, 2368: { kind: 'Weapon.DualFist', grade: 'NONE', ref: 138, npcBuy: 69 } }, gearLadder: { slots: {} } };
    const orc = Engine.mainOf({ ...accounts[0], held: [2368], worn: { 14: 2368 } }, 0, Engine.viewOf(gloved), bands);
    assert.deepEqual([orc.kit, orc.weapon], [{ 7: 0, 14: 2368 }, 2368], 'the gloves are worn in slot 14 and are the weapon in hand');
    assert.deepEqual(KitHours.kitInHand(gloved, orc), { 7: 0, 14: 2368 }, 'the kit factors read the gloves in slot 14');
    const armed = Engine.mainOf({ ...accounts[0], held: [100, 2368], worn: { 14: 2368 } }, 0, Engine.viewOf(gloved), bands);
    assert.deepEqual([armed.kit, armed.weapon], [{ 7: 100 }, 100], 'the kit\'s own weapon keeps the hands');
}

// The hunt rule is pure: the main it is given is left as it was.
const main = Engine.mainOf(accounts[0], 0, Engine.viewOf(snapshot), bands);
const frozen = JSON.stringify(main);
Engine.hunt(main, Engine.viewOf(snapshot), 2, () => 0.5);
assert.equal(JSON.stringify(main), frozen);

// No failure passes unseen: an arrival answer at or before now is dropped and
// counted, a main below the max level that can never level is counted once,
// an event of an unknown kind throws naming its kind.
const late = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, nextArrival: (main, state) => state.now });
assert.equal(late.counters.arrivalNotAhead, 2, 'the start and the level-up at 2 h each answered now');
assert.equal(late.counters.visits, 0, 'a dropped answer sends nobody');
for (const bad of [undefined, NaN, Infinity, { at: undefined, read: true }]) {
    assert.throws(() => plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, nextArrival: () => bad }),
        new RegExp(`arrival rule answered ${typeof bad === 'object' ? '\\{' : String(bad)}.* for main 1 at 0 h \\(start\\)`), `an answer of ${JSON.stringify(bad) ?? 'undefined'} throws naming the main`);
}
const idle = plainRun({ view: Engine.viewOf(snapshot), accounts, bands, rates: { default: { huntShare: 0, visitsPerBotHour: 0 } }, hours: 3, seed: 7, nextArrival: () => null });
assert.equal(idle.counters.unlevelableMains, 1, 'the hunting main with no hunting share never levels; the station is not a hunting main');
assert.equal(run(3, 40).counters.unlevelableMains, 0, 'a main that levels is not counted');
const today = planeWith(Engine.viewOf(snapshot), () => null), bogus = { ...today, start: context => { context.push({ at: 0.5, kind: 'bogus', who: 0 }); return today.start(context); } };
assert.throws(() => Engine.simulate({ view: Engine.viewOf(snapshot), accounts, bands, rates, hours: 3, seed: 7, plane: bogus }), /unknown kind: bogus/);

// A plane with deaths: a main dies over its hunting hours at its row's deaths per hour, loses the death exp
// of its level (levels down past the level's start), runs the visit at the death hour (died: true), does not
// hunt the way back and never dies after it has left for town; a plane without deaths rolls none.
{
    const dyingAt = rate => ({ ...snapshot, deathExp: [10, 50, 120, 200], hours: Object.fromEntries(Object.entries(snapshot.hours).map(([line, levels]) => [line,
        Object.fromEntries(Object.entries(levels).map(([level, row]) => [level, { ...row, best: { ...row.best, deaths: rate } }]))])) });
    const dying = dyingAt(0.5);
    const deadPlane = (rule, { afterHours = 0, deaths = true, snap = dying, deathFactor = null } = {}) => {
        const seen = { visits: [], spotHours: 0, levels: [], huntExp: 0, huntLevel: 0 };
        const plane = { sinks: [], deaths, start: () => ({
            ...(deathFactor ? { deathFactor } : {}),
            hunt: (main, delta) => { seen.spotHours += delta.spotHours; seen.huntExp = main.exp; seen.huntLevel = main.level; },
            visit: (main, now, options) => { seen.visits.push({ now, died: options.died === true, exp: main.exp, level: main.level, huntExp: seen.huntExp, huntLevel: seen.huntLevel }); return { ...Today.visit(main, Engine.viewOf(snap), options), afterHours }; },
            nextArrival: rule, firing: () => ({ id: 1463, perHour: 20 }), kills: () => null,
            levelUp: (main, now) => { seen.levels.push([now, main.level]); return main; }, event() {}, hour: () => 0, finish: () => ({ money: { start: 0, end: 0 }, design: {} }) }) };
        return { plane, seen };
    };
    const go = (plane, hours, { seed = 3, share = 1, snap = dying } = {}) => Engine.simulate({ view: Engine.viewOf(snap), accounts: [accounts[0]], bands, rates: { default: { huntShare: share, visitsPerBotHour: 1 } }, hours, seed, plane });
    // (a) the rate: 0.5 deaths per hunting hour over 200 h, 3 sigma of the expected; at a hunting share of 0.5
    // the main hunts half the hours, so half the deaths.
    for (const share of [1, 0.5]) {
        const a = deadPlane(() => null, { afterHours: 0.25 });
        const out = go(a.plane, 200, { share });
        assert.equal(out.counters.deaths, a.seen.visits.length, 'every death is one visit');
        const huntingHours = 200 - 0.25 * a.seen.visits.length, expected = 0.5 * share * huntingHours;
        assert.ok(Math.abs(out.counters.deaths - expected) <= 3 * Math.sqrt(expected), `share ${share}: deaths ${out.counters.deaths} within 3 sigma of ${expected}`);
        assert.ok(Math.abs(a.seen.spotHours - huntingHours) < 1e-6, 'the hours back (afterHours) are not hunted');
        if (share !== 1) continue;
        // (b) each died visit: the exp hunted to the hour less the death exp of the level it died at; the level
        // read from that exp (down past a level's start); the exp lost is counted.
        assert.ok(a.seen.visits.every(visit => visit.died), 'a visit at a death is called with died: true');
        for (const visit of a.seen.visits) assert.equal(visit.exp, visit.huntExp - Math.min(visit.huntExp, dying.deathExp[visit.huntLevel - 1]), `the loss at ${visit.now} h is the death exp of level ${visit.huntLevel}`);
        assert.ok(a.seen.visits.some(visit => visit.level < visit.huntLevel), 'a death that crosses a level start levels the main down');
        assert.ok(out.counters.deathExpLost > 0 && a.seen.levels.some(([, level]) => level < 4), 'the exp lost is counted and the level read goes down');
    }
    // (c) no death between departs and arrival: it leaves at 8, arrives at 10; at 5 deaths an hour one would
    // fall in [8, 10] with certainty if drawn, so none is.
    const fast = dyingAt(5);
    const c = deadPlane((main, ev) => (ev.now < 8 ? { at: 10, away: 2 } : null), { snap: fast });
    go(c.plane, 10, { snap: fast });
    assert.ok(c.seen.visits.filter(visit => visit.died).length > 10, 'it dies while hunting');
    assert.ok(c.seen.visits.filter(visit => visit.now > 8).every(visit => !visit.died), 'no death after it has left for town');
    assert.ok(c.seen.visits.some(visit => visit.now === 10 && !visit.died), 'it arrives at 10');
    // (c2) a deathFactor of 2 doubles the deaths of the same long run: 0.5 per hour x 2 over 200 h, 3 sigma of 200.
    const doubled = deadPlane(() => null, { deathFactor: () => 2 });
    const doubledOut = go(doubled.plane, 200);
    assert.ok(Math.abs(doubledOut.counters.deaths - 200) <= 3 * Math.sqrt(200), `factor 2: deaths ${doubledOut.counters.deaths} within 3 sigma of 200`);
    assert.ok(doubledOut.counters.deaths > go(deadPlane(() => null).plane, 200).counters.deaths * 1.5, 'factor 2 has clearly more deaths than factor 1');
    // (c3) shots that run out inside the run: it dies at the fired form's rate (none) while they last, then at the bare rate.
    // 20 shots at 20 an hour last 1 h; the row's own deaths are 0 and its bare hour's 5 an hour.
    const crossing = { ...snapshot, deathExp: [10, 50, 120, 200], hours: { 9: Object.fromEntries(Object.entries(snapshot.hours[9]).map(([level, row]) => [level, { ...row, best: { ...row.best, deaths: 0, shotless: { deaths: 5 } } }])) } };
    const crossed = deadPlane(() => null, { snap: crossing });
    Engine.simulate({ view: Engine.viewOf(crossing), accounts: [{ ...accounts[0], shots: { 1463: 20 } }], bands, rates: { default: { huntShare: 1, visitsPerBotHour: 1 } }, hours: 10, seed: 3, plane: crossed.plane });
    const diedAt = crossed.seen.visits.filter(visit => visit.died).map(visit => visit.now);
    assert.ok(diedAt.length > 0, 'once its shots are out it dies at the bare form\'s deaths');
    assert.ok(diedAt[0] >= 1, `it does not die while its shots last (first death at ${diedAt[0]} h)`);
    // (d) a plane without deaths rolls none.
    const d = deadPlane(() => null, { deaths: false });
    assert.equal(go(d.plane, 50).counters.deaths, 0);
    assert.deepEqual(d.seen.visits, []);
    assert.throws(() => Engine.simulate({ view: Engine.viewOf(snapshot), accounts: [accounts[0]], bands, rates, hours: 3, seed: 1, plane: deadPlane(() => null).plane }), /deathExp/);
}

// A situation read commits the hunt to its hour: the plane answering it sees the adena and the exp hunted
// in the hours before it (row: 100 adena and 50 exp an hour, read at 1.5 h).
{
    const seen = [];
    const view = Engine.viewOf(snapshot), today = Today.plane({ view, hunter: Today.hunter(view) });
    const plane = { ...today, start: context => ({ ...today.start(context), nextArrival: (main, ev) => {
        if (ev.event === 'start') return { at: 1.5, read: true };
        if (ev.event !== 'situation') return ev.pending === null ? null : { at: ev.pending, read: true };
        seen.push({ event: ev.event, now: ev.now, money: main.money, exp: main.exp });
        return null;
    } }) };
    Engine.simulate({ view, accounts: [accounts[0]], bands, rates: silent, hours: 3, seed: 7, plane });
    assert.equal(seen.length, 1, 'the situation is read once');
    assert.equal(seen[0].event, 'situation');
    assert.equal(seen[0].exp, 75, 'the read sees the 1.5 hours of exp hunted before it');
    assert.ok(seen[0].money > 10000, `and their adena: ${seen[0].money}`);
}

// A read schedules the main's level and death again on what it saw: a plane whose kit changes at its read (more
// kills, no deaths from then on, as after a better kit) has its level crossing earlier and its deaths gone.
{
    const ruleAt = readAt => (main, ev) => (ev.event === 'start' ? { at: readAt, read: true } : ev.event === 'situation' ? null : (ev.pending === null ? null : { at: ev.pending, read: true }));
    const planeOf = (extra, view, readAt) => {
        const today = Today.plane({ view, hunter: Today.hunter(view) });
        return { ...today, start: context => ({ ...today.start(context), nextArrival: ruleAt(readAt), ...extra }) };
    };
    // Level: 50 exp an hour, level 2 at exp 100; from the read it kills twice as many: 25 exp at the read, then
    // 75 at 100 an hour, so level 2 at 1.25 h (2 h if the old schedule were kept).
    const levels = [];
    const view = Engine.viewOf(snapshot);
    const faster = planeOf({ firing: () => null, kills: main => ({ bare: main.counter >= 1 ? 2 : 1, shots: 1, blessed: 1 }), levelUp: (main, now) => { levels.push([now, main.level]); return main; } }, view, 0.5);
    Engine.simulate({ view, accounts: [accounts[0]], bands, rates: silent, hours: 3, seed: 7, plane: faster });
    const two = levels.find(([, level]) => level === 2);
    assert.ok(two && Math.abs(two[0] - 1.25) < 1e-6, `the level is scheduled again at the read: level 2 at ${two && two[0]} h, not 2`);
    // Deaths: 0.5 an hour for the first draw only; from the read the factor is 0, so a death pending from the
    // start (drawn at the start) is void: none in 200 h.
    const dying = { ...snapshot, deathExp: [10, 50, 120, 200], hours: Object.fromEntries(Object.entries(snapshot.hours).map(([line, lv]) => [line,
        Object.fromEntries(Object.entries(lv).map(([level, row]) => [level, { ...row, best: { ...row.best, deaths: 0.5 } }]))])) };
    const dview = Engine.viewOf(dying);
    const safe = planeOf({ deathFactor: main => (main.counter >= 1 ? 0 : 1) }, dview, 0.01);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
        const out = Engine.simulate({ view: dview, accounts: [accounts[0]], bands, rates: silent, hours: 200, seed, plane: { ...safe, deaths: true } });
        assert.equal(out.counters.deaths, 0, `seed ${seed}: the death schedule is redrawn at the read (factor 0): no death`);
    }
}

// A born plane: each main's one visit at hour 0 (born: true) with its sales in the ledger; it hunts after the
// visit's way back (afterHours 1.5), not before.
{
    const seen = { visits: [], spotHours: 0 };
    const view = Engine.viewOf(snapshot), today = Today.plane({ view, hunter: Today.hunter(view) });
    const plane = { ...today, born: true, start: context => {
        const hooks = today.start(context);
        return { ...hooks, nextArrival: () => null,
            hunt: (main, delta) => { seen.spotHours += delta.spotHours; },
            visit: (main, now, options) => { seen.visits.push({ now, born: options.born === true, outingHours: options.outingHours }); const out = hooks.visit(main, now, options); return { ...out, afterHours: 1.5 }; } };
    } };
    const stocked = [{ ...accounts[0], held: [100], shots: { 1463: 100 } }];
    const out = Engine.simulate({ view, accounts: [...stocked, accounts[1]], bands, rates: silent, hours: 3, seed: 7, plane });
    assert.deepEqual(seen.visits, [{ now: 0, born: true, outingHours: 0 }], 'one born visit at hour 0 for the main, none for the station');
    assert.equal(seen.spotHours, 1.5, 'it hunts the 1.5 hours after the way back');
    const without = Engine.simulate({ view, accounts: stocked, bands, rates: silent, hours: 3, seed: 7, plane: { ...plane, born: false } });
    assert.equal(out.flows.totals.npcSales, 500, 'the born visit sold the 100 shots of a grade it does not fire (5 adena each): its sale is in the ledger');
    assert.equal(without.flows.totals.npcSales, 0, 'a plane without born has no such sale');
    assert.ok(out.flows.totals.huntCold < 300, `the 1.5 hunted hours only: ${out.flows.totals.huntCold}`);
}

// A main without shots at a row where its line kills nothing bare (the snapshot's zero shotless hour) gains
// nothing: no exp, no adena (it stood), where the shots hour would credit it.
{
    const zero = { kills: 0, exp: 0, adena: 0, dropLoot: 0, spoilLoot: 0, loot: 0 };
    const row = { ...hour(100, 50, 20).best, shotless: zero }, line = { ...hour(100, 50, 20), best: row };
    const dry = { ...snapshot, hours: { 9: { 1: line, 2: line, 3: line, 4: line } } }, at = Engine.viewOf(dry);
    const out = Engine.simulate({ view: at, accounts: [accounts[0]], bands, rates: silent, hours: 2, seed: 7, plane: planeWith(at, () => null) });
    assert.equal(out.flows.totals.huntCold, 0, 'no adena without shots where the line kills nothing bare');
    assert.equal(out.progress.stageBands.low.expPerBotHour, 0, 'and no exp');
    assert.equal(out.counters.unlevelableMains, 1, 'the main that gains no exp there is counted once as unlevelable (physically right: it gains nothing bare)');
}

console.log('economy model engine: ok');

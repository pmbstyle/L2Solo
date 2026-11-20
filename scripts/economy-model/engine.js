'use strict';

// The economy model's engine: one main per account, driven by a seeded queue
// of the named situations, over the game-data snapshot (inputs.js) alone: no
// server module, no World, no database, no clock.
//
// Between two situations a main hunts analytically at its spot: the spot a
// cohort account starts at (Cohort.savedBots: its own, else its travel's, else
// its stay's) while the snapshot has that spot's hour for its line and level
// (spotHours), else its line's best spot for its level. It earns the hour
// (a party member's exp: its party share, huntExp) times the hunting hours
// (wall hours times its stage band's hunting share). Items with a mean count under 5 are drawn whole (Poisson), larger
// counts round by a draw on the fraction, so rare recipes and gear arrive as
// pieces. Situations:
//   level_up      the exp of the next level is reached (from exp per hour);
//                 the kit plan and shot grade follow the new level, and a
//                 main whose spot has no hour at it moves to its line's best.
//   arrived_town  the main is in town: the run's plane runs the visit (today's:
//                 sells its bag, restocks shots, buys the kit pieces its plan
//                 names). When it comes is the plane's nextArrival(main, view)
//                 alone: asked at the start and after
//                 each committed event that changes the main (a visit, a
//                 level-up), its answer is the one pending arrival (replaced,
//                 or dropped by null): today's and the plain mode's plane
//                 answer by the fitted periodic rule.
//                 A bot is in one state at a time: an answer { at, away }
//                 leaves the spot at at - away (the hunt stops there and the
//                 way to town is not hunted), and an arrival it has
//                 left for is held: no later event asks the rule again for
//                 it. A visit's afterHours (its onward stops and its way back
//                 to the spot) are not hunted either.
//   died          a plane with deaths (plane.deaths === true; needs the snapshot's deathExp): the main dies
//                 over its hunting hours at its row's deaths per hour, loses the death exp of its level
//                 (levels down when it crosses the level's start), and the plane's visit runs at once as
//                 in the respawn town, called with died: true and town: the town of the row it died at; the way
//                 back is the visit's afterHours.
//                 It never dies after it has left for town.
//   born          a plane with born: true: each main's one visit at hour 0 (called with born: true), before any
//                 hunting; its way back is the visit's afterHours.
//   situation     a situation the arrival rule names to be read at its hour
//                 without going to town (its answer { at, read: true }, held
//                 in the same pending slot): the main's hunt is committed to
//                 that hour, then the rule is asked again.
//   report        every simulated hour: counters only, never a decision.
// Every mode hunts one way: a main fires the shots its plane names (firing)
// while it holds them, then hunts the hour without shots, at the worn kit's
// kill factor (kills), at the spot its occupation or save chose. The run's
// plane (today.js plane() for today's and the plain mode) owns what differs
// between the modes: its sinks, the visit, the arrival rule, what a main
// fires, its own events and the money it holds apart from the mains.
//
// hunt and visit are pure: they take a main and the view and return the new
// main with the flows it caused; the engine commits both. Rolls are seeded per
// (run seed, account id, the account's situation counter).
const { hash, mulberry } = require('../hunt-tables/common');
const PartyRewardMath = require('../../src/GameServer/Actor/PartyRewardMath');
const BeginnerShots = require('../../src/GameServer/Items/C4BeginnerShots');
const OfferOrder = require('../../src/GameServer/Bot/Economy/OfferOrder');
const Ledger = require('./ledger');
const { npcBuyValue } = require('./rules/hunt-rows');

const ADENA = 57;
// Counts drawn whole below this mean, rounded by a draw above it.
const WHOLE_DRAW_MEAN = 5;

// The Blessed Spiritshots' place in the snapshot's shot families (soulshot,
// spiritshot, blessed spiritshot).
const BLESSED_FAMILY = 2;
// The game's kinds of the snapshot's shot families, in their order.
const FAMILY_KINDS = Object.freeze(['soulshot', 'spiritshot', 'blessedSpiritshot']);

// The paperdoll's hand slots: a one-handed weapon's and a two-handed one's.
const HAND_SLOTS = Object.freeze([7, 14]);

const isGear = item => /^(Weapon|Armor)/.test(item?.kind || '');
const isWeapon = item => /^Weapon/.test(item?.kind || '');

// The snapshot read once into what the rules look up. options.market:
// { buy: { town: { item: price } }, sell: { town: { item: price } } }, the
// fixed stores a mode adds (none by default). options.npcPrices: 'preset' (the
// game's NPC prices at the snapshot's rate) or 'x1'. options.yields: 'design'
// hunts the per-kill yields at the design's rates (the snapshot's yieldsDesign), else the
// snapshot's (today's rates): huntYields, the one table a hunt reads.
function viewOf(snapshot, options = {}) {
    const npcTable = snapshot.npcOffers[options.npcPrices || 'preset'];
    const market = { buy: options.market?.buy || {}, sell: options.market?.sell || {} };
    // item -> [{ town, price, channel }] cheapest first: the NPC shops and the fixed sell lines.
    const offers = new Map();
    const offer = (id, row) => { if (!offers.has(id)) offers.set(id, []); offers.get(id).push(row); };
    for (const [id, rows] of Object.entries(npcTable || {})) for (const row of rows) offer(Number(id), { town: row.town, price: row.price, channel: 'npc_buy' });
    for (const [town, lines] of Object.entries(market.sell)) for (const [id, price] of Object.entries(lines)) offer(Number(id), { town, price, channel: 'fixed_wts' });
    for (const rows of offers.values()) rows.sort((a, b) => a.price - b.price);
    const recipeGrade = {};
    for (const row of snapshot.recipes || []) recipeGrade[row.recipeItemId] = String(snapshot.items[row.productId]?.grade || 'NONE').toLowerCase();
    return {
        hours: snapshot.hours, kits: snapshot.kits, yields: snapshot.yields, items: snapshot.items, exp: snapshot.exp,
        maxLevel: Math.min(snapshot.header.levels[1], snapshot.exp.length), fares: snapshot.fares || {},
        shotFamilies: snapshot.shotFamilies || null, offers, market, recipeGrade, yieldRows: new Map(), rowItems: new Map(),
        tripHours: snapshot.tripHours || null, deathExp: snapshot.deathExp || null, bags: snapshot.bags || null,
        spotHours: snapshot.spotHours?.rows || null, spotLevels: snapshot.spotLevels || null, spotAvgLevel: snapshot.spotAvgLevel || null,
        huntYields: (options.yields === 'design' ? snapshot.yieldsDesign : snapshot.yields) || null,
        blessedShots: new Set(snapshot.shotFamilies?.ids?.[BLESSED_FAMILY] || [])
    };
}

// The exp at which a level starts (the table's index 0 is level 1).
const expAt = (view, level) => view.exp[level - 1];
// The level an exp reaches; rounding: the share of a level's exp it may fall
// short by and still reach it (LEVEL_ROUNDING at the level's read, none in a hunt).
function levelOf(view, exp, from = 1, rounding = 0) {
    let level = from;
    while (level < view.maxLevel && expAt(view, level + 1) - exp <= rounding * expAt(view, level + 1)) level++;
    return level;
}
// The level's read is scheduled at the hour the hunt's credit reaches the level's exp, but that credit
// is a float sum that can land a few ulps under it at that hour. 1e-9 of the level's exp is far above
// that rounding and at most a few exp at the table's highest levels.
const LEVEL_ROUNDING = 1e-9;

function bandOf(bands, level) {
    let name = bands[0][0];
    for (const [band, from] of bands) if (level >= from) name = band;
    return name;
}

const hourOf = (view, main) => view.hours[main.line]?.[main.level] || null;
// The row of a spot a main may hold at a level: the spot's own hour (inputs.js --spots) when the snapshot has it,
// else the line's best or bare best, else its top, bare top or other row of that spot at the level.
const rowAt = (hour, id) => (hour && String(hour.best?.spotId) === String(id) ? hour.best : hour && String(hour.bareBest?.spotId) === String(id) ? hour.bareBest
    : hour?.top?.find(row => String(row.spotId) === String(id)) || hour?.bareTop?.find(row => String(row.spotId) === String(id))
    || hour?.others?.find(row => String(row.spotId) === String(id)) || null);
const ownRow = (view, line, level, spot) => (spot ? view.spotHours?.[line]?.[level]?.[spot] || rowAt(view.hours[line]?.[level], spot) : null);
// The town of a spot row at a level (its spot card's), null without one.
const townOfRow = (view, row, level) => (row ? view.yields[`${row.spotId}@${level}`]?.town || null : null);

// The spot row a main hunts: the spot its occupation chose (a
// plane's, among its line's top spots at its level or the other rows it may
// hold there), else its own spot's hour, else its line's best.
function spotRowOf(view, main) {
    const hour = main.occupied ? hourOf(view, main) : null, chosen = row => String(row.spotId) === main.occupied;
    const occupied = hour ? hour.top?.find(chosen) || hour.others?.find(chosen) || null : null;
    return occupied || ownRow(view, main.line, main.level, main.spot) || hourOf(view, main)?.best || null;
}

// The exp a main gains hunting a spot row for hours, in both modes: the row's,
// or in a party its share by the game's party reward rule. The game composes
// that reward in BackgroundPartyResolver.distributeRewards: a party of n kills
// n solo bots' kills, their exp is split by PartyRewardMath.sharesForLevels
// (the C4 bonus for n members, then the squared-level split), the adena is the
// total divided by n and each kill's drops go to one member. Here: the main's
// row exp times n through the same split; adena and drops stay a solo bot's
// per kill, which is what that division gives each member on average.
// Our reading: the party and the other members' levels are the save's and are
// held for the whole run (the game leaves a party on party_left and
// party_outleveled). A member under the squared-level cut therefore gets no
// exp for the run (the share the game gives it while it is a member), where
// the game would have it leave and hunt solo; the late save has none.
function huntExp(main, row, hours) {
    const exp = row.exp * hours, party = main.party;
    if (!party) return exp;
    const levels = party.levels.map((level, at) => (at === party.self ? main.level : level));
    return PartyRewardMath.sharesForLevels(levels, exp * levels.length).find(share => share.index === party.self)?.exp || 0;
}

// The shot a main fires: the hour's kind of shot at the grade of the weapon
// in its hand (C4: a weapon fires only the shots of its grade); none without
// a weapon. The held weapon is the one grade source: a weapon the snapshot
// does not grade is a model bug (every NPC weapon is in the snapshot's
// items). A snapshot without shot grades fires the hour's shot as named.
function shotOf(view, main, hour) {
    const family = view.shotFamilies?.ids.find(ids => ids.includes(hour.shotId));
    if (!family) return hour.shotId;
    if (!main.weapon) return 0;
    const at = view.shotFamilies.grades.indexOf(view.items[main.weapon]?.grade);
    if (at < 0) throw new Error(`weapon ${main.weapon} has no shot grade in the snapshot`);
    return family[at];
}

// The beginner shot that charges a shot's skill, 0 for none: the game's rule
// (C4BeginnerShots.selfIdFor of the shot's kind and grade: Soulshots for
// Beginners charge the no-grade Soulshot, Spiritshots for Beginners the
// no-grade Spiritshot; no graded or blessed shot).
function beginnerOf(view, shotId) {
    const at = view.shotFamilies?.ids.findIndex(ids => ids.includes(Number(shotId))) ?? -1;
    if (at < 0) return 0;
    const grade = view.shotFamilies.grades[view.shotFamilies.ids[at].indexOf(Number(shotId))];
    return BeginnerShots.selfIdFor(FAMILY_KINDS[at], String(grade).toLowerCase()) || 0;
}

// The shots a firing ({ id, beginner }) can spend: the beginner shots that
// charge its skill (beginnerOf) and the shot itself.
const heldOf = (main, firing) => (main.shots[firing.id] || 0) + (firing.beginner ? main.shots[firing.beginner] || 0 : 0);

// The form of its spot row a main hunts firing a shot (0: none): 'bare' the
// row's hour without shots, 'blessed' its hour firing Blessed Spiritshots,
// 'shots' the row itself (its plain shot: a soulshot or a Spiritshot).
function formOf(view, shotId) {
    return !shotId ? 'bare' : view.blessedShots.has(Number(shotId)) ? 'blessed' : 'shots';
}

// A spot row's hour in a form (formOf): the row with the form's fields over
// it, the row itself where it has no such hour (a row without a shotless
// field, as a hand-built row: the snapshot always writes one, the zero hour
// where the line kills nothing bare; no blessed hour: the spot table
// measured no such fight there, where a main fires its plain shot and the
// plane's firing offers no Blessed Spiritshots).
function rowIn(row, form) {
    const over = form === 'bare' ? row?.shotless : form === 'blessed' ? row?.blessed : null;
    return over ? { ...row, ...over } : row;
}

// The kill-mix correction of a spot row: { drop, spoil }. The snapshot's
// per-kill yields are one row per spot and level, at the spot's spawn mix and
// the highest Spoil level of any line there; the row's loot is at the species
// its line kills (the spot table's kill mix, which the snapshot does not
// carry) and its line's own Spoil. Drop items scale by the row's drop loot
// over the spawn mix's drop value at the NPC's price, spoil items by its spoil
// loot over the spoil value (0 for a line without Spoil); 1 where the spawn
// mix is worth nothing. One factor per kind: one factor for both would hand a
// line without Spoil the spoiler's materials and shrink its gear drops.
function killMixCorrection(view, row, level) {
    const yields = row && view.yields[`${row.spotId}@${level}`];
    const valueOf = table => npcBuyValue(table, view.items) * (row?.kills || 0);
    const drop = valueOf(yields?.drop), spoil = valueOf(yields?.spoil);
    return { drop: drop > 0 ? row.dropLoot / drop : 1, spoil: spoil > 0 ? row.spoilLoot / spoil : 1 };
}

// [[item, per kill]] of a spot row's hour in a form (row: rowIn's of that
// form) at a level, at the hunt's yields (huntYields), adena apart (the row's
// own adena), at that hour's kill-mix correction. One list per line, level,
// spot and form.
function yieldRows(view, line, level, row, form) {
    const key = `${line}@${level}@${row.spotId}@${form}`;
    if (view.yieldRows.has(key)) return view.yieldRows.get(key);
    const yields = view.huntYields?.[`${row.spotId}@${level}`], factor = killMixCorrection(view, row, level), rows = [];
    for (const kind of yields ? ['drop', 'spoil'] : []) {
        for (const [id, perKill] of Object.entries(yields[kind])) if (Number(id) !== ADENA) rows.push([Number(id), perKill * factor[kind]]);
    }
    view.yieldRows.set(key, rows);
    return rows;
}

// A spot row's items per hunting hour at the hunt's yields in a form
// (formOf: without shots, its plain shot, Blessed Spiritshots):
// { items: [{ id, rate, weight, stack }], adena, loot: the items at the NPC's buy price, npc: adena + loot }.
// One per line, level, spot and form.
function rowItems(view, main, row, form) {
    const key = `${main.line}@${main.level}@${row.spotId}@${form}`;
    if (view.rowItems.has(key)) return view.rowItems.get(key);
    const hour = rowIn(row, form);
    const items = yieldRows(view, main.line, main.level, hour, form).map(([id, perKill]) => ({ id, rate: perKill * hour.kills,
        weight: view.items[id]?.weight || 0, stack: !isGear(view.items[id]) }));
    const adena = hour.adena * adenaFactor(view, row, main.level);
    const loot = items.reduce((sum, item) => sum + item.rate * (view.items[item.id]?.npcBuy || 0), 0);
    const out = { items, adena, loot, npc: adena + loot };
    view.rowItems.set(key, out);
    return out;
}

// The game's trip hours (the snapshot's tripHours, built for every spot and
// town): into the spot's town (toHoursOf), back from a town to the spot
// (backHoursOf). A missing one throws.
function tripLeg(hours, what) {
    if (typeof hours !== 'number') throw new Error(`no trip hours for ${what}`);
    return hours;
}
const toHoursOf = (view, spotId) => tripLeg(view.tripHours.to[spotId], `spot ${spotId}`);
const backHoursOf = (view, spotId, town) => tripLeg(view.tripHours.back[spotId]?.[town], `spot ${spotId} from ${town}`);

function poisson(mean, random) {
    const limit = Math.exp(-mean);
    let count = 0, product = random();
    while (product > limit) { count++; product *= random(); }
    return count;
}

function wholeCount(mean, random) {
    if (!(mean > 0)) return 0;
    if (mean < WHOLE_DRAW_MEAN) return poisson(mean, random);
    const whole = Math.floor(mean);
    return whole + (random() < mean - whole ? 1 : 0);
}

const emptyFlows = () => ({ huntCold: 0, npcSales: 0, fixedBuyers: 0, npcBuys: 0, fixedSellers: 0, fares: 0 });

// The hunt's adena per kill over today's at a spot row's spawn mix (1 where
// today's yields carry no adena; exactly 1 where the hunt reads today's).
function adenaFactor(view, row, level) {
    const key = `${row.spotId}@${level}`, today = view.yields[key]?.drop?.[ADENA] || 0, hunted = view.huntYields?.[key]?.drop?.[ADENA] || 0;
    return today > 0 ? hunted / today : 1;
}

// Hunting for huntHours at the main's spot: adena, exp and items into the
// bag (huntYields: today's or the design's rates) at the kills and kill mix
// of the spot row's hour of the kind it fires (formOf: its plain shot the
// row, Blessed Spiritshots the row's blessed hour); the shots the main fires
// (firing: { id, perHour, beginner }, the run's hunter's answer, perHour that hour's
// shots at its weapon's count: shotsPerHour; null fires none) last shots
// held / shots per hour, and past them, or firing none, it hunts at the same
// spot's hour without shots (fewer kills, less exp and loot) until it
// restocks; the shots it missed are counted. The row is the reference kit's
// hour: the main hunts its worn kit's, the row's adena, exp and loot times
// the worn kit's kills over the reference kit's in the form hunted (kills:
// { bare, shots, blessed }, the hunter's; null reads 1), and firing's
// perHour is already its worn kit's. Spoil loot a hunted hour has but the
// hunt's yields carry no spoil for is lost, so its kills are counted
// (spoilUnyielded).
// The shot a hunt fires and the hunting hours its held stock lasts
// (held over the shots an hour, the beginner shots that charge it counted:
// heldOf; then it hunts bare), and the form of its row it fires in (formOf).
function firedOf(view, main, firing) {
    const shotId = firing?.id || 0, held = shotId ? heldOf(main, firing) : 0, perHour = shotId ? firing.perHour || 0 : 0;
    return { shotId, held, perHour, lasts: perHour > 0 ? held / perHour : 0, form: formOf(view, shotId) };
}

// The exp a form of a spot row credits for its hunting hours, at the worn
// kit's kills in that form (kills: per form over the reference kit's; none: 1).
const formExp = (main, best, form, hours, kills) => huntExp(main, rowIn(best, form), hours * (kills?.[form] ?? 1));

// The shots a form of a spot row fires an hour: the row's count in that form
// (rowIn) times the worn weapon's count per action over the reference's
// (scale) and the worn kit's shots over the reference kit's (factor: the
// form's { kills, shots }; none: 1).
const shotsPerHour = (row, form, scale = 1, factor = null) => (rowIn(row, form)?.shots || 0) * scale * (factor?.shots ?? 1);

// full: the main's bag is at the game's unload floor (SurvivalFloor.evaluate:
// the slot limit or the first weight penalty), so the hunt takes no item
// (exp and adena stay) and counts the drop it would have taken at the NPC's
// buy price (lostDrop). Our choice, the form the design's value prices (the
// full-bag hour is the same hour with no loot): a C4 player keeps picking up
// below the slot limit's held stacks and below the weight limit
// (PickupCapacity.check), past 50 % load at a speed and regen penalty. Cost:
// none per step; it gives up the drop between the floor and the capacity and
// the penalty.
function hunt(main, view, huntHours, random, firing = null, kills = null, full = false) {
    const best = spotRowOf(view, main), flows = emptyFlows();
    const delta = { flows, exp: 0, drops: [], lostDrop: 0, shotsUsed: 0, shotsWanted: 0, noSpot: 0, huntHours: 0, ownSpot: false, spoilUnyielded: 0, shotId: 0, huntBare: 0 };
    if (!best || !(huntHours > 0)) { delta.noSpot = best ? 0 : 1; return { main, delta }; }
    delta.huntHours = huntHours;
    delta.ownSpot = best === ownRow(view, main.line, main.level, main.spot);
    const { shotId, held, perHour, lasts, form } = firedOf(view, main, firing);
    const shotHours = perHour > 0 ? Math.min(huntHours, lasts) : 0;
    const adenaRatio = adenaFactor(view, best, main.level);
    const bag = { ...main.bag }, counts = new Map();
    for (const [at, hours] of [[form, shotHours], ['bare', huntHours - shotHours]]) {
        if (!(hours > 0)) continue;
        const row = rowIn(best, at), worn = hours * (kills?.[at] ?? 1);
        flows.huntCold += row.adena * adenaRatio * worn;
        if (row.spoilLoot > 0 && !Object.keys(view.huntYields?.[`${best.spotId}@${main.level}`]?.spoil || {}).length) delta.spoilUnyielded += row.kills * worn;
        delta.exp += formExp(main, best, at, hours, kills);
        for (const [id, perKill] of yieldRows(view, main.line, main.level, row, at)) {
            const mean = perKill * row.kills * worn;
            if (full) delta.lostDrop += mean * (view.items[id]?.npcBuy || 0);
            else counts.set(id, (counts.get(id) || 0) + mean);
        }
    }
    flows.huntCold = Math.round(flows.huntCold);
    for (const [id, mean] of counts) {
        const count = wholeCount(mean, random);
        if (!count) continue;
        bag[id] = (bag[id] || 0) + count;
        delta.drops.push([id, count]);
    }
    delta.shotsWanted = Math.round(perHour * huntHours);
    delta.shotsUsed = Math.min(held, delta.shotsWanted);
    delta.huntBare = huntHours - shotHours;
    // The beginner shots that charge its skill fire first, then the shot itself
    // (the game's combatPlanForState); the shot it fires next is the beginner
    // while some are left, else its own.
    const beginnerHeld = firing?.beginner ? main.shots[firing.beginner] || 0 : 0, fromBeginner = Math.min(beginnerHeld, delta.shotsUsed);
    let shots = main.shots;
    if (delta.shotsUsed) {
        shots = { ...main.shots };
        if (fromBeginner) shots[firing.beginner] = beginnerHeld - fromBeginner;
        if (delta.shotsUsed > fromBeginner) shots[shotId] = (main.shots[shotId] || 0) - (delta.shotsUsed - fromBeginner);
    }
    delta.shotId = beginnerHeld > fromBeginner ? firing.beginner : shotId;
    const exp = main.exp + delta.exp;
    return { main: { ...main, exp, level: levelOf(view, exp, main.level), money: main.money + flows.huntCold, bag, shots }, delta };
}

// Where the main standing in `town` buys an item, as a human buys (our choice;
// travel time never counts): in its own town when that town sells it, the
// best of that town's offers (the NPC lists and the configured stores) in the
// game's one offer order (OfferOrder.best: the cheapest, at the same price a
// store before an NPC); else the first of the other towns' offers in that
// order with the gatekeeper fare to the offer's town as the trip cost (money
// only). With no town, no trip: the cheapest offer. Null when no town sells
// it or no route leads to one that does. { town, price, channel, fare }.
function sellerOf(view, id, town = null) {
    const rows = view.offers.get(Number(id));
    if (!rows) return null;
    const fareOf = at => (town === null || at === town ? 0 : view.fares[town]?.[at]);
    const reached = rows.filter(row => fareOf(row.town) !== null && fareOf(row.town) !== undefined);
    const here = town === null ? [] : reached.filter(row => row.town === town);
    const offers = (here.length ? here : reached).map(row => ({ ...row, sourceType: row.channel === 'npc_buy' ? 'npc' : 'store' }));
    const best = OfferOrder.best(offers, { cost: fareOf });
    return best ? { town: best.town, price: best.price, channel: best.channel, fare: fareOf(best.town) } : null;
}

// The one onward hop of a town visit (a gatekeeper teleport): to the seller
// (sellerOf) of the first of `ids` whose seller is in another town (its fare
// may be 0), when the wallet pays its fare and one unit; else null.
function hopSeller(view, ids, town, money) {
    for (const id of ids) {
        const seller = sellerOf(view, id, town);
        if (seller && seller.town !== town) return money >= seller.fare + seller.price ? seller : null;
    }
    return null;
}

// The hop's booking (a hopSeller answer, or a gear piece's seller): its fare
// paid from the wallet and booked, the town added to the visit's towns.
// Returns the adena left.
function hopTo(seller, money, delta) {
    delta.flows.fares -= seller.fare;
    delta.towns.push(seller.town);
    return money - seller.fare;
}

// The engine's opening state of an account record (cohort.js): its line's
// kit of the level, each piece it holds, and in each slot still empty the
// piece it wears there; a worn hand piece (HAND_SLOTS: a one-handed weapon in
// 7, a two-handed one in 14) takes its own slot while the kit holds none in
// hand, so the weapon in hand sits where it is worn.
function mainOf(account, index, view, bands) {
    const kit = {}, held = new Set(account.held || []), level = Math.min(account.level, view.maxLevel);
    for (const piece of view.kits[account.line]?.[level] || []) kit[piece.slot] = held.has(piece.selfId) ? piece.selfId : 0;
    const handHeld = HAND_SLOTS.some(slot => kit[slot]);
    for (const [slot, selfId] of Object.entries(account.worn || {})) {
        if (!kit[slot] && (kit[slot] !== undefined || (!handHeld && HAND_SLOTS.includes(Number(slot))))) kit[slot] = selfId;
    }
    // The weapon in hand: the plan's when held, else the one the account wears.
    const planned = Object.values(kit).find(selfId => selfId && isWeapon(view.items[selfId]));
    const weapon = planned || Object.values(account.worn || {}).find(selfId => isWeapon(view.items[selfId])) || 0;
    const station = !!account.station || !view.hours[account.line];
    const spot = ownRow(view, account.line, level, account.spot) ? account.spot : null;
    return { index, id: account.id, station, line: account.line, level, exp: account.exp, money: account.money, weapon, spot, party: account.party || null,
        bag: {}, shots: { ...(account.shots || {}) }, kit, band: station ? Ledger.STATION : bandOf(bands, level), since: 0, lastVisit: 0, counter: 0 };
}

// A min-heap of { at, seq, kind, who } by time, then by push order.
function heap() {
    const rows = [];
    const less = (a, b) => a.at < b.at || (a.at === b.at && a.seq < b.seq);
    let seq = 0;
    return {
        get size() { return rows.length; },
        push(event) {
            rows.push({ ...event, seq: seq++ });
            for (let i = rows.length - 1; i > 0;) {
                const parent = (i - 1) >> 1;
                if (!less(rows[i], rows[parent])) break;
                [rows[i], rows[parent]] = [rows[parent], rows[i]];
                i = parent;
            }
        },
        pop() {
            const top = rows[0], last = rows.pop();
            if (rows.length) {
                rows[0] = last;
                for (let i = 0; ;) {
                    const left = 2 * i + 1, right = left + 1;
                    let least = i;
                    if (left < rows.length && less(rows[left], rows[least])) least = left;
                    if (right < rows.length && less(rows[right], rows[least])) least = right;
                    if (least === i) break;
                    [rows[i], rows[least]] = [rows[least], rows[i]];
                    i = least;
                }
            }
            return top;
        }
    };
}

// A run: accounts (cohort.js), the view, the stage bands [[name, fromLevel]],
// per band { huntShare, ... } and the run's plane (today.js plane()):
// { sinks, start(context) }. sinks: the plane's own
// ledger sinks. start({ view, mains, ledger, push, seed, rateOf, rearrive,
// commit }) returns the hooks the run calls:
//   deathFactor(main)  optional: the multiplier of the row's deaths per hour for the kit the main wears (default 1)
//   nextArrival(main, view)  the time of the main's next arrival in town ({ at, away }: away, the hours of the way
//             lumped before the visit, not hunted), or { at, read: true } for a
//             situation to read at that hour without going (null: neither), asked on the main as it is
//             after the committed event. view is the plain data a trip rule may read:
//     event     'start' | 'visit' | 'level_up' | 'situation'  (a visit after a death is a 'visit' called with died: true)
//     now       the time of the event, hours
//     pending   the hour of the arrival or situation already scheduled (null after a visit or at the start)
//     rate      the main's band's rates
//     roll      a seeded number in [0, 1)
//     hour      the main's spot row: exp, adena, kills, shots, dropLoot, spoilLoot, loot, potions per hunting hour (null without one)
//     shotsPerHour  the row's shots per hunting hour; the main's own bag and shots are on main
//     huntShare the band's share of wall time spent hunting
//   firing(main), kills(main)  the shot a main fires as it hunts and its worn kit's kills (hunt's)
//   full(main)  (optional) whether its bag is at the game's full rule: it hunts with no item drop (hunt's; none: never full)
//   hunt(main, delta)  told each committed hunt, the delta with its spotHours and wayHours; it answers the main's bag
//             when the hunt's bag fact cleared it (its slots destroyed: BagClearing), else nothing
//   visit(main, now, { outingHours, died, town })  { main, delta, afterHours }: afterHours, the hours after
//             the arrival before it hunts again (its onward stops and its way back to the spot)
//   levelUp(main, now)  the main after a level read
//   event(event)  an event the plane pushed (any kind but the run's own); it throws on a kind it does not own
//   hour(at)  the money the plane holds apart from the mains at a report hour
//   finish(hours, mains)  { money: { start, end } the plane holds (none: no such money), ...fields the output adds }
// push(event) queues a plane's event. rearrive(index, now, event) hunts the main to now and asks the arrival rule again
// for a main after a situation raised outside its own events (a line in
// reach, a bid for what it sells); commit(index, now, change) hunts a main to
// now, replaces it by change(main) (a deal met with it while it hunts) and
// asks again. Returns the model ledger.
function simulate({ view, accounts, bands, rates, hours, seed = 1, plane, onProgress = null, inputs = {} }) {
    if (!plane) throw new Error('simulate needs a plane (today.js plane())');
    const rateOf = band => rates[band] || rates.default;
    const mains = accounts.map((account, index) => mainOf(account, index, view, bands));
    const ledger = Ledger.create({ bands, mains, view, extraSinks: plane.sinks });
    const queue = heap();
    const hooks = plane.start({ view, mains, ledger, push: event => queue.push(event), seed, rateOf,
        rearrive: (index, now, event) => commitTo(index, now, main => main, event),
        commit: (index, now, change, event) => commitTo(index, now, change, event) });
    // A plane with deaths: a main dies over its hunting hours at its row's deaths per hour, loses the
    // game's death exp for its level (levels down past the level's start) and is in its respawn town
    // for a visit (called with died: true). Ours: the respawn town is the spot card's town, the game's
    // is its RestartPoint region; the row's hour already holds the respawn and the rest, so the loss
    // and the way back are all the death adds.
    const deaths = plane.deaths === true;
    if (deaths && !view.deathExp) throw new Error('a plane with deaths needs the snapshot\'s deathExp');
    const randomFor = main => mulberry(hash(`${seed}:${main.id}:${main.counter}`));
    let events = 0;

    // The level is scheduled at the hour the exp the hunt credits reaches it
    // (as levelOf reads it), counted from the hour its exp stands at (its
    // last credited hunt, or the hour it hunts again after a visit's onward
    // stops): a situation read hunts the main to the read hour first. The
    // hunt credits the form it fires while its held shots last, then the bare
    // form (firedOf, formExp: as hunt credits), so the crossing is read on
    // those two pieces. A committed visit or deal may change the kit, the shots
    // or the row, so the level is scheduled again after each from the exp then
    // held; the one pending level time per main is the one read, an earlier
    // one still queued is skipped.
    const pendingLevel = new Map(), unlevelable = new Set();
    const scheduleLevel = (main, now) => {
        const row = spotRowOf(view, main), share = rateOf(main.band).huntShare, held = pendingLevel.get(main.index) ?? null;
        let at = Infinity;
        if (row && share > 0 && main.level < view.maxLevel) {
            // A need within float rounding of the level's exp is reached: the read is due at once.
            const gap = expAt(view, main.level + 1) - main.exp, need = gap <= LEVEL_ROUNDING * expAt(view, main.level + 1) ? 0 : gap;
            const kills = hooks.kills(main), { lasts, form } = firedOf(view, main, hooks.firing(main));
            const fired = lasts > 0 ? formExp(main, row, form, lasts, kills) : 0;
            const hours = need <= fired ? need / formExp(main, row, form, 1, kills) : lasts + (need - fired) / formExp(main, row, 'bare', 1, kills);
            at = main.since + hours / share;
        }
        if (!Number.isFinite(at)) {
            // Below the max level, a main whose hunt credits it no exp to the level (no row, no exp at its
            // row once its shots are spent) or with no hunting share never levels: counted once per main.
            if (main.level < view.maxLevel && !unlevelable.has(main.index)) { unlevelable.add(main.index); ledger.counters.unlevelableMains++; }
            pendingLevel.set(main.index, null);
            return;
        }
        // A level not reached before it leaves is not reached on its way: the arrival's visit schedules it again.
        const trip = pending.get(main.index);
        if (trip && trip.departs !== null && at > trip.departs) { pendingLevel.set(main.index, null); return; }
        pendingLevel.set(main.index, at);
        if (at !== held) queue.push({ at, kind: 'level_up', who: main.index });
    };
    // The one pending death per main: an exponential draw over its hunting hours from the hour it hunts
    // again (memoryless, so a redraw after a visit or deal is exact); one that falls after it has left for
    // town is dropped (it dies only while hunting), as a level is.
    const pendingDeath = new Map();
    const scheduleDeath = (main, now) => {
        if (!deaths) return;
        const row = spotRowOf(view, main), share = rateOf(main.band).huntShare, held = pendingDeath.get(main.index) ?? null;
        // The deaths per hour of the form it hunts in, as the hunt credits it (firedOf: the form it fires while its held
        // shots last, then bare; rowIn: a form without its own deaths dies at the row's), at the reference kit, times the
        // plane's factor for the kit the main wears (default 1).
        const factor = hooks.deathFactor ? hooks.deathFactor(main) : 1, { lasts, form } = firedOf(view, main, hooks.firing(main));
        const fired = rowIn(row, form)?.deaths * factor, bare = rowIn(row, 'bare')?.deaths * factor;
        if (!((fired > 0 || bare > 0) && share > 0)) { pendingDeath.set(main.index, null); return; }
        const roll = mulberry(hash(`${seed}:${main.id}:death:${main.counter}`))(), draw = -Math.log(1 - roll);
        const hours = draw <= fired * lasts || fired === bare ? draw / fired : bare > 0 ? lasts + (draw - fired * lasts) / bare : Infinity;
        if (!Number.isFinite(hours)) { pendingDeath.set(main.index, null); return; }
        const at = main.since + hours / share;
        const trip = pending.get(main.index);
        if (trip && trip.departs !== null && at > trip.departs) { pendingDeath.set(main.index, null); return; }
        pendingDeath.set(main.index, at);
        if (at !== held) queue.push({ at, kind: 'died', who: main.index });
    };
    // The one pending arrival (or situation to read) per main, replaced by the
    // rule's answer after each committed event; departs: the hour it leaves its
    // spot for it (null: it hunts to the arrival). An arrival it has left for
    // is held: the rule is not asked again on its way.
    const pending = new Map();
    const reschedule = (main, now, event) => {
        const held = pending.get(main.index) ?? null;
        if (held && held.departs !== null && held.departs <= now) return;
        // Asked from the hour it hunts again (a visit's onward stops keep it in town).
        const from = Math.max(now, main.since);
        const row = spotRowOf(view, main), rate = rateOf(main.band);
        const answer = hooks.nextArrival(main, { event, now: from, pending: held && held.at, rate, roll: mulberry(hash(`${seed}:${main.id}:arrival:${main.counter}`))(),
            hour: row || null, shotsPerHour: row?.shots || 0, huntShare: rate.huntShare });
        const at = answer !== null && typeof answer === 'object' ? answer.at : answer, kind = answer?.read ? 'situation' : 'arrived_town';
        // An answer is null (no arrival) or a finite hour: anything else is a defect of the rule, never a quiet drop.
        if (at !== null && !Number.isFinite(at)) throw new Error(`arrival rule answered ${typeof answer === 'object' ? JSON.stringify(answer) : String(answer)} for main ${main.id} at ${now} h (${event}): neither null nor a finite hour`);
        const away = kind === 'arrived_town' && answer?.away > 0 ? answer.away : 0;
        const next = at !== null && at > from ? { at, kind, departs: away > 0 ? at - away : null } : null;
        // An answer at or before the hour it was asked from is dropped: the main waits for its next other event.
        if (at !== null && at <= from) ledger.counters.arrivalNotAhead++;
        pending.set(main.index, next);
        if (next !== null && !(held && held.at === at && held.kind === kind)) queue.push({ at, kind, who: main.index });
        // A departure set or moved after the level was scheduled: the level counts hunting hours only.
        if ((next?.departs ?? null) !== (held?.departs ?? null)) { scheduleLevel(main, now); scheduleDeath(main, now); }
    };
    // Hunting from the main's last situation to now, committed: to the hour it
    // left its spot when it is on its way (departs), and none while it is in
    // town for a visit's onward stops (since after now).
    const huntTo = (main, now, departs = pending.get(main.index)?.departs ?? null) => {
        const share = rateOf(main.band).huntShare, end = departs !== null && departs < now ? departs : now;
        const spotHours = Math.max(0, end - main.since), wayHours = end < now ? now - Math.max(end, main.since) : 0;
        const moved = { ...main, counter: main.counter + 1, since: Math.max(now, main.since) };
        const { main: next, delta } = hunt(moved, view, spotHours * share, randomFor(main), hooks.firing(main), hooks.kills(main), hooks.full ? hooks.full(main) : false);
        Ledger.recordHunt(ledger, next, delta);
        const bag = hooks.hunt(next, { ...delta, spotHours, wayHours });
        return bag ? { ...next, bag } : next;
    };

    // Hunts a main to now, replaces it by change(main), schedules its level and death and asks the arrival rule
    // again: the one commit of a situation read, a raised situation (rearrive: change is the identity) and a deal.
    const commitTo = (index, now, change, event) => {
        const main = change(huntTo(mains[index], now));
        mains[index] = main;
        scheduleLevel(main, now);
        scheduleDeath(main, now);
        reschedule(main, now, event);
        return main;
    };
    // A born plane (plane.born === true): each main has one visit at hour 0 first, called with born: true; its way
    // back is the visit's afterHours (not hunted), as after any visit.
    if (plane.born === true) {
        for (let i = 0; i < mains.length; i++) {
            if (mains[i].station) continue;
            const { main: after, delta, afterHours = 0 } = hooks.visit(mains[i], 0, { outingHours: 0, born: true });
            Ledger.recordVisit(ledger, after, delta);
            mains[i] = { ...after, lastVisit: afterHours, since: afterHours };
        }
    }
    for (let i = 0; i < mains.length; i++) {
        const main = mains[i];
        if (main.station) continue;
        scheduleLevel(main, 0);
        scheduleDeath(main, 0);
        reschedule(main, 0, 'start');
    }
    for (let hour = 1; hour <= hours; hour++) queue.push({ at: hour, kind: 'report', who: -1 });

    const startedAt = Date.now();
    while (queue.size) {
        const event = queue.pop();
        if (event.at > hours) break;
        events++;
        if (event.kind === 'report') {
            Ledger.recordHour(ledger, mains, event.at, hooks.hour(event.at));
            if (onProgress && event.at % 10 === 0) onProgress({ hour: event.at, hours, events, seconds: (Date.now() - startedAt) / 1000 });
            continue;
        }
        // Any kind but the run's own is the plane's.
        if (event.kind !== 'arrived_town' && event.kind !== 'situation' && event.kind !== 'level_up' && event.kind !== 'died') {
            hooks.event(event);
            continue;
        }
        let departs = null;
        if (event.kind === 'arrived_town' || event.kind === 'situation') {
            const held = pending.get(event.who);
            if (!held || held.at !== event.at || held.kind !== event.kind) continue; // replaced by a later answer
            pending.set(event.who, null);
            departs = held.departs;
            // A situation is read on the main with its hunt committed to the read hour (the exp, adena and drops of the hours
            // before it), then the rule is asked again.
            if (event.kind === 'situation') { commitTo(event.who, event.at, main => main, 'situation'); continue; }
        }
        if (event.kind === 'level_up') {
            if (pendingLevel.get(event.who) !== event.at) continue; // replaced by a later schedule
            pendingLevel.set(event.who, null);
        }
        if (event.kind === 'died') {
            if (pendingDeath.get(event.who) !== event.at) continue; // replaced by a later schedule
            pendingDeath.set(event.who, null);
        }
        let main = event.kind === 'arrived_town' ? huntTo(mains[event.who], event.at, departs) : huntTo(mains[event.who], event.at), respawn = null;
        if (event.kind === 'died') {
            // The loss, the level it leaves (down: from level 1), then the respawn town's visit; the arrival
            // it had pending is void, and its hours back are the visit's afterHours (not hunted). The respawn
            // town is the town of the row it died at, read before a lost level moves its spot.
            respawn = townOfRow(view, spotRowOf(view, main), main.level);
            const lost = Math.min(main.exp, view.deathExp[main.level - 1]);
            const exp = main.exp - lost, level = levelOf(view, exp, 1);
            ledger.counters.deaths++;
            ledger.counters.deathExpLost += lost;
            if (level !== main.level) {
                const spot = ownRow(view, main.line, level, main.spot) ? main.spot : null;
                if (main.spot && !spot) ledger.counters.leftOwnSpot++;
                main = hooks.levelUp({ ...main, exp, level, band: bandOf(bands, level), spot }, event.at);
            } else main = { ...main, exp };
            pending.set(event.who, null);
        }
        if (event.kind === 'level_up') {
            // The read takes a level its hunted exp reaches within float rounding (LEVEL_ROUNDING), no more.
            const level = levelOf(view, main.exp, main.level, LEVEL_ROUNDING);
            const band = bandOf(bands, level), spot = ownRow(view, main.line, level, main.spot) ? main.spot : null;
            if (main.spot && !spot) ledger.counters.leftOwnSpot++;
            main = { ...main, level, band, spot };
            main = hooks.levelUp(main, event.at);
            scheduleLevel(main, event.at);
            scheduleDeath(main, event.at);
            mains[event.who] = main;
            reschedule(main, event.at, 'level_up');
        } else {
            // The restock covers an outing as long as the one just ended: its hours at the spot, from
            // the end of its last visit to the hour it left (lastVisit: the hour that visit ended).
            const outingHours = ((departs ?? event.at) - main.lastVisit) * rateOf(main.band).huntShare;
            const { main: after, delta, afterHours = 0 } = hooks.visit(main, event.at, event.kind === 'died' ? { outingHours, died: true, town: respawn } : { outingHours });
            Ledger.recordVisit(ledger, after, delta);
            // Its onward stops and its way back are not hunted: it hunts again from their end.
            main = { ...after, lastVisit: event.at + afterHours, since: event.at + afterHours };
            mains[event.who] = main;
            // A visit changes the kit and the shots held, so the hour's exp and how long its shots last.
            scheduleLevel(main, event.at);
            scheduleDeath(main, event.at);
            reschedule(main, event.at, 'visit');
        }
    }
    for (let i = 0; i < mains.length; i++) if (!mains[i].station) mains[i] = huntTo(mains[i], hours);
    const { money, ...added } = hooks.finish(hours, mains);
    return { ...Ledger.build(ledger, { mains, hours, events, inputs, held: money }), ...added };
}

module.exports = { HAND_SLOTS, beginnerOf, heldOf, townOfRow, viewOf, hunt, shotsPerHour, sellerOf, hopSeller, hopTo, emptyFlows, mainOf, simulate, wholeCount, spotRowOf, huntExp, hourOf, shotOf, levelOf,
    killMixCorrection, adenaFactor, yieldRows, formOf, rowIn, isGear, isWeapon, expAt, rowItems, tripLeg, toHoursOf, backHoursOf, firedOf };

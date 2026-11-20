'use strict';

// Today mode of the economy model: the mechanisms of today's world the model
// imitates so that it can reproduce a real run's ledger, and the two numbers
// per stage band it fits on one. Every constant is a named field of TODAY or
// of the fitted rates, printed with each run.
//
// Today's-world mechanisms (each goes when the design replaces it):
//   fixed buyers       the 14 configured city buy stores pay every bot the
//                      line's price, without a count limit;
//   static shot lines  the configured city sell stores sell a bot shots (and
//                      only shots) at the line's price, without a count limit;
//   kit buys at the scaled NPC price: a kit piece comes from a town NPC at
//                      the rate-scaled, taxed price of the snapshot's preset;
//   fitted arrivals    a main comes to town at its band's fitted visits per
//                      bot-hour (nextArrival), today's trip triggers folded in.
// Crafting is not imitated: today's crafts are a few per cent of the shots
// fired and no flow of the ledger depends on them.
const Engine = require('./engine');
const BeginnerShots = require('../../src/GameServer/Items/C4BeginnerShots');
const KitHours = require('./kit-hours');
const { STAGE_BANDS } = require('../economy/ledger-rules');

// Today's shot restock (KitRule.kitReader, ShotStock.restockPlan):
// below one hunting hour of use a bot buys up to an outing's use, never
// under one hour.
const SHOT_LINE_HOURS = 1;

// MerchantStoreConfigs store types.
const SELL = 1, BUY = 3;
const TODAY = Object.freeze({
    // Kit pieces at the snapshot preset's NPC prices (NpcShopBuyLists, scaled by NpcShopPriceScale).
    npcPrices: 'preset',
    // A fixed buyer pays at most this share of the item's cheapest repeatable
    // supply (StaticMerchantPricing BUYBACK_RATIO).
    buybackRatio: 0.9,
    // Shot restock: below this many hunting hours of use, up to the use of the hunting hours since the last visit (Today.errands).
    shotLineHours: SHOT_LINE_HOURS,
    // When a main comes to town: periodic at the band's visits per bot-hour, fitted on a real run (nextArrival).
    arrivals: 'fitted periodic'
});

// Today's arrivals (the plane's nextArrival): every 1 / visitsPerBotHour
// hours, the first at a seeded share of that interval so mains do not all
// arrive at once; none at a rate of 0. A level-up changes no trip: the
// arrival already pending stays.
function nextArrival(main, { event, now, pending, rate, roll }) {
    const visits = rate?.visitsPerBotHour;
    if (!(visits > 0)) return null;
    if (event === 'level_up') return pending;
    return now + (event === 'start' ? roll : 1) / visits;
}

// The run's hunter in today's and the plain mode: what a main fires as it hunts and its worn kit's kills, the two
// answers the engine's one hunt reads. firing(main): the hour's shot at the
// grade of the weapon in hand (shotOf) at the shots its spot row's hour of
// that kind fires (shotsPerHour: times the worn weapon's count per action,
// scaleOf(main, row, form), and the worn kit's shots, factorsOf(main)[form]);
// beginner: the beginner shot that charges it (Engine.beginnerOf, 0 for none);
// null where the hour fires no shot or that count is 0. kills(main): per form
// the worn kit's kills over the reference kit's (factorsOf(main)[form].kills;
// 1 unstated). factorsOf null: every main hunts the row's own kit (the plain
// mode). Held per main until its kit, weapon, level or spot row changes (the
// inputs of both answers).
function hunter(view, factorsOf = null, scaleOf = null) {
    const held = new Map();
    const answerOf = main => {
        const row = Engine.spotRowOf(view, main), last = held.get(main.index);
        if (last && last.kit === main.kit && last.weapon === main.weapon && last.level === main.level && last.row === row) return last;
        const factors = factorsOf ? factorsOf(main) : null, hour = Engine.hourOf(view, main);
        let firing = null;
        if (row && hour?.shotId) {
            const id = Engine.shotOf(view, main, hour), form = Engine.formOf(view, id);
            const perHour = Engine.shotsPerHour(row, form, scaleOf ? scaleOf(main, row, form) : 1, factors?.[form]);
            firing = perHour > 0 ? { id, perHour, beginner: Engine.beginnerOf(view, id) } : null;
        }
        const kills = Object.fromEntries(['bare', 'shots', 'blessed'].map(form => [form, factors?.[form]?.kills ?? 1]));
        const answer = { kit: main.kit, weapon: main.weapon, level: main.level, row, firing, kills };
        held.set(main.index, answer);
        return answer;
    };
    return { firing: main => answerOf(main).firing, kills: main => answerOf(main).kills };
}

// The main's errands in town, in its wallet's order: the shot restock (of
// the shot it fires at its shots an hour, context.firing: the run's hunter's
// answer, held with the beginner shots that charge it, Engine.heldOf; none
// firing none), then the kit plan's pieces it does not wear, by slot.
function errands(main, view, context) {
    const out = [], firing = context.firing;
    if (firing) {
        const held = Engine.heldOf(main, firing);
        const target = Math.ceil(firing.perHour * Math.max(SHOT_LINE_HOURS, context.outingHours || 0));
        if (held < firing.perHour * SHOT_LINE_HOURS && target > held) out.push({ kind: 'shots', id: firing.id, amount: target - held });
    }
    for (const piece of view.kits[main.line]?.[main.level] || []) {
        if (main.kit[piece.slot] !== piece.selfId) out.push({ kind: 'piece', id: piece.selfId, slot: piece.slot, amount: 1 });
    }
    return out;
}

// A visit: the main arrives in its spot's town, sells its bag (to a fixed
// buyer of the town when one buys the item, else to the NPC), sells shots of
// a grade it no longer fires to the NPC (never a restricted item: the beginner
// shots, BeginnerShots.isRestricted, stay), then runs its errands where it
// stands; an errand nobody sells here takes it by gatekeeper to the nearest
// town that sells it (one such hop per visit), where it runs what it can.
function visit(main, view, context = {}) {
    const hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main), flows = Engine.emptyFlows();
    const town = Engine.townOfRow(view, row, main.level);
    const delta = { flows, towns: [], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0,
        unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
    if (!town) { delta.noTown = 1; return { main, delta }; }
    delta.towns.push(town);
    let money = main.money;
    const sellToNpc = (id, count) => {
        const value = Math.round(count * (view.items[id]?.npcBuy || 0));
        if (!(value > 0)) return false;
        flows.npcSales += value;
        money += value;
        if (Engine.isGear(view.items[id])) delta.gearToNpc += count;
        return true;
    };
    const buyers = view.market.buy[town] || {};
    for (const [key, count] of Object.entries(main.bag)) {
        const id = Number(key), price = buyers[id];
        if (price > 0) { const value = Math.round(price * count); flows.fixedBuyers += value; money += value; } else if (!sellToNpc(id, count)) delta.unsold += count;
    }
    const shots = {}, firing = Engine.shotOf(view, main, hour);
    for (const [key, count] of Object.entries(main.shots)) {
        if (Number(key) === firing || BeginnerShots.isRestricted(key) || !count) { if (count) shots[key] = count; continue; }
        if (sellToNpc(Number(key), count)) delta.shotsSoldNpc += count; else delta.unsold += count;
    }
    const kit = { ...main.kit };
    let weapon = main.weapon;
    const buy = (errand, seller) => {
        if (errand.kind === 'shots') {
            const count = Math.min(errand.amount, Math.floor(money / seller.price));
            if (count <= 0) return false;
            const cost = count * seller.price;
            money -= cost;
            shots[errand.id] = (shots[errand.id] || 0) + count;
            if (seller.channel === 'fixed_wts') { flows.fixedSellers -= cost; delta.shotsBoughtFixed += count; } else { flows.npcBuys -= cost; delta.shotsBoughtNpc += count; }
            return count === errand.amount;
        }
        if (money < seller.price) return false;
        money -= seller.price;
        flows[seller.channel === 'fixed_wts' ? 'fixedSellers' : 'npcBuys'] -= seller.price;
        delta.gearBought++;
        const worn = kit[errand.slot];
        kit[errand.slot] = errand.id;
        if (Engine.isWeapon(view.items[errand.id])) weapon = errand.id;
        if (worn) sellToNpc(worn, 1);
        return true;
    };
    let open = [];
    for (const errand of errands(main, view, context)) {
        const seller = Engine.sellerOf(view, errand.id, town);
        if (!(seller?.town === town && buy(errand, seller))) open.push(errand);
    }
    // One onward hop: to the seller of the first errand still open that sells in another town.
    const hop = Engine.hopSeller(view, open.map(errand => errand.id), town, money);
    if (hop) {
        money = Engine.hopTo(hop, money, delta);
        const there = hop.town;
        open = open.filter(errand => {
            const seller = Engine.sellerOf(view, errand.id, there);
            return !(seller?.town === there && buy(errand, seller));
        });
    }
    for (const errand of open) delta[errand.kind === 'shots' ? 'missingShots' : 'missingPieces']++;
    return { main: { ...main, money, bag: {}, shots, kit, weapon }, delta };
}

// Today's plane (the engine's plane contract): no sinks
// or events of its own and no money apart from the mains; a main fires and
// kills as the hunter answers, visits by today's visit and comes to town by
// nextArrival (the fitted periodic rule).
function plane({ view, hunter }) {
    return {
        sinks: [],
        start: () => ({
            firing: hunter.firing,
            kills: hunter.kills,
            nextArrival,
            visit: (main, now, { outingHours }) => visit(main, view, { outingHours, firing: hunter.firing(main) }),
            hunt() {},
            levelUp: main => main,
            event(event) { throw new Error(`an event of an unknown kind: ${event.kind}`); },
            hour: () => 0,
            finish: () => ({})
        })
    };
}

// A configured line's price: the game's own at the snapshot's preset
// (StaticMerchantPricing.botPriceFor, stored by inputs.js as gamePrice).
function configuredPrice(line) {
    if (!Number.isFinite(Number(line.gamePrice))) throw new Error(`store line ${line.selfId} has no gamePrice: rebuild the snapshot (inputs.js)`);
    return Number(line.gamePrice);
}

// What a fixed buyer pays a bot (StaticMerchantPricing.botPriceFor): its
// configured price, at most the buyback share of the cheapest repeatable
// supply (a fixed sell line or a town NPC), so no bot buys and sells back at a profit.
function fixedBuyerPrice(line, cheapestSupply, buybackRatio = TODAY.buybackRatio) {
    return Math.min(configuredPrice(line), Math.floor(cheapestSupply * buybackRatio));
}

const isShot = item => item?.kind === 'Other.Shot';

// The fixed stores as the engine's market: buy { town: { item: price } } from
// the buy stores, sell { town: { shot: price } } from the sell stores, reserve
// { town: { piece: price } } from the bot-only gear lines of the sell stores
// (the design's sellers add them; today's bots restock shots only).
function marketOf(snapshot, config = TODAY) {
    const supply = new Map();
    const lower = (id, price) => supply.set(id, Math.min(supply.get(id) ?? Infinity, price));
    for (const store of snapshot.stores) {
        if (store.storeType !== SELL) continue;
        for (const line of store.items) if (Number(line.count ?? 1) > 0) lower(Number(line.selfId), configuredPrice(line));
    }
    for (const [id, rows] of Object.entries(snapshot.npcOffers[config.npcPrices] || {})) for (const row of rows) lower(Number(id), row.price);
    const buy = {}, sell = {}, reserve = {};
    for (const store of snapshot.stores) {
        if (!store.town) continue;
        for (const line of store.items) {
            const id = Number(line.selfId);
            if (!(Number(line.count ?? 1) > 0)) continue;
            if (store.storeType === BUY) {
                const price = fixedBuyerPrice(line, supply.get(id) ?? Infinity, config.buybackRatio);
                const town = buy[store.town] ||= {};
                town[id] = Math.max(town[id] || 0, price);
            } else if (store.storeType === SELL && isShot(snapshot.items[id])) {
                const town = sell[store.town] ||= {}, price = configuredPrice(line);
                town[id] = Math.min(town[id] ?? Infinity, price);
            } else if (store.storeType === SELL && line.reserve) {
                const town = reserve[store.town] ||= {}, price = configuredPrice(line);
                town[id] = Math.min(town[id] ?? Infinity, price);
            }
        }
    }
    return { buy, sell, reserve };
}

// The hunting share and visits per bot-hour of each stage band, fitted on a
// real run's ledger: the share is the band's realized exp per bot-hour over
// the cohort's mean exp per hunting hour at its start levels (each main at
// the spot row the engine hunts: its own spot's, else its line's best);
// visits are the run's town arrivals per hunting main, one value for every
// band (the ledger counts visits for the world only). A band the run did not
// populate takes its nearest populated band's numbers. Printed beside the
// fit, never fitted to: the share at the best spots, the end snapshot's
// hunting and grouped fractions, and the members at their own spot.
// factorOf(main): the main's worn kit's exp factor over the reference kit (the
// factor its hunt, restock and this fit all read). The fitted share is real exp
// per wall bot-hour over the row's exp x that factor: the time at the spot x an
// unexplained residual, not a share of time alone.
// Without factorOf every main is fitted on its bare row.
function fit(baseline, accounts, view, bands, factorOf = null) {
    const mains = accounts.map((account, index) => Engine.mainOf(account, index, view, bands)).filter(main => !main.station);
    const visitsPerBotHour = Number(baseline.visits?.perHour || 0) / Math.max(1, mains.length);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const basis = {};
    for (const [band] of bands) {
        const real = baseline.progress?.stageBands?.[band];
        const members = mains.filter(main => main.band === band);
        const expOf = factored => mean(members.map(main => { const row = Engine.spotRowOf(view, main); return row ? Engine.huntExp(main, row, factored ? factorOf(main) : 1) : 0; }));
        const meanExp = expOf(!!factorOf), plainExp = factorOf ? expOf(false) : meanExp;
        const bestExp = mean(members.map(main => view.hours[main.line]?.[main.level]?.best?.exp || 0));
        if (!real || !members.length || !(meanExp > 0)) continue;
        const activity = real.activityAtEnd || {}, of = count => (real.bots ? (count || 0) / real.bots : null);
        basis[band] = { realExp: real.expPerBotHour, meanExp, huntShare: real.expPerBotHour / meanExp, bestExp, bestShare: real.expPerBotHour / bestExp,
            activityHunting: of(activity.hunting), activityGrouped: of(activity.grouped), activityResting: of(activity.resting),
            atOwnSpot: members.filter(main => main.spot).length, bots: members.length };
        if (factorOf) basis[band].kitFactor = meanExp / plainExp;
    }
    const fitted = Object.keys(basis);
    if (!fitted.length) throw new Error('the baseline populates no stage band the cohort has');
    const rates = {};
    bands.forEach(([band], at) => {
        const nearest = fitted.reduce((best, name) => {
            const distance = Math.abs(bands.findIndex(([b]) => b === name) - at);
            return best === null || distance < best.distance ? { name, distance } : best;
        }, null).name;
        rates[band] = { huntShare: basis[nearest].huntShare, visitsPerBotHour, fittedOn: nearest };
    });
    rates.default = rates[fitted[0]];
    return { rates, basis, visitsPerBotHour };
}

// Today's mode on a real run's ledger (fitLedger) and its start cohort
// (fitAccounts): the view at today's fixed stores and NPC prices, the kit
// hours (the game's hunt cycle, booted here; kitHours: given readers instead),
// the fit with each main's worn kit counted once (its shots form's kill
// factor, as its hunt reads it) and the hunter the run reads (the worn kit's
// factors, the worn weapon's shots per action). The kit hours price a shot at
// its cheapest fixed sell line, the line a today bot restocks it at (ours: the
// game has no single shot price); a shot no fixed line sells is no option.
// Returns { view, rates, basis, hunter }.
function setup(snapshot, fitLedger, fitAccounts, kitHours = null) {
    const market = marketOf(snapshot), view = Engine.viewOf(snapshot, { market, npcPrices: TODAY.npcPrices }), anchor = {};
    for (const lines of Object.values(market.sell)) for (const [id, price] of Object.entries(lines)) anchor[id] = Math.min(anchor[id] ?? Infinity, price);
    const readers = kitHours || KitHours.gameKitHours({ snapshot, anchor });
    const factorsOf = KitHours.kitFactors({ snapshot, view, kitHours: readers });
    const { rates, basis } = fit(fitLedger, fitAccounts, view, STAGE_BANDS, main => factorsOf(main).shots?.kills ?? 1);
    const scaleOf = (main, row, form) => readers.shotScale(main.line, main.level, row.spotId, main.weapon, form === 'blessed');
    return { view, rates, basis, hunter: hunter(view, factorsOf, scaleOf) };
}

module.exports = { TODAY, configuredPrice, fixedBuyerPrice, marketOf, fit, nextArrival, hunter, visit, errands, plane, setup, SELL, BUY, SHOT_LINE_HOURS };

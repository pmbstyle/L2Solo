'use strict';

// The model run's ledger, under the field names of the real run's economy
// ledger (scripts/economy/ledger-rules.js, schema l2solo.economy-ledger/1)
// wherever the model produces the same quantity, so a comparison walks the
// leaves both have: flows.perBotHour, money, trade.channels,
// progress.stageBands (by start level, as the real one), shots, gear,
// recipes, visits. Fields only the model has (hunt adena per band, drops by
// item, hunting hours by spot, the hourly series, its own counters) carry
// names the real ledger does not use.
//
// The engine records each committed situation here; build() reads the totals
// once at the end. Every flow is a whole adena amount, so the money stock
// changes by exactly the flows' net.
const SCHEMA = 'l2solo.economy-model/1';
const STATION = 'station';
const FAUCETS = ['fixedBuyers', 'huntCold', 'npcSales'];
const SINKS = ['npcBuys', 'fixedSellers', 'fares'];
// Trade-log channels of the real ledger for the flows that are trades.
const CHANNEL_OF = { fixedBuyers: 'static_wtb', fixedSellers: 'fixed_wts', npcBuys: 'npc_buy' };

const round = (value, digits = 1) => {
    const scale = 10 ** digits;
    return Math.round(Number(value || 0) * scale) / scale;
};
const ratio = (value, base) => (base ? value / base : 0);

// extraSinks: a plane's own sinks; today's ledger has none.
function create({ bands, mains, view, extraSinks = [] }) {
    const bandNames = [...bands.map(([name]) => name), STATION], sinks = [...SINKS, ...extraSinks];
    const byBand = Object.fromEntries(bandNames.map(name => [name, { flows: Object.fromEntries([...FAUCETS, ...sinks].map(kind => [kind, 0])) }]));
    return {
        bands, view, byBand, sinks,
        start: mains.map(main => ({ band: main.band, money: main.money, exp: main.exp, level: main.level })),
        totals: Object.fromEntries([...FAUCETS, ...sinks].map(kind => [kind, 0])),
        shots: { used: 0, wanted: 0, boughtNpc: 0, boughtFixed: 0, soldNpc: 0 },
        gear: { toNpcUnits: 0, boughtNpcUnits: 0 },
        recipes: {},
        drops: {},
        huntHours: { ownSpot: 0, bestSpot: 0 },
        visits: new Map(),
        // missingPieces, missingShots: errands left open at a visit, once per visit they stay open.
        // spoilUnyielded: kills at spot rows with spoil loot where the snapshot holds no spoil yields (the loot is lost).
        // leftOwnSpot: level-ups after which the main's own spot had no hour and it moved to its line's best.
        // arrivalNotAhead: arrival answers at or before the event's hour, dropped (the main goes at none).
        // deaths, deathExpLost: the deaths a plane with deaths rolled and the exp they took.
        // unlevelableMains: mains below the max level that once had no level time (no exp at their row or no hunting share).
        counters: { visits: 0, onwardHops: 0, missingPieces: 0, missingShots: 0, unsoldUnits: 0, noSpotRow: 0, noTown: 0, spoilUnyielded: 0,
            startAtOwnSpot: mains.filter(main => main.spot).length, leftOwnSpot: 0, arrivalNotAhead: 0, unlevelableMains: 0, deaths: 0, deathExpLost: 0 },
        hourly: []
    };
}

function addFlows(ledger, index, flows) {
    const band = ledger.byBand[ledger.start[index].band].flows;
    for (const [kind, adena] of Object.entries(flows)) {
        if (!adena) continue;
        ledger.totals[kind] += adena;
        band[kind] += adena;
    }
}

function recordHunt(ledger, main, delta) {
    addFlows(ledger, main.index, delta.flows);
    ledger.shots.used += delta.shotsUsed;
    ledger.shots.wanted += delta.shotsWanted;
    ledger.counters.noSpotRow += delta.noSpot;
    ledger.counters.spoilUnyielded += Math.round(delta.spoilUnyielded);
    ledger.huntHours[delta.ownSpot ? 'ownSpot' : 'bestSpot'] += delta.huntHours || 0;
    for (const [id, count] of delta.drops) {
        ledger.drops[id] = (ledger.drops[id] || 0) + count;
        const item = ledger.view.items[id];
        if (item?.kind !== 'Other.Recipe') continue;
        const grade = ledger.view.recipeGrade[id] || 'none';
        ledger.recipes[grade] = (ledger.recipes[grade] || 0) + count;
    }
}

function recordVisit(ledger, main, delta) {
    addFlows(ledger, main.index, delta.flows);
    const { counters } = ledger;
    counters.noTown += delta.noTown;
    counters.missingPieces += delta.missingPieces;
    counters.missingShots += delta.missingShots;
    counters.unsoldUnits += delta.unsold;
    counters.onwardHops += Math.max(0, delta.towns.length - 1);
    ledger.shots.boughtNpc += delta.shotsBoughtNpc;
    ledger.shots.boughtFixed += delta.shotsBoughtFixed;
    ledger.shots.soldNpc += delta.shotsSoldNpc;
    ledger.gear.toNpcUnits += delta.gearToNpc;
    ledger.gear.boughtNpcUnits += delta.gearBought;
    for (const town of delta.towns) {
        counters.visits++;
        if (!ledger.visits.has(town)) ledger.visits.set(town, { count: 0, bots: new Set() });
        const row = ledger.visits.get(town);
        row.count++;
        row.bots.add(main.id);
    }
}

// The hourly report: the money stock, the flows so far and the mains per
// current stage band. Counters only. held: money the mains do not hold (the
// plane's twins).
function recordHour(ledger, mains, hour, held = 0) {
    const bands = {};
    let money = held;
    for (const main of mains) {
        money += main.money;
        bands[main.band] = (bands[main.band] || 0) + 1;
    }
    ledger.hourly.push({ hour, money, totals: { ...ledger.totals }, bands });
}

// held: { start, end } money the mains do not hold (a plane's twins).
function build(ledger, { mains, hours, events, inputs, held = { start: 0, end: 0 } }) {
    const botHours = mains.length * hours;
    const totals = ledger.totals;
    const faucets = FAUCETS.reduce((sum, kind) => sum + totals[kind], 0);
    const sinks = ledger.sinks.reduce((sum, kind) => sum + totals[kind], 0);
    const stockStart = ledger.start.reduce((sum, row) => sum + row.money, held.start);
    const stockEnd = mains.reduce((sum, main) => sum + main.money, held.end);
    const groups = {};
    for (const main of mains) {
        const start = ledger.start[main.index], group = groups[start.band] ||= { bots: 0, moneyStart: 0, moneyEnd: 0, exp: 0, levelUps: 0, entries: 0, exits: 0 };
        group.bots++;
        group.moneyStart += start.money;
        group.moneyEnd += main.money;
        group.exp += main.exp - start.exp;
        group.levelUps += Math.max(0, main.level - start.level);
        if (main.band !== start.band) {
            group.exits++;
            (groups[main.band] ||= { bots: 0, moneyStart: 0, moneyEnd: 0, exp: 0, levelUps: 0, entries: 0, exits: 0 }).entries++;
        }
    }
    const order = [...ledger.bands.map(([name]) => name), STATION];
    const stageBands = {};
    for (const name of order) {
        const group = groups[name];
        if (!group?.bots) continue;
        const bandHours = group.bots * hours, flows = ledger.byBand[name].flows;
        stageBands[name] = {
            bots: group.bots,
            botHours: round(bandHours, 2),
            expPerBotHour: round(ratio(group.exp, bandHours), 0),
            levelUps: group.levelUps,
            bandEntries: group.entries,
            bandExits: group.exits,
            money: { meanStart: round(ratio(group.moneyStart, group.bots), 0), meanEnd: round(ratio(group.moneyEnd, group.bots), 0),
                deltaPerBotHour: round(ratio(group.moneyEnd - group.moneyStart, bandHours), 0) },
            trade: Object.fromEntries(Object.entries(CHANNEL_OF).filter(([kind]) => flows[kind]).map(([kind, channel]) => [channel, round(ratio(Math.abs(flows[kind]), bandHours), 0)])),
            modelFlowsPerBotHour: Object.fromEntries(Object.entries(flows).map(([kind, adena]) => [kind, round(ratio(adena, bandHours), 0)]))
        };
    }
    const recipesTotal = Object.values(ledger.recipes).reduce((sum, count) => sum + count, 0);
    return {
        schema: SCHEMA,
        inputs,
        window: { hours },
        population: { bots: mains.length, botHours: round(botHours, 2),
            stageBands: Object.fromEntries(order.filter(name => groups[name]?.bots).map(name => [name, groups[name].bots])) },
        flows: {
            perBotHour: Object.fromEntries(Object.entries(totals).map(([kind, adena]) => [kind, round(ratio(adena, botHours))])),
            totals: { ...totals },
            faucets, sinks, net: faucets + sinks,
            fixedBuyerShareOfFaucets: round(ratio(totals.fixedBuyers, faucets), 4)
        },
        money: {
            stockStart, stockEnd, delta: stockEnd - stockStart, journalNet: faucets + sinks,
            closureGap: stockEnd - stockStart - (faucets + sinks),
            growthPerHour: round(ratio((faucets + sinks) / hours, (stockStart + stockEnd) / 2), 6),
            growthBasis: 'net flows per hour / mean of start and end stock'
        },
        trade: { channels: Object.fromEntries(Object.entries(CHANNEL_OF).filter(([kind]) => totals[kind]).map(([kind, channel]) => [channel, { adena: Math.abs(totals[kind]) }])) },
        progress: { bandsBasis: 'startLevel', stageBands },
        shots: { ...ledger.shots, usedShareOfWanted: round(ratio(ledger.shots.used, ledger.shots.wanted), 4) },
        gear: { ...ledger.gear },
        recipes: { dropped: { ...ledger.recipes }, droppedTotal: recipesTotal },
        drops: { byItem: { ...ledger.drops } },
        huntHours: { ownSpot: round(ledger.huntHours.ownSpot, 1), bestSpot: round(ledger.huntHours.bestSpot, 1) },
        visits: { perHour: round(ratio(ledger.counters.visits, hours), 0),
            towns: [...ledger.visits].map(([town, row]) => ({ town, perHour: round(ratio(row.count, hours), 0), bots: row.bots.size })).sort((a, b) => b.perHour - a.perHour) },
        counters: { events, ...ledger.counters },
        hourly: ledger.hourly
    };
}

module.exports = { SCHEMA, STATION, create, addFlows, recordHunt, recordVisit, recordHour, build };

'use strict';

// Today mode against a real run's economy ledger: the model starts from the
// run's start population, fitted on --fit (default the baseline itself: the
// hunting share and visits per stage band), runs the run's hours and prints
// two tables.
//   What the model computes from the rules it keeps
//     (exp, hunt adena, drops by class and grade, shots fired, fares,
//     arrivals), each with a verdict at its tolerance; a fitted number, a
//     consequence of the fit (level-ups) and a number with too few real units
//     are printed without one. Where the real ledger counts only the cold
//     bots (hunt adena, drops) while the model hunts every main, the real
//     number is a range, cold to cold plus hot, and the verdict says which end.
//   Today's mechanisms, imitated coarsely: the flows of mechanisms the target
//     model has none of (fixed buyers and sellers, NPC trade, money growth), printed
//     with the reason the model differs, never judged.
//
//   node scripts/economy-model/compare.js --baseline <ledger JSON> [--fit <ledger JSON>]
//       [--others <ledger JSON>,...] [--preset x50] [--snapshot <file>] [--seed 1] [--json <out>]
//
// --others are runs of another code era: compared with the same fit and
// printed as such, never as a validation.
const fs = require('node:fs');
const Boot = require('./boot');
const Cohort = require('./cohort');
const Load = require('./load');
const Engine = require('./engine');
const Today = require('./today');
const Run = require('./run');
// The real ledger's item classes, so both ledgers group drops alike.
const Rules = require('../economy/ledger-rules');

// relative: |model / baseline - 1| <= limit. "ours": no tolerance was set for it, the limit is ours.
const RELATIVE = 0.25;
// Real units under this many are Poisson noise of ±18 % or more: printed, not judged.
const MIN_UNITS = 30;
// The goods classes a hunt drops that both ledgers count apart from their use:
// cold drops of consumables net with their use inside one journal row (the real ledger's notComputed).
// Recipes are judged by product grade below (the class row would be their sum: one miss counted twice).
const DROP_CLASSES = Object.freeze(['material', 'weapon', 'armor', 'jewel']);
// Today's flows: the ledger path and why the model differs.
const TODAY_ROWS = Object.freeze([
    { path: 'flows.perBotHour.fixedBuyers', why: 'real bots start with stock the fixed buyers take and carry stock to buyer towns; the model starts with empty bags' },
    { path: 'flows.perBotHour.npcSales', why: 'real bots keep part of their materials; the model sells the whole bag' },
    { path: 'flows.perBotHour.npcBuys', why: 'real bots buy gear at the NPC for today\'s gear improvement; the model buys kit pieces only' },
    { path: 'flows.perBotHour.fixedSellers', why: 'today\'s funding rules hold shot buying back; the model restocks the shots of its hunting rate x the outing' },
    { path: 'flows.fixedBuyerShareOfFaucets', why: 'follows the fixed buyers' },
    { path: 'money.growthPerHour', why: 'follows the four flows above' },
    { path: 'gear.toNpcUnits', why: 'today\'s improvement and kit churn; the model sells dropped gear and the pieces it replaces' }
]);
// What the shared table says and does not say, for the baseline the compare ran against.
const footerOf = (baseline, preset) => [
    `WHAT THE SHARED TABLE SAYS: adena, drops and shots per unit of exp at the bots' real spots, over one ${+(baseline.window.hours * 60).toFixed(1)}-minute ${preset} run.`,
    'The hunting share is fitted on this same run\'s exp (in-sample), so it says',
    'nothing about the time bots hunt, and the level-ups follow from the fitted exp. It says nothing about visits (arrivals are fitted),',
    `longer horizons, today's flows or other presets than ${preset} (no real run there).`
];

const pick = (json, at) => at.split('.').reduce((value, name) => value?.[name], json);

// A row's verdict: PASS or FAIL for a relative check (a wrong sign fails
// whatever its size), or the reason it has none. A row with baselineHigh has a
// real range [baseline, baselineHigh]: PASS when the model lies within the
// tolerance of any point of it, and `end` says which end it is nearest.
function judged(row, kind) {
    const ratio = row.baseline ? row.model / row.baseline : null;
    const high = row.baselineHigh, ratioHigh = high ? row.model / high : null;
    if (kind !== 'relative') return { ...row, ratio, ratioHigh, verdict: kind, why: '' };
    const ends = high !== undefined ? [row.baseline, high] : [row.baseline];
    const low = Math.min(...ends), top = Math.max(...ends);
    const sign = Math.sign(row.baseline) === Math.sign(row.model);
    const within = ratio !== null && row.model >= low - Math.abs(low) * RELATIVE - 1e-12 && row.model <= top + Math.abs(top) * RELATIVE + 1e-12;
    const end = high === undefined || !within ? '' : Math.abs(ratio - 1) <= RELATIVE + 1e-12 ? 'cold end' : Math.abs(ratioHigh - 1) <= RELATIVE + 1e-12 ? 'cold+hot end' : 'between the ends';
    return { ...row, ratio, ratioHigh, verdict: sign && within ? 'PASS' : 'FAIL', why: !sign ? 'sign' : within ? end : 'size' };
}

// Units dropped per class/grade of a ledger: the real one's goods rows, the
// model's drops by item grouped by the real ledger's class rule.
function realDrops(baseline) {
    const out = {};
    for (const row of baseline.goods || []) if (DROP_CLASSES.includes(row.class) && row.drop > 0) out[`${row.class}/${row.grade}`] = row.drop;
    return out;
}
// The hot bots' units of the same goods rows (the real ledger counts a drop of a hot bot as hotIn).
function realHotDrops(baseline) {
    const out = {};
    for (const row of baseline.goods || []) if (DROP_CLASSES.includes(row.class) && row.drop > 0) out[`${row.class}/${row.grade}`] = row.hotIn || 0;
    return out;
}
function modelDrops(model, items) {
    const out = {};
    for (const [id, units] of Object.entries(model.drops?.byItem || {})) {
        const item = items[id], cls = Rules.itemClass(item);
        if (!DROP_CLASSES.includes(cls)) continue;
        const key = `${cls}/${String(item?.grade || 'none').toLowerCase()}`;
        out[key] = (out[key] || 0) + units;
    }
    return out;
}

const huntingMains = ledger => ledger.population.bots - (ledger.population.stageBands?.station || 0);

// The shared table: { label, baseline, baselineHigh?, model, ratio, ratioHigh?, verdict, why, note }.
function sharedRows(baseline, model, items) {
    const rows = [];
    const add = (label, real, mine, kind, note = '', realHigh = undefined) => {
        if (typeof real !== 'number') return;
        const row = { label, baseline: real, model: typeof mine === 'number' ? mine : 0 };
        if (realHigh !== undefined && realHigh > real) row.baselineHigh = realHigh;
        rows.push({ ...judged(row, kind), note });
    };
    // A count of real units: judged at ±25 % (ours) from MIN_UNITS on, printed below it.
    const counted = (label, units, real, mine, note, realHigh) => add(label, real, mine, units < MIN_UNITS ? 'few units' : 'relative',
        units < MIN_UNITS ? `${units} real units` : `${note}; ±25 % ours`, realHigh);
    const realBands = baseline.progress?.stageBands || {}, modelBands = model.progress?.stageBands || {};
    for (const [band] of Run.STAGE_BANDS) {
        if (!realBands[band]) continue;
        add(`exp per bot-hour ${band}`, realBands[band].expPerBotHour, modelBands[band]?.expPerBotHour, 'fitted', 'the hunting share is fitted to it');
        add(`level-ups ${band}`, realBands[band].levelUps, modelBands[band]?.levelUps ?? 0, 'follows the fit', 'a consequence of the fitted exp');
    }
    const realHours = baseline.population.botHours, modelHours = model.population.botHours, perHour = baseline.flows?.perBotHour;
    const cold = perHour?.huntCold;
    add('hunt adena per bot-hour', cold, model.flows?.perBotHour?.huntCold, 'relative',
        'real: cold bots only ... plus hot unlabeled; the model hunts every main; ±25 % ours', typeof cold === 'number' ? cold + (perHour.hotUnlabeled || 0) : undefined);
    const real = realDrops(baseline), hot = realHotDrops(baseline), mine = modelDrops(model, items);
    for (const key of Object.keys(real)) {
        counted(`dropped ${key} per bot-hour`, real[key], real[key] / realHours, (mine[key] || 0) / modelHours, 'units cold ... plus hot', (real[key] + hot[key]) / realHours);
    }
    for (const [grade, units] of Object.entries(baseline.recipes?.dropped || {})) {
        counted(`recipes for ${grade} products per bot-hour`, units, units / realHours, (model.recipes?.dropped?.[grade] || 0) / modelHours, 'cold only: the hot recipes are not split by grade');
    }
    add('shots used per bot-hour', pick(baseline, 'shots.used') / realHours, pick(model, 'shots.used') / modelHours, 'relative', '±25 % ours');
    add('fares per bot-hour', baseline.flows?.perBotHour?.fares, model.flows?.perBotHour?.fares, 'relative');
    // Arrivals alone: what the fit takes from the real ledger; onward hops are the model's own and have no real count.
    add('arrivals per hunting bot-hour', pick(baseline, 'visits.perHour') / huntingMains(baseline),
        (model.counters.visits - model.counters.onwardHops) / model.window.hours / huntingMains(model), 'fitted',
        'the real number is a lower bound (the life feed keeps 20 rows per bot); fitted to it');
    rows.push({ label: 'onward hops per hunting bot-hour', baseline: null, model: model.counters.onwardHops / model.window.hours / huntingMains(model), ratio: null, verdict: 'no real count',
        why: '', note: 'the model\'s own: a second town for an errand' });
    return rows;
}

// Today's table: model, real, ratio and the reason they differ; never a verdict.
function todayRows(baseline, model) {
    const rows = TODAY_ROWS.map(({ path, why }) => ({ label: path, baseline: pick(baseline, path), model: pick(model, path) ?? 0, why }));
    for (const [band] of Run.STAGE_BANDS) {
        rows.push({ label: `money per bot-hour ${band}`, baseline: pick(baseline, `progress.stageBands.${band}.money.deltaPerBotHour`),
            model: pick(model, `progress.stageBands.${band}.money.deltaPerBotHour`) ?? 0, why: 'follows the trade flows above' });
    }
    return rows.filter(row => typeof row.baseline === 'number').map(row => ({ ...row, ratio: row.baseline ? row.model / row.baseline : null, verdict: 'today' }));
}

const shown = value => Math.abs(value) >= 1e4 ? `${(value / 1000).toFixed(1)}k` : Math.abs(value) < 1 && value !== 0 ? value.toFixed(4) : String(Math.round(value * 10) / 10);
const ratioText = row => (row.ratio === null ? '-' : row.ratio.toFixed(2));

const baselineText = row => (row.baseline === null ? '-' : row.baselineHigh === undefined ? shown(row.baseline) : `${shown(row.baseline)}..${shown(row.baselineHigh)}`);
const ratioOf = row => (row.ratio === null ? '-' : row.ratioHigh === null || row.ratioHigh === undefined ? row.ratio.toFixed(2) : `${row.ratio.toFixed(2)}/${row.ratioHigh.toFixed(2)}`);

function printShared(rows, title) {
    console.log(title);
    console.log(`  ${'number'.padEnd(44)}${'real (cold..cold+hot)'.padStart(22)}${'model'.padStart(10)}${'ratio'.padStart(12)}  verdict`);
    for (const row of rows) {
        const verdict = row.verdict === 'PASS' || row.verdict === 'FAIL' ? `${row.verdict}${row.why ? ` (${row.why})` : ''}` : `(${row.verdict})`;
        console.log(`  ${row.label.padEnd(44)}${baselineText(row).padStart(22)}${shown(row.model).padStart(10)}${ratioOf(row).padStart(12)}  ${verdict}${row.note ? `  ${row.note}` : ''}`);
    }
    const count = verdict => rows.filter(row => row.verdict === verdict).length;
    console.log(`  pass ${count('PASS')}, fail ${count('FAIL')}, follows the fit ${count('follows the fit')}, not judged ${rows.length - count('PASS') - count('FAIL') - count('follows the fit')}`);
}

function printToday(rows, title) {
    console.log(title);
    for (const row of rows) console.log(`  ${row.label.padEnd(44)}${shown(row.baseline).padStart(12)}${shown(row.model).padStart(12)}${ratioText(row).padStart(8)}  ${row.why}`);
}

// The kill-mix correction over the mains' starting spot rows: quantiles per kind.
function printCorrection(view, accounts) {
    const factors = { drop: [], spoil: [] };
    accounts.forEach((account, index) => {
        const main = Engine.mainOf(account, index, view, Run.STAGE_BANDS), row = !main.station && Engine.spotRowOf(view, main);
        if (!row) return;
        const factor = Engine.killMixCorrection(view, row, main.level);
        if (row.dropLoot > 0) factors.drop.push(factor.drop);
        if (row.spoilLoot > 0) factors.spoil.push(factor.spoil);
    });
    const at = (values, share) => values.slice().sort((a, b) => a - b)[Math.floor(share * (values.length - 1))];
    console.log(`KILL-MIX CORRECTION of the spawn-mix yields at the mains' starting rows (p10 / p50 / p90): ${Object.entries(factors)
        .filter(([, values]) => values.length).map(([kind, values]) => `${kind} ${at(values, 0.1).toFixed(2)} / ${at(values, 0.5).toFixed(2)} / ${at(values, 0.9).toFixed(2)} (${values.length} mains)`).join('; ')}`);
}

// The save a today-mode comparison starts from must be the save the snapshot's
// spot rows were read from, and the rows must hold every spot that save names
// for a main (a snapshot built before the model read a bot's travel and stay
// spots has none for them): without them those mains hunt their line's best
// spot and the hunt adena comes out 20-37 % over the real run's. Throws,
// naming how to build the snapshot; returns the save's path. accounts: the
// cohort read from that save.
function requireSpots(snapshot, baseline, accounts) {
    const save = baseline.inputs.start.db, from = snapshot.spotHours?.source || null, rows = snapshot.spotHours?.rows || {};
    const build = `build it with node scripts/economy-model/inputs.js --preset <preset> --spots ${save} and pass it as --snapshot`;
    if (from !== save) throw new Error(`the snapshot has ${from ? `spot rows of another save (${from})` : 'no spot rows'}, the baseline starts from ${save}: ${build}`);
    // The snapshot reads no spot above its top level.
    const top = snapshot.header?.levels?.[1] ?? Infinity;
    const missing = accounts.filter(account => !account.station && account.spot && account.level <= top
        && rows[account.line]?.[account.level]?.[account.spot] === undefined).length;
    if (missing) throw new Error(`the snapshot's spot rows lack ${missing} spots the save names for its mains: ${build}`);
    return save;
}

// The model over a baseline's start population and hours, at today's mechanisms and the given rates.
function modelOf(baseline, snapshot, { view, rates, hunter }, seed, cohort = Cohort.fromSave(baseline.inputs.start.db, snapshot)) {
    const model = Engine.simulate({ view, accounts: cohort.accounts, bands: Run.STAGE_BANDS, rates, hours: baseline.window.hours, seed,
        plane: Today.plane({ view, hunter }), inputs: { cohort: cohort.source, seed, rates } });
    return { model, cohort };
}

function main(argv) {
    const baselineFile = Boot.option(argv, 'baseline', null);
    if (!baselineFile) throw new Error('--baseline <economy ledger JSON> is required');
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const baseline = read(baselineFile), fitFile = Boot.option(argv, 'fit', baselineFile), seed = Number(Boot.option(argv, 'seed', 1));
    const preset = Boot.option(argv, 'preset', 'x50');
    const { snapshot, file } = Load.loadSnapshot(Load.SNAPSHOT_DIR, preset, Boot.option(argv, 'snapshot', null));
    console.log(`SNAPSHOT ${file} (revision ${snapshot.header.revision}); baseline ${baselineFile} (code ${baseline.inputs?.end?.sha || '?'}, ${(baseline.window.hours * 60).toFixed(1)} min, ${baseline.population.bots} bots)`);
    const startCohort = Cohort.fromSave(baseline.inputs.start.db, snapshot);
    console.log(`SPOTS the mains start at their bots' spots in ${requireSpots(snapshot, baseline, startCohort.accounts)}`);
    console.log(`TODAY ${JSON.stringify(Today.TODAY)}`);
    const fitCohort = Cohort.fromSave(read(fitFile).inputs.start.db, snapshot);
    const booted = Date.now(), mode = Today.setup(snapshot, read(fitFile), fitCohort.accounts), { view, rates, basis } = mode;
    console.log(`TODAY kit hours booted in ${((Date.now() - booted) / 1000).toFixed(1)} s`);
    console.log(`FITTED on ${fitFile}: arrivals every 1 / ${rates.default.visitsPerBotHour.toFixed(3)} hours per hunting main (the ledger's arrivals, a lower bound; one value for every band)`);
    Run.printFit(basis);
    printCorrection(view, fitCohort.accounts);
    const began = Date.now();
    const { model, cohort } = modelOf(baseline, snapshot, mode, seed, startCohort);
    console.log(`COHORT ${cohort.source}: lines exact ${cohort.lines.exact}, drawn by class weights ${cohort.lines.drawn}, no line ${cohort.lines.noLine}, stations ${cohort.lines.stations}; run ${((Date.now() - began) / 1000).toFixed(1)} s`);
    console.log(`HUNTING HOURS at the mains' own spots ${model.huntHours.ownSpot}, at their line's best ${model.huntHours.bestSpot}`);
    const shared = sharedRows(baseline, model, snapshot.items), today = todayRows(baseline, model);
    printShared(shared, `THE RULES THE MODEL KEEPS: today mode against ${baselineFile}`);
    printToday(today, 'TODAY\'S MECHANISMS, IMITATED COARSELY, NOT A VALIDATION (baseline, model, ratio, why they differ)');
    console.log(`  model counters: ${Object.entries(model.counters).map(([name, n]) => `${name} ${n}`).join(' | ')}`);
    const results = { baseline: baselineFile, shared, today, model };
    for (const other of String(Boot.option(argv, 'others', '')).split(',').filter(Boolean)) {
        const real = read(other);
        const { model: theirs } = modelOf(real, snapshot, mode, seed);
        printShared(sharedRows(real, theirs, snapshot.items), `OTHER CODE ERA, NOT A VALIDATION: ${other} (code ${real.inputs?.end?.sha || 'older'}, ${(real.window.hours * 60).toFixed(1)} min; same fit)`);
    }
    for (const line of footerOf(baseline, preset)) console.log(line);
    Run.printFooter();
    const json = Boot.option(argv, 'json', null);
    if (json) fs.writeFileSync(json, `${JSON.stringify(results, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { footerOf, requireSpots, judged, sharedRows, todayRows, realDrops, realHotDrops, modelDrops, RELATIVE, MIN_UNITS, DROP_CLASSES };

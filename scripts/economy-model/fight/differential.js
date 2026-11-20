'use strict';
// Two trees of the game on the same cells and seeds: each hunts every cell
// through its own generator (Generator.hunt, the table's row hunt) and the
// table lists kills, deaths per kill and rest per kill side by side, flagging
// each delta past the simulation's noise floor: the p90 spread of a cell's
// hunt over seeds, measured on the generator's hunt (kills 4.2 %, rest per kill
// 6.2 %, deaths per kill 0.010 absolute).
// node scripts/economy-model/fight/differential.js <old tree> <new tree> [--seeds 10] [--hours 2] [--cells <catalogue>]
// cells: a catalogue with { cells, spots, profiles } (default: the invariant test's fixture).
const path = require('path');
const { spawnSync } = require('child_process');

const NOISE = { kills: 0.042, rest: 0.062, deathsPerKill: 0.010 };

// One tree's hunts: per cell, summed over the seeds (a seed is the spot id's suffix:
// the hunt's rolls are seeded by spot, class and level).
function child(tree, catalogue, seeds, hours) {
    process.chdir(tree);
    require(path.join(tree, 'src/Global'));
    const Generator = require(path.join(tree, 'scripts/generate-spot-table'));
    const Decompose = require(path.join(tree, 'scripts/economy-model/fight/decompose'));
    Generator.loadSimulation(catalogue);
    const { cells, profiles } = require(catalogue);
    const byId = new Map(profiles.map((profile) => [String(profile.id), profile]));
    const out = cells.map((cell) => {
        const base = Decompose.speciesSpot(byId.get(cell.spotId), cell.selfId);
        const classId = Generator.classFor(cell.line, cell.level);
        const total = { kills: 0, deaths: 0, restMs: 0, spanMs: 0 };
        for (let seed = 0; seed < seeds; seed++) {
            const spot = seed ? { ...base, id: `${base.id}#${seed}` } : base;
            const sum = Generator.hunt(spot, cell.line, cell.level, cell.form, hours, undefined, Decompose.creationKit(classId), classId);
            total.kills += sum.mobs;
            total.deaths += sum.deaths;
            total.restMs += sum.restMs;
            total.spanMs += sum.spanMs || hours * 3600000; // an older generator records no span: its nominal hours
        }
        return { cell: `${cell.spotId}/${cell.selfId} L${cell.level} line ${cell.line}`, ...total };
    });
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
}

function run(tree, catalogue, seeds, hours) {
    const result = spawnSync(process.execPath, [__filename, '--child', path.resolve(tree), catalogue, String(seeds), String(hours)],
        { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }, maxBuffer: 1 << 26 });
    if (result.status !== 0) throw new Error(`${tree}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

// Per kill and per hour of the summed hunts; flags past the noise floor.
function compare(name, a, b) {
    const kph = (x) => x.kills / (x.spanMs / 3600000), dpk = (x) => (x.kills ? x.deaths / x.kills : 0), rpk = (x) => (x.kills ? x.restMs / 1000 / x.kills : 0);
    const ratio = (x, y) => (x > 0 ? y / x : (y > 0 ? Infinity : 1));
    const k = ratio(kph(a), kph(b)), d = dpk(b) - dpk(a), r = ratio(rpk(a), rpk(b));
    const flags = [Math.abs(k - 1) > NOISE.kills ? 'kills' : '', Math.abs(d) > NOISE.deathsPerKill ? 'deaths' : '',
        a.kills && b.kills && Math.abs(r - 1) > NOISE.rest ? 'rest' : ''].filter(Boolean);
    return `${name.padEnd(34)} kills/h ${kph(a).toFixed(1).padStart(7)} -> ${kph(b).toFixed(1).padStart(7)} x${k.toFixed(3)}`
        + `  deaths/kill ${dpk(a).toFixed(4)} -> ${dpk(b).toFixed(4)} ${d >= 0 ? '+' : ''}${d.toFixed(4)}`
        + `  rest s/kill ${rpk(a).toFixed(2).padStart(6)} -> ${rpk(b).toFixed(2).padStart(6)} x${r.toFixed(3)}`
        + (flags.length ? `  FLAG ${flags.join(',')}` : '');
}

function main(argv) {
    if (argv[0] === '--child') return child(argv[1], argv[2], Number(argv[3]), Number(argv[4]));
    const opt = (key, fallback) => { const index = argv.indexOf(`--${key}`); return index < 0 ? fallback : argv[index + 1]; };
    const [oldTree, newTree] = argv;
    if (!oldTree || !newTree) throw new Error('usage: differential.js <old tree> <new tree> [--seeds 10] [--hours 2] [--cells <catalogue>]');
    const seeds = Number(opt('seeds', 10)), hours = Number(opt('hours', 2));
    const catalogue = path.resolve(opt('cells', path.join(__dirname, '../../../tests/fixtures/cold_sim_invariants.json')));
    const a = run(oldTree, catalogue, seeds, hours), b = run(newTree, catalogue, seeds, hours);
    console.log(`old ${oldTree}\nnew ${newTree}\n${a.length} cells x ${seeds} seeds x ${hours} h; noise floor kills ${NOISE.kills * 100} %, rest ${NOISE.rest * 100} %, deaths/kill ${NOISE.deathsPerKill}`);
    const total = (rows) => rows.reduce((sum, row) => ({ kills: sum.kills + row.kills, deaths: sum.deaths + row.deaths, restMs: sum.restMs + row.restMs, spanMs: sum.spanMs + row.spanMs }),
        { kills: 0, deaths: 0, restMs: 0, spanMs: 0 });
    a.forEach((row, index) => console.log(compare(row.cell, row, b[index])));
    console.log(compare('TOTAL', total(a), total(b)));
}

if (require.main === module) main(process.argv.slice(2));

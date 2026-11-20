'use strict';
// The model's hunt table measures a bot's own combat per species, with the
// game's solo readiness lifted: a level-1 orc mystic, whom the game's gate
// keeps off every gremlin, gets measured kills, deaths and per-kill times at a
// gremlin spot, in parts that add up to the hunt's time (so species combine on
// time); and the builder refuses to build when the lift no longer reaches the
// fight (a table built then would measure the gate).
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const HuntTable = require('../scripts/economy-model/hunt-table');
const Invariants = require('../scripts/economy-model/fight/invariants');

const GREMLIN_SPOT = '-12_43';
// A dark elf fighter at level 15 hunts differently by night; a 2 h hunt from
// the builder's start holds 60 night minutes in UTC and 6 in Europe/Kiev.
const NIGHT_SPOT = '-2_1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-table-test-'));
const catalogue = path.join(dir, 'catalogue.json');
const built = Generator.buildCatalogue();
fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
const gremlins = built.profiles.find(spot => String(spot.id) === GREMLIN_SPOT);
assert(gremlins, `the catalogue has the gremlin spot ${GREMLIN_SPOT}`);
const species = [...new Set(gremlins.npcEntries.map(entry => Number(entry.selfId)))];
assert.equal(species.length, 1, 'one species there');

const key = Generator.botFor('51', 1);
const options = { from: 1, to: 1, hours: 1, children: 1, spots: [GREMLIN_SPOT], keys: [key], catalogue, out: path.join(dir, 'hunt.json'), log: () => {} };

(async () => {
    try {
        const { file, table } = await HuntTable.build(options);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), table, 'the file holds the table');
        assert.match(table.stamp, /^[0-9a-f]{12}$/);
        // the rest rule's value is a cell input, so it moves the stamp; the kill-death limit is read at read time and does not
        assert.strictEqual(HuntTable.stamp(), table.stamp);
        assert.notStrictEqual(HuntTable.stamp({ fightCover: 1.25 }), table.stamp, 'another rest bound is another table');
        const at = Object.fromEntries(table.fields.map((field, index) => [field, index]));
        for (const field of ['kills', 'deaths', 'fight', 'rest', 'walk', 'exp', 'shots', 'pull']) assert(field in at, `a cell carries ${field}`);
        const bodies = Object.keys(table.bodies).filter(body => body.startsWith(`${key}|1|`));
        assert.equal(bodies.length, 1, 'one body: the creation kit\'s point');
        const body = table.bodies[bodies[0]];
        assert(body.runSpd > 0 && body.reach >= 0, 'the body\'s walk inputs');
        const spot = table.spots[GREMLIN_SPOT];
        assert(spot.area > 0 && spot.density > 0 && spot.species[species[0]].count > 0, 'the spot\'s statics');
        const forms = table.cells[bodies[0]][GREMLIN_SPOT][species[0]];
        assert.equal(forms.length, table.forms.length, 'bare and shots');
        for (const [form, cell] of forms.entries()) {
            const name = table.forms[form];
            assert(cell[at.kills] > 0, `${name}: measured kills (the game's gate allows none)`);
            assert(Number.isFinite(cell[at.deaths]) && cell[at.deaths] >= 0, `${name}: measured deaths a kill`);
            assert(cell[at.fight] > 0, `${name}: the fight a kill, without the walk`);
            assert(cell[at.pull] >= 1, `${name}: mobs per engagement`);
            // Time per kill = fight + rest + other + walk: the hour holds kills x that.
            const perKill = cell[at.fight] + cell[at.rest] + cell[at.other] + cell[at.walk];
            assert(Math.abs(perKill * cell[at.kills] - 3600) < 3600 * 0.01, `${name}: the parts make the hour (${perKill} s x ${cell[at.kills]})`);
        }
        // No cell's other time below the rounding; the parts tile each cell's hour per kill.
        assert.deepEqual(Invariants.checkTable(table, { rounding: Generator.ROUNDING }), [], 'the table keeps the conservation laws');

        // The game ignores the lift's option (a renamed or removed solo-safety switch): the gate stays.
        const TM = invoke('GameServer/Bot/AI/BotTargetMatchup'), CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
        const real = { spotShares: TM.spotShares, npcForSpot: CCP.npcForSpot };
        TM.spotShares = (profiles, at, more = {}) => real.spotShares(profiles, at, { ...more, soloSafety: true });
        CCP.npcForSpot = (at, roll, more = {}) => real.npcForSpot(at, roll, { ...more, soloSafety: true });
        try {
            await assert.rejects(HuntTable.build({ ...options, out: path.join(dir, 'refused.json') }), /lift no longer reaches/);
            assert(!fs.existsSync(path.join(dir, 'refused.json')), 'nothing written');
        } finally {
            Object.assign(TM, { spotShares: real.spotShares });
            Object.assign(CCP, { npcForSpot: real.npcForSpot });
        }
        // The resolver stops reading the readiness rule through its module object: the lift's write does not reach it.
        const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness'), evaluate = ER.evaluate;
        Object.defineProperty(ER, 'evaluate', { get: () => evaluate, set: () => {}, configurable: true, enumerable: true });
        try {
            await assert.rejects(HuntTable.build({ ...options, out: path.join(dir, 'refused.json') }), /lift no longer reaches/);
        } finally {
            Object.defineProperty(ER, 'evaluate', { value: evaluate, writable: true, configurable: true, enumerable: true });
        }
        // A build stopped after its hunts (the combat inputs change under it) leaves its parts.
        const TF = invoke('GameServer/Bot/AI/TableFingerprint'), computeReal = TF.compute;
        const stopped = async more => {
            let calls = 0;
            TF.compute = (...args) => { calls += 1; const got = computeReal(...args); return calls === 1 ? got : { ...got, hash: `${got.hash}x` }; };
            try { await assert.rejects(HuntTable.build(more), /combat inputs changed/); } finally { TF.compute = computeReal; }
        };
        const seeded = { ...options, out: path.join(dir, 'seeded.json') }, lines = [];
        const run = more => HuntTable.build({ ...more, log: line => lines.push(line) });
        await stopped(seeded);
        const left = fs.readdirSync(`${seeded.out}.parts`).filter(name => name.endsWith('.jsonl'));
        assert(left.length > 0, 'the stopped build left its hunts');
        const again = await run(seeded);
        assert(lines.some(line => /round species: [1-9]\d* hunts already .* 0 to run/.test(line)), 'the hunts of the same inputs are not run again');
        assert.deepEqual(again.table, table, 'the resumed table is the built one');

        // Parts made under other hours are cleared, not reused.
        const other = { ...options, out: path.join(dir, 'other.json') };
        await stopped(other);
        lines.length = 0;
        const longer = await run({ ...other, hours: 2 });
        assert(lines.some(line => /were made under other inputs: cleared/.test(line)), 'the parts of other hours are cleared');
        assert(lines.some(line => /round species: 0 hunts already/.test(line)), 'none of them is reused');
        assert.equal(longer.table.hours, 2);

        // Split over machines: each share hunts its every n-th hunt and writes no
        // table; the join hunts nothing, refuses while a share is missing, and
        // gives the table the one machine built.
        const split = { ...options, out: path.join(dir, 'split.json') };
        const first = await HuntTable.build({ ...split, shard: { i: 1, n: 2 } });
        assert.equal(first.file, null, 'a share writes no table');
        assert(!fs.existsSync(split.out), 'no table file from a share');
        await assert.rejects(HuntTable.build({ ...split, join: true }), /round species: 1 hunts without a result/);
        assert(!fs.existsSync(split.out), 'no table file from a refused join');
        await HuntTable.build({ ...split, shard: { i: 2, n: 2 } });
        const shares = fs.readdirSync(`${split.out}.parts`).filter(name => name.endsWith('.jsonl'));
        assert.deepEqual(shares.map(name => name.replace(/^[0-9a-f]{12}-/, '')).sort(), ['species-s1-0.jsonl', 'species-s2-0.jsonl'],
            'a share\'s parts are named by its number, not the pid (two machines can share one)');
        lines.length = 0;
        const joined = await run({ ...split, join: true });
        assert(lines.some(line => /round species: 2 hunts already .* 0 to run/.test(line)), 'the join runs no hunt');
        assert.deepEqual(joined.table, table, 'the joined table is the one machine\'s');

        // A build is one in every zone: the game day counts from local midnight,
        // so the builder runs in UTC, and a laptop build equals the fork's.
        const zoned = zone => new Promise((resolve, reject) => {
            const out = path.join(dir, `zone-${zone.replace('/', '-')}.json`);
            const child = childProcess.spawn(process.execPath, [path.join(__dirname, '../scripts/economy-model/hunt-table.js'), '--levels', '15-15',
                '--keys', Generator.botFor('34', 15), '--spots', NIGHT_SPOT, '--children', '1', '--catalogue', catalogue, '--out', out],
            { env: { ...process.env, TZ: zone }, stdio: ['ignore', 'ignore', 'inherit'] });
            child.on('exit', code => code === 0 ? resolve(JSON.parse(fs.readFileSync(out, 'utf8')).cells) : reject(new Error(`build in ${zone} exited ${code}`)));
        });
        const [utc, kiev] = await Promise.all([zoned('UTC'), zoned('Europe/Kiev')]);
        assert(Object.keys(utc).length > 0, 'the night body has cells');
        assert.deepEqual(kiev, utc, 'a build in Europe/Kiev gives the cells of a build in UTC');
        assert.deepEqual(Invariants.checkTable({ fields: table.fields, cells: utc }, { rounding: Generator.ROUNDING }), [], 'the night body\'s 2 h cells keep the conservation laws');
        console.log('test_economy_model_hunt_table: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exit(1); });

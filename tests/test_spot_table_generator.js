const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The spot table generator on two spots with short hunts: the same file with
// one worker and with two, and every count in place. About half a minute
// (the world spawn takes most of it).
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-table-'));
function generate(jobs) {
    const out = path.join(dir, `table-${jobs}.json`);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-spot-table.js'),
        '--spots=2', '--hours=0.1', '--curve-hours=0.05', `--jobs=${jobs}`, `--out=${out}`],
    { cwd: root, encoding: 'utf8', env: { ...process.env } });
    assert.strictEqual(result.status, 0, `generator failed: ${result.stderr}`);
    return fs.readFileSync(out, 'utf8');
}

try {
    const one = generate(1);
    const two = generate(2);
    assert.strictEqual(one, two, 'the table does not depend on the number of workers');
    const table = JSON.parse(one);
    const roles = table.roles.length;
    // A key per C4 class line (its second profession), the author's role names as aliases (user 10-29).
    assert.strictEqual(roles, 31, 'a key per second-profession class line');
    assert.strictEqual(table.header.inputs.roleLines.dps, '2');
    assert.deepStrictEqual(table.header.inputs.roleClasses['3'], [0, 1, 3], 'a line holds its classes by profession stage');
    assert.deepStrictEqual(table.shots, [1, 0, 2], 'shots, none, blessed spiritshot');
    assert.strictEqual(table.spots.length, 2);
    assert.strictEqual(table.header.counts.spots, 2);
    assert.strictEqual(table.header.counts.rows, 2 * roles * 3);
    assert.strictEqual(table.rows.length, 2);
    assert(table.rows.every((rows) => rows.length === roles * 3), 'a row per role and shots');
    const dps = table.roles.indexOf(table.header.inputs.roleLines.dps);
    assert(table.rows.every((rows) => rows[dps * 3 + 2] === null), 'no blessed spiritshot row for a soulshot class');
    assert(table.rows.flat().every((row) => row === null || row.length === table.rowFields.length), 'complete rows');
    assert.strictEqual(table.rows.flat().filter(Boolean).length, table.header.counts.huntableRows);
    assert(table.header.counts.huntableRows > 0, 'the first spots are huntable');
    assert(table.header.counts.catalogueSpots > 1500, 'the spawned world has its hunting spots');
    assert.strictEqual(table.header.inputs.rate, 'x1');
    assert(/^[0-9a-f]{7,}/.test(table.header.revision), 'the revision is recorded');
    assert(table.spots.every((spot) => spot.length === 9 && spot[3] > 0 && spot[4] === 1 && spot[5] > 0 && spot[6] > 0
        && spot[7] > 0 && spot[8] > 0),
        'every spot has its level, density, kill cap, a pull of one monster, its loot response to the rate and its kills\' accuracy and evasion');
    // Per-mob rows (user 10-29): mobs per fight, the cap of the spawns the bot may fight, the kills by species.
    const field = name => table.rowFields.indexOf(name);
    for (const row of table.rows.flat().filter(Boolean)) {
        assert(row[field('pull')] >= 1 && row[field('cap')] > 0, 'a row has its pull and its own cap');
        const mix = row[field('mix')];
        assert(Array.isArray(mix) && mix.length >= 2 && mix.length % 2 === 0, 'a row has its kill mix');
        const shares = mix.filter((_, at) => at % 2 === 1);
        assert(Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) < 0.01, 'the mix shares make the kills');
        // The gate per gap (T106): cap x 256 + the mix species that bot may fight, open at the reference.
        const gate = row[field('gate')];
        assert(Array.isArray(gate) && gate.length === table.gaps.length, 'a gate value per gap');
        const reference = gate[table.gaps.findLastIndex(gap => gap <= row[field('refGap')])];
        assert(reference > 0 && reference % 256 > 0 && reference % 256 < 1 << (mix.length / 2), 'the reference gap is open');
    }
    // Gladiator and Warlord lines are one Warrior below 40: a row read there is measured once.
    const gladiator = table.roles.indexOf('2'), warlord = table.roles.indexOf('3'), exp = field('exp');
    table.rows.forEach((rows, spot) => {
        const row = rows[gladiator * 3];
        if (row && table.spots[spot][1] + row[field('refGap')] < 40) {
            assert.strictEqual(rows[warlord * 3][exp], row[exp], 'lines of one class share its hunt');
        }
    });
    // The kit surface (user 10-29): fight and damage-taken coefficients per
    // line and band over the kit features, fitted from real fights in kits.
    assert.deepStrictEqual(table.kitSurface.features, ['offence', 'pDefence', 'mDefence', 'hp']);
    const surfaces = Object.values(table.kitSurface.rows).flatMap((byBand) => Object.values(byBand));
    assert(surfaces.length > 0, 'a band has its kit surface');
    for (const [fight, taken, points] of surfaces) {
        // taken null: a line that kills before contact in every kit (a bow below 40 too).
        assert(fight.length === 4 && (taken === null || taken.length === 4) && points >= 8, 'four coefficients each, from enough kits');
        assert(fight[0] < 0, `a stronger weapon shortens the fight: ${fight}`);
    }
    for (const role of Object.keys(table.curves)) {
        for (const curve of Object.values(table.curves[role])) {
            assert(table.curveFields.every((field) => curve[field].length === table.gaps.length), 'a curve value per gap');
            assert.strictEqual(curve.kph[table.gaps.indexOf(table.header.inputs.refGap)], 1, 'curves are relative to the reference gap');
        }
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('Spot table generator determinism and counts passed');

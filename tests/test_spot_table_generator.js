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
    assert.strictEqual(roles, 8, 'eight combat roles');
    assert.deepStrictEqual(table.shots, [1, 0]);
    assert.strictEqual(table.spots.length, 2);
    assert.strictEqual(table.header.counts.spots, 2);
    assert.strictEqual(table.header.counts.rows, 2 * roles * 2);
    assert.strictEqual(table.rows.length, 2);
    assert(table.rows.every((rows) => rows.length === roles * 2), 'a row per role and shots');
    assert(table.rows.flat().every((row) => row === null || row.length === table.rowFields.length), 'complete rows');
    assert.strictEqual(table.rows.flat().filter(Boolean).length, table.header.counts.huntableRows);
    assert(table.header.counts.huntableRows > 0, 'the first spots are huntable');
    assert(table.header.counts.catalogueSpots > 1500, 'the spawned world has its hunting spots');
    assert.strictEqual(table.header.inputs.rate, 'x1');
    assert(/^[0-9a-f]{7,}/.test(table.header.revision), 'the revision is recorded');
    assert(table.spots.every((spot) => spot.length === 5 && spot[3] > 0 && spot[4] === 1),
        'every spot has its level, density, kill cap and a pull of one monster');
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

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TableFingerprint = require('../src/GameServer/Bot/AI/TableFingerprint');

// A bot table against the files it was simulated by: `npm run check`
// (scripts/check-tables.js) passes a table of the current files, fails a
// table whose files moved naming the table and the files, warns only on a
// table built before fingerprints, and fails an input list naming a missing
// file. Run on a scratch tree holding a placeholder of every listed input.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'table-fingerprint-'));
const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
};
// Off CI: without --strict and without the CI flag the runner sets (CI=true makes every check strict).
const offCi = { ...process.env };
delete offCi.CI;
const check = (strict = true) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-tables.js'), `--root=${root}`, ...(strict ? ['--strict'] : [])],
    { encoding: 'utf8', env: strict ? process.env : offCi });
const table = (file, generator, fingerprint) => put(file, JSON.stringify({ header: { generator, revision: 'abc123', fingerprint }, rows: [] }));
const SPOT = 'scripts/generate-spot-table.js', HUNT = 'scripts/hunt-tables/build.js';

// The list names files of this checkout (a rename or move updates it, else `npm run check` fails).
for (const kind of Object.keys(TableFingerprint.INPUTS)) {
    assert.deepStrictEqual(TableFingerprint.files(kind).missing, [], `every input of the ${kind} tables exists here`);
}

try {
    for (const input of new Set([...TableFingerprint.INPUTS.spot, ...TableFingerprint.INPUTS.hunt])) {
        if (/\.(js|json)$/.test(input)) put(input, `// ${input}\n`);
        else put(`${input}/a.json`, '{"a":1}\n');
    }
    const spot = TableFingerprint.compute('spot', root);
    assert.deepStrictEqual(spot.missing, [], 'every listed input exists');
    assert.deepStrictEqual(TableFingerprint.compute('spot', root), spot, 'unchanged files: the same fingerprint');
    assert(spot.files['data/Npcs/a.json'] && spot.files['src/GameServer/Formulas.js'], 'a directory counts every file under it');
    assert(!spot.files['data/Bots/spot-reward-npcs.json'] && TableFingerprint.compute('hunt', root).files['data/Bots/spot-reward-npcs.json'],
        'the reward catalogue is an input of the hunt tables only');
    put('data/Npcs/.DS_Store', 'x');
    put('data/Npcs/NOTES.md', 'x');
    put('src/GameServer/Formulas.js', `// src/GameServer/Formulas.js\r\n`);
    assert.strictEqual(TableFingerprint.compute('spot', root).hash, spot.hash, 'dot files, notes and CRLF line ends change nothing');

    table('data/Bots/spot-table.json', SPOT, TableFingerprint.fingerprint('spot', root));
    table('data/Bots/hunt/mobs.json', HUNT, TableFingerprint.fingerprint('hunt', root));
    table('data/Bots/hunt/henna.json', HUNT, undefined);
    let result = check();
    assert.strictEqual(result.status, 0, `current tables pass: ${result.stderr}`);
    assert.match(result.stderr, /warning: Bot table data\/Bots\/hunt\/henna\.json \(built at abc123\): no fingerprint/,
        'a table built before fingerprints only warns');
    assert.match(result.stdout, /2 tables match their inputs, 1 warning/);

    put('src/GameServer/Formulas.js', '// a changed formula\n');
    assert.notStrictEqual(TableFingerprint.compute('spot', root).hash, spot.hash, 'a changed input: another fingerprint');
    result = check(false);
    assert.strictEqual(result.status, 0, 'off CI a stale table only warns');
    assert.match(result.stderr, /warning: Stale bot table data\/Bots\/spot-table\.json/);
    result = check();
    assert.strictEqual(result.status, 1, 'a stale table fails the check on CI / --strict');
    assert.match(result.stderr, /error: Stale bot table data\/Bots\/spot-table\.json \(built at abc123\): 1 input file changed since: src\/GameServer\/Formulas\.js\. Rebuild on the fork: tables\/spot\//);
    assert.match(result.stderr, /error: Stale bot table data\/Bots\/hunt\/mobs\.json .*src\/GameServer\/Formulas\.js\. Rebuild on the fork: tables\/hunt\//);

    put('src/GameServer/Formulas.js', `// src/GameServer/Formulas.js\n`);
    put('data/Bots/spot-reward-npcs.json', '{"rows":[]}\n');
    put('data/Items/b.json', '{}\n');
    result = check();
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Stale bot table data\/Bots\/spot-table\.json .*: 1 input file changed since: data\/Items\/b\.json\./,
        'a new file under a listed directory moves the table');
    assert.match(result.stderr, /Stale bot table data\/Bots\/hunt\/mobs\.json .*: 2 input files changed since: data\/Bots\/spot-reward-npcs\.json, data\/Items\/b\.json\./,
        'a hunt-only input moves the hunt tables');

    fs.rmSync(path.join(root, 'data/Items/b.json'));
    fs.rmSync(path.join(root, 'src/GameServer/Bot/Population/ColdTrip.js'));
    result = check();
    assert.strictEqual(result.status, 1, 'a listed input gone fails the check');
    assert.match(result.stderr, /lists inputs of the spot table that do not exist: src\/GameServer\/Bot\/Population\/ColdTrip\.js/);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log('Table fingerprint check passed');

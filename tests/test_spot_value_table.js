const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
// ---------------------------------------------------------------- lookups on a hand-made table
// Spot S (level 18, the spot allows 250 kills per hour) and T (allows 48): dps rows with and without
// shots measured at gap 6, a spoiler row, and the dps curve of the spots' band.
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
process.env.L2NODE_PROGRESSION_RATE = 'x1';

const ref = Table.value('S', 'dps', 24, true);
near(ref.kills, 200, 'at the reference level the row\'s kills');
// ARCH-NOTE: the shipped reader already applies the C4 gap-six XP/SP penalty;
// this older fixture expected unpenalized rewards. Preserve that gameplay rule.
near(ref.exp, 20000 * (5 / 6), 'exp per hour = kills x exp per kill x gap-six penalty');
near(ref.sp, 1000 * (5 / 6), 'SP per hour follows the same C4 penalty');
near(ref.adena, 6000, 'adena per hour');
near(ref.loot, 4000, 'loot per hour');
near(ref.shots, 800, 'shots per hour');
near(ref.deaths, 0.2, 'deaths per hour = kills x deaths per kill');
near(ref.busyShare, 0.5, 'combat and recovery share of the hour');
assert.strictEqual(ref.stacks, null, 'an old table does not invent zero bag growth');
near(Table.value('S', 'dps', 18).kills, 100, 'at the spot\'s level the curve halves the kills');
near(Table.value('S', 'dps', 18).deaths, 100 * (0.001 + 0.01), 'deaths per kill add the curve\'s difference');
near(Table.value('S', 'dps', 19).kills, 200 * 0.625, 'between measured gaps the curve is linear');
near(Table.value('S', 'dps', 30).kills, 240, 'higher levels follow the curve');
near(Table.value('S', 'dps', 40).kills, 240, 'beyond the last gap the curve is flat');
near(Table.value('S', 'dps', 29).adena, 200 * 1.2 * 30 * 0.375, 'adena follows its curve (deep blue)');
near(Table.value('S', 'dps', 29).loot, 200 * 1.2 * 20 * 0.375, 'loot follows the adena curve');
near(Table.value('S', 'dps', 90).kills, Table.value('S', 'dps', 78).kills, 'levels above the maximum count as the maximum');
near(Table.value('T', 'dps', 24).kills, 48, 'kills never exceed what the spot\'s monster count allows');
assert.strictEqual(Table.value('S', 'dps', 15), null, 'below the lowest level that finds a safe target: no solo hunt');
assert.strictEqual(Table.value('S', 'dps', 24, false), null, 'no row: no value');
assert.strictEqual(Table.value('X', 'dps', 24), null, 'unknown spot');
assert.strictEqual(Table.value('S', 'healer', 24), null, 'unknown role');
near(Table.value('S', 'spoiler', 18).kills, 150, 'a role without a measured curve keeps its row at every level');
assert.strictEqual(Table.referenceLevel('S', 'spoiler'), 24, 'the level the row was measured at');
assert.strictEqual(Table.spotLevel('T'), 18);

// Rates: kills do not change, exp, SP and adena scale with the server's rates, loot with the spot's
// measured response to the drop rate (S keeps 0.8 of rate x loot at x10, 0.6 at x50).
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const x10 = Table.value('S', 'dps', 24, true);
near(x10.kills, ref.kills, 'the rate does not change the fights');
near(x10.exp, ref.exp * 10, 'exp x rate');
near(x10.sp, ref.sp * 10, 'SP x rate');
near(x10.adena, ref.adena * 10, 'adena x rate');
near(x10.loot, ref.loot * 10 * 0.8, 'loot x rate x the spot\'s response to the drop rate');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
near(Table.value('S', 'dps', 24, true).loot, ref.loot * 50 * 0.6, 'and at x50');
near(Table.value('T', 'dps', 24, true).loot, Table.value('T', 'dps', 24, true).kills * 20 * 50, 'a spot whose drops scale fully');
process.env.L2NODE_PROGRESSION_RATE = 'x1';

// New tables report distinct bag slots per hour, with the drop response and
// without multiplying distinct kinds by the drop amount rate.
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spot-stacks-'));
try {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spot_table.json'), 'utf8'));
    fixture.rowFields.push('stacks');
    for (const rows of fixture.rows) for (const row of rows) if (row) row.push(.02);
    const file = path.join(scratch, 'table.json');
    fs.writeFileSync(file, JSON.stringify(fixture));
    Table.useFile(file);
    near(Table.value('S', 'dps', 24).stacks, 4, '200 kills x .02 new slots per kill');
    process.env.L2NODE_PROGRESSION_RATE = 'x10';
    near(Table.value('S', 'dps', 24).stacks, 4 * .8, 'distinct slots use the drop response, not the drop amount');
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    near(Table.value('S', 'dps', 24).stacks, 4 * .6, 'the high-rate response also preserves distinct kinds');
    fixture.rows[0][0][fixture.rowFields.indexOf('stacks')] = null;
    fs.writeFileSync(file, JSON.stringify(fixture));
    Table.useFile(file);
    assert.strictEqual(Table.value('S', 'dps', 24).stacks, null, 'an absent regenerated measurement remains unknown');
} finally {
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    Table.useFile();
    fs.rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the committed table
const raw = JSON.parse(fs.readFileSync(Table.DEFAULT_FILE, 'utf8'));
assert.strictEqual(raw.rows.length, raw.spots.length, 'one row set per spot');
assert(raw.rows.every((rows) => rows.length === raw.roles.length * raw.shots.length), 'every spot has a row per role and shots');
assert(raw.rows.flat().every((row) => row === null || row.length === raw.rowFields.length), 'every row has every field');
assert.strictEqual(raw.rows.flat().filter(Boolean).length, raw.header.counts.huntableRows, 'header counts the huntable rows');
assert(raw.roles.every((role) => Object.keys(raw.curves[role] || {}).length > 0), 'every role has curves');
assert.strictEqual(raw.header.inputs.rate, 'x1', 'the file is at rate x1');

// A few spots of the committed table (rate x1). Bearded Keltir fields (level 2): every role hunts it;
// a dps kills more with shots, more at a higher level, and never more than the spot allows.
Table.useFile();
const keltir = Table.value('-15_42', 'dps', 5, true);
assert(keltir && keltir.kills > 100 && keltir.kills <= 275.2 && keltir.exp > 0 && keltir.adena > 0, 'a low field gives a dps kills, exp and adena');
assert(Table.value('-15_42', 'dps', 5, false).kills <= keltir.kills, 'shots do not slow a dps');
assert(Table.value('-15_42', 'dps', 12, true).kills >= keltir.kills, 'a higher dps kills at least as fast');
assert(raw.roles.every((role) => Table.value('-15_42', role, 8, true)), 'every role hunts the newbie field');
// Level 44 spot 7_34: the dps row was measured six levels up; far below the spot there is no solo hunt.
assert.strictEqual(Table.referenceLevel('7_34', 'dps'), 50);
assert(Table.value('7_34', 'dps', 50).exp > Table.value('-15_42', 'dps', 8).exp * 5, 'higher spots give much more exp');
assert.strictEqual(Table.value('7_34', 'dps', 30), null, 'no solo hunt far below the spot\'s level');
// Seven Signs catacombs are not solo hunting grounds in the author's rules.
assert(raw.roles.every((role) => Table.value('8_23:catacomb_of_the_heretics', role, 50) === null), 'catacombs: no solo row');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const keltirX10 = Table.value('-15_42', 'dps', 5, true);
near(keltirX10.exp, keltir.exp * 10, 'the committed table scales exp with the rate');
process.env.L2NODE_PROGRESSION_RATE = 'x1';

console.log('Spot value table lookups, curves, caps, rates and the committed table passed');

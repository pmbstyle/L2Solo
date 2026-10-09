'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module');
require('../src/Global');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const filename = require.resolve('../src/GameServer/Bot/AI/SpotValueTable');
const source = fs.readFileSync(filename, 'utf8');
// Bypass only local scalar reuse in the native table evaluator.
const scalarPattern = /const expRatio = ratio\('exp'\), busyRatio = ratio\('busy'\), adenaRatio = ratio\('adena'\);\s*const gapFactor = expGapFactor\(gap\), lootFactor = lootRateFactor\(t.spots\[s\], rates.drop\);/;
assert(scalarPattern.test(source));
let old = source.replace(scalarPattern, '');
old = old.replace(/\bexpRatio\b/g, "ratio('exp')").replace(/\bbusyRatio\b/g, "ratio('busy')")
    .replace(/\badenaRatio\b/g, "ratio('adena')").replace(/\* gapFactor\b/g, '* expGapFactor(gap)')
    .replace(/\blootFactor\b/g, 'lootRateFactor(t.spots[s], rates.drop)');
function compiled(text) {
    const m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(text, filename); return m.exports;
}
const reference = compiled(old);
const counts = { current: 0, reference: 0 };
function counted(text, key) {
    const instrumented = text.replace('function at(values, gaps, gap) {',
        `function at(values, gaps, gap) { global.__spotCurveCounts.${key}++;`);
    return compiled(instrumented);
}
global.__spotCurveCounts = counts;
const currentCounted = counted(source, 'current'), oldCounted = counted(old, 'reference');
const fixtureFile = path.join(__dirname, 'fixtures/spot_table.json');
let comparisons = 0;
try {
    for (const file of [fixtureFile, Table.DEFAULT_FILE]) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        Table.useFile(file); reference.useFile(file);
        // Full native roles, diverse spots, fractional level interpolation,
        // capped/invalid/deep-blue levels and missing rows; fresh rate each call.
        const spots = [raw.spots[0][0], raw.spots[1][0], ...raw.spots.filter((_, i) => i % 113 === 0).map(s => s[0]), 'missing'];
        for (const rate of ['x1', 'x10', 'x50']) {
            process.env.L2NODE_PROGRESSION_RATE = rate;
            for (const spot of spots) for (const role of [...raw.roles, 'missing'])
                for (const level of [0, 1, 5, 18, 24, 30.5, 39, 52, 65, 78, 100, NaN]) for (const shots of [true, false]) {
                    assert.deepEqual(Table.value(spot, role, level, shots), reference.value(spot, role, level, shots));
                    comparisons++;
                }
        }
    }
    currentCounted.useFile(fixtureFile); oldCounted.useFile(fixtureFile);
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    assert.deepEqual(currentCounted.value('S', 'dps', 24), oldCounted.value('S', 'dps', 24));
    assert.equal(counts.current, 10, 'four ratios plus two death interpolation reads');
    assert.equal(counts.reference, 18, 'eight repeated ratios plus two death reads');
    const a = Table.value('-15_42', 'dps', 5), b = Table.value('-15_42', 'dps', 5);
    assert.notEqual(a, b, 'each caller still owns a fresh row');
    const expected = structuredClone(b); a.kills = -1;
    assert.deepEqual(Table.value('-15_42', 'dps', 5), expected);
    console.log(`spot arithmetic exact parity PASS: ${comparisons} lookups; interpolation calls ${counts.reference}->${counts.current}`);
} finally {
    delete global.__spotCurveCounts; Table.useFile(); delete process.env.L2NODE_PROGRESSION_RATE;
}

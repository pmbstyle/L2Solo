// One roll by tendency: chances never 0 or 1; one deterministic roll per decision.
const assert = require('assert');
const T = require('../src/GameServer/Bot/AI/TendencyRoll');
const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');

assert.deepStrictEqual([-1, 0, 0.01, 0.5, 0.99, 1, 2, NaN, undefined].map(T.chance), [0.02, 0.02, 0.02, 0.5, 0.98, 0.98, 0.98, 0.02, 0.02]);
assert.strictEqual(T.roll('defense', 7, 9, 1000), T.roll('defense', 7, 9, 1000), 'the same decision reads the same roll');
assert.notStrictEqual(T.roll('defense', 7, 9, 1000), T.roll('defense', 7, 9, 1001), 'another decision rolls again');
assert.strictEqual(T.roll('a', 'b'), seeded('a:b')(), 'the roll is the first draw of the shared seeded stream');
assert.strictEqual(seeded, T.seeded, 'the cold monitor uses the same stream');
let low = 0, sum = 0;
const n = 20000;
for (let i = 0; i < n; i++) {
    const r = T.roll('spread', i);
    assert(r >= 0 && r < 1);
    sum += r; if (r < T.chance(0)) low++;
}
assert(Math.abs(sum / n - 0.5) < 0.01, 'rolls spread evenly');
assert(low > n * 0.01 && low < n * 0.03, 'the floor chance still happens, rarely');
console.log('tendency roll checks passed');

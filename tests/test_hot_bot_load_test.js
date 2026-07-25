const assert = require('assert');
const { parseArguments, appendTail } = require('../scripts/hot-bot-load-test');

assert.deepStrictEqual(parseArguments([]), {
    counts: [50, 100, 200, 300], durationMs: 60000, tickMs: 1000, spreadMs: 100
});
assert.deepStrictEqual(parseArguments(['--counts=25,100', '--duration=12', '--tick=500', '--spread=50']), {
    counts: [25, 100], durationMs: 12000, tickMs: 500, spreadMs: 50
});
assert.throws(() => parseArguments(['--counts=0']), /counts/);
assert.throws(() => parseArguments(['--duration=2']), /duration/);
assert.throws(() => parseArguments(['--tick=100']), /tick/);
assert.throws(() => parseArguments(['--spread=2000']), /spread/);
assert.strictEqual(appendTail('1234', '5678').length, 8, 'short diagnostic output must remain unchanged');
const diagnosticTail = appendTail('x'.repeat(1024 * 1024), 'tail');
assert.strictEqual(diagnosticTail.length, 1024 * 1024, 'diagnostic output must stay bounded');
assert.ok(diagnosticTail.endsWith('tail'), 'diagnostic output must retain the newest text');
console.log('hot bot load runner argument checks passed');

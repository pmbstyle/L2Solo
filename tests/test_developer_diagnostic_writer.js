'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EconomyDiagnosticWriter, FILES } = require('../src/EconomyDiagnosticWriter');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'developer-writer-'));
try {
    const off = new EconomyDiagnosticWriter(path.join(directory, 'off'), {}, { now() { throw Error('off clock'); } });
    assert.equal(off.write(new Proxy([], { get() { throw Error('off payload'); } })), 0); off.cleanup(); off.rotate();
    assert(!fs.existsSync(path.join(directory, 'off'))); assert.deepEqual(off.snapshot(), { enabled: false });
    const writer = new EconomyDiagnosticWriter(directory, { build: 'fixture' }, { enabled: true, maxFile: 1024 });
    const rows = new Array(16).fill(JSON.stringify({ owner: 64, reason: 'x'.repeat(390) }));
    assert.equal(writer.write(rows), 16); assert.equal(writer.snapshot().records, 16);
    assert(writer.snapshot().rotations > 0);
    const names = fs.readdirSync(directory); assert.equal(names.length, FILES);
    for (const name of names) { assert(fs.statSync(path.join(directory, name)).size <= 1024);
        for (const line of fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line)); }
    const tooLarge = JSON.stringify({ reason: 'x'.repeat(950) });
    assert.equal(writer.write([tooLarge]), 0, 'row/header cannot fit a small file: explicit loss');
    assert.equal(writer.snapshot().dropped, 1);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('Diagnostic writer: off no files, bounded batch split/rotation, explicit oversized loss passed');

'use strict';

// When the history thread reports moved outbox rows, the world deletes
// them through the write queue. A failed delete must not retry at once in a
// microtask loop (a lasting SQLite fault would spin without yielding); it is
// retried on the next report from the history thread.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const History = require('../src/HistoryDatabase');
const Statements = require('../src/DatabaseStatements');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-outbox-retry-'));

const originalStart = History.start;
const originalPrepare = Statements.prepare;
let onMoved = null;
let attempts = 0;
let failuresLeft = 0;

History.start = function captureOnMoved(config) {
    onMoved = config.onMoved;
    return originalStart.call(this, config);
};
Statements.prepare = function injectCleanupFailure(connection, sql, ...rest) {
    if (/^DELETE FROM history_outbox\b/.test(sql)) {
        attempts += 1;
        if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('injected outbox cleanup failure');
        }
    }
    return originalPrepare.call(this, connection, sql, ...rest);
};

function turn() {
    return new Promise((resolve) => setImmediate(resolve));
}

(async () => {
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = '';
    Database.init();
    assert.strictEqual(typeof onMoved, 'function', 'Database.init hands its cleanup callback to the history thread');

    failuresLeft = 3;
    onMoved(7);
    await turn();
    assert.strictEqual(attempts, 1, 'a failed cleanup must not retry before the event loop turns');
    for (let i = 0; i < 5; i++) await turn();
    assert.strictEqual(attempts, 1, 'no hidden retry runs without a new report');

    failuresLeft = 0;
    onMoved(9);
    await turn();
    assert.strictEqual(attempts, 2, 'the next report from the history thread retries the cleanup');
    onMoved(9);
    await turn();
    assert.strictEqual(attempts, 2, 'a successful cleanup is not repeated for the same report');

    console.log('history outbox cleanup retry ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    // A still-looping failed cleanup (old behaviour) is stopped by shutdown.
    failuresLeft = 0;
    await Database.close().catch(() => null);
    History.start = originalStart;
    Statements.prepare = originalPrepare;
    fs.rmSync(directory, { recursive: true, force: true });
});

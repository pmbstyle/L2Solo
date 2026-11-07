'use strict';

// Native reproduction with disposable data and no filesystem/SQLite mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { prepareWorld } = require('./world-fixture.cjs');

async function main() {
    assert.equal(process.platform, 'win32');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-native-backup-proof-'));
    try {
        fs.mkdirSync(path.join(root, 'config'));
        fs.writeFileSync(path.join(root, 'config/local.ini'), '');
        prepareWorld(root, process.execPath);
        const beforeFile = path.join(root, 'scripts/saved-games-before.js');
        fs.writeFileSync(beforeFile, execFileSync('git', ['show', '2c6a0a6919cc8be547f98208df02dd9207846869:scripts/saved-games.js']));
        const before = require(beforeFile), after = require(path.join(root, 'scripts/saved-games.js'));
        const options = { operation: 'create', databasePath: path.join(root, 'tmp/world-data.sqlite'),
            historyPath: path.join(root, 'tmp/world-history.sqlite'), savesDir: path.join(root, 'tmp/saves') };
        const small = await before.run({ ...options, name: 'Old code, small history' });
        console.log(JSON.stringify({ phase: 'old-small-history', result: 'success', bytes: small.sizeBytes }));
        fs.rmSync(options.savesDir, { recursive: true, force: true });
        const db = new DatabaseSync(options.historyPath);
        try {
            db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; BEGIN; CREATE TABLE proof_payload(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);');
            const insert = db.prepare('INSERT INTO proof_payload(payload) VALUES(zeroblob(?))');
            for (let i = 0; i < 17; i++) insert.run(64 * 1024 * 1024);
            db.exec('COMMIT');
            assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
        } finally { db.close(); }
        const bytes = fs.statSync(options.historyPath).size;
        assert.ok(bytes > 2 ** 30);
        console.log(JSON.stringify({ phase: 'large-history-created', bytes }));
        let failure;
        try { await before.run({ ...options, name: 'Old code, large history' }); }
        catch (error) { failure = error; }
        console.log(JSON.stringify({ phase: 'old-large-history', error: failure?.message || null }));
        assert.ok(failure, 'Old code must fail with the large history.');
        assert.match(failure.message, /EBUSY.*copyfile/i);
        const saved = await after.run({ ...options, name: 'Fixed code, same large history' });
        assert.equal(fs.statSync(path.join(options.savesDir, saved.id, 'history.sqlite')).size, bytes);
        console.log(JSON.stringify({ phase: 'fixed-same-large-history', result: 'success', bytes: saved.sizeBytes }));
        console.log('Native Windows before/after proof passed.');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

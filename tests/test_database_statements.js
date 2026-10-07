const assert = require('assert');

const Statements = require('../src/DatabaseStatements');

const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
require(path.join(root, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(root, 'tests/helpers/isolatedSocialDatabase'))('database-statements', root);
// Install the exact own-path constructor guard before capturing native SQLite.
const sqlite = require('node:sqlite'), NativeDatabase = sqlite.DatabaseSync;
const allowed = new Set([':memory:', isolated.world]);
const opened = [], closed = new Set(), connectionFiles = [];
sqlite.DatabaseSync = class extends NativeDatabase {
    constructor(filename, settings) {
        assert.ok(allowed.has(filename), 'statement regression opens only memory or its exact UUID world');
        super(filename, settings); opened.push(this); connectionFiles.push(filename);
    }
    close() { const result = super.close(); closed.add(this); return result; }
};
const { DatabaseSync } = sqlite;
assert.ok(path.isAbsolute(isolated.world));
assert.equal(process.env.L2NODE_CONFIG_FILE, isolated.ini);
assert.equal(process.env.L2NODE_SHARED_CONFIG_FILE, undefined);
console.log('Isolated native paths:', isolated.world, isolated.history);
try {

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, amount INTEGER CHECK(amount >= 0));');
const put = 'INSERT INTO items VALUES (?, ?)';
const get = 'SELECT amount FROM items WHERE id = ?';
Statements.prepare(db, put).run(1, 10);
Statements.prepare(db, put).run(2, 20);
assert.strictEqual(Statements.prepare(db, get).get(1).amount, 10);
assert.strictEqual(Statements.prepare(db, get).get(2).amount, 20, 'bindings cannot leak across calls');
assert.strictEqual(Statements.prepare(db, get).get(), undefined, 'missing bindings must not reuse a prior ID');
assert.throws(() => Statements.prepare(db, put).run(3, -1), /constraint/i);
Statements.prepare(db, put).run(3, 30);
db.exec('BEGIN');
Statements.prepare(db, 'UPDATE items SET amount = ? WHERE id = ?').run(100, 1);
db.exec('ROLLBACK');
assert.strictEqual(Statements.prepare(db, get).get(1).amount, 10);
db.exec('ALTER TABLE items ADD COLUMN label TEXT; CREATE INDEX items_amount ON items(amount);');
assert.strictEqual(Statements.prepare(db, get).get(2).amount, 20, 'schema changes must not leave stale results');
db.close();
const reopened = new DatabaseSync(':memory:');
reopened.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO items VALUES(1, 99)');
assert.strictEqual(Statements.prepare(reopened, get).get(1).amount, 99, 'cached statements must belong to their connection');
reopened.close();
console.log('Database statement reuse checks passed');

// Actual native on-disk pair: each scalar read executes .get freshly. Both
// CAS stamp reads must leave the previous SELECT statement reusable.
const primary = new DatabaseSync(isolated.world);
primary.exec('PRAGMA journal_mode=WAL; CREATE TABLE version_probe(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO version_probe VALUES(1, 10)');
const foreign = new DatabaseSync(isolated.world);
const selectSql = 'SELECT value FROM version_probe WHERE id = ?';
const retained = Statements.prepare(primary, selectSql);
const stamp = () => ({
    epoch: Statements.prepare(primary, 'SELECT total_changes() AS epoch').get().epoch,
    dataVersion: Statements.prepare(primary, 'PRAGMA data_version').get().data_version
});
assert.strictEqual(retained.get(1).value, 10);
const initial = stamp();
assert.strictEqual(Statements.prepare(primary, selectSql), retained,
    'exact read-only data_version must not flush the connection statement cache');
const second = stamp();
assert.deepStrictEqual(second, initial);
assert.strictEqual(Statements.prepare(primary, selectSql), retained, 'both CAS reads preserve statement identity');
foreign.prepare('UPDATE version_probe SET value=20 WHERE id=1').run();
const externallyChanged = stamp();
assert.notStrictEqual(externallyChanged.dataVersion, initial.dataVersion,
    'each data_version read observes a real other-connection commit');
assert.strictEqual(externallyChanged.epoch, initial.epoch);
assert.strictEqual(Statements.prepare(primary, selectSql), retained);
assert.strictEqual(retained.get(1).value, 20, 'cached SELECT observes the new native rows');
Statements.prepare(primary, 'UPDATE version_probe SET value=value+1 WHERE id=?').run(1);
const locallyChanged = stamp();
assert.ok(locallyChanged.epoch > externallyChanged.epoch, 'local native change remains visible to scalar CAS');
assert.strictEqual(locallyChanged.dataVersion, externallyChanged.dataVersion);
assert.strictEqual(retained.get(1).value, 21);
const forbiddenAliases = ['PRAGMA user_version', 'PRAGMA user_version=7',
    ' PRAGMA data_version', 'pragma data_version', 'PRAGMA data_version;'];
for (const sql of forbiddenAliases) {
    const cached = Statements.prepare(primary, selectSql);
    Statements.prepare(primary, sql).get();
    assert.notStrictEqual(Statements.prepare(primary, selectSql), cached,
        'only exact canonical read gets the exception: ' + sql);
}
const beforeAlter = Statements.prepare(primary, selectSql);
Statements.prepare(primary, 'ALTER TABLE version_probe ADD COLUMN label TEXT').run();
assert.notStrictEqual(Statements.prepare(primary, selectSql), beforeAlter, 'DDL retains full invalidation');
assert.strictEqual(Statements.prepare(primary, 'SELECT label FROM version_probe WHERE id=?').get(1).label, null);
// Native statement error/rollback and ordinary bindings remain real.
primary.exec('BEGIN');
Statements.prepare(primary, 'UPDATE version_probe SET value=? WHERE id=?').run(99, 1);
primary.exec('ROLLBACK');
assert.strictEqual(Statements.prepare(primary, selectSql).get(1).value, 21);
assert.strictEqual(Statements.prepare(primary, selectSql).get(), undefined);
const lruHeld = Statements.prepare(primary, selectSql);
for (let i=0;i<257;i++) Statements.prepare(primary, 'SELECT ' + i + ' AS value').get();
assert.notStrictEqual(Statements.prepare(primary, selectSql), lruHeld, 'existing 256-entry bound remains effective');
foreign.close(); primary.close();
console.log('Native data_version reuse and conservative invalidation checks passed');
} finally {
    for (const db of opened) if (!closed.has(db)) db.close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    assert.strictEqual(closed.size, opened.length);
    assert.strictEqual(fs.existsSync(isolated.directory), false);
    console.log(JSON.stringify({ fixtureCleanup: { connectionFiles, openedConnections: opened.length, closedConnections: closed.size, directory: isolated.directory, removed: true, Global: false, DatabaseInit: false } }));
}

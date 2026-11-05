// One bounded cache per connection; statements never cross a close/reopen.
// All callers bind their parameters anew and consume results synchronously.
// One entry per SQL text, keyed by the text itself, with a slot for native
// Number callers and one for readers that normalize BigInts: a prefixed key
// would copy the whole text on every call (5 KB for the lifecycle save).
// At most 256 statements per connection; the least recently used text goes
// first, both its statements with it.
const caches = new WeakMap();
const MAX_STATEMENTS = 256;
const MAX_SQL_LENGTH = 16384;

function create(connection, sql, readBigInts) {
    const statement = connection.prepare(sql);
    if (readBigInts) statement.setReadBigInts(true);
    return statement;
}

function prepare(connection, sql, readBigInts = false) {
    // ARCH-NOTE: This exact scalar CAS read does not alter connection/schema.
    // Read its native value anew without flushing unrelated cached statements.
    // Every other PRAGMA/DDL retains the original invalidation below.
    if (sql === 'PRAGMA data_version') return create(connection, sql, readBigInts);
    let cache = caches.get(connection);
    if (!cache) { cache = { texts: new Map(), statements: 0 }; caches.set(connection, cache); }
    if (sql.length > MAX_SQL_LENGTH || !/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|EXPLAIN)\b/i.test(sql)) {
        cache.texts.clear();
        cache.statements = 0;
        return create(connection, sql, readBigInts);
    }
    let entry = cache.texts.get(sql);
    if (entry) cache.texts.delete(sql);
    else entry = { numbers: null, bigints: null };
    cache.texts.set(sql, entry);
    const slot = readBigInts ? 'bigints' : 'numbers';
    if (entry[slot]) return entry[slot];
    entry[slot] = create(connection, sql, readBigInts);
    cache.statements++;
    while (cache.statements > MAX_STATEMENTS) {
        const [oldest, evicted] = cache.texts.entries().next().value;
        cache.texts.delete(oldest);
        cache.statements -= (evicted.numbers ? 1 : 0) + (evicted.bigints ? 1 : 0);
    }
    return entry[slot];
}

module.exports = { prepare };

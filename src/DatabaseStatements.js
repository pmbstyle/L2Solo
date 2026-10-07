// One bounded cache per connection; statements never cross a close/reopen.
// All callers bind their parameters anew and consume results synchronously.
const caches = new WeakMap();
const MAX_ENTRIES = 256;
const MAX_SQL_LENGTH = 16384;

function prepare(connection, sql) {
    // ARCH-NOTE: This exact scalar CAS read does not alter connection/schema.
    // Read its native value anew without flushing unrelated cached statements.
    // Every other PRAGMA/DDL retains the original invalidation below.
    if (sql === 'PRAGMA data_version') return connection.prepare(sql);
    let cache = caches.get(connection);
    if (!cache) { cache = new Map(); caches.set(connection, cache); }
    if (sql.length > MAX_SQL_LENGTH || !/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|EXPLAIN)\b/i.test(sql)) {
        cache.clear();
        return connection.prepare(sql);
    }
    let statement = cache.get(sql);
    if (statement) cache.delete(sql);
    else statement = connection.prepare(sql);
    cache.set(sql, statement);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return statement;
}

module.exports = { prepare };

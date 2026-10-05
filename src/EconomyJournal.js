// Economy journal: every change of adena and items in the tables that hold
// value, summed per hour, per database operation, per store and per item.
//
// The SQL side is a set of TEMP triggers on the main connection. They are not
// stored in the database file, so tools that open the file on their own are
// unaffected. Each trigger calls economy_flow(), which adds the change to the
// operation running on the write queue. A change is kept only when its
// operation succeeds; a rolled-back transaction leaves nothing.
//
// Transfers (trades, escrow, warehouses) net to zero inside their operation;
// what an operation adds or removes in total is a faucet or a sink.

const HOUR_MS = 60 * 60 * 1000;

// store -> { table, value column, item column or a fixed item, extra WHEN }
const STORES = [
    { store: 'inventory', table: 'items', column: 'amount', item: 'selfId' },
    { store: 'warehouse', table: 'warehouse_items', column: 'amount', item: 'selfId' },
    { store: 'clan_warehouse', table: 'clan_warehouse_items', column: 'amount', item: 'selfId' },
    { store: 'afk_escrow', table: 'afk_trade_shops', column: 'escrowAdena', adena: true },
    // Only sell lines hold items; a buy line's count is the amount wanted.
    {
        store: 'afk_lines',
        table: 'afk_trade_lines',
        column: 'count',
        item: 'selfId',
        sellLinesOnly: true
    },
    { store: 'clan_hall_bid', table: 'clan_hall_bids', column: 'amount', adena: true },
    // What a deal or a closed record owes a cold bot until its next save.
    { store: 'board_settlement', table: 'board_settlements', column: 'amount', item: 'selfId' }
];

let operation = null;
let operationDetail = null;
let pending = null;
const totals = new Map();

function label() {
    return operationDetail ? `${operation}/${operationDetail}` : operation;
}

function begin(name) {
    operation = String(name || 'raw');
    operationDetail = null;
    pending = null;
}

// A sub-reason inside one operation, e.g. the kind of a cold commit.
function detail(name) {
    operationDetail = name ? String(name) : null;
}

function record(store, selfId, delta) {
    const change = Number(delta);
    if (!change) return;
    if (!pending) pending = new Map();
    const key = `${label() || 'raw'}\u0000${store}\u0000${Number(selfId)}`;
    const entry = pending.get(key);
    if (entry) {
        entry.delta += change;
        entry.events += 1;
    } else {
        pending.set(key, { operation: label() || 'raw', store: String(store), selfId: Number(selfId), delta: change, events: 1 });
    }
}

function commit(at = Date.now()) {
    if (pending) {
        const hour = Math.floor(at / HOUR_MS);
        pending.forEach((entry) => {
            const key = `${hour}\u0000${entry.operation}\u0000${entry.store}\u0000${entry.selfId}`;
            const total = totals.get(key);
            if (total) {
                total.delta += entry.delta;
                total.events += entry.events;
            } else {
                totals.set(key, { hour, ...entry });
            }
        });
    }
    operation = null;
    operationDetail = null;
    pending = null;
}

function discard() {
    operation = null;
    operationDetail = null;
    pending = null;
}

// Rows summed since the last drain; the caller writes them.
function drain() {
    const rows = [...totals.values()];
    totals.clear();
    return rows;
}

function changeCall(store, item, delta) {
    return `economy_flow('${store}', ${item}, ${delta})`;
}

function triggerSql({ store, table, column, item, adena, sellLinesOnly }) {
    const name = `economy_journal_${table}`;
    const itemOf = (row) => (adena ? '57' : `${row}.${item}`);
    const sellOnly = (row) => (sellLinesOnly
        ? ` AND (SELECT storeType FROM main.afk_trade_shops WHERE id = ${row}.shopId) = 1`
        : '');
    const sql = [
        `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_insert AFTER INSERT ON main.${table}
            WHEN NEW.${column} != 0${sellOnly('NEW')}
            BEGIN SELECT ${changeCall(store, itemOf('NEW'), `NEW.${column}`)}; END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_delete AFTER DELETE ON main.${table}
            WHEN OLD.${column} != 0${sellOnly('OLD')}
            BEGIN SELECT ${changeCall(store, itemOf('OLD'), `-OLD.${column}`)}; END`
    ];
    if (adena) {
        sql.push(`CREATE TEMP TRIGGER IF NOT EXISTS ${name}_update AFTER UPDATE OF ${column} ON main.${table}
            WHEN NEW.${column} != OLD.${column}
            BEGIN SELECT ${changeCall(store, '57', `NEW.${column} - OLD.${column}`)}; END`);
        return sql;
    }
    sql.push(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_update AFTER UPDATE OF ${column} ON main.${table}
            WHEN NEW.${item} = OLD.${item} AND NEW.${column} != OLD.${column}${sellOnly('NEW')}
            BEGIN SELECT ${changeCall(store, `NEW.${item}`, `NEW.${column} - OLD.${column}`)}; END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${name}_transform AFTER UPDATE OF ${item} ON main.${table}
            WHEN NEW.${item} != OLD.${item}${sellOnly('NEW')}
            BEGIN
                SELECT ${changeCall(store, `OLD.${item}`, `-OLD.${column}`)};
                SELECT ${changeCall(store, `NEW.${item}`, `NEW.${column}`)};
            END`
    );
    return sql;
}

let attachedTables = new Set();

// Registers economy_flow() on a new connection, then the triggers.
function attach(connection) {
    attachedTables = new Set();
    connection.function('economy_flow', (store, selfId, delta) => {
        record(store, selfId, delta);
        return null;
    });
    attachMissing(connection);
}

// Some stores are created lazily (clan hall tables); their triggers are added
// once the table exists. Returns true when every store is watched.
function attachMissing(connection) {
    STORES.forEach((store) => {
        if (attachedTables.has(store.table)) return;
        const exists = connection.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(store.table);
        if (!exists) return;
        triggerSql(store).forEach((sql) => connection.exec(sql));
        attachedTables.add(store.table);
    });
    return attachedTables.size === STORES.length;
}

module.exports = {
    HOUR_MS,
    STORES,
    attach,
    attachMissing,
    begin,
    detail,
    record,
    commit,
    discard,
    drain
};

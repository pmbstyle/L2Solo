'use strict';
const { isMainThread } = require('node:worker_threads');
const Henna = require('../Henna/HennaRules');
const FailureLog = require('../../FailureLog');

const TABLE = 'clan_dye_stock';
const dyeIds = new Set(require('../../../data/Henna/c4-henna.json').symbols.map(symbol => symbol.dyeSelfId));
const rows = new Map();
const dirty = new Set();
let revision = 0;
let ready = false;
let source = id => rows.get(id);
let selectStock;
const clanOf = state => Number(state?.clanId ?? state?.stats?.clanId);
const channel = isMainThread && require('../Bot/Population/ColdTableChannel').shared;

if (channel) channel.register(TABLE, {
    key: row => row[0], allRows: () => rows.values(), eventDriven: true, ready: () => ready
});

// Planning reads a committed projection. The warehouse transaction still
// validates membership, free stock and the order against current native rows.
function attach(connection) {
    for (const clanId of rows.keys()) channel.changed(TABLE, { key: clanId, removed: true });
    rows.clear();
    dirty.clear();
    connection.function('clan_dye_stock_moved', (clanId, selfId) => {
        if (selfId === null || dyeIds.has(selfId)) dirty.add(clanId);
        return null;
    });
    for (const [table, field, columns] of [
        ['clan_warehouse_items', 'selfId', 'clanId, selfId, amount, reservedAmount'],
        ['clan_orders', 'itemId', 'clanId, itemId, amount, status'],
        ['clans', null, 'level']
    ]) {
        const touch = row => `SELECT clan_dye_stock_moved(${row}.${field ? 'clanId' : 'id'}, ${field ? `${row}.${field}` : 'NULL'});`;
        connection.exec(`
            CREATE TEMP TRIGGER dye_stock_${table}_insert AFTER INSERT ON main.${table}
            BEGIN ${touch('new')} END;
            CREATE TEMP TRIGGER dye_stock_${table}_delete AFTER DELETE ON main.${table}
            BEGIN ${touch('old')} END;
            CREATE TEMP TRIGGER dye_stock_${table}_update AFTER UPDATE OF ${columns} ON main.${table}
            BEGIN ${touch('old')} ${touch('new')} END;
        `);
    }
    selectStock = connection.prepare(`
        SELECT w.selfId, MIN(SUM(MAX(0, w.amount - w.reservedAmount)),
            MAX(0, SUM(w.amount) - COALESCE(o.amount, 0))) AS free
        FROM clan_warehouse_items w
        JOIN clans c ON c.id = w.clanId AND c.level >= 1
        LEFT JOIN clan_orders o ON o.clanId = w.clanId AND o.itemId = w.selfId
            AND o.status IN ('active', 'paused', 'blocked')
        WHERE w.clanId = ? AND w.amount > 0
        GROUP BY w.selfId ORDER BY w.selfId
    `);
    for (const row of connection.prepare('SELECT DISTINCT clanId FROM clan_warehouse_items').all()) dirty.add(row.clanId);
    ready = true;
    publish();
    channel.flush();
}

function publish() {
    if (!selectStock || !dirty.size) return;
    try {
        for (const clanId of dirty) {
            const amounts = selectStock.all(clanId).filter(row => row.free > 0 && dyeIds.has(row.selfId))
                .map(row => [row.selfId, row.free]);
            const previous = rows.get(clanId);
            if (amounts.length && JSON.stringify(previous?.[2]) !== JSON.stringify(amounts)) {
                const row = [clanId, ++revision, amounts];
                rows.set(clanId, row);
                channel.changed(TABLE, row);
            } else if (!amounts.length && previous) {
                rows.delete(clanId);
                channel.changed(TABLE, { key: clanId, removed: true });
            }
            dirty.delete(clanId);
        }
    } catch (error) {
        FailureLog.note('clan.dye_projection', error);
    }
}

function amount(state, selfId) {
    return source(clanOf(state))?.[2].find(row => row[0] === selfId)?.[1] || 0;
}

// Actual post-withdrawal gap, including stock someone has already promised.
function remaining(state, rootKey, itemId) {
    const symbolId = Number(/^henna:(\d+)$/.exec(rootKey || '')?.[1]);
    if (!symbolId) return null;
    const symbol = Henna.symbolForClass(state.stats?.classId ?? state.classId, symbolId);
    if (!symbol || itemId && symbol.dyeSelfId !== Number(itemId)) return null;
    const id = symbol.dyeSelfId;
    return Math.max(0, symbol.dyeAmount - Number(state.inventory?.[id]?.amount || 0)
        - Number(state.acceptedIncoming?.[id] || 0));
}

module.exports = { TABLE, attach, publish, amount, remaining,
    version: state => source(clanOf(state))?.[1] || 0,
    useRowSource(reader) { source = reader; } };

'use strict';
const Protocol = require('./ColdSimulationProtocol');
const PAGE_BYTES = 240 * 1024;

// Each page carries the size counted while filling it (an upper bound of the
// final envelope), so the sender need not serialise it again to validate it.
function collectionPagesWithBytes(type, epoch, collections, msgId, onOversize = () => null) {
    const empty = () => Object.fromEntries(Object.keys(collections).map((field) => [field, []]));
    // Reserve room for a generated message ID/timestamp. The sender checks
    // this counted upper bound of the envelope against the size limit.
    const baseBytes = Protocol.byteLength(Protocol.envelope(type, epoch, empty(), msgId)) + 256;
    const pages = [];
    let page = empty();
    let bytes = baseBytes;
    let count = 0;
    const flush = () => {
        if (count) pages.push({ payload: page, bytes });
        page = empty(); bytes = baseBytes; count = 0;
    };
    const entryBytes = (value) => Protocol.byteLength([value]) - 2;
    for (const [field, entries] of Object.entries(collections)) {
        for (const original of entries || []) {
            let value = original;
            let size = entryBytes(value);
            if (!Number.isFinite(size) || baseBytes + size > PAGE_BYTES) {
                value = onOversize(original);
                if (!value) continue;
                size = entryBytes(value);
                if (!Number.isFinite(size) || baseBytes + size > PAGE_BYTES) continue;
            }
            if (count >= Protocol.MAX_BATCH || bytes + size + (page[field].length ? 1 : 0) > PAGE_BYTES) flush();
            bytes += size + (page[field].length ? 1 : 0);
            page[field].push(value);
            count++;
        }
    }
    flush();
    return pages;
}

// Table pages for ColdTableChannel: { tables: [piece] }, a piece being
// { name, from, to, full, rows: [[key, row]], removed: [key] }. Limited only by
// size: each page's payload stays within budget bytes, counted while it is
// built (each value measured once). A table cut across pages goes on in a
// piece at the version the first piece reached (from === to), which a
// TableMirror applies in order. Every piece of a full table carries `last`:
// 1 on its final piece, 0 before (equal lengths keep the counted size exact);
// the mirror does not read the table until it has the final piece. A single
// value larger than a page is left out and counted in skipped.
const EMPTY_TABLES_BYTES = Protocol.byteLength({ tables: [] });
function tablePagesWithBytes(tables, budget = PAGE_BYTES - 1024) {
    const pages = [];
    let pieces = [];
    let bytes = EMPTY_TABLES_BYTES;
    let piece = null;
    let skipped = 0;
    const closePage = () => {
        if (pieces.length) pages.push({ payload: { tables: pieces }, bytes });
        pieces = [];
        bytes = EMPTY_TABLES_BYTES;
    };
    const openPiece = (table, first) => {
        piece = { name: table.name, from: first ? table.from : table.to, to: table.to,
            full: first && table.full === true, rows: [], removed: [] };
        if (table.full === true) piece.last = 0;
        const size = Protocol.byteLength(piece);
        if (pieces.length && bytes + size + 1 > budget) closePage();
        bytes += size + (pieces.length ? 1 : 0);
        pieces.push(piece);
    };
    const add = (table, field, value) => {
        const size = Protocol.byteLength(value);
        if (bytes + size + (piece[field].length ? 1 : 0) > budget) {
            closePage();
            openPiece(table, false);
            if (bytes + size > budget) { skipped++; return; }
        }
        bytes += size + (piece[field].length ? 1 : 0);
        piece[field].push(value);
    };
    for (const table of tables) {
        openPiece(table, true);
        for (const entry of table.rows || []) add(table, 'rows', entry);
        for (const key of table.removed || []) add(table, 'removed', key);
        if (table.full === true) piece.last = 1;
    }
    closePage();
    return { pages, skipped };
}

function collectionPages(type, epoch, collections, msgId, onOversize) {
    return collectionPagesWithBytes(type, epoch, collections, msgId, onOversize).map((page) => page.payload);
}

// Optional actor branch only: ONE bounded piece, no all-pages materialization,
// no oversized-row skip-and-ready. Each bounded entry is byte-counted once.
function streamedTablePageWithBytes(piece, budget = PAGE_BYTES - 1024, maxEntries = Protocol.MAX_BATCH) {
    if (!piece || !Array.isArray(piece.rows) || !Array.isArray(piece.removed)
        || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > Protocol.MAX_BATCH
        || !Number.isSafeInteger(budget) || budget < 1 || budget > PAGE_BYTES - 1024
        || piece.rows.length + piece.removed.length > maxEntries) {
        throw new TypeError('invalid_actor_table_page');
    }
    const bounded = { ...piece, rows: [], removed: [] };
    const payload = { tables: [bounded] };
    let bytes = Protocol.byteLength(payload);
    if (!Number.isFinite(bytes) || bytes > budget) throw new RangeError('actor_table_page_oversize');
    let count = 0;
    let full = false;
    for (const field of ['rows', 'removed']) {
        for (const value of piece[field]) {
            const size = Protocol.byteLength(value);
            if (!Number.isFinite(size)) throw new TypeError('invalid_actor_table_value');
            const addition = size + (bounded[field].length ? 1 : 0);
            if (bytes + addition > budget) {
                if (!count) throw new RangeError('actor_table_page_oversize');
                full = true;
                break;
            }
            bounded[field].push(value);
            bytes += addition;
            count++;
        }
        if (full) break;
    }
    return { payload, bytes, consumedRows: bounded.rows.length, consumedRemoved: bounded.removed.length };
}

module.exports = { collectionPages, collectionPagesWithBytes, tablePagesWithBytes, streamedTablePageWithBytes, PAGE_BYTES };

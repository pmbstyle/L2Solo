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
// TableMirror applies in order. A single value larger than a page is left out
// and counted in skipped.
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
    }
    closePage();
    return { pages, skipped };
}

function collectionPages(type, epoch, collections, msgId, onOversize) {
    return collectionPagesWithBytes(type, epoch, collections, msgId, onOversize).map((page) => page.payload);
}

module.exports = { collectionPages, collectionPagesWithBytes, tablePagesWithBytes, PAGE_BYTES };

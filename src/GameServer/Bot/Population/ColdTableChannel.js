'use strict';
const { tablePagesWithBytes } = require('./ColdMessagePages');

const REMOVED = Symbol('removed');

// One versioned channel of tables from the main thread to the background
// workers (the cold worker and the clan planning worker), each holding a
// TableMirror. A table is registered once with its key and a way to read all
// its rows; the main thread reports each changed or removed row, which costs
// one Map write. flush() turns the changes of each table into one new version
// and posts it, in pages limited by size, to every attached worker.
//
// No acknowledgements: a MessagePort keeps the order. A worker that sees a
// gap asks for the whole table (resync); a worker with a new epoch (a
// restart) gets every table in full when it attaches. A page that could not
// be posted suspends the worker: the tables of that page and of the pages
// after it, and every table that changes while it is suspended, go in full
// at the next flush, tried once (the worker sees no gap in what it never
// got, so it would not ask); when that try fails too, they wait for a new
// epoch or a resync. The tables it got stay.
class ColdTableChannel {
    constructor() {
        this.tables = new Map();
        this.targets = new Map();
        this.stats = { flushes: 0, pages: 0, rows: 0, fulls: 0, resyncs: 0, skipped: 0, failedPosts: 0, retries: 0, suspendedFlushes: 0 };
    }

    // key(row) gives a row's key; allRows() gives every current row.
    register(name, { key, allRows }) {
        this.tables.set(String(name), { name: String(name), key, allRows, version: 0, pending: new Map(), changedUnseen: false });
    }

    // change: a row, or { key, removed: true } for a removed row. With no
    // worker attached nobody needs the row: a worker that attaches gets the
    // table in full, so only the next version is marked.
    changed(name, change) {
        const table = this.tables.get(String(name));
        if (!table || !change) return false;
        if (!this.targets.size) {
            table.changedUnseen = true;
            return true;
        }
        if (change.removed === true) table.pending.set(change.key, REMOVED);
        else table.pending.set(table.key(change), change);
        return true;
    }

    // target: the worker's coordinator (any key); post(payload, payloadBytes)
    // sends one page and returns false when it could not. A new epoch is a
    // new worker: it gets every table in full.
    attach(target, epoch, post) {
        const current = this.targets.get(target);
        if (current && current.epoch === epoch) {
            current.post = post;
            return;
        }
        this.targets.set(target, { epoch, post, synced: new Set(), suspended: false, retried: false });
        this.flush();
    }

    detach(target) {
        this.targets.delete(target);
    }

    resync(target, epoch, names = []) {
        const entry = this.targets.get(target);
        if (!entry || entry.epoch !== epoch) return;
        for (const name of names) entry.synced.delete(String(name));
        entry.suspended = false;
        entry.retried = false;
        this.stats.resyncs += 1;
        this.flush();
    }

    full(table) {
        const rows = [];
        for (const row of table.allRows() || []) rows.push([table.key(row), row]);
        return { name: table.name, from: null, to: table.version, full: true, rows, removed: [] };
    }

    pages(tables) {
        if (!tables.length) return [];
        const { pages, skipped } = tablePagesWithBytes(tables);
        this.stats.skipped += skipped;
        return pages;
    }

    flush() {
        // Each table's pending changes become one new version.
        const deltas = [];
        for (const table of this.tables.values()) {
            if (!table.pending.size && !table.changedUnseen) continue;
            table.changedUnseen = false;
            const rows = [];
            const removed = [];
            for (const [key, row] of table.pending) {
                if (row === REMOVED) removed.push(key);
                else rows.push([key, row]);
            }
            table.pending = new Map();
            deltas.push({ name: table.name, from: table.version, to: table.version + 1, full: false, rows, removed });
            table.version += 1;
        }
        let sharedPages = null;
        for (const target of this.targets.values()) {
            if (target.suspended && target.retried) {
                for (const delta of deltas) target.synced.delete(delta.name);
                this.stats.suspendedFlushes += 1;
                continue;
            }
            // The one try after a failed post: what it missed goes in full.
            if (target.suspended) {
                target.suspended = false;
                target.retried = true;
                this.stats.retries += 1;
            }
            // A table the worker does not hold yet goes in full; the full copy
            // already has this flush's changes.
            const fulls = [];
            for (const table of this.tables.values()) {
                if (target.synced.has(table.name)) continue;
                fulls.push(this.full(table));
                target.synced.add(table.name);
                this.stats.fulls += 1;
            }
            const fullNames = new Set(fulls.map((full) => full.name));
            const own = fullNames.size ? deltas.filter((delta) => !fullNames.has(delta.name)) : deltas;
            if (own === deltas && !sharedPages) sharedPages = this.pages(deltas);
            const pages = [...this.pages(fulls), ...(own === deltas ? sharedPages : this.pages(own))];
            for (let at = 0; at < pages.length; at++) {
                if (target.post(pages[at].payload, pages[at].bytes)) {
                    this.stats.pages += 1;
                    continue;
                }
                // The worker missed this page and the rest: their tables go
                // in full when it is back.
                this.stats.failedPosts += 1;
                for (const page of pages.slice(at)) {
                    for (const piece of page.payload.tables) target.synced.delete(piece.name);
                }
                target.suspended = true;
                break;
            }
            // Every page went: a later failed post gets its own try again.
            if (!target.suspended) target.retried = false;
        }
        if (deltas.length) {
            this.stats.flushes += 1;
            for (const delta of deltas) this.stats.rows += delta.rows.length + delta.removed.length;
        }
    }

    snapshot() {
        const tables = {};
        for (const table of this.tables.values()) tables[table.name] = { version: table.version, pending: table.pending.size };
        return { tables, targets: this.targets.size, ...this.stats };
    }
}

module.exports = { ColdTableChannel, shared: new ColdTableChannel() };

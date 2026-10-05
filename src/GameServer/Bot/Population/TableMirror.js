'use strict';

const EMPTY_ROWS = new Map();

// A worker's copy of the tables the main thread sends through
// ColdTableChannel. Each table has a version; a change applies only on top
// of the version it was made from. A missing version (a gap) is not patched:
// the mirror drops later changes of that table and asks the main thread for
// the whole table once (table_resync). A full copy cut across pages is
// loading until its final piece (`last: 1`): until then the table reads as
// empty, never as a part taken for the whole. A listener (watch) follows one
// table's rows as they change. Shared by the cold worker and the clan
// planning worker.
class TableMirror {
    constructor() {
        this.tables = new Map();
        this.listeners = new Map();
    }

    // listener: { reset(), put(key, row), remove(key) }, called as pieces apply.
    watch(name, listener) {
        this.listeners.set(String(name), listener);
    }

    // pieces: [{ name, from, to, full, last, rows: [[key, row]], removed: [key] }].
    // Returns the names of the tables to ask for in full.
    apply(pieces = []) {
        const resync = [];
        for (const piece of pieces) {
            const name = String(piece.name);
            const listener = this.listeners.get(name);
            let table = this.tables.get(name);
            if (piece.full) {
                table = { version: piece.to, rows: new Map(), waiting: false, loading: piece.last === 0 };
                this.tables.set(name, table);
                listener?.reset();
            } else if (!table || table.waiting || table.version !== piece.from
                || (table.loading && piece.from !== piece.to)) {
                // A change on a table not held, or on a full copy that never
                // finished, is a gap too.
                if (!table) {
                    table = { version: null, rows: new Map(), waiting: false, loading: false };
                    this.tables.set(name, table);
                }
                if (!table.waiting) resync.push(name);
                table.waiting = true;
                continue;
            }
            for (const [key, row] of piece.rows || []) {
                table.rows.set(key, row);
                listener?.put(key, row);
            }
            for (const key of piece.removed || []) {
                table.rows.delete(key);
                listener?.remove(key);
            }
            table.version = piece.to;
            if (piece.last === 1) table.loading = false;
        }
        return resync;
    }

    // Whether a table is held whole (its full copy arrived and is current).
    ready(name) {
        const table = this.tables.get(String(name));
        return !!table && table.version !== null && !table.waiting && !table.loading;
    }

    // The rows of one table by key (empty until its first full copy, and
    // while a full copy is loading).
    rows(name) {
        const table = this.tables.get(String(name));
        return table && !table.loading ? table.rows : EMPTY_ROWS;
    }

    version(name) {
        return this.tables.get(String(name))?.version ?? null;
    }

    summary() {
        const result = {};
        for (const [name, table] of this.tables) {
            result[name] = { version: table.version, rows: table.rows.size, waiting: table.waiting, loading: table.loading };
        }
        return result;
    }
}

module.exports = TableMirror;

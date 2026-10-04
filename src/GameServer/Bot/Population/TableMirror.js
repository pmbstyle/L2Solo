'use strict';

// A worker's copy of the tables the main thread sends through
// ColdTableChannel. Each table has a version; a change applies only on top
// of the version it was made from. A missing version (a gap) is not patched:
// the mirror drops later changes of that table and asks the main thread for
// the whole table once (table_resync). Shared by the cold worker and the clan
// planning worker.
class TableMirror {
    constructor() {
        this.tables = new Map();
    }

    // pieces: [{ name, from, to, full, rows: [[key, row]], removed: [key] }].
    // Returns the names of the tables to ask for in full.
    apply(pieces = []) {
        const resync = [];
        for (const piece of pieces) {
            const name = String(piece.name);
            let table = this.tables.get(name);
            if (piece.full) {
                table = { version: piece.to, rows: new Map(), waiting: false };
                this.tables.set(name, table);
            } else if (!table || table.waiting || table.version !== piece.from) {
                if (!table) {
                    table = { version: null, rows: new Map(), waiting: false };
                    this.tables.set(name, table);
                }
                if (!table.waiting) resync.push(name);
                table.waiting = true;
                continue;
            }
            for (const [key, row] of piece.rows || []) table.rows.set(key, row);
            for (const key of piece.removed || []) table.rows.delete(key);
            table.version = piece.to;
        }
        return resync;
    }

    // The rows of one table by key (empty until its first full copy).
    rows(name) {
        return this.tables.get(String(name))?.rows || new Map();
    }

    version(name) {
        return this.tables.get(String(name))?.version ?? null;
    }

    summary() {
        const result = {};
        for (const [name, table] of this.tables) {
            result[name] = { version: table.version, rows: table.rows.size, waiting: table.waiting };
        }
        return result;
    }
}

module.exports = TableMirror;

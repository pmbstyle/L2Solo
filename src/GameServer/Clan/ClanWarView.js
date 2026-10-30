'use strict';
const Rules = require('./ClanWarRules');
// Shared immutable rows; a withdrawal is a versioned tombstone, never a deletion.
class ClanWarView {
    constructor() { this.rows = new Map(); this.mutualCounts = new Map(); this.revision = 0; }
    accept(row) {
        if (!row || !Rules.id(row.fromClanId) || !Rules.id(row.toClanId) || row.fromClanId === row.toClanId
            || !Rules.id(row.revision) || ![0, 1].includes(row.active)) throw Error('invalid clan war row');
        const key = Rules.key(row.fromClanId, row.toClanId);
        if ((this.rows.get(key)?.revision || 0) >= row.revision) return false;
        const before = this.between(row.fromClanId, row.toClanId).mutual;
        this.rows.set(key, Object.freeze({ ...row }));
        const after = this.between(row.fromClanId, row.toClanId).mutual;
        if (before !== after) for (const id of [row.fromClanId, row.toClanId]) {
            const count = (this.mutualCounts.get(id) || 0) + (after ? 1 : -1);
            if (count) this.mutualCounts.set(id, count); else this.mutualCounts.delete(id);
        }
        this.revision = Math.max(this.revision, row.revision);
        return true;
    }
    replace(rows) { this.rows.clear(); this.mutualCounts.clear(); this.revision = 0; rows.forEach(row => this.accept(row)); }
    hasMutual(clanId) { return (this.mutualCounts.get(clanId) || 0) > 0; }
    between(a, b) {
        if (!Rules.id(a) || !Rules.id(b) || a === b) return Rules.relation(null, null);
        return Rules.relation(this.rows.get(Rules.key(a, b)), this.rows.get(Rules.key(b, a)));
    }
    all() { return [...this.rows.values()]; }
}
module.exports = ClanWarView;

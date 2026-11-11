'use strict';

// Grant relations read the actual supplied newbie source. Current readers keep
// fresh sets; identity-only readers retain only their own current observation.
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const observations = new WeakMap();
const EMPTY = Object.freeze([]);
const numericId = row => Number(row.selfId);
function firstClassRow(source, classId) {
    return require('../ClassProgression').firstClassRow(source, classId, 'strict');
}
function grants(source, classId) {
    if (arguments.length > 1) return (source == null ? undefined : firstClassRow(source, classId))?.items || EMPTY;
    return (source || EMPTY).flatMap(row => row.items || EMPTY);
}
function ids(source, equippedOnly = false, classId) {
    const rows = arguments.length > 2 ? grants(source, classId) : grants(source);
    return new Set(rows.filter(row => !equippedOnly || (equippedOnly === 'strict' ? row.equipped === true : row.equipped)).map(numericId));
}
// The imported PK template requires every class row to carry its items array.
function importIds(source) { return new Set(source.flatMap(row => row.items.map(numericId))); }

// A snapshot's ids, shared by its readers: a Set that refuses changes.
class ReadOnlyIds extends Set {
    constructor(values) { super(values); this.sealed = true; }
    add(value) { if (this.sealed) throw new TypeError('starter ids are read-only'); return super.add(value); }
    delete() { throw new TypeError('starter ids are read-only'); }
    clear() { throw new TypeError('starter ids are read-only'); }
}
// equippedOnly: as ids(); one observer reads one form. The ids are shared and
// read-only (ReadOnlyIds).
function snapshotIds(source, observer, equippedOnly = false) {
    let view = observations.get(observer);
    if (!view) {
        view = { source: null, ids: new ReadOnlyIds() };
        observations.set(observer, view);
    }
    if (view.source !== source) {
        // Publish the observed source before construction. The old disposition
        // reader retained prior IDs after a failed transition and did not retry
        // that same source; the first failed source retains its initial empty set.
        view.source = source;
        view.ids = new ReadOnlyIds(ids(source, equippedOnly));
    }
    return view.ids;
}
// A new character's starter rows as written to its items, one rule for players
// (CreateNewChar) and bots (BotManager, GeneratedColdSeeder): the template's
// slot, worn as the table marks it (equipped === true), except a shield beside
// a worn two-handed weapon (slot 14), which stays in the bag until that weapon
// is replaced. New row objects: the table is shared, frozen data.
function starterRows(source, classId, items) {
    const rows = grants(source, classId);
    const slotOf = row => Number(ItemTemplateIndex.findStrict(items, row.selfId)?.etc?.slot) || 0;
    const twoHanded = rows.some(row => row.equipped === true && slotOf(row) === 14
        && String(ItemTemplateIndex.findStrict(items, row.selfId)?.template?.kind || '').startsWith('Weapon.'));
    return rows.map(row => {
        const slot = slotOf(row);
        return { ...row, slot, equipped: row.equipped === true && !(twoHanded && slot === 8) };
    });
}
module.exports = { firstClassRow, grants, ids, importIds, snapshotIds, starterRows };

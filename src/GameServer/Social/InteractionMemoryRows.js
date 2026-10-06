'use strict';
const Policy = require('./InteractionMemoryPolicy');
// Only loaded snapshots with legacy overflow carry this weak, transient tail.
// Keys cost about 32 B each; it holds no row payload and disappears on save or GC.
const trimmedRows = new WeakMap();

function install(connection) {
    connection.exec(`CREATE TABLE IF NOT EXISTS interaction_owners (
        ownerId INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, replayFloor INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS interaction_relations (
        ownerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, targetId INTEGER NOT NULL, rowJson TEXT NOT NULL,
        PRIMARY KEY(ownerId,kind,targetId));
        CREATE INDEX IF NOT EXISTS interaction_relations_target ON interaction_relations(kind,targetId,ownerId);
        CREATE TABLE IF NOT EXISTS interaction_journal (
        ownerId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        eventKey TEXT NOT NULL, eventJson TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(ownerId,eventKey));`);
    const write = (sql, values) => connection.prepare(sql).run(...values);
    const one = (sql, values) => connection.prepare(sql).get(...values);
    const all = (sql, values) => connection.prepare(sql).all(...values);
    for (const legacy of all('SELECT ownerId,snapshotJson FROM bot_interaction_memory', [])) {
        if (one('SELECT ownerId FROM interaction_owners WHERE ownerId=?', [legacy.ownerId])) continue;
        const snapshot = Policy.validate(Policy.trim(JSON.parse(legacy.snapshotJson), Date.now()));
        save({ write }, Policy.empty(snapshot.ownerId), snapshot);
    }
    // The former player-bot store becomes directed character relations. Its
    // counters remain compatibility projections; it no longer receives writes.
    const exists = one("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_social_memory'", []);
    if (exists) for (const old of all('SELECT * FROM bot_social_memory', [])) {
        const before = load({ one, all }, Number(old.botId));
        const existing = before.relations.find(row => row.kind === 'character' && row.targetId === Number(old.playerId));
        const at = Math.max(0, Number(old.updatedAt || 0));
        const trust = Math.max(-100, Math.min(100, Number(old.trust || 0)));
        const row = { ...existing, kind: 'character', targetId: Number(old.playerId), at: Math.max(at, existing?.at || 0), player: true, order: existing?.order ?? before.revision,
            trust: trust < 0 ? Math.min(trust, existing?.trust ?? 0) : Math.max(trust, existing?.trust ?? 0),
            affinity: trust < 0 ? Math.min(trust, existing?.affinity ?? 0) : Math.max(trust, existing?.affinity ?? 0),
            hostility: Math.max(existing?.hostility || 0, -trust),
            fear: existing?.fear || 0, familiarity: Math.max(existing?.familiarity || 0, Math.min(100, Number(old.familiarity || 0))), reasons: existing?.reasons || [],
            social: { party_formed: Number(old.groupRuns || 0), party_wiped: Number(old.wipesTogether || 0),
                helped_in_combat: Number(old.helpedInCombat || 0), gave_useful_loot: Number(old.gaveUsefulLoot || 0),
                ignored_loot_request: Number(old.ignoredLootRequests || 0), trade_completed: Number(old.tradesCompleted || 0), insulted: Number(old.insults || 0) },
            ...(old.recentlyAbandonedAt ? { abandonedAt: Number(old.recentlyAbandonedAt) } : {}) };
        for (const [type, count] of Object.entries(existing?.social || {})) row.social[type] = Math.max(count, row.social[type] || 0);
        if (existing?.abandonedAt) row.abandonedAt = Math.max(existing.abandonedAt, row.abandonedAt || 0);
        save({ write }, before, { ...before, relations: [...before.relations.filter(relation => relation !== existing), row] });
    }
    connection.exec('DROP TABLE bot_interaction_memory; DROP TABLE IF EXISTS bot_social_memory;');
}
function load({ one, all, now = Date.now }, ownerId) {
    const header = one('SELECT revision,replayFloor FROM interaction_owners WHERE ownerId=?', [ownerId]);
    if (!header) return Policy.empty(ownerId);
    const original = { ...Policy.empty(ownerId), revision: Number(header.revision), replayFloor: Number(header.replayFloor),
        relations: all('SELECT rowJson FROM interaction_relations WHERE ownerId=? ORDER BY kind,targetId', [ownerId]).map(row => JSON.parse(row.rowJson)),
        recent: all('SELECT eventJson FROM interaction_journal WHERE ownerId=? ORDER BY at DESC,eventKey', [ownerId]).map(row => JSON.parse(row.eventJson)) };
    const snapshot = Policy.validate(Policy.trim(original, now()));
    if (snapshot.relations.length < original.relations.length) {
        const kept = new Set(snapshot.relations.map(row => `${row.kind}:${row.targetId}`));
        // ARCH-NOTE: trimming before validation removes the old rows from the diff's
        // `before`; weak discarded keys let its next write delete them without SQL reads.
        trimmedRows.set(snapshot, original.relations.filter(row => !kept.has(`${row.kind}:${row.targetId}`))
            .map(row => ({ kind: row.kind, targetId: row.targetId })));
    }
    return snapshot;
}
function save({ write }, before, after) {
    write(`INSERT INTO interaction_owners(ownerId,revision,replayFloor) VALUES (?,?,?)
        ON CONFLICT(ownerId) DO UPDATE SET revision=excluded.revision,replayFloor=excluded.replayFloor`,
    [after.ownerId, after.revision, after.replayFloor]);
    const previous = new Map(before.relations.map(row => [`${row.kind}:${row.targetId}`, row]));
    for (const row of after.relations) {
        const key = `${row.kind}:${row.targetId}`, old = previous.get(key);
        previous.delete(key);
        if (JSON.stringify(old) === JSON.stringify(row)) continue;
        write(`INSERT INTO interaction_relations(ownerId,kind,targetId,rowJson) VALUES (?,?,?,?)
            ON CONFLICT(ownerId,kind,targetId) DO UPDATE SET rowJson=excluded.rowJson`,
        [after.ownerId, row.kind, row.targetId, JSON.stringify(row)]);
    }
    for (const row of previous.values()) write('DELETE FROM interaction_relations WHERE ownerId=? AND kind=? AND targetId=?', [after.ownerId, row.kind, row.targetId]);
    const kept = new Set(after.relations.map(row => `${row.kind}:${row.targetId}`));
    for (const row of trimmedRows.get(before) || []) if (!kept.has(`${row.kind}:${row.targetId}`)) {
        write('DELETE FROM interaction_relations WHERE ownerId=? AND kind=? AND targetId=?', [after.ownerId, row.kind, row.targetId]);
    }
    const oldKeys = new Set(before.recent.map(event => event.key));
    for (const event of after.recent) if (!oldKeys.has(event.key)) write(
        'INSERT INTO interaction_journal(ownerId,eventKey,eventJson,at) VALUES (?,?,?,?)',
        [after.ownerId, event.key, JSON.stringify(event), event.at]);
    write('DELETE FROM interaction_journal WHERE ownerId=? AND at<=?', [after.ownerId, after.replayFloor]);
    trimmedRows.delete(before);
}
module.exports = { install, load, save };

'use strict';
const { JOIN_COOLDOWN_MS } = require('./ClanRules');

// One-time upgrade: retain elapsed wall time instead of starting a fresh day.
module.exports = function migrate(connection, timestamp) {
    // The policy marker survives migration renumbering and restored worlds.
    const key = 'clanJoinPenaltyVersion';
    if (Number(connection.prepare('SELECT value FROM world_meta WHERE key = ?').get(key)?.value) >= 1) return;
    const rows = connection.prepare(`SELECT c.id, c.clanJoinExpiryTime, l.statsJson, l.updatedAt
        FROM characters c LEFT JOIN bot_life_state l ON l.characterId = c.id
        WHERE c.clanJoinExpiryTime > 0 OR json_extract(l.statsJson, '$.clanDiscipline.banUntil') > 0`).all();
    const saveCharacter = connection.prepare('UPDATE characters SET clanJoinExpiryTime = ? WHERE id = ?');
    const saveBot = connection.prepare(`UPDATE bot_life_state SET statsJson = ?, updatedAt = ?,
        simulationRevision = simulationRevision + 1 WHERE characterId = ?`);
    for (const row of rows) {
        const stats = JSON.parse(row.statsJson || '{}');
        const discipline = stats.clanDiscipline;
        const expelledAt = Number(discipline?.expelledAt || 0);
        const previous = Number(row.clanJoinExpiryTime);
        // Legacy ordinary departures stored only the end of a five-day timer.
        const expiry = expelledAt > 0 ? expelledAt + JOIN_COOLDOWN_MS
            : Math.max(0, previous - 4 * JOIN_COOLDOWN_MS);
        if (previous > expiry) saveCharacter.run(expiry, row.id);
        if (expelledAt > 0 && Number(discipline.banUntil) > expiry) {
            discipline.banUntil = expiry;
            saveBot.run(JSON.stringify(stats), Math.max(timestamp, Number(row.updatedAt) + 1), row.id);
        }
    }

    // The old clan also retains the ban in its social memory. Keep all three
    // deadlines aligned without clearing the offender's reputation.
    const memories = connection.prepare('SELECT clanId, snapshotJson, updatedAt FROM clan_social_memory').all();
    let changedAt = Math.max(timestamp, ...memories.map(row => Number(row.updatedAt) + 1));
    const saveMemory = connection.prepare('UPDATE clan_social_memory SET snapshotJson = ?, updatedAt = ? WHERE clanId = ?');
    for (const row of memories) {
        const snapshot = JSON.parse(row.snapshotJson);
        let changed = false;
        for (const relation of snapshot.relations || []) {
            const discipline = relation.discipline;
            if (discipline?.stage !== 'expelled' || !(Number(discipline.banUntil) > 0)) continue;
            const expiry = Number(discipline.stageAt) + JOIN_COOLDOWN_MS;
            if (!(Number(discipline.stageAt) > 0) || discipline.banUntil <= expiry) continue;
            discipline.banUntil = expiry;
            changed = true;
        }
        if (!changed) continue;
        snapshot.revision = Number(snapshot.revision || 0) + 1;
        saveMemory.run(JSON.stringify(snapshot), changedAt++, row.clanId);
    }
    connection.prepare(`INSERT INTO world_meta(key, value) VALUES (?, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key);
};

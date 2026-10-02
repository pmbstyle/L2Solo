// Search persisted player identities without loading inventories or account details.
async function searchPlayers({ execute, query, limit = 6, classes = [], onlineIds = [] }) {
    const term = String(query || '').trim().slice(0, 80);
    if (term.length < 2) return [];
    const count = Math.max(1, Math.min(20, Math.floor(Number(limit) || 6)));
    const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await execute([`
        SELECT c.id, c.name, c.level, c.classId
        FROM characters c
        LEFT JOIN bot_life_state life ON life.characterId = c.id
        WHERE c.username NOT LIKE 'bot\\_%' ESCAPE '\\'
          AND COALESCE(life.accountName, '') NOT LIKE 'bot\\_%' ESCAPE '\\'
          AND COALESCE(json_extract(CASE WHEN json_valid(life.statsJson) THEN life.statsJson ELSE '{}' END, '$.generatedCold'), 0) != 1
          AND c.name LIKE ? ESCAPE '\\'
        ORDER BY c.name COLLATE NOCASE, c.id LIMIT ?
    `, [pattern, count], { read: true }]);
    const names = new Map(classes.map((entry) => [Number(entry.classId), entry.className || entry.name]));
    const online = new Set(onlineIds.map(Number));
    return rows.map((row) => ({ id: Number(row.id), kind: 'player', name: row.name,
        level: Number(row.level), classId: Number(row.classId), className: names.get(Number(row.classId)) || null,
        online: online.has(Number(row.id)) }));
}
module.exports = { searchPlayers };

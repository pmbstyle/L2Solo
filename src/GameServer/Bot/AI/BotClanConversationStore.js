const Database = invoke('Database');

const MAX_ROWS = 128;

function install(connection) {
    connection.exec(`
        CREATE TABLE IF NOT EXISTS bot_clan_dialogue_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clanId INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
            turnId TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('player', 'bot')),
            speakerId INTEGER REFERENCES characters(id) ON DELETE SET NULL,
            name TEXT NOT NULL,
            text TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            UNIQUE(clanId, turnId, role)
        );
        CREATE INDEX IF NOT EXISTS bot_clan_dialogue_recent ON bot_clan_dialogue_messages(clanId, id DESC);
    `);
}

async function append(clanId, turn) {
    if (!Database.isReady?.() || !(Number(clanId) > 0)) return false;
    try {
        await Database.execute([`INSERT INTO bot_clan_dialogue_messages
            (clanId, turnId, role, speakerId, name, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(clanId, turnId, role) DO NOTHING`, [Number(clanId), turn.turnId,
            turn.role, Number(turn.botId || turn.playerId) || null,
            String(turn.name || '').slice(0, 48), String(turn.text || '').slice(0, 500), Number(turn.at || Date.now())]], 'clan-dialogue:append');
        await Database.execute([`DELETE FROM bot_clan_dialogue_messages WHERE clanId = ? AND id NOT IN
            (SELECT id FROM bot_clan_dialogue_messages WHERE clanId = ? ORDER BY id DESC LIMIT ${MAX_ROWS})`,
        [Number(clanId), Number(clanId)]], 'clan-dialogue:retain');
        return true;
    } catch (_) { return false; }
}

async function recent(clanId, { since = 0, limit = 12 } = {}) {
    if (!Database.isReady?.() || !(Number(clanId) > 0)) return [];
    const count = Math.max(1, Math.min(32, Math.floor(Number(limit) || 12)));
    try {
        const rows = await Database.execute([`SELECT role, speakerId, name, text, createdAt, turnId
            FROM bot_clan_dialogue_messages WHERE clanId = ? AND createdAt >= ? ORDER BY id DESC LIMIT ?`,
        [Number(clanId), Number(since) || 0, count]], 'clan-dialogue:recent');
        return rows.reverse().map(row => ({ role: row.role, name: row.name, text: row.text, at: row.createdAt,
            turnId: row.turnId, channel: 'clan_chat', ...(row.role === 'bot' ? { botId: row.speakerId } : { playerId: row.speakerId }) }));
    } catch (_) { return []; }
}

module.exports = { install, append, recent, MAX_ROWS };

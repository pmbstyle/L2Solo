const Database = invoke('Database');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const FRIEND_TRUST = 8;
const MAX_CONST_MEMBERS = 8;
const PAGE_SIZE = 12;
const rosterWrites = new Map();

function id(subject) { return Number(subject?.characterId || subject?.actor?.fetchId?.() || 0); }
function page(value) { return Math.max(0, Number(value) || 0); }
function normalize(row) {
    let stats = {};
    try { stats = JSON.parse(row.statsJson || '{}'); } catch {}
    return { ...row, botId: Number(row.botId), trust: Number(row.trust || 0), familiarity: Number(row.familiarity || 0), selected: !!Number(row.selected), role: stats.role || 'dps' };
}
function list(playerId, where, currentPage) {
    return Database.execute([`SELECT l.characterId AS botId, l.characterName AS name, l.level, l.activity, l.currentRegion, l.statsJson, s.trust, s.familiarity, f.status,
        CASE WHEN r.botId IS NULL THEN 0 ELSE 1 END AS selected
        FROM bot_social_memory s INNER JOIN bot_life_state l ON l.characterId = s.botId
        LEFT JOIN bot_friendships f ON f.playerId = s.playerId AND f.botId = s.botId
        LEFT JOIN bot_friend_roster r ON r.playerId = s.playerId AND r.botId = s.botId
        WHERE s.playerId = ? AND ${where}
        ORDER BY s.trust DESC, s.familiarity DESC, l.characterName COLLATE NOCASE LIMIT ? OFFSET ?`,
        [playerId, PAGE_SIZE, page(currentPage) * PAGE_SIZE]
    ]).then((rows) => rows.map(normalize));
}

const BotFriendship = {
    FRIEND_TRUST, MAX_CONST_MEMBERS, PAGE_SIZE,
    init() { return Database.execute(['SELECT 1 FROM bot_friendships LIMIT 1', []], 'schema:bot-friends').catch(() => null); },
    listFriends(player, currentPage = 0) { const playerId = id(player); return playerId ? list(playerId, "f.status = 'accepted'", currentPage) : Promise.resolve([]); },
    listCandidates(player, currentPage = 0) { const playerId = id(player); return playerId ? list(playerId, "s.trust > 0 AND (f.status IS NULL OR f.status <> 'accepted')", currentPage) : Promise.resolve([]); },
    isFriend(player, botId) {
        const playerId = id(player);
        if (!playerId || !botId) return Promise.resolve(false);
        return Database.execute(["SELECT 1 FROM bot_friendships WHERE playerId = ? AND botId = ? AND status = 'accepted'", [playerId, Number(botId)]]).then((rows) => !!rows[0]);
    },
    request(player, state) {
        const playerId = id(player), botId = Number(state?.characterId || 0);
        if (!playerId || !botId) return Promise.resolve({ ok: false, reason: 'missing_bot' });
        return Database.execute(['SELECT * FROM bot_social_memory WHERE playerId = ? AND botId = ?', [playerId, botId]]).then((rows) => {
            const social = rows[0] || {};
            const accepted = Number(social.trust || 0) >= FRIEND_TRUST && Number(social.insults || 0) === 0 && !social.recentlyAbandonedAt;
            const now = Date.now();
            return Database.execute([`INSERT INTO bot_friendships (playerId, botId, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(playerId, botId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt`, [playerId, botId, accepted ? 'accepted' : 'declined', now, now]])
                .then(() => ({ ok: accepted, reason: accepted ? 'accepted' : 'trust_required', trust: Number(social.trust || 0), persona: BotPersona.generate(state) }));
        });
    },
    toggleConst(player, botId) {
        const playerId = id(player);
        if (!playerId || !botId) return Promise.resolve({ ok: false, reason: 'missing_bot' });
        const change = () => this.isFriend(player, botId).then((friend) => {
            if (!friend) return { ok: false, reason: 'not_friend' };
            return Database.execute(['SELECT 1 FROM bot_friend_roster WHERE playerId = ? AND botId = ?', [playerId, Number(botId)]]).then((rows) => {
                if (rows[0]) return Database.execute(['DELETE FROM bot_friend_roster WHERE playerId = ? AND botId = ?', [playerId, Number(botId)]]).then(() => ({ ok: true, selected: false }));
                return Database.execute(['SELECT COUNT(*) AS count FROM bot_friend_roster WHERE playerId = ?', [playerId]]).then((counts) => {
                    if (Number(counts[0]?.count || 0) >= MAX_CONST_MEMBERS) return { ok: false, reason: 'const_full' };
                    return Database.execute(['INSERT INTO bot_friend_roster (playerId, botId, selectedAt) VALUES (?, ?, ?)', [playerId, Number(botId), Date.now()]]).then(() => ({ ok: true, selected: true }));
                });
            });
        });
        const previous = rosterWrites.get(playerId) || Promise.resolve();
        const next = previous.then(change, change);
        const tracked = next.finally(() => {
            if (rosterWrites.get(playerId) === tracked) rosterWrites.delete(playerId);
        });
        rosterWrites.set(playerId, tracked);
        return next;
    },
    selected(player) {
        const playerId = id(player);
        if (!playerId) return Promise.resolve([]);
        return Database.execute([`SELECT l.* FROM bot_friend_roster r INNER JOIN bot_friendships f ON f.playerId = r.playerId AND f.botId = r.botId AND f.status = 'accepted'
            INNER JOIN bot_life_state l ON l.characterId = r.botId WHERE r.playerId = ? ORDER BY r.selectedAt`, [playerId]]);
    },
    selectedCount(player) {
        const playerId = id(player);
        if (!playerId) return Promise.resolve(0);
        return Database.execute(['SELECT COUNT(*) AS count FROM bot_friend_roster WHERE playerId = ?', [playerId]])
            .then((rows) => Number(rows[0]?.count || 0));
    }
};
module.exports = BotFriendship;

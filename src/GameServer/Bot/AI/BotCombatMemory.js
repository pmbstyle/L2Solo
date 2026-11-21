const { createHash } = require('node:crypto');

const EVENT_TYPES = {
    raid: ['raid_defeated', 'raid_failed'],
    pvp: ['pvp_encounter']
};
const COMBAT_EVENT_TYPES = Object.values(EVENT_TYPES).flat();

function characterIds(values = []) {
    return [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
}

function writeEvent(write, { kind, eventType, at, identity, summary, participantIds, bots, details, onceFor = [] }) {
    if (!EVENT_TYPES[kind]?.includes(eventType) || !Number.isSafeInteger(at) || at <= 0) return;
    const botIds = characterIds(bots).filter(id => participantIds.includes(id));
    if (!botIds.length) return;
    const key = kind + ':' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const meta = JSON.stringify({ ...details, participantIds });
    // A closing event can have a different observed subset from a later cleanup.
    const existing = onceFor.length ? 'botId IN (SELECT value FROM json_each(?))' : 'botId = c.id';
    write(`INSERT INTO bot_activity_journal (botId, eventType, summary, weight, dedupeKey, createdAt, updatedAt, metaJson)
        SELECT c.id, ?, ?, 8, ?, ?, ?, ?
        FROM json_each(?) AS bot JOIN characters c ON c.id = bot.value
        WHERE NOT EXISTS (SELECT 1 FROM bot_activity_journal
            WHERE ${existing} AND playerId IS NULL AND eventType = ? AND dedupeKey = ?)`,
    [eventType, summary, key, at, at, meta, JSON.stringify(botIds),
        ...(onceFor.length ? [JSON.stringify(onceFor)] : []), eventType, key]);
}

module.exports = { EVENT_TYPES, COMBAT_EVENT_TYPES, characterIds, writeEvent };

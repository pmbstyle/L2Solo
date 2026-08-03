const Database = invoke('Database');

const DEFAULT_RECENT_TURNS = 8;
const MAX_TEXT_CHARS = 360;

const memory = new Map();
let memoryConversationSequence = 0;
let memoryMessageSequence = 0;
let schemaPromise = null;

function now() {
    return Date.now();
}

function numericId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : 0;
}

function pairKey(playerId, botId) {
    return `${numericId(playerId)}:${numericId(botId)}`;
}

function text(value, max = MAX_TEXT_CHARS) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeMeta(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (_) {
        return null;
    }
}

function normalizeConversation(row) {
    if (!row) return null;
    return {
        id: row.id,
        playerId: numericId(row.playerId),
        botId: numericId(row.botId),
        summary: text(row.summary, 1600),
        summaryThroughId: Number(row.summaryThroughId || 0),
        summaryThroughOrdinal: Number(row.summaryThroughOrdinal || 0),
        nextTurnOrdinal: Number(row.nextTurnOrdinal || 0),
        version: Number(row.version || 0),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0)
    };
}

function normalizeTurn(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        conversationId: row.conversationId,
        turnId: String(row.turnId || ''),
        role: row.role,
        channel: row.channel || 'local',
        text: text(row.text),
        requestId: row.requestId || null,
        delivered: Number(row.delivered || 0) === 1,
        createdAt: Number(row.createdAt || 0),
        turnOrdinal: Number(row.turnOrdinal || row.id || 0),
        messageOrder: Number(row.messageOrder ?? roleOrder(row.role)),
        compacted: Number(row.compacted || 0) === 1,
        meta: normalizeMeta(row.metaJson || row.meta)
    };
}

function roleOrder(role) {
    if (role === 'player') return 0;
    if (role === 'bot') return 1;
    return 2;
}

function orderedTurns(turns) {
    return [...(turns || [])].sort((left, right) => (
        Number(left.turnOrdinal || left.id || 0) - Number(right.turnOrdinal || right.id || 0) ||
        Number(left.messageOrder ?? roleOrder(left.role)) - Number(right.messageOrder ?? roleOrder(right.role)) ||
        Number(left.id || 0) - Number(right.id || 0)
    ));
}

function memoryEntry(playerId, botId) {
    const key = pairKey(playerId, botId);
    let entry = memory.get(key);
    if (!entry) {
        const createdAt = now();
        entry = {
            conversation: {
                id: `memory:${++memoryConversationSequence}`,
                playerId: numericId(playerId),
                botId: numericId(botId),
                summary: '',
                summaryThroughId: 0,
                summaryThroughOrdinal: 0,
                nextTurnOrdinal: 0,
                version: 0,
                createdAt,
                updatedAt: createdAt
            },
            turns: []
        };
        memory.set(key, entry);
    }
    return entry;
}

function copyConversation(conversation) {
    return conversation ? { ...conversation } : null;
}

function copyTurn(turn) {
    return turn ? { ...turn, meta: turn.meta ? { ...turn.meta } : null } : null;
}

function databaseReady() {
    return typeof Database.isReady === 'function' && Database.isReady();
}

function ensureSchema() {
    if (!databaseReady()) return Promise.resolve(false);
    if (!schemaPromise) {
        schemaPromise = Database.execute([
            'SELECT 1 FROM bot_conversations LIMIT 1',
            []
        ], 'schema:bot-conversations').then(() => true).catch(() => false);
    }
    return schemaPromise;
}

async function loadFromDatabase(playerId, botId) {
    if (!(await ensureSchema())) return null;
    const rows = await Database.execute([
        `SELECT id, playerId, botId, summary, summaryThroughId, summaryThroughOrdinal, nextTurnOrdinal, version, createdAt, updatedAt
         FROM bot_conversations WHERE playerId = ? AND botId = ? LIMIT 1`,
        [numericId(playerId), numericId(botId)]
    ], 'bot-conversation:load');
    return normalizeConversation(rows[0]);
}

async function ensureConversation(playerId, botId) {
    const player = numericId(playerId);
    const bot = numericId(botId);
    if (!player || !bot) throw new Error('invalid conversation pair');

    const key = pairKey(player, bot);
    const cached = memory.get(key);
    if (cached) return cached;

    let conversation = null;
    try {
        conversation = await loadFromDatabase(player, bot);
    } catch (_) {
        conversation = null;
    }

    if (!conversation && databaseReady() && await ensureSchema()) {
        const createdAt = now();
        try {
            await Database.execute([
                `INSERT INTO bot_conversations (playerId, botId, summary, summaryThroughId, summaryThroughOrdinal, nextTurnOrdinal, version, createdAt, updatedAt)
                 VALUES (?, ?, '', 0, 0, 0, 0, ?, ?)
                 ON CONFLICT(playerId, botId) DO NOTHING`,
                [player, bot, createdAt, createdAt]
            ], 'bot-conversation:create');
            conversation = await loadFromDatabase(player, bot);
        } catch (_) {
            conversation = null;
        }
    }

    const entry = memoryEntry(player, bot);
    if (conversation) {
        entry.conversation = conversation;
    }
    return entry;
}

async function loadTurns(entry, limit = DEFAULT_RECENT_TURNS, includeCompacted = false) {
    if (!entry?.conversation) return [];
    const conversationId = entry.conversation.id;
    const count = Math.max(1, Number(limit) || DEFAULT_RECENT_TURNS);
    const summaryThroughOrdinal = Number(entry.conversation.summaryThroughOrdinal || 0);
    if (String(conversationId).startsWith('memory:')) {
        return orderedTurns(entry.turns)
            .filter((turn) => includeCompacted || (!turn.compacted && Number(turn.turnOrdinal || turn.id) > summaryThroughOrdinal))
            .slice(-count)
            .map(copyTurn);
    }

    try {
        const rows = await Database.execute([
            `SELECT id, conversationId, turnId, role, channel, text, requestId, delivered, createdAt, metaJson,
                    turnOrdinal, messageOrder, compacted
             FROM (
                 SELECT id, conversationId, turnId, role, channel, text, requestId, delivered, createdAt, metaJson,
                        turnOrdinal, messageOrder, compacted
                 FROM bot_conversation_messages
                 WHERE conversationId = ? ${includeCompacted ? '' : 'AND compacted = 0 AND turnOrdinal > ?'}
                 ORDER BY turnOrdinal DESC, messageOrder DESC, id DESC
                 LIMIT ?
             )
             ORDER BY turnOrdinal ASC, messageOrder ASC, id ASC`,
            includeCompacted
                ? [conversationId, count]
                : [conversationId, summaryThroughOrdinal, count]
        ], 'bot-conversation:recent');
        return rows.map(normalizeTurn);
    } catch (_) {
        return orderedTurns(entry.turns)
            .filter((turn) => includeCompacted || (!turn.compacted && Number(turn.turnOrdinal || turn.id) > summaryThroughOrdinal))
            .slice(-count)
            .map(copyTurn);
    }
}

async function turnOrdinalFor(entry, turnId) {
    const existing = orderedTurns(entry.turns).find((turn) => turn.turnId === turnId);
    if (existing?.turnOrdinal) return Number(existing.turnOrdinal);

    if (!String(entry.conversation.id).startsWith('memory:')) {
        try {
            const rows = await Database.execute([
                `SELECT turnOrdinal
                 FROM bot_conversation_messages
                 WHERE conversationId = ? AND turnId = ?
                 ORDER BY id ASC LIMIT 1`,
                [entry.conversation.id, turnId]
            ], 'bot-conversation:turn-ordinal');
            const persisted = Number(rows[0]?.turnOrdinal || 0);
            if (persisted > 0) return persisted;
        } catch (_) {
            // Fall through to the local allocator while the database is unavailable.
        }
    }

    if (!String(entry.conversation.id).startsWith('memory:')) {
        try {
            await Database.execute([
                'UPDATE bot_conversations SET nextTurnOrdinal = nextTurnOrdinal + 1 WHERE id = ?',
                [entry.conversation.id]
            ], 'bot-conversation:allocate-turn');
            const rows = await Database.execute([
                'SELECT nextTurnOrdinal FROM bot_conversations WHERE id = ? LIMIT 1',
                [entry.conversation.id]
            ], 'bot-conversation:read-turn-ordinal');
            const persisted = Number(rows[0]?.nextTurnOrdinal || 0);
            if (persisted > 0) {
                entry.conversation.nextTurnOrdinal = persisted;
                return persisted;
            }
        } catch (_) {
            // Fall through to the in-memory allocator.
        }
    }

    const next = Math.max(
        Number(entry.conversation.nextTurnOrdinal || 0),
        ...entry.turns.map((turn) => Number(turn.turnOrdinal || 0))
    ) + 1;
    entry.conversation.nextTurnOrdinal = next;
    return next;
}

async function appendTurn(input = {}) {
    const entry = await ensureConversation(input.playerId, input.botId);
    const conversation = entry.conversation;
    const turnId = text(input.turnId || `turn-${now()}-${++memoryMessageSequence}`, 128);
    const role = ['player', 'bot', 'system'].includes(input.role) ? input.role : 'system';
    const channel = text(input.channel || 'local', 32) || 'local';
    const value = text(input.text);
    const existing = entry.turns.find((turn) => turn.turnId === turnId && turn.role === role);
    if (existing) {
        return { conversation: copyConversation(conversation), turn: copyTurn(existing), inserted: false };
    }

    const turnOrdinal = Number(input.turnOrdinal || 0) || await turnOrdinalFor(entry, turnId);
    const createdAt = Number(input.createdAt || now());
    const turn = {
        id: ++memoryMessageSequence,
        conversationId: conversation.id,
        turnId,
        role,
        channel,
        text: value,
        requestId: input.requestId ? text(input.requestId, 128) : null,
        delivered: input.delivered !== false,
        createdAt,
        turnOrdinal,
        messageOrder: Number(input.messageOrder ?? roleOrder(role)),
        compacted: false,
        meta: input.meta && typeof input.meta === 'object' ? { ...input.meta } : null
    };
    entry.turns.push(turn);
    conversation.updatedAt = createdAt;

    if (!String(conversation.id).startsWith('memory:')) {
        try {
            const result = await Database.execute([
                `INSERT OR IGNORE INTO bot_conversation_messages
                 (conversationId, turnId, role, channel, text, requestId, delivered, createdAt, metaJson, turnOrdinal, messageOrder, compacted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    conversation.id,
                    turn.turnId,
                    turn.role,
                    turn.channel,
                    turn.text,
                    turn.requestId,
                    turn.delivered ? 1 : 0,
                    turn.createdAt,
                    turn.meta ? JSON.stringify(turn.meta) : null,
                    turn.turnOrdinal,
                    turn.messageOrder,
                    turn.compacted ? 1 : 0
                ]
            ], 'bot-conversation:append');
            if (Number(result.affectedRows || 0) === 0) {
                entry.turns.pop();
                const rows = await Database.execute([
                    `SELECT id, conversationId, turnId, role, channel, text, requestId, delivered, createdAt, metaJson,
                            turnOrdinal, messageOrder, compacted
                     FROM bot_conversation_messages WHERE conversationId = ? AND turnId = ? AND role = ? LIMIT 1`,
                    [conversation.id, turn.turnId, turn.role]
                ], 'bot-conversation:dedupe');
                const existingRow = normalizeTurn(rows[0]);
                if (existingRow) entry.turns.push(existingRow);
                return { conversation: copyConversation(conversation), turn: copyTurn(existingRow), inserted: false };
            }
            const rows = await Database.execute([
                `SELECT id, conversationId, turnId, role, channel, text, requestId, delivered, createdAt, metaJson,
                        turnOrdinal, messageOrder, compacted
                 FROM bot_conversation_messages WHERE conversationId = ? AND turnId = ? AND role = ? LIMIT 1`,
                [conversation.id, turn.turnId, turn.role]
            ], 'bot-conversation:append-row');
            const persisted = normalizeTurn(rows[0]);
            if (persisted) {
                entry.turns.pop();
                entry.turns.push(persisted);
                turn.id = persisted.id;
                turn.conversationId = persisted.conversationId;
            }
            await Database.execute([
                'UPDATE bot_conversations SET updatedAt = ? WHERE id = ?',
                [createdAt, conversation.id]
            ], 'bot-conversation:touch');
        } catch (_) {
            // Keep the in-memory turn usable if persistence is temporarily unavailable.
        }
    }

    return { conversation: copyConversation(conversation), turn: copyTurn(turn), inserted: true };
}

async function context(playerId, botId, options = {}) {
    const entry = await ensureConversation(playerId, botId);
    const recentTurns = await loadTurns(
        entry,
        options.limit || DEFAULT_RECENT_TURNS,
        options.includeCompacted === true
    );
    return {
        conversation: copyConversation(entry.conversation),
        recentTurns,
        summary: entry.conversation.summary || null,
        summaryThroughId: Number(entry.conversation.summaryThroughId || 0),
        summaryThroughOrdinal: Number(entry.conversation.summaryThroughOrdinal || 0),
        version: Number(entry.conversation.version || 0)
    };
}

async function setSummary(input = {}) {
    const entry = await ensureConversation(input.playerId, input.botId);
    const conversation = entry.conversation;
    const expectedVersion = Number(input.expectedVersion ?? conversation.version);
    if (expectedVersion !== Number(conversation.version || 0)) {
        return { ok: false, reason: 'version_conflict', conversation: copyConversation(conversation) };
    }

    const summary = text(input.summary, 1600);
    const throughId = Math.max(0, Number(input.summaryThroughId || 0));
    let throughOrdinal = Math.max(0, Number(input.summaryThroughOrdinal || 0));
    if (!throughOrdinal && throughId) {
        throughOrdinal = Number(
            orderedTurns(entry.turns).find((turn) => Number(turn.id) === throughId)?.turnOrdinal || 0
        );
    }
    if (!throughOrdinal && throughId && !String(conversation.id).startsWith('memory:')) {
        try {
            const rows = await Database.execute([
                `SELECT turnOrdinal
                 FROM bot_conversation_messages
                 WHERE conversationId = ? AND id = ? LIMIT 1`,
                [conversation.id, throughId]
            ], 'bot-conversation:summary-ordinal');
            throughOrdinal = Number(rows[0]?.turnOrdinal || 0);
        } catch (_) {
            // Keep the legacy id boundary if the ordinal cannot be read.
        }
    }
    const nextVersion = expectedVersion + 1;
    if (!String(conversation.id).startsWith('memory:')) {
        try {
            const result = await Database.execute([
                `UPDATE bot_conversations
                 SET summary = ?, summaryThroughId = ?, summaryThroughOrdinal = ?, version = ?, updatedAt = ?
                 WHERE id = ? AND version = ?`,
                [summary, throughId, throughOrdinal, nextVersion, now(), conversation.id, expectedVersion]
            ], 'bot-conversation:summary');
            if (Number(result.affectedRows || 0) === 0) {
                return { ok: false, reason: 'version_conflict', conversation: copyConversation(conversation) };
            }
            Database.execute([
                `UPDATE bot_conversation_messages
                 SET compacted = 1
                 WHERE conversationId = ? AND turnOrdinal <= ?`,
                [conversation.id, throughOrdinal]
            ], 'bot-conversation:mark-compacted').catch(() => {});
        } catch (_) {
            return { ok: false, reason: 'persistence_error', conversation: copyConversation(conversation) };
        }
    }

    conversation.summary = summary;
    conversation.summaryThroughId = throughId;
    conversation.summaryThroughOrdinal = throughOrdinal;
    conversation.version = nextVersion;
    conversation.updatedAt = now();
    return { ok: true, conversation: copyConversation(conversation) };
}

const BotConversationStore = {
    DEFAULT_RECENT_TURNS,
    MAX_TEXT_CHARS,
    ensureSchema,
    ensureConversation,
    appendTurn,
    context,
    setSummary,
    resetMemory() {
        memory.clear();
        schemaPromise = null;
        memoryConversationSequence = 0;
        memoryMessageSequence = 0;
    },
    memorySize() {
        return memory.size;
    }
};

module.exports = BotConversationStore;

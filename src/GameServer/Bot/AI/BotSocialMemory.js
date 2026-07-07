const Database = invoke('Database');

const TABLE = 'bot_social_memory';
const cache = new Map();
const loadedKeys = new Set();
const pendingWrites = new Map();
const combatHelpSeen = new Set();
let initialized = false;
let initStarted = false;

function now() {
    return Date.now();
}

function actorId(session) {
    if (session?.characterId) return Number(session.characterId);
    return session?.actor?.fetchId ? Number(session.actor.fetchId()) : 0;
}

function actorName(session) {
    if (session?.name) return session.name;
    if (session?.characterName) return session.characterName;
    return session?.actor?.fetchName ? session.actor.fetchName() : '';
}

function key(playerId, botId) {
    return `${playerId}:${botId}`;
}

function isBotSession(session) {
    return session && (session.constructor.name === 'BotSession' || (session.accountId && String(session.accountId).startsWith('bot_')));
}

function botSessionForActor(actor) {
    if (!actor || !actor.fetchId) return null;
    if (isBotSession(actor.session)) return actor.session;

    const BotManager = invoke('GameServer/Bot/BotManager');
    return BotManager.findSessionById(actor.fetchId());
}

function defaultRecord(playerSession, botSession) {
    return {
        playerId: actorId(playerSession),
        botId: actorId(botSession),
        playerName: actorName(playerSession),
        botName: actorName(botSession),
        trust: 0,
        familiarity: 0,
        lastGroupedAt: null,
        groupRuns: 0,
        wipesTogether: 0,
        helpedInCombat: 0,
        gaveUsefulLoot: 0,
        ignoredLootRequests: 0,
        tradesCompleted: 0,
        insults: 0,
        recentlyAbandonedAt: null,
        notes: ''
    };
}

function normalize(row, playerSession, botSession) {
    return {
        ...defaultRecord(playerSession, botSession),
        ...row,
        playerId: Number(row.playerId),
        botId: Number(row.botId),
        trust: Number(row.trust || 0),
        familiarity: Number(row.familiarity || 0),
        groupRuns: Number(row.groupRuns || 0),
        wipesTogether: Number(row.wipesTogether || 0),
        helpedInCombat: Number(row.helpedInCombat || 0),
        gaveUsefulLoot: Number(row.gaveUsefulLoot || 0),
        ignoredLootRequests: Number(row.ignoredLootRequests || 0),
        tradesCompleted: Number(row.tradesCompleted || 0),
        insults: Number(row.insults || 0),
        lastGroupedAt: row.lastGroupedAt ? Number(row.lastGroupedAt) : null,
        recentlyAbandonedAt: row.recentlyAbandonedAt ? Number(row.recentlyAbandonedAt) : null
    };
}

function relationship(record) {
    if (!record) return 'stranger';
    if (record.trust >= 8) return 'trusted';
    if (record.trust >= 3 || record.familiarity >= 5) return 'friendly';
    if (record.trust <= -5) return 'wary';
    return record.familiarity > 0 ? 'familiar' : 'stranger';
}

function applyEvent(record, eventName) {
    const updated = { ...record };
    const before = {
        trust: updated.trust,
        familiarity: updated.familiarity
    };

    if (eventName === 'invite_attempt') {
        updated.familiarity += 1;
    } else if (eventName === 'party_formed') {
        updated.trust += 2;
        updated.familiarity += 2;
        updated.groupRuns += 1;
        updated.lastGroupedAt = now();
    } else if (eventName === 'party_refused') {
        updated.familiarity += 1;
    } else if (eventName === 'party_dismissed') {
        updated.trust -= 1;
        updated.recentlyAbandonedAt = now();
    } else if (eventName === 'party_kicked') {
        updated.trust -= 3;
        updated.recentlyAbandonedAt = now();
    } else if (eventName === 'party_wiped') {
        updated.trust -= 2;
        updated.familiarity += 1;
        updated.wipesTogether += 1;
    } else if (eventName === 'chat') {
        updated.familiarity += 1;
    } else if (eventName === 'helped_in_combat') {
        updated.trust += 3;
        updated.familiarity += 1;
        updated.helpedInCombat += 1;
    } else if (eventName === 'trade_completed') {
        updated.trust += 1;
        updated.familiarity += 1;
        updated.tradesCompleted += 1;
    } else if (eventName === 'gave_useful_loot') {
        updated.trust += 3;
        updated.gaveUsefulLoot += 1;
    } else if (eventName === 'ignored_loot_request') {
        updated.trust -= 1;
        updated.ignoredLootRequests += 1;
    } else if (eventName === 'insulted') {
        updated.trust -= 3;
        updated.insults += 1;
    }

    return {
        record: updated,
        delta: {
            trust: updated.trust - before.trust,
            familiarity: updated.familiarity - before.familiarity
        }
    };
}

function save(record) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            playerId, botId, playerName, botName, trust, familiarity, lastGroupedAt,
            groupRuns, wipesTogether, helpedInCombat, gaveUsefulLoot, ignoredLootRequests,
            tradesCompleted, insults, recentlyAbandonedAt, notes, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            playerName = VALUES(playerName),
            botName = VALUES(botName),
            trust = VALUES(trust),
            familiarity = VALUES(familiarity),
            lastGroupedAt = VALUES(lastGroupedAt),
            groupRuns = VALUES(groupRuns),
            wipesTogether = VALUES(wipesTogether),
            helpedInCombat = VALUES(helpedInCombat),
            gaveUsefulLoot = VALUES(gaveUsefulLoot),
            ignoredLootRequests = VALUES(ignoredLootRequests),
            tradesCompleted = VALUES(tradesCompleted),
            insults = VALUES(insults),
            recentlyAbandonedAt = VALUES(recentlyAbandonedAt),
            notes = VALUES(notes),
            updatedAt = VALUES(updatedAt)`,
        [
            record.playerId,
            record.botId,
            record.playerName,
            record.botName,
            record.trust,
            record.familiarity,
            record.lastGroupedAt,
            record.groupRuns,
            record.wipesTogether,
            record.helpedInCombat,
            record.gaveUsefulLoot,
            record.ignoredLootRequests,
            record.tradesCompleted,
            record.insults,
            record.recentlyAbandonedAt,
            record.notes,
            now()
        ]
    ]);
}

const BotSocialMemory = {
    init() {
        if (initialized || initStarted) return;
        initStarted = true;

        Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                playerId INT NOT NULL,
                botId INT NOT NULL,
                playerName VARCHAR(35) NOT NULL DEFAULT '',
                botName VARCHAR(35) NOT NULL DEFAULT '',
                trust INT NOT NULL DEFAULT 0,
                familiarity INT NOT NULL DEFAULT 0,
                lastGroupedAt BIGINT NULL,
                groupRuns INT NOT NULL DEFAULT 0,
                wipesTogether INT NOT NULL DEFAULT 0,
                helpedInCombat INT NOT NULL DEFAULT 0,
                gaveUsefulLoot INT NOT NULL DEFAULT 0,
                ignoredLootRequests INT NOT NULL DEFAULT 0,
                tradesCompleted INT NOT NULL DEFAULT 0,
                insults INT NOT NULL DEFAULT 0,
                recentlyAbandonedAt BIGINT NULL,
                notes TEXT NULL,
                updatedAt BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (playerId, botId)
            )`,
            []
        ]).then(() => {
            initialized = true;
            utils.infoSuccess('BotSocial', 'memory table ready');
        }).catch((err) => {
            utils.infoWarn('BotSocial', 'memory table unavailable: %s', err.message);
        });
    },

    getSnapshot(playerSession, botSession) {
        const playerId = actorId(playerSession);
        const botId = actorId(botSession);
        if (!playerId || !botId) return defaultRecord(playerSession, botSession);

        const cacheKey = key(playerId, botId);
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const fallback = defaultRecord(playerSession, botSession);
        cache.set(cacheKey, fallback);
        this.load(playerSession, botSession);
        return fallback;
    },

    load(playerSession, botSession) {
        const playerId = actorId(playerSession);
        const botId = actorId(botSession);
        if (!playerId || !botId) return Promise.resolve(null);

        return Database.execute([
            `SELECT * FROM ${TABLE} WHERE playerId = ? AND botId = ? LIMIT 1`,
            [playerId, botId]
        ]).then((rows) => {
            loadedKeys.add(key(playerId, botId));
            if (!rows[0]) return null;
            const record = normalize(rows[0], playerSession, botSession);
            cache.set(key(playerId, botId), record);
            return record;
        }).catch(() => null);
    },

    recordEvent(playerSession, botSession, eventName, detail = '') {
        const playerId = actorId(playerSession);
        const botId = actorId(botSession);
        if (!playerId || !botId) return Promise.resolve(null);

        const cacheKey = key(playerId, botId);
        const update = (loadedRecord) => {
            const base = loadedRecord || cache.get(cacheKey) || defaultRecord(playerSession, botSession);
            const result = applyEvent(base, eventName);
            const record = {
                ...result.record,
                playerName: actorName(playerSession),
                botName: actorName(botSession)
            };

            cache.set(cacheKey, record);
            loadedKeys.add(cacheKey);
            botSession.socialSummary = {
                playerName: record.playerName,
                trust: record.trust,
                familiarity: record.familiarity,
                relationship: relationship(record)
            };
            botSession.lastSocialEvent = {
                playerName: record.playerName,
                event: eventName,
                detail,
                at: now()
            };

            const trustDelta = result.delta.trust === 0 ? '' : ` trust ${result.delta.trust > 0 ? '+' : ''}${result.delta.trust}`;
            const familiarDelta = result.delta.familiarity === 0 ? '' : ` familiarity ${result.delta.familiarity > 0 ? '+' : ''}${result.delta.familiarity}`;
            console.info('BotSocial :: %s -> %s %s%s%s', record.botName, record.playerName, eventName, trustDelta, familiarDelta);

            return save(record).catch((err) => {
                utils.infoWarn('BotSocial', 'failed to save %s/%s: %s', record.playerName, record.botName, err.message);
                return record;
            });
        };

        const run = () => {
            if (!loadedKeys.has(cacheKey)) {
                return this.load(playerSession, botSession).then((loadedRecord) => update(loadedRecord));
            }

            return update(cache.get(cacheKey));
        };

        const previous = pendingWrites.get(cacheKey) || Promise.resolve();
        const next = previous.then(run, run);
        const tracked = next.finally(() => {
            if (pendingWrites.get(cacheKey) === tracked) {
                pendingWrites.delete(cacheKey);
            }
        });
        pendingWrites.set(cacheKey, tracked);
        return next;
    },

    recordTradeCompleted(playerSession, merchantActor, detail = '') {
        if (!playerSession || isBotSession(playerSession)) return Promise.resolve(null);

        let botSession = null;
        try {
            botSession = botSessionForActor(merchantActor);
        } catch (err) {
            utils.infoWarn('BotSocial', 'trade social lookup failed: %s', err.message);
            return Promise.resolve(null);
        }

        if (!botSession || botSession.plan !== 'merchant') return Promise.resolve(null);
        return this.recordEvent(playerSession, botSession, 'trade_completed', detail);
    },

    recordCombatHelp(playerSession, npc, detail = '') {
        if (!playerSession || isBotSession(playerSession) || !npc || !npc.fetchId) {
            return [];
        }

        const playerId = actorId(playerSession);
        const npcId = npc.fetchId();
        if (!playerId || !npcId) return [];

        let botSessions = [];
        try {
            const BotManager = invoke('GameServer/Bot/BotManager');
            botSessions = BotManager.sessions;
        } catch (err) {
            utils.infoWarn('BotSocial', 'combat social lookup failed: %s', err.message);
            return [];
        }

        if (combatHelpSeen.size > 5000) {
            combatHelpSeen.clear();
        }

        return botSessions
            .filter((botSession) => (
                botSession.actor &&
                botSession.followPlayerSession === playerSession &&
                botSession.partyCompanion === true &&
                botSession.currentTargetId === npcId
            ))
            .map((botSession) => {
                const seenKey = `${playerId}:${actorId(botSession)}:${npcId}`;
                if (combatHelpSeen.has(seenKey)) return null;

                combatHelpSeen.add(seenKey);
                return this.recordEvent(playerSession, botSession, 'helped_in_combat', detail || `shared target ${npcId}`);
            })
            .filter(Boolean);
    },

    relationship
};

module.exports = BotSocialMemory;

const Database = invoke('Database');

const TABLE = 'bot_goal_state';
const cache = new Map();
let initialized = false;
let initPromise = null;

const STATUSES = new Set(['planned', 'active', 'blocked', 'completed', 'abandoned']);

function now() {
    return Date.now();
}

function parseJson(raw, fallback = {}) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeGoal(goal = {}, timestamp = now()) {
    const type = text(goal.type);
    if (!type) return null;

    const status = STATUSES.has(goal.status) ? goal.status : 'planned';
    return {
        type,
        status,
        priority: Math.max(0, Math.min(100, Number(goal.priority) || 0)),
        target: goal.target && typeof goal.target === 'object' ? { ...goal.target } : {},
        plan: goal.plan && typeof goal.plan === 'object' ? { ...goal.plan } : {},
        progress: goal.progress && typeof goal.progress === 'object' ? { ...goal.progress } : {},
        blockers: Array.isArray(goal.blockers) ? [...new Set(goal.blockers.map(text).filter(Boolean))].slice(0, 8) : [],
        createdAt: Number(goal.createdAt) || timestamp,
        reviewedAt: Number(goal.reviewedAt) || timestamp,
        nextReviewAt: Number(goal.nextReviewAt) || timestamp + 60000
    };
}

function normalize(row) {
    const characterId = Number(row?.characterId || 0);
    if (!characterId) return null;

    return {
        characterId,
        current: normalizeGoal(parseJson(row.goalJson, null), Number(row.updatedAt) || now()),
        updatedAt: Number(row.updatedAt || 0)
    };
}

function save(snapshot) {
    return Database.execute([
        `INSERT INTO ${TABLE} (characterId, goalJson, updatedAt)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            goalJson = VALUES(goalJson),
            updatedAt = VALUES(updatedAt)`,
        [snapshot.characterId, safeJson(snapshot.current), snapshot.updatedAt]
    ]);
}

const GoalState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initPromise) return initPromise;

        initPromise = Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                characterId INT NOT NULL PRIMARY KEY,
                goalJson TEXT NULL,
                updatedAt BIGINT NOT NULL
            )`,
            []
        ]).then(() => {
            initialized = true;
            return true;
        }).catch((err) => {
            utils.infoWarn('BotGoals', 'goal state table unavailable: %s', err.message);
            initPromise = null;
            return false;
        });

        return initPromise;
    },

    snapshot(characterId) {
        return cache.get(Number(characterId)) || null;
    },

    load(characterId) {
        const id = Number(characterId || 0);
        if (!id) return Promise.resolve(null);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);

        return this.init().then((ready) => {
            if (!ready) return null;
            return Database.execute([
                `SELECT characterId, goalJson, updatedAt FROM ${TABLE} WHERE characterId = ? LIMIT 1`,
                [id]
            ]).then((rows) => {
                const snapshot = normalize(rows?.[0]);
                if (snapshot) cache.set(id, snapshot);
                return snapshot;
            });
        }).catch((err) => {
            utils.infoWarn('BotGoals', 'failed to load goal state for %d: %s', id, err.message);
            return null;
        });
    },

    set(characterId, goal) {
        const id = Number(characterId || 0);
        const current = normalizeGoal(goal);
        if (!id || !current) return Promise.resolve(null);

        const snapshot = { characterId: id, current, updatedAt: now() };
        return this.init().then((ready) => {
            if (!ready) return null;
            return save(snapshot).then(() => {
                cache.set(id, snapshot);
                return snapshot;
            });
        }).catch((err) => {
            utils.infoWarn('BotGoals', 'failed to save goal state for %d: %s', id, err.message);
            return null;
        });
    },

    clear(characterId, status = 'abandoned') {
        const existing = this.snapshot(characterId);
        if (!existing?.current) return Promise.resolve(existing || null);

        return this.set(characterId, {
            ...existing.current,
            status: STATUSES.has(status) ? status : 'abandoned',
            reviewedAt: now(),
            nextReviewAt: now()
        });
    },

    reset() {
        cache.clear();
        initialized = false;
        initPromise = null;
    }
};

module.exports = GoalState;

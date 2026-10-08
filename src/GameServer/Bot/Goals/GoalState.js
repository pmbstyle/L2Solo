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

    const plan = goal.plan && typeof goal.plan === 'object' ? { ...goal.plan } : {};
    delete plan.economyInputKey; delete plan.inputKey;
    const status = STATUSES.has(goal.status) ? goal.status : 'planned';
    return {
        type,
        status,
        priority: Math.max(0, Math.min(100, Number(goal.priority) || 0)),
        target: goal.target && typeof goal.target === 'object' ? { ...goal.target } : {},
        plan,
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

// Shared by the asynchronous goal caller and the native NPC transaction.
function purchasePatch(expectedGoal, units, timestamp = now()) {
    const amount = expectedGoal?.type === 'upgrade_gear' ? 1 : Number(expectedGoal?.target?.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(units) || units <= 0) return null;
    const remaining = Math.max(0, amount - units);
    return normalizeGoal({ ...expectedGoal, target: { ...expectedGoal.target, amount: remaining },
        status: remaining ? 'active' : 'completed', reviewedAt: timestamp, nextReviewAt: timestamp });
}

function save(snapshot) {
    return Database.execute([
        `INSERT INTO ${TABLE} (characterId, goalJson, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(characterId) DO UPDATE SET
            goalJson = excluded.goalJson,
            updatedAt = excluded.updatedAt`,
        [snapshot.characterId, safeJson(snapshot.current), snapshot.updatedAt]
    ]);
}

const GoalState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initPromise) return initPromise;

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-goals').then(() => {
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

    prime(characterId, goalJson, updatedAt = now()) {
        const snapshot = normalize({ characterId, goalJson, updatedAt });
        if (snapshot) cache.set(snapshot.characterId, snapshot);
        return snapshot;
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

    set(characterId, goal, { inputHash } = {}) {
        const id = Number(characterId || 0);
        const current = normalizeGoal(goal);
        if (!id || !current) return Promise.resolve(null);

        const snapshot = { characterId: id, current, updatedAt: now(), inputHash };
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

    setBatch(entries = []) {
        const snapshots = (entries || []).map((entry) => {
            const characterId = Number(entry?.characterId || 0);
            const current = normalizeGoal(entry?.goal);
            if (!characterId || !current) return null;
            return { characterId, current, updatedAt: now(), inputHash: entry.inputHash };
        }).filter(Boolean);
        if (!snapshots.length) return Promise.resolve([]);
        return this.init().then((ready) => {
            if (!ready) return [];
            return Database.upsertBotGoalStates(snapshots.map((snapshot) => ({
                characterId: snapshot.characterId,
                goalJson: safeJson(snapshot.current),
                updatedAt: snapshot.updatedAt
            }))).then(() => {
                snapshots.forEach((snapshot) => cache.set(snapshot.characterId, snapshot));
                return snapshots;
            });
        }).catch((err) => {
            utils.infoWarn('BotGoals', 'failed to save %d goal states: %s', snapshots.length, err.message);
            return [];
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

    // Advance only the goal accepted before the asynchronous native purchase.
    // Matching its persisted value also makes a repeated receipt a no-op.
    applyPurchase(characterId, expectedGoal, units) {
        const id = Number(characterId), existing = this.snapshot(id);
        if (!existing?.current || safeJson(existing.current) !== safeJson(expectedGoal)
            || !Number.isSafeInteger(units) || units <= 0) return Promise.resolve(null);
        const timestamp = now(), current = purchasePatch(existing.current, units, timestamp);
        if (!current) return Promise.resolve(null);
        const snapshot = { ...existing, current, updatedAt: timestamp, inputHash: undefined };
        return Database.execute([
            `UPDATE ${TABLE} SET goalJson = ?, updatedAt = ?
             WHERE characterId = ? AND updatedAt = ? AND goalJson = ?`,
            [safeJson(current), timestamp, id, existing.updatedAt, safeJson(existing.current)]
        ], 'bot-goals:purchase-progress').then(result => {
            if (Number(result?.affectedRows) !== 1) return null;
            if (cache.get(id) === existing) cache.set(id, snapshot);
            return snapshot;
        });
    },

    reset() {
        cache.clear();
        initialized = false;
        initPromise = null;
    }
};

GoalState.purchasePatch = purchasePatch;

module.exports = GoalState;

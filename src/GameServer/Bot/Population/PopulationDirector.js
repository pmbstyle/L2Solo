const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentileFromHistogram(rows, percentile) {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    if (total <= 0) return null;

    const target = Math.max(1, Math.ceil(total * percentile));
    let seen = 0;
    for (const row of rows) {
        seen += row.count;
        if (seen >= target) return row.level;
    }
    return rows[rows.length - 1]?.level || null;
}

function summarizeHistogram(histogram, targetLevel) {
    const byLevel = new Map();
    histogram.levels.forEach((row) => {
        byLevel.set(row.level, (byLevel.get(row.level) || 0) + row.count);
    });

    const rows = [...byLevel.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => a.level - b.level);

    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const radius = Config.directorTargetBandRadius;
    let below = 0;
    let inBand = 0;
    let above = 0;
    let newbies = 0;

    rows.forEach((row) => {
        if (row.level <= 5) newbies += row.count;
        if (!targetLevel) return;
        if (row.level < targetLevel - radius) below += row.count;
        else if (row.level > targetLevel + radius) above += row.count;
        else inBand += row.count;
    });

    return {
        total,
        min: rows[0]?.level || null,
        max: rows[rows.length - 1]?.level || null,
        median: percentileFromHistogram(rows, 0.5),
        p90: percentileFromHistogram(rows, 0.9),
        below,
        inBand,
        above,
        newbies,
        inBandRatio: total > 0 ? inBand / total : 0,
        newbieRatio: total > 0 ? newbies / total : 0
    };
}

function realPlayerLevels() {
    const World = invoke('GameServer/World/World');
    return World.user.sessions
        .filter((session) => (
            session.actor &&
            session.actor.fetchIsOnline() &&
            session.accountId &&
            !String(session.accountId).startsWith('bot_')
        ))
        .map((session) => Number(session.actor.fetchLevel() || 1))
        .filter((level) => Number.isFinite(level) && level > 0);
}

const PopulationDirector = {
    timer: null,
    lastSnapshot: {
        updatedAt: 0,
        targetLevel: null,
        reason: 'not_started',
        player: { count: 0, highest: null, median: null },
        bots: { total: 0, median: null, inBandRatio: 0, newbieRatio: 0 }
    },

    init() {
        this.refresh();
    },

    start() {
        if (this.timer || Config.directorEnabled === false) return;

        this.refresh();
        this.timer = setInterval(() => {
            this.refresh();
        }, Config.directorIntervalMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    },

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    },

    refresh() {
        if (Config.directorEnabled === false) {
            this.lastSnapshot = {
                ...this.lastSnapshot,
                updatedAt: Date.now(),
                targetLevel: null,
                reason: 'disabled'
            };
            return Promise.resolve(this.lastSnapshot);
        }

        const playerLevels = realPlayerLevels();
        const playerMedian = median(playerLevels);
        const targetLevel = playerMedian || null;

        return LifeState.levelHistogram().then((histogram) => {
            const bots = summarizeHistogram(histogram, targetLevel);
            this.lastSnapshot = {
                updatedAt: Date.now(),
                targetLevel,
                reason: targetLevel ? 'active_players' : 'no_active_players',
                player: {
                    count: playerLevels.length,
                    highest: playerLevels.length ? Math.max(...playerLevels) : null,
                    median: playerMedian
                },
                bots,
                phases: histogram.phases
            };
            return this.lastSnapshot;
        });
    },

    pressureForState(state) {
        const snapshot = this.lastSnapshot || {};
        const targetLevel = Number(snapshot.targetLevel || 0);
        if (!targetLevel) {
            return {
                expMultiplier: 1,
                deathChanceMultiplier: 1,
                directorReason: snapshot.reason || 'no_target'
            };
        }

        const level = Number(state?.level || 1);
        const radius = Config.directorTargetBandRadius;
        const delta = targetLevel - level;

        if (delta > radius) {
            const catchUp = Math.min(
                Config.directorMaxCatchUpMultiplier,
                1 + (delta - radius) * 0.06
            );
            return {
                expMultiplier: catchUp,
                deathChanceMultiplier: 0.95,
                directorReason: 'catch_up'
            };
        }

        if (delta < -radius) {
            return {
                expMultiplier: Config.directorSlowdownMultiplier,
                deathChanceMultiplier: 1.05,
                directorReason: 'ahead_slowdown'
            };
        }

        return {
            expMultiplier: 1,
            deathChanceMultiplier: 1,
            directorReason: 'in_band'
        };
    },

    snapshot() {
        return this.lastSnapshot;
    },

    statusLine() {
        const snapshot = this.lastSnapshot;
        if (!snapshot || !snapshot.targetLevel) {
            return `director=${snapshot?.reason || 'idle'}`;
        }

        const inBand = Math.round((snapshot.bots?.inBandRatio || 0) * 100);
        return `director=target:${snapshot.targetLevel} botsMedian:${snapshot.bots?.median || '-'} inBand:${inBand}%`;
    }
};

module.exports = PopulationDirector;

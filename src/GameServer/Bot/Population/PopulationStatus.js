const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');

function isBotSession(session) {
    return session && session.accountId && String(session.accountId).startsWith('bot_');
}

const PopulationStatus = {
    counts() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const sessions = BotManager.sessions || [];
        const hot = sessions.filter((session) => isBotSession(session) && session.actor).length;
        const merchants = sessions.filter((session) => isBotSession(session) && session.actor && session.plan === 'merchant').length;
        const lifeCounts = LifeState.counts();

        return {
            hot,
            warm: lifeCounts.warm || 0,
            cold: lifeCounts.cold || 0,
            merchants,
            total: Math.max(hot, lifeCounts.total || 0),
            persisted: lifeCounts.total || 0
        };
    },

    summary() {
        const counts = this.counts();
        const metrics = Metrics.snapshot();
        const lag = Math.round(metrics.eventLoop.lagMs);
        const maxLag = Math.round(metrics.eventLoop.maxLagMs);

        return {
            ...counts,
            metrics,
            director: Director.snapshot(),
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} persisted=${counts.persisted} merchants=${counts.merchants} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} skipped=${metrics.delta.skippedResolves} activations=${metrics.delta.activations} cooldowns=${metrics.delta.cooldowns} dbFlushes=${metrics.delta.dbFlushes} lag=${lag}ms maxLag=${maxLag}ms ${Director.statusLine()}`
        };
    }
};

module.exports = PopulationStatus;

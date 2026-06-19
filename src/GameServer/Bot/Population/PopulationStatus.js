const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

function isBotSession(session) {
    return session && session.accountId && String(session.accountId).startsWith('bot_');
}

const PopulationStatus = {
    counts() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const sessions = BotManager.sessions || [];
        const hot = sessions.filter((session) => isBotSession(session) && session.actor).length;
        const merchants = sessions.filter((session) => isBotSession(session) && session.actor && session.plan === 'merchant').length;

        return {
            hot,
            warm: 0,
            cold: 0,
            merchants,
            total: hot
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
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} merchants=${counts.merchants} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} skipped=${metrics.delta.skippedResolves} lag=${lag}ms maxLag=${maxLag}ms`
        };
    }
};

module.exports = PopulationStatus;

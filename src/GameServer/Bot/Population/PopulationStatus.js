const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
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
        const partyCounts = PartyState.counts();

        return {
            hot,
            warm: lifeCounts.warm || 0,
            cold: lifeCounts.cold || 0,
            parties: partyCounts.active || 0,
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
        const heapMb = metrics.memory?.heapUsed ? Math.round(metrics.memory.heapUsed / 1024 / 1024) : 0;
        const resolve = metrics.resolve || {};
        const scheduler = metrics.scheduler || {};

        return {
            ...counts,
            metrics,
            director: Director.snapshot(),
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} parties=${counts.parties} persisted=${counts.persisted} merchants=${counts.merchants} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} partyResolves=${metrics.delta.partyResolves} skipped=${metrics.delta.skippedResolves} activations=${metrics.delta.activations} cooldowns=${metrics.delta.cooldowns} partyForms=${metrics.delta.partyFormations} partyRecruits=${metrics.delta.partyRecruits} dbFlushes=${metrics.delta.dbFlushes} resolveAvg=${resolve.avgMs || 0}ms resolveP95=${resolve.p95Ms || 0}ms schedulerP95=${scheduler.p95Ms || 0}ms schedulerSkips=${metrics.delta.schedulerSkips || 0} schedulerOverruns=${metrics.delta.schedulerOverruns || 0} slowResolves=${metrics.delta.slowResolves || 0} heap=${heapMb}MB lag=${lag}ms maxLag=${maxLag}ms ${Director.statusLine()}`
        };
    }
};

module.exports = PopulationStatus;

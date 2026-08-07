const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');

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
        const coldQueue = LifeState.coldDueSummary();
        const partyCounts = PartyState.counts();
        const targetCombat = LifeState.targetCombatSummary();
        const partyRequests = LifeState.partyRequestSummary();

        return {
            hot,
            warm: lifeCounts.warm || 0,
            cold: lifeCounts.cold || 0,
            parties: partyCounts.active || 0,
            merchants,
            total: Math.max(hot, lifeCounts.total || 0),
            persisted: lifeCounts.total || 0,
            coldQueue,
            targetCombat,
            partyRequests,
            marketState: MarketSnapshot.snapshot()
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
        const schedulerSlice = metrics.schedulerSlice || {};
        const partyFormation = metrics.partyFormation || {};
        const partyFormationStages = metrics.partyFormationStages || {};
        const skipReasons = Object.entries(metrics.skippedResolveReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const market = MarketTelemetry.snapshot();
        const partyRequiredReasons = Object.entries(counts.partyRequests.requiredReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';

        return {
            ...counts,
            metrics,
            director: Director.snapshot(),
            market,
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} parties=${counts.parties} persisted=${counts.persisted} merchants=${counts.merchants} coldDue=${counts.coldQueue.due} coldDueHigh=${counts.coldQueue.highLevel} coldReplans=${counts.coldQueue.replans} coldDueAge=${Math.round(counts.coldQueue.oldestAgeMs / 1000)}s partyRequests=${counts.partyRequests.total} partyRequired=${counts.partyRequests.required} partyPreferred=${counts.partyRequests.preferred} partyBlocked=${counts.partyRequests.blocked} partyMaxAge=${Math.round(counts.partyRequests.maxAgeMs / 1000)}s partyRequiredReasons=${partyRequiredReasons} marketListings=${market.delta.listingsOpened} marketBuyStores=${market.delta.buyStoresOpened} marketBuys=${market.delta.purchases} marketItems=${market.delta.itemsSold} marketAdena=${market.delta.adenaTraded} dynamicBuyerSales=${market.delta.dynamicBuyerSales} dynamicBuyerItems=${market.delta.dynamicBuyerItems} dynamicBuyerAdena=${market.delta.dynamicBuyerAdena} staticBuyerSales=${market.delta.staticBuyerSales} staticBuyerItems=${market.delta.staticBuyerItems} staticBuyerAdena=${market.delta.staticBuyerAdena} marketNoOffer=${market.delta.noOffer} marketSoldOut=${market.delta.soldOut} marketExpired=${market.delta.expired} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} partyResolves=${metrics.delta.partyResolves} combatActions=${metrics.delta.combatActions} skillUses=${metrics.delta.skillUses} heals=${metrics.delta.heals} skipped=${metrics.delta.skippedResolves} skipReasons=${skipReasons} activations=${metrics.delta.activations} cooldowns=${metrics.delta.cooldowns} partyForms=${metrics.delta.partyFormations} partyRecruits=${metrics.delta.partyRecruits} partyDissolves=${metrics.delta.partyDissolutions} partyFormP95=${partyFormation.p95Ms || 0}ms partyFormBudgetStops=${metrics.delta.partyFormationBudgetStops || 0} partyFormStages=${Object.entries(partyFormationStages).map(([stage, value]) => `${stage}:${value.p95Ms || 0}`).join('|') || 'none'} dbFlushes=${metrics.delta.dbFlushes} resolveAvg=${resolve.avgMs || 0}ms resolveP95=${resolve.p95Ms || 0}ms schedulerP95=${scheduler.p95Ms || 0}ms schedulerBudget=${scheduler.budgetMs || 0}ms schedulerMode=${scheduler.mode || 'unknown'} coldBatch=${scheduler.coldBatch || 0}/${scheduler.coldBatchLimit || 0} schedulerLag=${scheduler.lagMs || 0}ms schedulerYields=${metrics.delta.schedulerYields || 0} schedulerSkips=${metrics.delta.schedulerSkips || 0} schedulerBudgetStops=${metrics.delta.schedulerBudgetStops || 0} schedulerOverruns=${metrics.delta.schedulerOverruns || 0} slowResolves=${metrics.delta.slowResolves || 0} heap=${heapMb}MB lag=${lag}ms maxLag=${maxLag}ms ${Director.statusLine()}`
        };
    }
};

module.exports = PopulationStatus;

const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const ClanEconomyService = invoke('GameServer/Clan/ClanEconomyService');
const ClanWarehouseService = invoke('GameServer/Clan/ClanWarehouseService');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanPartyService = invoke('GameServer/Clan/ClanPartyService');
const ClanMarketService = invoke('GameServer/Clan/ClanMarketService');
const BackgroundWorkGovernor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');

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
        const actorPath = metrics.pathfinding?.actor || {};
        const companionPath = metrics.pathfinding?.companion || {};
        const activationFloor = metrics.activationFloor || {};
        const coldOwner = metrics.coldOwner || {};
        const warehouseCleanup = metrics.warehouseCleanup || {};
        const stateRetention = metrics.stateRetention || {};
        const partyFormationStages = metrics.partyFormationStages || {};
        const skipReasons = Object.entries(metrics.skippedResolveReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const market = MarketTelemetry.snapshot();
        const pathWorkers = invoke('GameServer/Geodata/PathfindingWorkerPool').stats();
        const raidAggro = invoke('GameServer/World/RaidBossMinionManager').stats();
        const raidIndex = invoke('GameServer/World/RaidEntityIndex').stats(invoke('GameServer/World/World'));
        const hotLod = invoke('GameServer/Bot/AI/HotActorLodPolicy').snapshot(invoke('GameServer/Bot/BotManager').sessions || []);
        const hotDispatch = invoke('GameServer/Bot/AI/HotAiDispatcher').snapshot();
        const governor = BackgroundWorkGovernor.snapshot();
        const backgroundJobs = BackgroundJobRegistry.snapshot();
        const marketGoalCursor = LifeState.marketGoalCursorSnapshot();
        const clanSimulation = {
            founder: ClanSimulationService.metrics(),
            actions: ClanActionService.metrics(),
            economy: ClanEconomyService.metrics(),
            warehouse: ClanWarehouseService.metrics(),
            goals: ClanGoalService.metrics(),
            market: ClanMarketService.metrics(),
            party: ClanPartyService.metrics()
        };
        const stageP95 = (stages, names) => names
            .map((name) => `${name}:${stages?.[name]?.p95Ms || 0}`)
            .join('|');
        const clanActionStages = stageP95(clanSimulation.actions.stages, ['claim', 'projection', 'execute', 'settle', 'follow_up', 'total']);
        const clanFounderStages = stageP95(clanSimulation.founder.stages, ['candidate_projection', 'clan_projection', 'resolve_candidate', 'scan_loop', 'total']);
        const governorDeferrals = Object.entries(governor.deferralReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const governorJobs = Object.entries(governor.jobs || {})
            .map(([job, value]) => {
                const grantedAvg = Math.round(Number(value.grantedMs || 0) / Math.max(1, Number(value.admitted || 0)));
                const actualAvg = Math.round(Number(value.actualMs || 0) / Math.max(1, Number(value.completed || 0)));
                return `${job}:${value.admitted || 0}/${value.deferred || 0}/${value.completed || 0}/${value.overruns || 0}:${grantedAvg}>${actualAvg}ms`;
            })
            .join('|') || 'none';
        const goalMetadataStages = [
            ['stale', governor.jobs?.goal_stale_review],
            ['warehouse', governor.jobs?.goal_warehouse_release],
            ['market', governor.jobs?.goal_market_reconcile]
        ].flatMap(([label, job]) => Object.entries(job?.stages || {})
            .map(([stage, value]) => `${label}.${stage}:${value.p95Ms || 0}`))
            .join('|') || 'none';
        const partyRequiredReasons = Object.entries(counts.partyRequests.requiredReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const activationFloorReasons = Object.entries(activationFloor.reasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const coldOwnerLegacyReasons = Object.entries(coldOwner.legacyReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const coldOwnerRejectReasons = Object.entries(coldOwner.rejectReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const coldOwnerStaleRevisionGaps = Object.entries(coldOwner.staleRevisionGaps || {})
            .map(([gap, count]) => `${gap}:${count}`)
            .join('|') || 'none';
        const coldOwnerStaleOwners = Object.entries(coldOwner.staleOwners || {})
            .map(([owner, count]) => `${owner}:${count}`)
            .join('|') || 'none';
        const warehouseCleanupDeferrals = Object.entries(warehouseCleanup.deferralReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const stateRetentionDeferrals = Object.entries(stateRetention.deferralReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const stateRetentionPolicyRows = Object.entries(stateRetention.policyRows || {})
            .map(([policy, count]) => `${policy}:${count}`)
            .join('|') || 'none';
        const database = invoke('Database').stats();
        const checkpoint = database.checkpoint || {};
        const checkpointLast = checkpoint.last || {};
        const checkpointDebt = Math.max(0,
            Number(checkpointLast.logFrames || 0) - Number(checkpointLast.checkpointedFrames || 0));

        const summary = {
            ...counts,
            metrics,
            governor,
            backgroundJobs,
            clanSimulation,
            director: Director.snapshot(),
            market,
            hotLod,
            hotDispatch,
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} parties=${counts.parties} persisted=${counts.persisted} merchants=${counts.merchants} coldDue=${counts.coldQueue.due} coldDueHigh=${counts.coldQueue.highLevel} coldReplans=${counts.coldQueue.replans} coldDueAge=${Math.round(counts.coldQueue.oldestAgeMs / 1000)}s partyRequests=${counts.partyRequests.total} partyRequired=${counts.partyRequests.required} partyPreferred=${counts.partyRequests.preferred} partyBlocked=${counts.partyRequests.blocked} partyMaxAge=${Math.round(counts.partyRequests.maxAgeMs / 1000)}s partyRequiredReasons=${partyRequiredReasons} marketListings=${market.delta.listingsOpened} marketSpeculative=${market.delta.speculativeListings} marketBuyStores=${market.delta.buyStoresOpened} marketBuys=${market.delta.purchases} marketItems=${market.delta.itemsSold} marketAdena=${market.delta.adenaTraded} dynamicBuyerSales=${market.delta.dynamicBuyerSales} dynamicBuyerItems=${market.delta.dynamicBuyerItems} dynamicBuyerAdena=${market.delta.dynamicBuyerAdena} staticBuyerSales=${market.delta.staticBuyerSales} staticBuyerItems=${market.delta.staticBuyerItems} staticBuyerAdena=${market.delta.staticBuyerAdena} marketNoOffer=${market.delta.noOffer} marketSoldOut=${market.delta.soldOut} marketExpired=${market.delta.expired} marketDemandClosed=${market.delta.demandClosed} marketDemandPruned=${market.delta.demandPrunedItems} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} partyResolves=${metrics.delta.partyResolves} combatActions=${metrics.delta.combatActions} skillUses=${metrics.delta.skillUses} heals=${metrics.delta.heals} skipped=${metrics.delta.skippedResolves} skipReasons=${skipReasons} activations=${metrics.delta.activations} cooldowns=${metrics.delta.cooldowns} partyForms=${metrics.delta.partyFormations} partyRecruits=${metrics.delta.partyRecruits} partyDissolves=${metrics.delta.partyDissolutions} partyFormP95=${partyFormation.p95Ms || 0}ms partyFormBudgetStops=${metrics.delta.partyFormationBudgetStops || 0} partyFormDeferrals=${metrics.delta.partyFormationDeferrals || 0} partyFormStages=${Object.entries(partyFormationStages).map(([stage, value]) => `${stage}:${value.p95Ms || 0}`).join('|') || 'none'} dbFlushes=${metrics.delta.dbFlushes} resolveAvg=${resolve.avgMs || 0}ms resolveP95=${resolve.p95Ms || 0}ms schedulerP95=${scheduler.p95Ms || 0}ms schedulerBudget=${scheduler.budgetMs || 0}ms schedulerMode=${scheduler.mode || 'unknown'} playerMode=${scheduler.playerMode || 'idle'} realPlayers=${scheduler.realPlayers || 0} connectingPlayers=${scheduler.connectingPlayers || 0} companions=${scheduler.companions || 0} coldBatch=${scheduler.coldBatch || 0}/${scheduler.coldBatchLimit || 0} schedulerLag=${scheduler.lagMs || 0}ms schedulerYields=${metrics.delta.schedulerYields || 0} schedulerSkips=${metrics.delta.schedulerSkips || 0} schedulerBudgetStops=${metrics.delta.schedulerBudgetStops || 0} backgroundDeferrals=${metrics.delta.backgroundDeferrals || 0} schedulerOverruns=${metrics.delta.schedulerOverruns || 0} slowResolves=${metrics.delta.slowResolves || 0} actorPath=${actorPath.count || 0}/${actorPath.p95Ms || 0}/${actorPath.maxMs || 0}ms companionPath=${companionPath.count || 0}/${companionPath.p95Ms || 0}/${companionPath.maxMs || 0}ms pathWorkers=${pathWorkers.workers || 0}w/${pathWorkers.busy || 0}b/${pathWorkers.queue || 0}q/${pathWorkers.maxQueue || 0}mq/${pathWorkers.completed || 0}ok/${pathWorkers.errors || 0}err/${pathWorkers.rejected || 0}rej/${pathWorkers.stale || 0}stale raidAggro=${raidAggro.engagements || 0}/${raidAggro.minionsAlerted || 0} raidIndex=${raidIndex.bosses || 0}b/${raidIndex.minions || 0}m/${raidIndex.rebuilds || 0}r/${raidIndex.objectsScanned || 0}s heap=${heapMb}MB lag=${lag}ms maxLag=${maxLag}ms ${Director.statusLine()}`
        };
        summary.line += ` floorCandidates=${metrics.delta.activationFloorCandidates || 0} floorAccepted=${metrics.delta.activationFloorAccepted || 0} floorRejected=${metrics.delta.activationFloorRejected || 0} floorGeo=${metrics.delta.activationFloorGeoChecks || 0}/${metrics.delta.activationFloorCacheHits || 0}/${metrics.delta.activationFloorBudgetDeferred || 0} floorP95=${activationFloor.p95Ms || 0}ms floorReasons=${activationFloorReasons} companionWorkers=${pathWorkers.companionBusy || 0}b/${pathWorkers.companionQueue || 0}q lod=${hotLod.population.full}/${hotLod.population.visible}/${hotLod.population.preload} lodTicks=${hotLod.delta.fullTicks || 0}/${hotLod.delta.visibleTicks || 0}/${hotLod.delta.preloadTicks || 0} lodDeferred=${hotLod.delta.deferrals || 0} lodPromotions=${hotLod.delta.promotions || 0} aiP95=${hotLod.tick.p95Ms || 0}ms statusP95=${hotLod.status.p95Ms || 0}ms botPackets=${hotLod.delta.packetBroadcasts || 0}/${hotLod.delta.packetSkips || 0}/${hotLod.delta.packetRecipients || 0}`;
        summary.line += ` hotDispatch=${hotDispatch.depth || 0}/${hotDispatch.urgentDepth || 0}/${hotDispatch.maxDepth || 0} hotDispatchFlow=${hotDispatch.enqueued || 0}/${hotDispatch.completed || 0}/${hotDispatch.coalesced || 0}/${hotDispatch.canceled || 0}/${hotDispatch.errors || 0} hotDispatchWait=${hotDispatch.waitP95Ms || 0}/${hotDispatch.waitMaxMs || 0}ms hotDispatchRun=${hotDispatch.runP95Ms || 0}/${hotDispatch.runMaxMs || 0}ms`;
        summary.line += ` coldOwner=${metrics.delta.coldOwnerSelected || 0}/${metrics.delta.coldOwnerClaimed || 0}/${metrics.delta.coldOwnerResolved || 0}/${metrics.delta.coldOwnerCommitted || 0}/${metrics.delta.coldOwnerReleased || 0} coldOwnerCasStale=${metrics.delta.coldOwnerCasStale || 0} coldOwnerRejected=${metrics.delta.coldOwnerRejected || 0} coldOwnerRecovered=${metrics.delta.coldOwnerLeaseRecoveries || 0} coldOwnerExpired=${metrics.delta.coldOwnerLeaseExpiries || 0} coldOwnerTimeouts=${metrics.delta.coldOwnerTimeouts || 0} coldOwnerErrors=${metrics.delta.coldOwnerErrors || 0} coldOwnerLegacy=${metrics.delta.coldOwnerLegacyDeferred || 0} legacyConflicts=${metrics.delta.legacyOwnershipConflicts || 0} coldOwnerLegacyReasons=${coldOwnerLegacyReasons} coldOwnerRejectReasons=${coldOwnerRejectReasons} coldOwnerStaleGap=${coldOwnerStaleRevisionGaps} coldOwnerStaleOwner=${coldOwnerStaleOwners} coldOwnerClaimP95=${coldOwner.claim?.p95Ms || 0}ms coldOwnerCommitP95=${coldOwner.commit?.p95Ms || 0}ms coldOwnerHandoffs=${metrics.delta.coldOwnerHandoffs || 0} dbQueue=${database.pending || 0}/${database.maxPending || 0} dbFailures=${database.failures || 0} dbBusy=${metrics.delta.coldOwnerDbBusy || 0} dbRetries=${metrics.delta.coldOwnerDbRetries || 0} checkpoint=${checkpoint.ready ? 'ready' : checkpoint.started ? 'starting' : 'stopped'}/${checkpoint.inFlight ? 'busy' : 'idle'} checkpointRuns=${checkpoint.completed || 0}/${checkpoint.skipped || 0}/${checkpoint.busy || 0}/${checkpoint.errors || 0} checkpointP95=${checkpoint.p95Ms || 0}ms checkpointFrames=${checkpoint.frames || 0} checkpointDebt=${checkpointDebt} checkpointWal=${Math.round(Number(checkpointLast.afterBytes || 0) / 1024 / 1024)}MB checkpointResets=${checkpoint.resets || 0}/${checkpoint.resetBusy || 0}/${checkpoint.resetErrors || 0} checkpointRestarts=${checkpoint.restarts || 0}`;
        summary.line += ` warehouseCleanup=${metrics.delta.warehouseCleanupRuns || 0}/${metrics.delta.warehouseCleanupOwners || 0}/${metrics.delta.warehouseCleanupCompacted || 0}/${metrics.delta.warehouseCleanupRows || 0}/${metrics.delta.warehouseCleanupUnits || 0}/${metrics.delta.warehouseCleanupPayout || 0} warehouseCleanupP95=${warehouseCleanup.p95Ms || 0}ms warehouseCleanupCursor=${warehouseCleanup.cursor || 0} warehouseCleanupDeferrals=${metrics.delta.warehouseCleanupDeferrals || 0}:${warehouseCleanupDeferrals} warehouseCleanupErrors=${metrics.delta.warehouseCleanupErrors || 0} warehouseCleanupBudgetStops=${metrics.delta.warehouseCleanupBudgetStops || 0}`;
        summary.line += ` stateRetention=${metrics.delta.stateRetentionRuns || 0}/${metrics.delta.stateRetentionRows || 0}/${stateRetention.policy || 'none'} stateRetentionNext=${stateRetention.nextPolicy || 'none'} stateRetentionP95=${stateRetention.p95Ms || 0}ms stateRetentionRows=${stateRetentionPolicyRows} stateRetentionDeferrals=${metrics.delta.stateRetentionDeferrals || 0}:${stateRetentionDeferrals} stateRetentionErrors=${metrics.delta.stateRetentionErrors || 0} stateRetentionOverruns=${metrics.delta.stateRetentionOverruns || 0}`;
        summary.line += ` clanSim=${clanSimulation.founder.founderCreated || 0}/${clanSimulation.founder.existingClanJoins || 0}/${clanSimulation.founder.founderBlocked || 0} clanActions=${clanSimulation.actions.claimed || 0}/${clanSimulation.actions.succeeded || 0}/${clanSimulation.actions.failed || 0}/${clanSimulation.actions.queueAgeAvgMs || 0}ms clanActionFlow=${clanSimulation.actions.claimed || 0}/${clanSimulation.actions.resolved || 0}/${clanSimulation.actions.releasedUnstarted || 0} clanActionQueue=${clanSimulation.actions.queuePending || 0}/${clanSimulation.actions.queueReady || 0}/${clanSimulation.actions.queueRunning || 0}/${Math.round(Number(clanSimulation.actions.queueOldestReadyAgeMs || 0) / 1000)}s clanActionLease=${clanSimulation.actions.leaseRecoveries || 0}/${clanSimulation.actions.releaseConflicts || 0}/${clanSimulation.actions.budgetOverruns || 0} clanActionP95=${clanActionStages} clanFounderP95=${clanFounderStages} clanFounderBudget=${clanSimulation.founder.budgetStops || 0}/${clanSimulation.founder.budgetOverruns || 0} clanLevels=${clanSimulation.economy.levelUps || 0} clanDeposits=${clanSimulation.warehouse.depositsApplied || 0} clanGoals=${clanSimulation.goals.activeGoals || 0}/${clanSimulation.goals.replans || 0} clanMarket=${clanSimulation.market.purchases || 0}/${clanSimulation.market.deposited || 0} clanParty=${clanSimulation.party.operationsStarted || 0}/${clanSimulation.party.operationsSucceeded || 0}/${clanSimulation.party.operationsFailed || 0}`;
        summary.line += ` bgGovernor=${governor.mode || 'idle'}/${governor.usedMs || 0}/${governor.capMs || 0}/${Object.keys(governor.resources || {}).length} bgGovernorFlow=${governor.admitted || 0}/${governor.deferred || 0}/${governor.completed || 0}/${governor.overruns || 0} bgGovernorDeferrals=${governorDeferrals}`;
        summary.line += ` bgGovernorJobs=${governorJobs} bgGoalP95=${goalMetadataStages} marketGoalCursor=${marketGoalCursor.updatedAt || 0}/${marketGoalCursor.characterId || 0} bgJobs=${backgroundJobs.registered || 0}/${backgroundJobs.inFlight || 0}/${backgroundJobs.tickMs || 0}ms bgJobFlow=${backgroundJobs.due || 0}/${backgroundJobs.started || 0}/${backgroundJobs.completed || 0}/${backgroundJobs.skipped || 0}/${backgroundJobs.deferred || 0}/${backgroundJobs.coalesced || 0}/${backgroundJobs.errors || 0}`;
        const coldWorker = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').snapshot();
        const worker = coldWorker.worker || {};
        const commitQueue = coldWorker.queue || {};
        summary.coldWorker = coldWorker;
        const invalidIpcReasons = Object.entries(coldWorker.invalidReasons || {}).map(([reason, count]) => `${reason}:${count}`).join('|') || 'none';
        const snapshots = coldWorker.snapshots || {};
        const lastSnapshot = snapshots.last || {};
        summary.line += ` coldWorker=${coldWorker.ready ? 'ready' : coldWorker.started ? 'starting' : 'stopped'}/${coldWorker.heartbeatAgeMs ?? -1}ms workerState=${worker.paused ? 'paused' : 'running'}/${worker.stopping ? 'stopping' : 'active'}/${worker.heap || 0}h workerLimit=${worker.maxInFlight || 0} workerFlow=${worker.selected || 0}/${worker.claimed || 0}/${worker.resolved || 0}/${worker.proposals || 0} workerDue=${worker.due || 0}/${Math.round(Number(worker.dueAgeMs || 0) / 1000)}s/${worker.dueFences?.scheduled || 0},${worker.dueFences?.claiming || 0},${worker.dueFences?.inFlight || 0},${worker.dueFences?.commanding || 0},${worker.dueFences?.orphaned || 0} workerFlight=${worker.claiming || 0}/${worker.inFlight || 0}/${worker.dirty || 0}/${worker.commanding || 0}:${Math.round(Number(worker.commandingAgeMs || 0) / 1000)}s workerRecovery=${worker.claimRecoveries || 0}/${worker.leaseRecoveries || 0}/${worker.orphanRecoveries || 0} workerRenewal=${worker.leaseRenewals || 0}/${worker.leaseRenewalMisses || 0} workerPayload=${worker.proposalCompactions || 0}/${worker.proposalOversize || 0}/${worker.proposalOversizeRejected || 0} workerLoop=${Math.round(Number(worker.eventLoopLagP95Ms || 0))}/${Math.round(Number(worker.eventLoopLagMaxMs || 0))}ms workerElu=${Number(worker.eventLoopUtilization || 0).toFixed(2)} workerHeap=${Math.round(Number(worker.heapUsed || 0) / 1024 / 1024)}MB workerRestarts=${coldWorker.workerRestarts || 0} ipc=${coldWorker.messagesIn || 0}/${coldWorker.messagesOut || 0}/${coldWorker.invalidMessages || 0}/${coldWorker.duplicateMessages || 0} ipcRejects=${invalidIpcReasons} commitQueue=${commitQueue.depth || 0}/${commitQueue.p0 || 0}/${commitQueue.p1 || 0}/${commitQueue.p2 || 0} commitFlow=${commitQueue.committed || 0}/${commitQueue.stale || 0}/${commitQueue.rejected || 0} commitLag=${commitQueue.queueP95Ms || 0}/${commitQueue.oldestMs || 0}ms commitP95=${commitQueue.commitP95Ms || 0}ms commitBusy=${commitQueue.busy || 0}/${commitQueue.retries || 0}`;
        summary.line += ` snapshot=${snapshots.dirty || 0}/${snapshots.critical || 0}/${snapshots.inFlight ? 1 : 0} snapshotLast=${lastSnapshot.mode || 'none'}/${lastSnapshot.rows || 0}/${lastSnapshot.pages || 0}/${lastSnapshot.durationMs || 0}ms snapshotRuns=${snapshots.fullRuns || 0}/${snapshots.dirtyRuns || 0}/${snapshots.criticalRuns || 0} snapshotDeferrals=${snapshots.deferrals || 0} snapshotYields=${snapshots.yields || 0}`;
        return summary;
    }
};

module.exports = PopulationStatus;

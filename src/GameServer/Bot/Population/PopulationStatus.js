const Config = invoke('GameServer/Bot/Population/PopulationConfig');
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
const ClanTitleService = invoke('GameServer/Clan/ClanTitleService');
const BackgroundWorkGovernor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const NpcDecay = invoke('GameServer/World/Generics/NpcDecay');
const Npc = invoke('GameServer/Npc/Npc');
const PvpEncounterRuntime = invoke('GameServer/Bot/Population/PvpEncounterRuntime');
const { heapRecord, heapsLine } = require('./WorkerHeapTelemetry');
const { performance } = require('node:perf_hooks');
let mainEluMark = performance.eventLoopUtilization();
const ClanPlanningCoordinator = invoke('GameServer/Clan/ClanPlanningCoordinator');
const HistoryDatabase = invoke('HistoryDatabase');
const CheckpointCoordinator = invoke('DatabaseCheckpointCoordinator');
const MarketTradeOverviewReader = invoke('MarketTradeOverviewReader');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
let lastMoneyPacketMissing = 0;
// The body's fact posts (BotLifeState.notifyNearFacts reasons); any other
// near post reason is a named raise.
const NEAR_FACTS = Object.freeze(['bag', 'equip', 'level', 'death', 'revive', 'near_spot', 'activated']);

function isBotSession(session) {
    return session && session.accountId && String(session.accountId).startsWith('bot_');
}

const PopulationStatus = {
    counts() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const sessions = BotManager.sessions || [];
        let hot = 0, merchants = 0;
        for (const session of sessions) {
            if (!isBotSession(session) || !session.actor) continue;
            hot++;
            if (session.plan === 'merchant') merchants++;
        }
        const active = Math.max(0, hot - merchants);
        const lifeCounts = LifeState.counts();
        const coldQueue = LifeState.coldDueSummary();
        const partyCounts = PartyState.counts();
        const targetCombat = LifeState.targetCombatSummary();
        const partyRequests = LifeState.partyRequestSummary();

        return {
            hot,
            active,
            warm: lifeCounts.warm || 0,
            cold: lifeCounts.cold || 0,
            parties: partyCounts.active || 0,
            merchants,
            services: merchants,
            total: Math.max(hot, lifeCounts.total || 0),
            persisted: lifeCounts.total || 0,
            coldQueue,
            targetCombat,
            partyRequests,
            raidSearch: invoke('GameServer/Bot/Population/PopulationService').opportunisticRaids?.searchCounters.snapshot() || null,
            marketState: MarketSnapshot.snapshot()
        };
    },

    // The heap of every isolate of the server, each from the module that owns that thread (null: no report
    // yet). The caller passes the records it already holds: coldWorker is
    // ColdSimulationCoordinator.snapshot().worker, history and checkpoint are Database.stats().history and
    // .checkpoint, pathWorkers is PathfindingWorkerPool.stats(); an omitted one is read from its owner.
    heaps({ coldWorker, history = HistoryDatabase.stats(), checkpoint = CheckpointCoordinator.snapshot(),
        pathWorkers = PathfindingWorkerPool.stats() } = {}) {
        const heaps = { main: heapRecord(), cold: coldWorker?.v8Heap || null, clan: ClanPlanningCoordinator.metrics().v8Heap || null,
            history: history.v8Heap || null, checkpoint: checkpoint.v8Heap || null,
            market: MarketTradeOverviewReader.stats().v8Heap || null };
        (pathWorkers.v8Heaps || []).forEach((heap, index) => { heaps[`path${index}`] = heap; });
        return heaps;
    },

    // The near bots' line, always on (logSummary prints it without
    // diagnostics), from the coordinator's snapshot: nearFacts=bag/equip/
    // level/death/revive/near_spot/activated, their fact posts queued since
    // start; nearRaises=, the posts a named raise made (DecisionEvents
    // raiseDecision: town, money, revived, sources, ...); nearDecisions=
    // accepted/refused/dropped, the decisions their bodies took, refused as
    // older than the one held, or dropped as the bot cooled before they came.
    nearText(coordinator) {
        const nearFacts = coordinator?.snapshots?.nearFacts || {}, decisions = coordinator?.nearDecisions || {};
        const raises = Object.entries(nearFacts).reduce((sum, [reason, count]) => NEAR_FACTS.includes(reason) ? sum : sum + count, 0);
        return `nearFacts=${NEAR_FACTS.map(reason => nearFacts[reason] || 0).join('/')} nearRaises=${raises}`
            + ` nearDecisions=${decisions.accepted || 0}/${decisions.refused || 0}/${decisions.dropped || 0}`;
    },

    // The goal's numbers without diagnostics, in the full line's names: cold queue due now and the oldest wait,
    // worker busy share since the last heartbeat, main busy share since the last goal line (its only caller is
    // the periodic summary), worker heap after the last major GC / its 10-min maximum, how early a far step
    // starts before its due (ColdSimulationKernel stepLeadMs); pvp= cold PvP fights running / steps, wall ms
    // and due fights left of the encounter runtime's longest pass since the last line (budget PASS_MS).
    goalText(queue = {}, coordinator) {
        const worker = coordinator?.worker || {}, mb = bytes => bytes ? Math.round(bytes / 1024 / 1024) : '-';
        const mainElu = performance.eventLoopUtilization(mainEluMark);
        mainEluMark = performance.eventLoopUtilization();
        const pvp = PvpEncounterRuntime.passPeak();
        const geodata = GeodataEngine.storageStats();
        return `coldDue=${queue.overdue || 0} coldDueAll=${queue.due || 0} coldDueAge=${Math.round((queue.oldestAgeMs || 0) / 1000)}s`
            + ` workerElu=${Number(worker.eventLoopUtilization || 0).toFixed(2)} mainElu=${mainElu.utilization.toFixed(2)} workerHeapGc=${mb(worker.heapAfterGc)}/${mb(worker.heapAfterGcMax10)}MB`
            + ` stepLead=${worker.stepLeadMs || 0}ms pvp=${pvp.live}/${pvp.steps}/${pvp.ms}ms/${pvp.left}`
            + ` geo=${mb(geodata.loadedBytes)}MB/${geodata.loadedRegions} geoViews=${mb(geodata.attachedBytes)}+${mb(worker.geodata?.attachedBytes)}MB`
            + ` geoRaw=${geodata.rawRegions || 0} geoIndexOnly=${geodata.indexOnlyRegions || 0}`
            + ` geoHeightReads=${geodata.heightFileReads || 0}+${worker.geodata?.heightFileReads || 0}`;
    },

    summary() {
        if (!Config.developerDiagnostics) return { enabled: false };
        const counts = this.counts();
        const metrics = Metrics.snapshot();
        const lag = Math.round(metrics.eventLoop.lagMs);
        const maxLag = Math.round(metrics.eventLoop.maxLagMs);
        const heapMb = metrics.memory?.heapUsed ? Math.round(metrics.memory.heapUsed / 1024 / 1024) : 0;
        const resolve = metrics.resolve || {};
        const scheduler = metrics.scheduler || {};
        const partyFormation = metrics.partyFormation || {};
        const assembly = invoke('GameServer/Bot/Population/PopulationService').partyAssemblyEvents?.metrics || {};
        const actorPath = metrics.pathfinding?.actor || {};
        const companionPath = metrics.pathfinding?.companion || {};
        const activationFloor = metrics.activationFloor || {};
        const coldOwner = metrics.coldOwner || {};
        const stateRetention = metrics.stateRetention || {};
        const partyFormationStages = metrics.partyFormationStages || {};
        const skipReasons = Object.entries(metrics.skippedResolveReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const market = MarketTelemetry.snapshot();
        const pathWorkers = PathfindingWorkerPool.stats();
        const raidAggro = invoke('GameServer/World/RaidBossMinionManager').stats();
        const raidIndex = invoke('GameServer/World/RaidEntityIndex').stats(invoke('GameServer/World/World'));
        const npcDecay = NpcDecay.stats();
        const npcHate = Npc.hateStats();
        const hotLod = invoke('GameServer/Bot/AI/HotActorLodPolicy').snapshot(invoke('GameServer/Bot/BotManager').sessions || []);
        const hotDispatch = invoke('GameServer/Bot/AI/HotAiDispatcher').snapshot();
        const governor = BackgroundWorkGovernor.snapshot();
        const backgroundJobs = BackgroundJobRegistry.snapshot();
        const clanSimulation = {
            founder: ClanSimulationService.metrics(),
            actions: ClanActionService.metrics(),
            economy: ClanEconomyService.metrics(),
            warehouse: ClanWarehouseService.metrics(),
            goals: ClanGoalService.metrics(),
            titles: ClanTitleService.metrics(),
            market: ClanMarketService.metrics(),
            party: ClanPartyService.metrics()
        };
        const stageP95 = (stages, names) => names
            .map((name) => `${name}:${stages?.[name]?.p95Ms || 0}`)
            .join('|');
        const clanActionStages = stageP95(clanSimulation.actions.stages, ['claim', 'projection', 'execute', 'settle', 'follow_up', 'total']);
        const clanActionTypeStages = ['goal_plan', 'contribution', 'warehouse', 'market', 'party']
            .map((type) => `${type}:${clanSimulation.actions.stages?.[`execute:${type}`]?.p95Ms || 0}`)
            .join('|');
        const clanActionDeferP95 = clanSimulation.actions.stages?.defer?.p95Ms || 0;
        const clanWorker = clanSimulation.goals.equipment?.worker || {};
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
        const stateRetentionDeferrals = Object.entries(stateRetention.deferralReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const stateRetentionPolicyRows = Object.entries(stateRetention.policyRows || {})
            .map(([policy, count]) => `${policy}:${count}`)
            .join('|') || 'none';
        const database = invoke('Database').stats();
        const databaseFailureOps = Object.entries(database.operations || {})
            .filter(([, value]) => Number(value.failures || 0) > 0)
            .sort((left, right) => Number(right[1].failures || 0) - Number(left[1].failures || 0)
                || left[0].localeCompare(right[0]))
            .map(([operation, value]) => `${operation}:${value.failures}`)
            .join('|') || 'none';
        const checkpoint = database.checkpoint || {};
        const checkpointLast = checkpoint.last || {};
        const checkpointDebt = Math.max(0,
            Number(checkpointLast.logFrames || 0) - Number(checkpointLast.checkpointedFrames || 0));
        const lodSubsystems = Object.entries(hotLod.subsystems || {})
            .map(([name, value]) => `${name}:${value.count || 0}/${value.p95Ms || 0}/${value.items || 0}`)
            .join('|') || 'none';
        // Per occupied spot of the world index: the bots standing or
        // travelling there against the spot's capacity.
        const farmIndex = LifeState.occupancyIndex();
        const farmCapacity = {
            spots: 0,
            violations: 0,
            maxReserved: 0,
            maxExcess: 0,
            worstSpot: 'none',
            worstReserved: 0,
            worstCapacity: 0,
            worstExcess: 0
        };
        for (const spotId of farmIndex.spotIds()) {
            const spot = SpotProfiles.findById(spotId);
            const present = spot ? farmIndex.physicalCount(spotId) : 0;
            if (!present) continue;
            const capacity = LevelingRoutes.roomForSpot(spot);
            farmCapacity.spots += 1;
            farmCapacity.maxReserved = Math.max(farmCapacity.maxReserved, present);
            if (present > capacity) {
                farmCapacity.violations += 1;
                farmCapacity.maxExcess = Math.max(farmCapacity.maxExcess, present - capacity);
                if (present - capacity > farmCapacity.worstExcess) {
                    farmCapacity.worstSpot = spotId;
                    farmCapacity.worstReserved = present;
                    farmCapacity.worstCapacity = capacity;
                    farmCapacity.worstExcess = present - capacity;
                }
            }
        }

        const summary = {
            ...counts,
            metrics,
            governor,
            backgroundJobs,
            opportunisticRaids: invoke('GameServer/Bot/Population/PopulationService').opportunisticRaids?.snapshot() || null,
            clanSimulation,
            director: Director.snapshot(),
            market,
            hotLod,
            hotDispatch,
            line: `hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} parties=${counts.parties} persisted=${counts.persisted} merchants=${counts.merchants} coldDue=${counts.coldQueue.overdue} coldDueAll=${counts.coldQueue.due} coldDueHigh=${counts.coldQueue.highLevel} coldReplans=${counts.coldQueue.replans} coldDueAge=${Math.round(counts.coldQueue.oldestAgeMs / 1000)}s partyRequests=${counts.partyRequests.total} partyRequired=${counts.partyRequests.required} partyPreferred=${counts.partyRequests.preferred} partyBlocked=${counts.partyRequests.blocked} partyMaxAge=${Math.round(counts.partyRequests.maxAgeMs / 1000)}s partyRequiredReasons=${partyRequiredReasons} marketListings=${market.delta.listingsOpened} marketSpeculative=${market.delta.speculativeListings} marketBuyStores=${market.delta.buyStoresOpened} marketBuys=${market.delta.purchases} marketItems=${market.delta.itemsSold} marketAdena=${market.delta.adenaTraded} dynamicBuyerSales=${market.delta.dynamicBuyerSales} dynamicBuyerItems=${market.delta.dynamicBuyerItems} dynamicBuyerAdena=${market.delta.dynamicBuyerAdena} staticBuyerSales=${market.delta.staticBuyerSales} staticBuyerItems=${market.delta.staticBuyerItems} staticBuyerAdena=${market.delta.staticBuyerAdena} marketNoOffer=${market.delta.noOffer} marketSoldOut=${market.delta.soldOut} marketExpired=${market.delta.expired} marketDemandClosed=${market.delta.demandClosed} marketDemandPruned=${market.delta.demandPrunedItems} ticks=${metrics.delta.hotTicks} resolves=${metrics.delta.backgroundResolves} partyResolves=${metrics.delta.partyResolves} combatActions=${metrics.delta.combatActions} skillUses=${metrics.delta.skillUses} heals=${metrics.delta.heals} skipped=${metrics.delta.skippedResolves} skipReasons=${skipReasons} activations=${metrics.delta.activations} cooldowns=${metrics.delta.cooldowns} partyForms=${metrics.delta.partyFormations} partyRecruits=${metrics.delta.partyRecruits} partyDissolves=${metrics.delta.partyDissolutions} partyFormP95=${partyFormation.p95Ms || 0}ms partyAssembly=${assembly.events || 0}/${assembly.attempts || 0} partyFormBudgetStops=${metrics.delta.partyFormationBudgetStops || 0} partyFormDeferrals=${metrics.delta.partyFormationDeferrals || 0} partyFormStages=${Object.entries(partyFormationStages).map(([stage, value]) => `${stage}:${value.p95Ms || 0}`).join('|') || 'none'} dbFlushes=${metrics.delta.dbFlushes} resolveAvg=${resolve.avgMs || 0}ms resolveP95=${resolve.p95Ms || 0}ms schedulerP95=${scheduler.p95Ms || 0}ms schedulerBudget=${scheduler.budgetMs || 0}ms schedulerMode=${scheduler.mode || 'unknown'} playerMode=${scheduler.playerMode || 'idle'} realPlayers=${scheduler.realPlayers || 0} connectingPlayers=${scheduler.connectingPlayers || 0} companions=${scheduler.companions || 0} coldBatch=${scheduler.coldBatch || 0}/${scheduler.coldBatchLimit || 0} schedulerLag=${scheduler.lagMs || 0}ms schedulerSkips=${metrics.delta.schedulerSkips || 0} backgroundDeferrals=${metrics.delta.backgroundDeferrals || 0} schedulerOverruns=${metrics.delta.schedulerOverruns || 0} slowResolves=${metrics.delta.slowResolves || 0} actorPath=${actorPath.count || 0}/${actorPath.p95Ms || 0}/${actorPath.maxMs || 0}ms companionPath=${companionPath.count || 0}/${companionPath.p95Ms || 0}/${companionPath.maxMs || 0}ms pathWorkers=${pathWorkers.workers || 0}w/${pathWorkers.busy || 0}b/${pathWorkers.queue || 0}q/${pathWorkers.maxQueue || 0}mq/${pathWorkers.completed || 0}ok/${pathWorkers.errors || 0}err/${pathWorkers.rejected || 0}rej/${pathWorkers.stale || 0}stale raidAggro=${raidAggro.engagements || 0}/${raidAggro.minionsAlerted || 0} raidMinions=${raidAggro.refills || 0}/${raidAggro.groupVisits || 0}/${raidAggro.removalFeeds || 0} raidIndex=${raidIndex.bosses || 0}b/${raidIndex.minions || 0}m/${raidIndex.rebuilds || 0}r/${raidIndex.objectsScanned || 0}s npcDecay=${npcDecay.scheduled || 0}s/${npcDecay.expired || 0}e/${npcDecay.retries || 0}r/${npcDecay.discarded || 0}d npcHate=${npcHate.outOfReach}o/${npcHate.noPath}n/${npcHate.idleWithHate}i heap=${heapMb}MB lag=${lag}ms lagSustained=${Metrics.sustainedEventLoopLag()}ms maxLag=${maxLag}ms ${Director.statusLine()}`
        };
        const missingTotal = require('../Economy/PurchaseFunding').summary().moneyPacketMissing;
        summary.moneyPacketMissing = Math.max(0, missingTotal - lastMoneyPacketMissing);
        summary.moneyPacketMissingTotal = missingTotal;
        lastMoneyPacketMissing = missingTotal;
        summary.line += ` moneyPacketMissing=${summary.moneyPacketMissing}`;
        summary.improvementDeferred = invoke('GameServer/Bot/Economy/BotImprovementService').summary().improvementDeferred;
        summary.planDeferred = Number(invoke('GameServer/Bot/Population/PopulationService').planDeferred || 0);
        summary.coldBuffSales = invoke('GameServer/Bot/Economy/ColdBuffService').summary();
        summary.line += ` coldBuffSales=${summary.coldBuffSales.offers}/${summary.coldBuffSales.sold}/${summary.coldBuffSales.dropped}`;
        summary.line += ` improvementDeferred=${summary.improvementDeferred} planDeferred=${summary.planDeferred}`;
        summary.line += ` floorCandidates=${metrics.delta.activationFloorCandidates || 0} floorAccepted=${metrics.delta.activationFloorAccepted || 0} floorRejected=${metrics.delta.activationFloorRejected || 0} floorGeo=${metrics.delta.activationFloorGeoChecks || 0}/${metrics.delta.activationFloorCacheHits || 0}/${metrics.delta.activationFloorBudgetDeferred || 0} floorP95=${activationFloor.p95Ms || 0}ms floorReasons=${activationFloorReasons} companionWorkers=${pathWorkers.companionBusy || 0}b/${pathWorkers.companionQueue || 0}q lod=${hotLod.population.full}/${hotLod.population.visible}/${hotLod.population.preload} lodTicks=${hotLod.delta.fullTicks || 0}/${hotLod.delta.visibleTicks || 0}/${hotLod.delta.preloadTicks || 0} lodDeferred=${hotLod.delta.deferrals || 0} lodPromotions=${hotLod.delta.promotions || 0} aiP95=${hotLod.tick.p95Ms || 0}ms statusP95=${hotLod.status.p95Ms || 0}ms botPackets=${hotLod.delta.packetBroadcasts || 0}/${hotLod.delta.packetSkips || 0}/${hotLod.delta.packetRecipients || 0} lodStages=${lodSubsystems}`;
        summary.clanFinanceMs = invoke('GameServer/ClanHall/Runtime').financeSummary().p95Ms;
        summary.line += ` clanFinanceMs=${summary.clanFinanceMs}`;
        summary.safetyRepairs = (Metrics.lastSafetyRepairs || [0, 0, 0]).join('/');
        summary.line += ` safetyRepairs=${summary.safetyRepairs}`;
        summary.boardReviewWakeups = metrics.delta.boardReviewWakeups || 0;
        summary.line += ` boardReviewWakeups=${summary.boardReviewWakeups}`;
        summary.line += ` hotDispatch=${hotDispatch.depth || 0}/${hotDispatch.urgentDepth || 0}/${hotDispatch.maxDepth || 0} hotDispatchFlow=${hotDispatch.enqueued || 0}/${hotDispatch.completed || 0}/${hotDispatch.coalesced || 0}/${hotDispatch.canceled || 0}/${hotDispatch.errors || 0} hotDispatchWait=${hotDispatch.waitP95Ms || 0}/${hotDispatch.waitMaxMs || 0}ms hotDispatchRun=${hotDispatch.runP95Ms || 0}/${hotDispatch.runMaxMs || 0}ms`;
        summary.line += ` coldOwner=${metrics.delta.coldOwnerCommitted || 0} coldOwnerRejected=${metrics.delta.coldOwnerRejected || 0} coldOwnerErrors=${metrics.delta.coldOwnerErrors || 0} coldOwnerLegacy=${metrics.delta.coldOwnerLegacyDeferred || 0} legacyConflicts=${metrics.delta.legacyOwnershipConflicts || 0} coldOwnerLegacyReasons=${coldOwnerLegacyReasons} coldOwnerRejectReasons=${coldOwnerRejectReasons} coldOwnerCommitP95=${coldOwner.commit?.p95Ms || 0}ms coldOwnerHandoffs=${metrics.delta.coldOwnerHandoffs || 0} farmCapacity=${farmCapacity.spots}/${farmCapacity.violations}/${farmCapacity.maxReserved}/${farmCapacity.maxExcess} farmWorst=${farmCapacity.worstSpot}:${farmCapacity.worstReserved}/${farmCapacity.worstCapacity} dbQueue=${database.pending || 0}/${database.maxPending || 0} dbSnapshots=${database.snapshots || 0} dbFailures=${database.failures || 0} dbFailureOps=${databaseFailureOps} dbBusy=${metrics.delta.coldOwnerDbBusy || 0} dbRetries=${metrics.delta.coldOwnerDbRetries || 0} checkpoint=${checkpoint.ready ? 'ready' : checkpoint.started ? 'starting' : 'stopped'}/${checkpoint.inFlight ? 'busy' : 'idle'} checkpointRuns=${checkpoint.completed || 0}/${checkpoint.skipped || 0}/${checkpoint.busy || 0}/${checkpoint.errors || 0} checkpointP95=${checkpoint.p95Ms || 0}ms checkpointFrames=${checkpoint.frames || 0} checkpointDebt=${checkpointDebt} checkpointWal=${Math.round(Number(checkpointLast.afterBytes || 0) / 1024 / 1024)}MB checkpointResets=${checkpoint.resets || 0}/${checkpoint.resetBusy || 0}/${checkpoint.resetErrors || 0} checkpointRestarts=${checkpoint.restarts || 0}`;
        summary.line += ` stateRetention=${metrics.delta.stateRetentionRuns || 0}/${metrics.delta.stateRetentionRows || 0}/${stateRetention.policy || 'none'} stateRetentionNext=${stateRetention.nextPolicy || 'none'} stateRetentionP95=${stateRetention.p95Ms || 0}ms stateRetentionRows=${stateRetentionPolicyRows} stateRetentionDeferrals=${metrics.delta.stateRetentionDeferrals || 0}:${stateRetentionDeferrals} stateRetentionErrors=${metrics.delta.stateRetentionErrors || 0} stateRetentionOverruns=${metrics.delta.stateRetentionOverruns || 0}`;
        summary.line += ` clanSim=${clanSimulation.founder.founderCreated || 0}/${clanSimulation.founder.existingClanJoins || 0}/${clanSimulation.founder.founderBlocked || 0} clanActions=${clanSimulation.actions.claimed || 0}/${clanSimulation.actions.succeeded || 0}/${clanSimulation.actions.failed || 0}/${clanSimulation.actions.queueAgeAvgMs || 0}ms clanActionFlow=${clanSimulation.actions.claimed || 0}/${clanSimulation.actions.resolved || 0}/${clanSimulation.actions.releasedUnstarted || 0}/${clanSimulation.actions.deferred || 0} clanActionQueue=${clanSimulation.actions.queuePending || 0}/${clanSimulation.actions.queueReady || 0}/${clanSimulation.actions.queueRunning || 0}/${Math.round(Number(clanSimulation.actions.queueOldestReadyAgeMs || 0) / 1000)}s clanActionLease=${clanSimulation.actions.leaseRecoveries || 0}/${clanSimulation.actions.releaseConflicts || 0}/${clanSimulation.actions.budgetOverruns || 0} clanActionP95=${clanActionStages} clanActionTypeP95=${clanActionTypeStages} clanActionDeferP95=${clanActionDeferP95}ms clanFounderP95=${clanFounderStages} clanFounderBudget=${clanSimulation.founder.budgetStops || 0}/${clanSimulation.founder.budgetOverruns || 0} clanLevels=${clanSimulation.economy.levelUps || 0} clanDeposits=${clanSimulation.warehouse.depositsApplied || 0} clanGoals=${clanSimulation.goals.activeGoals || 0}/${clanSimulation.goals.replans || 0} clanLlm=${clanSimulation.goals.llm?.requested || 0}/${clanSimulation.goals.llm?.selected || 0}/${clanSimulation.goals.llm?.fallback || 0}/${clanSimulation.goals.llm?.pendingEntries || 0} clanLlmTokens=${clanSimulation.goals.llm?.promptTokensActual || clanSimulation.goals.llm?.promptTokensEstimated || 0}/${clanSimulation.goals.llm?.completionTokens || 0} clanContext=${clanSimulation.goals.context?.builds || 0}/${Math.round(clanSimulation.goals.context?.tokenAvg || 0)}/${clanSimulation.goals.candidates?.cacheHits || 0} clanTitles=${clanSimulation.titles.appliedClans || 0}/${clanSimulation.titles.appliedTitles || 0}/${clanSimulation.titles.llm?.requested || 0}/${clanSimulation.titles.llm?.pendingEntries || 0} clanTitleTokens=${clanSimulation.titles.llm?.promptTokensActual || clanSimulation.titles.llm?.promptTokensEstimated || 0}/${clanSimulation.titles.llm?.completionTokens || 0} clanMarket=${clanSimulation.market.purchases || 0}/${clanSimulation.market.deposited || 0} clanParty=${clanSimulation.party.operationsStarted || 0}/${clanSimulation.party.operationsSucceeded || 0}/${clanSimulation.party.operationsFailed || 0}`;
        summary.line += ` bgGovernor=${governor.mode || 'idle'}/${governor.usedMs || 0}/${governor.capMs || 0}/${Object.keys(governor.resources || {}).length} bgGovernorFlow=${governor.admitted || 0}/${governor.deferred || 0}/${governor.completed || 0}/${governor.overruns || 0} bgGovernorDeferrals=${governorDeferrals}`;
        const delay = metrics.eventLoop.delay || {};
        summary.line += ` clanPlannerWorker=${clanWorker.running ? 'ready' : 'idle'}/${clanWorker.pending || 0}/${clanWorker.completed || 0}/${clanWorker.failures || 0} clanPlannerRunMax=${Math.round(clanWorker.maxRunMs || 0)}ms`;
        summary.line += ` loopDelay=${delay.p95Ms || 0}/${delay.p99Ms || 0}/${delay.maxMs || 0}ms:${delay.windowMs || 0}ms`;
        summary.line += ` bgGovernorJobs=${governorJobs} bgJobs=${backgroundJobs.registered || 0}/${backgroundJobs.inFlight || 0}/${backgroundJobs.tickMs || 0}ms bgJobFlow=${backgroundJobs.due || 0}/${backgroundJobs.started || 0}/${backgroundJobs.completed || 0}/${backgroundJobs.skipped || 0}/${backgroundJobs.deferred || 0}/${backgroundJobs.coalesced || 0}/${backgroundJobs.errors || 0}`;
        const coldWorker = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').snapshot();
        const worker = coldWorker.worker || {};
        const queueHead = worker.queueHead;
        const workerQueueHead = !queueHead ? 'unknown' : queueHead.kind === 'empty' ? 'empty'
            : `${queueHead.kind}/${queueHead.current ? 'current' : 'stale'}/${queueHead.overdue ? 'overdue' : 'future'}/${Math.round(queueHead.ageMs / 1000)}s`;
        const commitQueue = coldWorker.queue || {};
        summary.coldWorker = coldWorker;
        const invalidIpcReasons = Object.entries(coldWorker.invalidReasons || {}).map(([reason, count]) => `${reason}:${count}`).join('|') || 'none';
        // Refused commits by reason and stale_command answers since start (main counts them always).
        const refusals = coldWorker.refusals || {};
        const byReason = counts => Object.entries(counts || {}).map(([reason, count]) => `${reason}:${count}`).join('|') || 'none';
        const commitRefused = byReason(refusals.commitRefused);
        // Review commands (a far bot's plan, buff, training after its commit) since start, counted always:
        // answered, ok, refused by reason, skipped by the worker for want of a command slot, steps carried.
        const reviewCounts = coldWorker.reviews || {};
        const reviewRefused = Object.entries(reviewCounts.refused || {}).map(([reason, count]) => `refused:${reason}:${count}`).join('|') || 'refused:0';
        const reviews = `sent:${reviewCounts.sent || 0}|ok:${reviewCounts.ok || 0}|${reviewRefused}|skipped:${worker.reviewsSkipped || 0}`
            + `|plan:${reviewCounts.plan || 0}|buff:${reviewCounts.buff || 0}|training:${reviewCounts.training || 0}`;
        const snapshots = coldWorker.snapshots || {};
        const workerFlushReasons = Object.entries(worker.flushReasons || {})
            .map(([reason, count]) => `${reason}:${count}`)
            .join('|') || 'none';
        const lastSnapshot = snapshots.last || {};
        const commitStages = Object.entries(commitQueue.stages || {})
            .map(([stage, values]) => `${stage}:${values.p95Ms || 0}`).join('|') || 'none';
        // afterCommitSteps=<step>:<p95 ms of that step's sum per flush>, over the flushes where it ran.
        const afterCommitSteps = Object.entries(commitQueue.afterCommitSteps || {})
            .map(([step, p95Ms]) => `${step}:${p95Ms}`).join('|') || 'none';
        const commitTriggers = Object.entries(commitQueue.flushReasons || {})
            .map(([reason, count]) => `${reason}:${count}`).join('|') || 'none';
        summary.line += ` heaps=${heapsLine(PopulationStatus.heaps({ coldWorker: worker, history: database.history, checkpoint, pathWorkers }))}`;
        summary.line += ` commitStages=${commitStages} afterCommitSteps=${afterCommitSteps} commitTriggers=${commitTriggers} commitEarly=${commitQueue.earlyAttempts || 0}/${commitQueue.earlyDenied || 0}/${commitQueue.earlyEmpty || 0}`;
        // workerFlight=inFlight/dirty/commanding:<oldest command age>/<oldest step age>; workerRecovery=stalled/orphan;
        // workerNearHeld=hot rows older than their near record, kept out (ColdSimulationKernel nearHeld).
        summary.line += ` coldWorker=${coldWorker.ready ? 'ready' : coldWorker.started ? 'starting' : 'stopped'}/${coldWorker.heartbeatAgeMs ?? -1}ms workerState=${worker.paused ? 'paused' : 'running'}/${worker.stopping ? 'stopping' : 'active'}/${worker.heap || 0}h workerLimit=${worker.maxInFlight || 0} workerFlow=${worker.selected || 0}/${worker.resolved || 0}/${worker.proposals || 0} workerQueueHead=${workerQueueHead} workerFlight=${worker.inFlight || 0}/${worker.dirty || 0}/${worker.commanding || 0}:${Math.round(Number(worker.commandingAgeMs || 0) / 1000)}s/${Math.round(Number(worker.inFlightAgeMs || 0) / 1000)}s workerPartyCapacity=${worker.partyCapacityBursts || 0}/${worker.partyCapacityDeferrals || 0} workerFlush=${worker.flushes || 0}/${worker.flushRows || 0}/${worker.lastFlushRows || 0}/${worker.maxFlushRows || 0}:${workerFlushReasons} workerRecovery=${worker.stallRecoveries || 0}/${worker.orphanRecoveries || 0} workerNearHeld=${worker.nearHeld || 0} heldAcks=${coldWorker.heldAcks || 0}/${worker.lateAcks || 0} ackState=${coldWorker.ackState?.with || 0}/${coldWorker.ackState?.without || 0}/${worker.ackUnbuilt || 0} workerPayload=${worker.proposalCompactions || 0}/${worker.proposalOversize || 0}/${worker.proposalOversizeRejected || 0} workerLoop=${Math.round(Number(worker.eventLoopLagP95Ms || 0))}/${Math.round(Number(worker.eventLoopLagMaxMs || 0))}ms workerElu=${Number(worker.eventLoopUtilization || 0).toFixed(2)} commitRefused=${commitRefused} staleCommand=${refusals.staleCommand || 0} reviews=${reviews} workerHeap=${Math.round(Number(worker.heapUsed || 0) / 1024 / 1024)}MB workerHeapGc=${worker.heapAfterGc ? Math.round(worker.heapAfterGc / 1024 / 1024) : '-'}/${worker.heapAfterGcMax10 ? Math.round(worker.heapAfterGcMax10 / 1024 / 1024) : '-'}MB workerRestarts=${coldWorker.workerRestarts || 0} economyDecisions=${coldWorker.economyDecisions?.hits || 0}/${coldWorker.economyDecisions?.misses || 0}/${coldWorker.economyDecisions?.held || 0} ipc=${coldWorker.messagesIn || 0}/${coldWorker.messagesOut || 0}/${coldWorker.invalidMessages || 0}/${coldWorker.duplicateMessages || 0} ipcRejects=${invalidIpcReasons} commitQueue=${commitQueue.depth || 0}/${commitQueue.p0 || 0}/${commitQueue.p1 || 0}/${commitQueue.p2 || 0} commitFlow=${commitQueue.committed || 0}/${commitQueue.stale || 0}/${commitQueue.rejected || 0} commitLag=${commitQueue.queueP95Ms || 0}/${commitQueue.oldestMs || 0}ms commitP95=${commitQueue.commitP95Ms || 0}ms commitBusy=${commitQueue.busy || 0}/${commitQueue.retries || 0}`;
        // workerCaches=s:<memo>/<best>/<income>/<bases>/<cells>:<memoHits>/<memoMisses>:<memoEvictions>/<incomeEvictions>/<baseEvictions>/<resets>:<bestHits>/<bestMisses>:<incomeHits>/<incomeMisses>,k:<kit profile store bots>; counts since worker start
        // mainKits=<the kit profile store bots of the main thread>
        if (worker.caches) {
            const s = worker.caches.spotValue || {};
            summary.line += ` workerCaches=s:${s.memo || 0}/${s.best || 0}/${s.income || 0}/${s.bases || 0}/${s.cells || 0}:${s.memoHits || 0}/${s.memoMisses || 0}:${s.memoEvictions || 0}/${s.incomeEvictions || 0}/${s.baseEvictions || 0}/${s.resets || 0}:${s.bestHits || 0}/${s.bestMisses || 0}:${s.incomeHits || 0}/${s.incomeMisses || 0},k:${worker.caches.kitProfiles || 0}`;
        }
        summary.line += ` mainKits=${ColdCombatProfile.kitStoreSize()}`;
        const soloHolds = coldWorker.soloHolds || {};
        summary.line += ` soloHolds=${soloHolds.hits || 0}/${soloHolds.misses || 0}/${soloHolds.size || 0}`;
        summary.line += ` snapshot=${snapshots.dirty || 0}/${snapshots.critical || 0}/${snapshots.inFlight ? 1 : 0} snapshotLast=${lastSnapshot.mode || 'none'}/${lastSnapshot.rows || 0}/${lastSnapshot.pages || 0}/${lastSnapshot.durationMs || 0}ms snapshotRuns=${snapshots.fullRuns || 0}/${snapshots.dirtyRuns || 0}/${snapshots.criticalRuns || 0} snapshotDeferrals=${snapshots.deferrals || 0} snapshotYields=${snapshots.yields || 0}`;
        summary.line += ` ${this.nearText(coldWorker)}`;
        return summary;
    }
};

module.exports = PopulationStatus;

const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const GeneratedColdSeeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const ColdMarketTradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PartyRecruitmentChat = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const CraftTelemetry = invoke('GameServer/Bot/Economy/CraftTelemetry');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');

const HUNTING_TRAVEL_MS = 25000;

function beginHuntingTravel(state, spot, timestamp = Date.now(), options = {}) {
    if (!state || !spot || state.activity === 'traveling') return null;
    const from = { ...(state.loc || {}) };
    const hasLocation = Number.isFinite(Number(from.locX)) && Number.isFinite(Number(from.locY))
        && (Object.prototype.hasOwnProperty.call(from, 'locX') || Object.prototype.hasOwnProperty.call(from, 'locY'));
    if (!hasLocation) return null;
    const physical = SpotService.findCurrentSpot(from);
    const currentId = physical?.id || options.currentSpotId || state.spotId || null;
    if (currentId === spot.id) return null;

    return {
        ...state,
        activity: 'traveling',
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + HUNTING_TRAVEL_MS
        },
        stats: {
            ...(state.stats || {}),
            travel: {
                from,
                to: { ...spot.center },
                startedAt: timestamp,
                arrivalAt: timestamp + HUNTING_TRAVEL_MS,
                regionName: spot.name || state.currentRegion || 'Hunting Ground',
                method: 'gatekeeper_spot',
                spotId: spot.id,
                arrivalActivity: 'hunting',
                arrivalEvent: 'arrived_hunting_ground',
                reason: state.stats?.equipmentPlan?.status === 'active'
                    ? 'equipment_source_replan'
                    : 'level_replan'
            }
        }
    };
}

function groupBySpot(states, options = {}) {
    const grouped = new Map();
    states.forEach((state) => {
        const planSpotId = !SpotProfiles.isProtectedStarterCohort(state)
            && state.stats?.equipmentPlan?.status === 'active'
            ? state.stats.equipmentPlan.next?.spotId
            : null;
        const spotId = planSpotId || state.spotId;
        if (!spotId) return;
        if (!grouped.has(spotId)) grouped.set(spotId, []);
        grouped.get(spotId).push(state);
    });

    const activePartiesBySpot = options.activePartiesBySpot || new Map();
    return Array.from(grouped.entries())
        .map(([spotId, group]) => ({
            spotId,
            states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
            partyWaiters: group.filter((state) => state.activity === 'party_wait'
                || state.stats?.partyRequest?.status === 'open').length,
            oldestPartyWaitAt: Math.min(...group
                .filter((state) => state.activity === 'party_wait'
                    || state.stats?.partyRequest?.status === 'open')
                .map((state) => Number(state.stats?.partyRequest?.requestedAt
                    || state.timing?.activityStartedAt
                    || state.updatedAt
                    || Date.now())))
        }))
        .sort((a, b) => {
            if (options.prioritizePartyWait) {
                const aDeficit = a.partyWaiters / (1 + Number(activePartiesBySpot.get(a.spotId) || 0));
                const bDeficit = b.partyWaiters / (1 + Number(activePartiesBySpot.get(b.spotId) || 0));
                if (aDeficit !== bDeficit) return bDeficit - aDeficit;
                if (a.oldestPartyWaitAt !== b.oldestPartyWaitAt) return a.oldestPartyWaitAt - b.oldestPartyWaitAt;
            }
            const aGroup = a.states;
            const bGroup = b.states;
            const aPlanned = aGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            const bPlanned = bGroup.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            return bPlanned - aPlanned || bGroup.length - aGroup.length;
        })
        .map((group) => group.states);
}

function partySpotForLeader(leader, objectiveSpotId = null) {
    if (objectiveSpotId) {
        const objectiveSpot = SpotProfiles.findById(objectiveSpotId);
        if (objectiveSpot) return objectiveSpot;
    }
    const preserveStarterSpot = SpotProfiles.isProtectedStarterCohort(leader);
    return SpotProfiles.findForState({
        ...leader,
        spotId: preserveStarterSpot ? leader.spotId : null,
        party: {
            ...(leader.party || {}),
            partyId: 'forming',
            role: PartyComposition.roleForState(leader)
        },
        stats: {
            ...(leader.stats || {}),
            routeMode: 'party'
        }
    }, { mode: 'party', role: PartyComposition.roleForState(leader) }) || SpotProfiles.findById(leader.spotId);
}

function maxBackgroundPartiesForBacklog(partyWaitCount = 0) {
    const base = Math.max(0, Number(Config.maxBackgroundParties) || 0);
    const threshold = Math.max(1, Number(Config.partyBacklogCapacityThreshold) || 250);
    const step = Math.max(0, Number(Config.partyBacklogCapacityStep) || 0);
    const maxExtra = Math.max(0, Number(Config.partyBacklogCapacityMaxExtra) || 0);
    const extra = Math.min(maxExtra, Math.floor(Math.max(0, Number(partyWaitCount) || 0) / threshold) * step);
    return base + extra;
}

function acquisitionRequirementKey(plan) {
    return JSON.stringify({
        status: plan?.status || null,
        strategy: plan?.strategy || null,
        partyNeed: plan?.partyNeed || (plan?.requiresParty ? 'required' : 'solo_ok'),
        partyNeedReason: plan?.partyNeedReason || null,
        requiresParty: Boolean(plan?.requiresParty),
        target: Number(plan?.target?.selfId || 0),
        nextSpot: plan?.next?.spotId || null,
        nextNpc: Number(plan?.next?.npcId || 0),
        nextItem: Number(plan?.next?.itemId || 0)
    });
}

function partyObjectiveForPlan(plan) {
    if (!plan || !['active', 'blocked'].includes(plan.status) || !plan.next?.spotId) return null;
    const partyNeed = plan.partyNeed || (plan.requiresParty ? 'required' : 'solo_ok');
    if (!['required', 'preferred'].includes(partyNeed)) return null;
    const strategy = plan.strategy || 'acquisition';
    const targetItemId = Number(plan.next.itemId || plan.target?.selfId || 0);
    const npcId = Number(plan.next.npcId || 0);
    // A party hunts a route/NPC, not one item at a time. The item remains in
    // the request for personal reward tracking, but it must not fragment all
    // bots killing the same dropper into incompatible groups.
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    return {
        status: 'open',
        priority: partyNeed,
        objectiveKey,
        reason: strategy === 'craft' ? 'craft_material' : 'gear_acquisition',
        partyNeedReason: plan.partyNeedReason || null,
        strategy,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: Number(plan.target?.selfId || 0) || null
    };
}

function partyRequestEligible(state) {
    return !state?.party?.partyId
        && ['hunting', 'resting', 'party_wait'].includes(state?.activity);
}

function partyRequestForPlan(state, plan, timestamp = Date.now()) {
    if (!partyRequestEligible(state)) return null;
    const objective = partyObjectiveForPlan(plan);
    if (!objective) return null;
    const previous = state.stats?.partyRequest;
    const sameRequest = ['open', 'deferred'].includes(previous?.status)
        && previous.objectiveKey === objective.objectiveKey
        && Number(previous.itemId || 0) === Number(objective.itemId || 0)
        && Number(previous.targetId || 0) === Number(objective.targetId || 0);
    const maxAge = objective.priority === 'required'
        ? Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000)
        : Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
    const cooldownMs = Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000);
    const previousRequestedAt = sameRequest ? Number(previous.requestedAt || timestamp) : timestamp;
    const previousAttempts = sameRequest ? Number(previous.attempts || 0) : 0;

    if (sameRequest && previous.status === 'deferred' && Number(previous.deferredUntil || 0) > timestamp) {
        return {
            ...objective,
            status: 'deferred',
            requestedAt: previousRequestedAt,
            deferredUntil: Number(previous.deferredUntil),
            expiredAt: Number(previous.expiredAt || 0) || null,
            attempts: previousAttempts,
            lastMatchedAt: previous.lastMatchedAt || null
        };
    }

    if (sameRequest && previous.status === 'open' && timestamp - previousRequestedAt >= maxAge) {
        return {
            ...objective,
            status: 'deferred',
            requestedAt: previousRequestedAt,
            deferredUntil: timestamp + cooldownMs,
            expiredAt: timestamp,
            attempts: previousAttempts + 1,
            lastMatchedAt: previous.lastMatchedAt || null
        };
    }

    return {
        ...objective,
        status: 'open',
        requestedAt: sameRequest && previous.status === 'open' ? previousRequestedAt : timestamp,
        reviewAt: timestamp + Math.max(30000, Number(Config.partyWaitReplanMs) || 5 * 60 * 1000),
        attempts: sameRequest ? previousAttempts : 0,
        lastMatchedAt: sameRequest ? previous.lastMatchedAt || null : null
    };
}

function partyObjectiveForState(state) {
    if (state?.stats?.partyRequest) {
        return state.stats.partyRequest.status === 'open' ? state.stats.partyRequest : null;
    }
    return partyObjectiveForPlan(state?.stats?.equipmentPlan);
}

function partyObjectivesShareRoute(left, right) {
    return Boolean(left && right
        && String(left.spotId || '') === String(right.spotId || '')
        && Number(left.npcId || 0) > 0
        && Number(left.npcId || 0) === Number(right.npcId || 0));
}

function partySessionExpired(party, timestamp = Date.now()) {
    const sessionExpiresAt = Number(party?.stats?.sessionExpiresAt || 0);
    if (sessionExpiresAt > 0) return timestamp >= sessionExpiresAt;
    const maxAge = Math.max(0, Number(Config.partySessionMaxMs) || 0);
    const startedAt = Number(party?.stats?.formedAt || party?.startedAt || 0);
    return maxAge > 0 && startedAt > 0 && timestamp - startedAt >= maxAge;
}

function statesForParties(partyIds = []) {
    const ids = [...new Set((partyIds || []).map((partyId) => String(partyId || '')).filter(Boolean))];
    if (typeof LifeState.statesForParties === 'function') {
        return LifeState.statesForParties(ids);
    }
    return Promise.all(ids.map((partyId) => LifeState.statesForParty(partyId)))
        .then((groups) => new Map(ids.map((partyId, index) => [partyId, groups[index] || []])));
}

function expirePartyRequestForState(state, timestamp = Date.now()) {
    const request = state?.stats?.partyRequest;
    if (request?.status !== 'open') return state;
    const maxAge = request.priority === 'required'
        ? Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000)
        : Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
    if (timestamp - Number(request.requestedAt || timestamp) < maxAge) return state;
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            partyRequest: {
                ...request,
                status: 'deferred',
                deferredUntil: timestamp + Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000),
                expiredAt: timestamp,
                attempts: Number(request.attempts || 0) + 1
            }
        }
    };
}

function partyObjectiveKeyForState(state) {
    return partyObjectiveForState(state)?.objectiveKey
        || `spot:${state?.spotId || 'unknown'}`;
}

function partyObjectiveSpotForState(state) {
    return partyObjectiveForState(state)?.spotId
        || state?.stats?.equipmentPlan?.next?.spotId
        || state?.spotId
        || null;
}

function directDropTargetNpcId(...plans) {
    for (const plan of plans) {
        if (plan?.status !== 'active' || plan?.strategy !== 'direct_drop') continue;
        const npcId = Number(plan.next?.npcId || 0);
        if (npcId > 0) return npcId;
    }
    return 0;
}

function partyTargetNpcId(party, leader) {
    const objectiveNpcId = Number(party.stats?.objective?.npcId || 0);
    return objectiveNpcId > 0
        ? objectiveNpcId
        : directDropTargetNpcId(leader.stats?.equipmentPlan, party.stats?.acquisitionGoal);
}

function joinedBackgroundParty(state) {
    const current = LifeState.cachedState(state?.characterId);
    return !!current?.party?.partyId;
}

function canTakePartyMarketBreak(party, members, member, timestamp = Date.now()) {
    if (timestamp - Number(party.stats?.formedAt || party.startedAt || timestamp) < Config.partyMarketBreakMinSessionMs) return false;
    if (Number(party.stats?.fightsResolved || 0) < Config.partyMarketBreakMinFights) return false;
    if (timestamp - Number(party.stats?.lastMarketBreakAt || 0) < Config.partyMarketBreakCooldownMs) return false;
    const role = PartyComposition.roleForState(member);
    const coverage = PartyComposition.roleCoverage(members);
    return !(['tank', 'healer'].includes(role) && Number(coverage[role] || 0) <= 1);
}

function dissolveBackgroundParty(party, reason, memberCount = 0) {
    return BackgroundPartyState.setStatus(party.partyId, 'dissolved')
        .then(() => LifeState.clearParty(party.partyId, reason))
        .then((cleared) => {
            Metrics.recordPartyDissolution();
            console.info(
                'BotPopulation :: dissolved background party %s reason=%s members=%d cleared=%d',
                party.partyId,
                reason,
                memberCount,
                cleared
            );
            return { ok: false, reason, party, cleared };
        });
}

function activationCandidatesForPlayer(states, playerLevel) {
    const level = Number(playerLevel || 1);
    const range = Math.max(0, Number(Config.activationLevelRange || 0));
    const matching = states.filter((state) => {
        const stateLevel = Number(state.level || 1);
        if (Math.abs(stateLevel - level) <= range) return true;
        return !!state.stats?.newbieAnchor && level <= Config.newbieAnchorMaxLevel + 2;
    });

    return matching.length > 0 ? matching : states;
}

function distance2d(a, b) {
    const dx = Number(a?.fetchLocX?.() || 0) - Number(b?.fetchLocX?.() || 0);
    const dy = Number(a?.fetchLocY?.() || 0) - Number(b?.fetchLocY?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function nearbyHotCount(sessions, player) {
    const playerLevel = Number(player.fetchLevel?.() || 1);
    return sessions.filter((session) => {
        const actor = session?.actor;
        if (!actor || !session.accountId || !String(session.accountId).startsWith('bot_')) return false;
        if (actor.fetchIsOnline && !actor.fetchIsOnline()) return false;
        if (session.plan === 'merchant') return false;
        if (distance2d(actor, player) > Config.activationRadius) return false;
        return Math.abs(Number(actor.fetchLevel?.() || 1) - playerLevel) <= Config.activationLevelRange;
    }).length;
}

const PopulationService = {
    groupBySpot,
    partySpotForLeader,
    partyTargetNpcId,
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    partyFormationTimer: null,
    phasePolicyTimer: null,
    seedTimer: null,
    classProgressionMigrationTimer: null,
    marketTownMigrationTimer: null,
    nextColdCombatProfileMigrationAt: 0,
    nextMarketTownMigrationAt: 0,
    nextPartyRequestCleanupAt: 0,
    marketExpiryCleanupTimer: null,
    personaBackfillTimer: null,
    personaBackfillRunning: false,
    nextMarketExpiryCleanupAt: 0,
    resolving: false,
    classProgressionMigrationRunning: false,
    coldCombatProfileMigrationRunning: false,
    marketTownMigrationRunning: false,
    marketExpiryCleanupRunning: false,
    partyFormationRunning: false,
    partyFormationPending: false,
    phasePolicyRunning: false,

    init() {
        if (this.initialized || Config.enabled === false) return;

        Metrics.init();
        Metrics.startEventLoopMonitor();
        LifeState.init();
        LifeEvents.init();
        BackgroundPartyState.init();
        Director.init();
        this.initialized = true;
        utils.infoSuccess('BotPopulation', 'population service initialized');
    },

    start() {
        if (this.started || Config.enabled === false) return;
        if (!this.initialized) this.init();

        this.started = true;
        this.initialSummaryTimer = setTimeout(() => {
            this.logSummary('start');
            this.initialSummaryTimer = null;
        }, 5000);

        if (typeof this.initialSummaryTimer.unref === 'function') {
            this.initialSummaryTimer.unref();
        }

        this.summaryTimer = setInterval(() => {
            this.logSummary('summary');
        }, Config.summaryIntervalMs);

        if (typeof this.summaryTimer.unref === 'function') {
            this.summaryTimer.unref();
        }

        if (Config.backgroundResolverEnabled !== false) {
            this.schedulerTimer = setInterval(() => {
                this.tickBudgeted();
            }, Config.schedulerIntervalMs);

            if (typeof this.schedulerTimer.unref === 'function') {
                this.schedulerTimer.unref();
            }
        }

        this.classProgressionMigrationTimer = setInterval(() => {
            this.migrateLegacyClassProgression();
        }, Config.classProgressionMigrationIntervalMs);

        if (typeof this.classProgressionMigrationTimer.unref === 'function') {
            this.classProgressionMigrationTimer.unref();
        }

        this.marketTownMigrationTimer = setInterval(() => {
            this.maybeMigrateLegacyMarketTowns();
        }, Config.marketTownMigrationIntervalMs);

        if (typeof this.marketTownMigrationTimer.unref === 'function') {
            this.marketTownMigrationTimer.unref();
        }

        this.marketExpiryCleanupTimer = setInterval(() => {
            this.maybeExpireStaleMarketStores();
        }, Config.marketExpiryCleanupIntervalMs);

        if (typeof this.marketExpiryCleanupTimer.unref === 'function') {
            this.marketExpiryCleanupTimer.unref();
        }

        if (Config.backgroundPartyEnabled !== false) {
            this.partyFormationTimer = setInterval(() => {
                this.formBackgroundParties();
            }, Config.partyFormationIntervalMs);

            if (typeof this.partyFormationTimer.unref === 'function') {
                this.partyFormationTimer.unref();
            }
        }

        if (Config.phasePolicyEnabled !== false) {
            this.phasePolicyTimer = setInterval(() => {
                this.tickPhasePolicy();
            }, Config.phasePolicyIntervalMs);

            if (typeof this.phasePolicyTimer.unref === 'function') {
                this.phasePolicyTimer.unref();
            }
        }

        this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
        this.schedulePersonaBackfill();

        Director.start();
    },

    stop() {
        if (this.initialSummaryTimer) {
            clearTimeout(this.initialSummaryTimer);
            this.initialSummaryTimer = null;
        }
        if (this.summaryTimer) {
            clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        if (this.partyFormationTimer) {
            clearInterval(this.partyFormationTimer);
            this.partyFormationTimer = null;
        }
        if (this.phasePolicyTimer) {
            clearInterval(this.phasePolicyTimer);
            this.phasePolicyTimer = null;
        }
        if (this.seedTimer) {
            clearTimeout(this.seedTimer);
            this.seedTimer = null;
        }
        if (this.classProgressionMigrationTimer) {
            clearInterval(this.classProgressionMigrationTimer);
            this.classProgressionMigrationTimer = null;
        }
        this.nextColdCombatProfileMigrationAt = 0;
        if (this.marketTownMigrationTimer) {
            clearInterval(this.marketTownMigrationTimer);
            this.marketTownMigrationTimer = null;
        }
        if (this.marketExpiryCleanupTimer) {
            clearInterval(this.marketExpiryCleanupTimer);
            this.marketExpiryCleanupTimer = null;
        }
        if (this.personaBackfillTimer) {
            clearInterval(this.personaBackfillTimer);
            this.personaBackfillTimer = null;
        }
        this.personaBackfillRunning = false;
        Director.stop();
        Metrics.stopEventLoopMonitor();
        this.started = false;
    },

    scheduleGeneratedColdSeed(delayMs = Config.generatedColdSeedDelayMs) {
        if (Config.enabled === false || Config.maxPlayingPopulation <= 0 || this.seedTimer) return;

        this.seedTimer = setTimeout(() => {
            this.seedTimer = null;
            GeneratedColdSeeder.seedPopulation().then((result) => {
                if (result.seeded > 0) {
                    console.info(
                        'BotPopulation :: population wave=%d seeded=%d created=%d total=%d/%d target=%d avgLevel=%s starterSpots=%d',
                        result.wave || 1,
                        result.seeded,
                        result.created,
                        result.total,
                        result.limit,
                        result.targetPopulation || result.limit,
                        Number(result.averageLevel || 0).toFixed(1),
                        result.eligible || 0
                    );
                }

                // Keep checking the next wave: once the mean bot level crosses
                // another five-level threshold, newly opened grounds are filled.
                if (this.started && result.limit > 0 && result.total < result.limit && !result.error) {
                    this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
                }
            });
        }, Math.max(1000, Number(delayMs || 0)));

        if (typeof this.seedTimer.unref === 'function') {
            this.seedTimer.unref();
        }
    },

    schedulePersonaBackfill() {
        if (this.personaBackfillTimer) return;

        const run = () => {
            if (this.personaBackfillRunning) return;
            this.personaBackfillRunning = true;
            BotPersona.backfillGenerated().then((result) => {
                // Only a successful short read closes this one-time migration.
                // A failed write stays scheduled for a later retry.
                if (result.exhausted && this.personaBackfillTimer) {
                    clearInterval(this.personaBackfillTimer);
                    this.personaBackfillTimer = null;
                }
            }).finally(() => {
                this.personaBackfillRunning = false;
            });
        };

        run();
        this.personaBackfillTimer = setInterval(run, 2000);
        if (typeof this.personaBackfillTimer.unref === 'function') {
            this.personaBackfillTimer.unref();
        }
    },

    migrateLegacyClassProgression() {
        // Database uses one ordered connection. Never queue a migration behind
        // an active resolver: a skipped migration tick is harmless, but a
        // queued one can stretch the normal world loop into a long backlog.
        if (this.classProgressionMigrationRunning || this.resolving || Config.enabled === false) return Promise.resolve([]);
        this.classProgressionMigrationRunning = true;
        return LifeState.migrateLegacyClassProgression(Config.classProgressionMigrationBatchSize)
            .then((migrated) => {
                if (migrated.length) {
                    console.info('BotPopulation :: migrated class progression for %d cold bot(s)', migrated.length);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy class progression migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.classProgressionMigrationRunning = false;
            });
    },

    migrateLegacyColdCombatProfiles() {
        if (this.coldCombatProfileMigrationRunning || this.resolving || this.classProgressionMigrationRunning || Config.enabled === false) {
            return Promise.resolve([]);
        }
        this.coldCombatProfileMigrationRunning = true;
        return LifeState.migrateLegacyColdCombatProfiles(Config.coldCombatProfileMigrationBatchSize)
            .then((migrated) => {
                if (migrated.length) {
                    console.info('BotPopulation :: migrated cold combat profiles for %d bot(s)', migrated.length);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy cold combat profile migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.coldCombatProfileMigrationRunning = false;
            });
    },

    maybeMigrateLegacyColdCombatProfiles(timestamp = Date.now()) {
        if (this.coldCombatProfileMigrationRunning || timestamp < this.nextColdCombatProfileMigrationAt) {
            return Promise.resolve([]);
        }
        this.nextColdCombatProfileMigrationAt = timestamp + Config.coldCombatProfileMigrationIntervalMs;
        return this.migrateLegacyColdCombatProfiles();
    },

    migrateLegacyMarketTowns() {
        // This migration is deliberately bounded and serialized. Do not gate
        // it on `resolving`: both timers share a 10-second cadence, which can
        // otherwise starve the transition forever while the resolver is live.
        if (this.marketTownMigrationRunning || Config.enabled === false) return Promise.resolve([]);
        this.marketTownMigrationRunning = true;
        return ColdMarketListingService.migrateLegacyMarketTowns(Config.marketTownMigrationBatchSize)
            .then((migrated) => {
                const relocated = migrated.filter((entry) => entry.relocated).length;
                if (migrated.length) {
                    console.info('BotPopulation :: migrated market towns checked=%d relocated=%d', migrated.length, relocated);
                }
                return migrated;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'legacy market-town migration failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.marketTownMigrationRunning = false;
            });
    },

    maybeMigrateLegacyMarketTowns(timestamp = Date.now()) {
        if (this.marketTownMigrationRunning || timestamp < this.nextMarketTownMigrationAt) return Promise.resolve([]);
        this.nextMarketTownMigrationAt = timestamp + Config.marketTownMigrationIntervalMs;
        return this.migrateLegacyMarketTowns();
    },

    expireStaleMarketStores(timestamp = Date.now()) {
        if (this.marketExpiryCleanupRunning || Config.enabled === false) return Promise.resolve([]);
        this.marketExpiryCleanupRunning = true;
        return ColdMarketListingService.expireStaleMarketStores(Config.marketExpiryCleanupBatchSize, timestamp)
            .then((expired) => {
                if (expired.length) console.info('BotPopulation :: expired market stores closed=%d', expired.length);
                return expired;
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'expired market cleanup failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.marketExpiryCleanupRunning = false;
            });
    },

    maybeExpireStaleMarketStores(timestamp = Date.now()) {
        if (this.marketExpiryCleanupRunning || timestamp < this.nextMarketExpiryCleanupAt) return Promise.resolve([]);
        this.nextMarketExpiryCleanupAt = timestamp + Config.marketExpiryCleanupIntervalMs;
        return this.expireStaleMarketStores(timestamp);
    },

    recordHotTick(session) {
        if (Config.enabled === false) return;
        if (!session || !session.accountId || !String(session.accountId).startsWith('bot_')) return;
        Metrics.recordHotTick();
    },

    markHot(session, reason = 'hot') {
        if (Config.enabled === false) return Promise.resolve(null);
        return LifeState.markHot(session, reason);
    },

    cooldownSession(session, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return Cooldown.cooldown(session, reason, options);
    },

    requestActivation(stateOrName, reason = 'manual', options = {}) {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return HotActivation.activate(stateOrName, reason, options);
    },

    tickPhasePolicy() {
        if (this.phasePolicyRunning || Config.enabled === false || Config.phasePolicyEnabled === false) {
            return Promise.resolve({ cooled: [], activated: [] });
        }

        this.phasePolicyRunning = true;
        return this.activateNearPlayers()
            .then((activated) => this.cooldownEligibleHot().then((cooled) => ({ activated, cooled })))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'phase policy failed: %s', err.message);
                return { activated: [], cooled: [] };
            })
            .finally(() => {
                this.phasePolicyRunning = false;
            });
    },

    realPlayerSessions() {
        const World = invoke('GameServer/World/World');
        return World.user.sessions.filter((session) => (
            session.actor &&
            session.actor.fetchIsOnline() &&
            session.accountId &&
            !String(session.accountId).startsWith('bot_')
        ));
    },

    isRestingActivationState(state) {
        const activity = state?.activity || 'hunting';
        if (activity === 'resting' || activity === 'dead') return true;

        const vitals = state?.vitals || {};
        const hpPct = Number(vitals.hp || 0) / Math.max(1, Number(vitals.maxHp || vitals.hp || 1));
        const mpPct = Number(vitals.mp || 0) / Math.max(1, Number(vitals.maxMp || vitals.mp || 1));
        return hpPct < 0.35 || mpPct < 0.20;
    },

    activateNearPlayers() {
        const players = this.realPlayerSessions();
        if (players.length === 0) return Promise.resolve([]);

        const BotManager = invoke('GameServer/Bot/BotManager');
        const activated = [];
        const ambientActivated = [];
        let chain = Promise.resolve();

        players.forEach((playerSession) => {
            chain = chain.then(() => {
                const actor = playerSession.actor;
                const loc = {
                    locX: actor.fetchLocX(),
                    locY: actor.fetchLocY(),
                    locZ: actor.fetchLocZ()
                };
                const existingNearby = nearbyHotCount(BotManager.sessions, actor);
                const densityDeficit = Math.max(0, Config.nearPlayerHotTarget - existingNearby);
                // Craft shops are persistent town infrastructure. They must not
                // compete with the ambient-density budget, otherwise a full row
                // of public stations can only appear in several policy ticks.
                return LifeState.coldNear(loc, Config.activationRadius, 100)
                    .then((states) => {
                        // A cold traveller has no hot equivalent for its
                        // persisted route. Keep it cold until its resolver
                        // reaches the destination, instead of spawning a
                        // hunter/resting bot stranded on a road or plaza.
                        // A persisted background party is one lifecycle unit.
                        // Ambient visibility must not materialize one member
                        // as a solo hot bot and silently dissolve the group.
                        const available = states.filter((state) => (
                            !['pk_hunting', 'traveling'].includes(state.activity) &&
                            !state.stats?.supplyErrand &&
                            !state.party?.partyId
                        ));
                        const merchants = available.filter((state) => state.activity === 'merchant' && state.stats?.marketStore);
                        const crafters = available.filter((state) => state.activity === 'crafting' && state.stats?.craftShop);
                        const ambientRemaining = Math.min(
                            Math.max(0, Config.maxActivationsPerScan - ambientActivated.length),
                            Math.max(0, densityDeficit - crafters.length)
                        );
                        const candidates = [...crafters, ...merchants, ...activationCandidatesForPlayer(
                            available.filter((state) => state.activity !== 'merchant' && state.activity !== 'crafting'),
                            actor.fetchLevel()
                        )].slice(0, crafters.length + ambientRemaining);
                        return candidates.reduce((stateChain, state) => (
                            stateChain.then(() => {
                                return this.requestActivation(state, 'near_player', {
                                    recoverOnActivation: this.isRestingActivationState(state),
                                    readyOnActivation: true,
                                    keepStoreLocation: (state.activity === 'merchant' && !!state.stats?.marketStore)
                                        || (state.activity === 'crafting' && !!state.stats?.craftShop),
                                    playerLoc: loc
                                });
                            }).then((result) => {
                                if (result.ok) {
                                    activated.push(result);
                                    if (state.activity !== 'crafting' || !state.stats?.craftShop) ambientActivated.push(result);
                                }
                            })
                        ), Promise.resolve());
                    });
            });
        });

        return chain.then(() => activated);
    },

    cooldownEligibleHot() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const now = Date.now();
        const players = this.realPlayerSessions();
        const cooldownRadius = Math.max(Config.cooldownRadius, Config.activationRadius);
        const candidates = BotManager.sessions
            .filter((session) => session.actor && session.accountId && String(session.accountId).startsWith('bot_'))
            .filter((session) => {
                if (session.chatArrivalActive) return false;
                if (session.plan === 'merchant' && !session.coldMarketState && !session.coldCraftState) return false;
                // Red-name bots are part of the visible PK population, not
                // disposable ambient population. Keep them hot until their
                // karma is genuinely cleared.
                if (session.actor.fetchKarma?.() > 0) return false;
                if (session.partyCompanion === true || session.followPlayerSession) return false;
                const lastHotAt = session.populationHotAt || 0;
                if (lastHotAt && now - lastHotAt < Config.cooldownGraceMs) return false;
                if (players.length === 0) return true;
                return players.every((playerSession) => (
                    distance2d(session.actor, playerSession.actor) > cooldownRadius
                ));
            })
            .sort((a, b) => {
                const aDistance = players.length
                    ? Math.min(...players.map((player) => distance2d(a.actor, player.actor)))
                    : Infinity;
                const bDistance = players.length
                    ? Math.min(...players.map((player) => distance2d(b.actor, player.actor)))
                    : Infinity;
                return bDistance - aDistance;
            })
            .slice(0, Config.cooldownBatchSize);

        return candidates.reduce((chain, session) => (
            chain.then((results) => this.cooldownSession(session, 'policy').then((result) => {
                if (result.ok) results.push(result);
                return results;
            }))
        ), Promise.resolve([]));
    },

    formBackgroundParties() {
        // Formation rewrites party membership.  It must not overlap with the
        // scheduler after that scheduler has already selected solo candidates.
        if (this.partyFormationRunning || Config.enabled === false || Config.backgroundPartyEnabled === false) {
            return Promise.resolve([]);
        }
        if (this.resolving) {
            // The intervals are intentionally aligned (45s and 5s), so
            // dropping this tick would starve party formation indefinitely.
            // Let the scheduler launch it from its safe completion edge.
            this.partyFormationPending = true;
            return Promise.resolve([]);
        }

        this.partyFormationRunning = true;
        const startedAt = Date.now();
        const deadlineAt = startedAt + this.partyFormationBudgetMs();
        let budgetStopRecorded = false;
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            if (!budgetStopRecorded) {
                budgetStopRecorded = true;
                Metrics.recordPartyFormationBudgetStop();
            }
            return true;
        };
        const timedStage = (name, work) => {
            const stageStartedAt = Date.now();
            return Promise.resolve().then(work).finally(() => {
                Metrics.recordPartyFormationStage(name, Date.now() - stageStartedAt);
            });
        };
        const formationWork = () => {
            const timestamp = Date.now();
            const cleanupInterval = Math.max(5000, Number(Config.partyRequestCleanupIntervalMs) || 30000);
            const cleanup = timestamp >= this.nextPartyRequestCleanupAt
                ? LifeState.expireStalePartyRequests(Config.partyRequestCleanupBatchSize).catch((error) => {
                    utils.infoWarn('BotPopulation', 'party request cleanup failed: %s', error?.message || error);
                    return 0;
                }).finally(() => {
                    this.nextPartyRequestCleanupAt = Date.now() + cleanupInterval;
                })
                : Promise.resolve(0);
            return timedStage('cleanup', () => cleanup)
            // Extra capacity and eviction are reserved for actionable required
            // requests. The candidate query still includes preferred and
            // elective bots, but orders open requests ahead of the bounded
            // general pool so crowded solo grounds cannot starve them.
            .then(() => timedStage('candidate_count', () => LifeState.coldPartyCandidateCount(true)))
            .then((requiredPartyRequestCount) => timedStage('candidate_query', () => LifeState.coldPartyCandidates(Config.partyFormationCandidateLimit)
                .then((states) => ({ states, requiredPartyRequestCount }))
                .then(({ states, requiredPartyRequestCount }) => {
                    const activeParties = BackgroundPartyState.active();
                    const recruitSpots = activeParties
                        .filter((party) => (party.memberIds || []).length < Config.partyMaxSize)
                        .map((party) => party.spotId);
                    const fairCandidates = LifeState.coldPartyCandidatesForSpots(
                        recruitSpots,
                        Config.partyRecruitmentCandidateLimit,
                        false
                    );
                    return fairCandidates.then((spotCandidates) => {
                        const byId = new Map((states || []).map((state) => [Number(state.characterId), state]));
                        spotCandidates.forEach((state) => byId.set(Number(state.characterId), state));
                        const mergedStates = Array.from(byId.values());
                        return {
                            states: mergedStates,
                            partyRequestBacklog: mergedStates.some((state) => state.stats?.partyRequest?.status === 'open'),
                            requiredPartyRequestCount
                        };
                    });
                })))
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const willingStates = states.filter((state) => PersonaPartyPolicy.backgroundIntent(state).accept);
                const requiredStates = willingStates.filter((state) => (
                    state.stats?.partyRequest?.status === 'open'
                    && state.stats?.partyRequest?.priority === 'required'
                ));
                return this.reclaimBackgroundPartyCapacity(requiredStates, requiredPartyRequestCount, {
                    deadlineAt,
                    markBudgetStop: () => budgetReached()
                })
                    .then(() => this.recruitBackgroundMembers(willingStates, {
                        deadlineAt,
                        markBudgetStop: () => budgetReached()
                    })).then((recruitedIds) => ({
                    states: willingStates.filter((state) => !recruitedIds.has(Number(state.characterId))),
                    partyRequestBacklog,
                    requiredPartyRequestCount
                }));
            })
            .then(({ states, partyRequestBacklog, requiredPartyRequestCount }) => {
                const activeParties = BackgroundPartyState.counts().active || 0;
                const slots = Math.max(0, maxBackgroundPartiesForBacklog(requiredPartyRequestCount) - activeParties);
                if (slots <= 0) return [];
                const maxNewParties = Math.min(slots, Config.partyFormationBatchSize);
                const activePartiesBySpot = BackgroundPartyState.active().reduce((counts, party) => {
                    const spotId = String(party.spotId || '');
                    if (spotId) counts.set(spotId, Number(counts.get(spotId) || 0) + 1);
                    return counts;
                }, new Map());
                const groups = this.groupPartyCandidatesByObjective(states, { prioritizePartyWait: partyRequestBacklog, activePartiesBySpot });
                const created = [];

                return groups.reduce((chain, group) => chain.then(() => {
                    if (created.length >= maxNewParties || budgetReached()) return null;
                    if (group.length < Config.partyMinSize) return null;

                    const members = PartyComposition.selectMembers(group, {
                        minSize: Config.partyMinSize,
                        maxSize: Config.partyMaxSize
                    });
                    if (members.length < Config.partyMinSize) return null;

                    const leader = PartyComposition.chooseLeader(members);
                    const objectiveMember = members.find((member) => (
                        member.stats?.partyRequest?.status === 'open'
                        && member.stats?.partyRequest?.priority === 'required'
                    )) || members.find((member) => partyObjectiveForState(member)) || leader;
                    const objective = partyObjectiveForState(objectiveMember);
                    const partySpot = partySpotForLeader(leader, objective?.spotId || null);
                    const partyId = `bgp_${Date.now().toString(36)}_${leader.characterId}`;
                    const nextResolveAt = Date.now() + 45000 + Math.round(Math.random() * 90000);
                    const party = {
                        partyId,
                        leaderId: leader.characterId,
                        memberIds: members.map((state) => state.characterId),
                        spotId: partySpot?.id || leader.spotId,
                        startedAt: Date.now(),
                        nextResolveAt,
                        cohesion: 0.55 + Math.random() * 0.25,
                        risk: 0.18 + Math.random() * 0.22,
                        roleCoverage: PartyComposition.roleCoverage(members),
                        stats: {
                            formedAt: Date.now(),
                            memberNames: members.map((state) => state.name),
                            personaFormation: Object.fromEntries(members.map((member) => [
                                member.characterId,
                                PersonaPartyPolicy.explain(member, members.filter((peer) => peer !== member), PartyComposition.roleCoverage(members))
                            ])),
                            route: partySpot?.route || null,
                            objective: objective || null,
                            acquisitionGoal: objectiveMember.stats?.equipmentPlan?.status === 'active'
                                ? objectiveMember.stats.equipmentPlan
                                : null
                        }
                    };

                    return BackgroundPartyState.createOrUpdate(party).then((savedParty) => {
                        if (!savedParty) return null;

                        return members.reduce((memberChain, member) => (
                            memberChain.then(() => LifeState.assignParty(
                                member,
                                savedParty.partyId,
                                PartyComposition.roleForState(member),
                                savedParty.leaderId
                            ))
                        ), Promise.resolve()).then(() => LifeEvents.record(leader.characterId, 'party', `${leader.name} formed a party near ${party.spotId}`, {
                            partyId: savedParty.partyId,
                            spotId: savedParty.spotId,
                            memberIds: savedParty.memberIds,
                            route: party.stats.route
                        }, 2)).then(() => {
                            Metrics.recordPartyFormation();
                            created.push(savedParty);
                            console.info(
                                'BotPopulation :: formed background party %s spot=%s members=%d leader=%s',
                                savedParty.partyId,
                                savedParty.spotId || 'none',
                                savedParty.memberIds.length,
                                leader.name
                            );
                            return savedParty;
                        });
                    });
                }), Promise.resolve()).then(() => created);
            });
        };
        return Database.cooperatively(formationWork, Config.partyFormationSliceMs)
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background party formation failed: %s', err.message);
                return [];
            })
            .finally(() => {
                Metrics.recordPartyFormationDuration(Date.now() - startedAt);
                this.partyFormationRunning = false;
            });
    },

    groupPartyCandidatesBySpot(states = [], options = {}) {
        return groupBySpot(states, options);
    },

    partyFormationBudgetMs() {
        let players = 0;
        try {
            players = this.realPlayerSessions().length;
        } catch (err) {
            players = 0;
        }
        const configured = players > 0
            ? Config.partyFormationPlayerBudgetMs
            : Config.partyFormationIdleBudgetMs;
        return Math.max(50, Number(configured) || 500);
    },

    schedulerProfile() {
        let players = 0;
        try {
            players = this.realPlayerSessions().length;
        } catch (err) {
            // Keep the background scheduler usable in startup/test harnesses
            // where the world session registry is not available yet.
            players = 0;
        }
        const idle = players === 0;
        const lagMs = Math.max(0, Number(Metrics.currentEventLoopLag()) || 0);
        const configured = idle ? Config.schedulerIdleBudgetMs : Config.schedulerPlayerBudgetMs;
        const baseBudget = Math.max(25, Number(configured) || 250);
        const lagThrottle = Math.max(0, Number(Config.schedulerLagThrottleMs) || 0);
        const lagAbort = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        let budget = baseBudget;

        if (lagAbort > 0 && lagMs >= lagAbort) {
            budget = 0;
        } else if (lagAbort > lagThrottle && lagMs > lagThrottle) {
            const pressure = Math.min(1, (lagMs - lagThrottle) / (lagAbort - lagThrottle));
            budget = Math.round(baseBudget * (1 - pressure));
        }

        return {
            idle,
            players,
            lagMs,
            budgetMs: budget > 0
                ? Math.min(budget, Math.max(25, Config.schedulerIntervalMs - 25))
                : 0,
            maxResolvesPerTick: Math.max(1, Number(idle
                ? Config.schedulerIdleMaxResolvesPerTick
                : Config.schedulerPlayerMaxResolvesPerTick) || 25)
        };
    },

    schedulerBudgetMs() {
        return this.schedulerProfile().budgetMs;
    },

    groupPartyCandidatesByObjective(states = [], options = {}) {
        const grouped = new Map();
        (states || []).forEach((state) => {
            const key = partyObjectiveKeyForState(state);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(state);
        });
        return Array.from(grouped.entries())
            .map(([key, group]) => ({
                key,
                spotId: partyObjectiveSpotForState(group[0]),
                states: group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)),
                partyWaiters: group.filter((state) => state.activity === 'party_wait'
                    || state.stats?.partyRequest?.status === 'open').length
            }))
            .sort((a, b) => {
                if (options.prioritizePartyWait && a.partyWaiters !== b.partyWaiters) {
                    return b.partyWaiters - a.partyWaiters;
                }
                const aActive = Number(options.activePartiesBySpot?.get(a.spotId) || 0);
                const bActive = Number(options.activePartiesBySpot?.get(b.spotId) || 0);
                if (aActive !== bActive) return aActive - bActive;
                return b.states.length - a.states.length;
            })
            .map((group) => group.states);
    },

    maxBackgroundPartiesForBacklog,
    partySessionExpired,
    partyRequestForPlan,
    partyObjectiveForState,
    expirePartyRequestForState,

    refreshBackgroundPartyRequirements(parties = [], options = {}) {
        const timestamp = Date.now();
        const deadlineAt = Number(options.deadlineAt || Infinity);
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            options.markBudgetStop?.();
            return true;
        };
        const refreshMs = Math.max(1000, Number(Config.partyRequirementRefreshMs) || 5 * 60 * 1000);
        const batchSize = Math.max(1, Number(Config.partyRequirementRefreshBatchSize) || 8);
        const refreshable = (parties || [])
            .filter((party) => timestamp - Number(party.stats?.lastRequirementRefreshAt || 0) >= refreshMs)
            .sort((a, b) => Number(a.stats?.lastRequirementRefreshAt || 0) - Number(b.stats?.lastRequirementRefreshAt || 0))
            .slice(0, batchSize);
        if (!refreshable.length) return Promise.resolve([]);

        let spots = [];
        try {
            spots = SpotProfiles.ensure();
        } catch (err) {
            // Unit/integration harnesses may not load the world spot index;
            // keep the refresh best-effort and let the normal party resolver
            // retry it on the next formation pass.
            utils.infoWarn('BotPopulation', 'party requirement refresh spot index unavailable: %s', err.message);
            return Promise.resolve([]);
        }
        return statesForParties(refreshable.map((party) => party.partyId)).then((membersByParty) => refreshable.reduce((chain, party) => chain.then(async (refreshed) => {
            if (budgetReached()) return refreshed;
            const members = membersByParty.get(String(party.partyId)) || [];
            let changed = false;
            const refreshedPlans = new Map();
            for (const member of members) {
                if (budgetReached()) return refreshed;
                const previousPlan = member.stats?.equipmentPlan;
                let nextPlan;
                try {
                    nextPlan = GearAcquisitionPlanner.planFor(member, { spots });
                } catch (err) {
                    utils.infoWarn('BotPopulation', 'party requirement refresh failed for %s: %s', member.name, err.message);
                    continue;
                }
                refreshedPlans.set(Number(member.characterId), nextPlan);
                if (acquisitionRequirementKey(previousPlan) === acquisitionRequirementKey(nextPlan)) continue;
                const nextState = {
                    ...member,
                    stats: { ...(member.stats || {}), equipmentPlan: nextPlan }
                };
                const saved = await LifeState.upsertState(nextState, 'party_requirement_refresh');
                changed = changed || !!saved;
            }
            const refreshedMembers = members.map((member) => {
                const nextPlan = refreshedPlans.get(Number(member.characterId)) || member.stats?.equipmentPlan;
                return nextPlan ? { ...member, stats: { ...(member.stats || {}), equipmentPlan: nextPlan } } : member;
            });
            const releasable = party.stats?.objective?.priority === 'required'
                ? refreshedMembers.filter((member) => (
                    member.stats?.equipmentPlan?.partyNeed !== 'required'
                    && member.stats?.equipmentPlan?.requiresParty !== true
                ))
                : [];
            const departures = refreshedMembers.length - releasable.length >= Config.partyMinSize
                ? releasable
                : [];
            await departures.reduce((chain, member) => chain.then(() => (
                LifeState.leaveParty(member, 'party_objective_complete')
            )), Promise.resolve());
            const retainedMembers = refreshedMembers.filter((member) => (
                !departures.some((departure) => Number(departure.characterId) === Number(member.characterId))
            ));
            const objectiveMember = retainedMembers.find((member) => (
                member.stats?.equipmentPlan?.partyNeed === 'required'
            )) || retainedMembers.find((member) => partyObjectiveForState(member));
            const objective = objectiveMember ? partyObjectiveForState(objectiveMember) : null;
            await BackgroundPartyState.createOrUpdate({
                ...party,
                memberIds: retainedMembers.map((member) => member.characterId),
                roleCoverage: PartyComposition.roleCoverage(retainedMembers),
                spotId: objective?.spotId || party.spotId,
                stats: {
                    ...(party.stats || {}),
                    objective: objective || null,
                    acquisitionGoal: objectiveMember?.stats?.equipmentPlan?.status === 'active'
                        ? objectiveMember.stats.equipmentPlan
                        : null,
                    lastRequirementRefreshAt: timestamp
                }
            });
            return changed || departures.length ? [...refreshed, party.partyId] : refreshed;
        }), Promise.resolve([])));
    },

    reclaimBackgroundPartyCapacity(partyWaitStates = [], partyWaitCount = partyWaitStates.length, options = {}) {
        if (!partyWaitStates.length) return Promise.resolve([]);
        const activeParties = BackgroundPartyState.active();
        const availableSlots = Math.max(0, maxBackgroundPartiesForBacklog(partyWaitCount) - activeParties.length);
        const wantedSlots = Math.min(
            Config.partyFormationBatchSize,
            Math.floor(partyWaitStates.length / Math.max(1, Config.partyMinSize))
        );
        const reclaimCount = Math.max(0, wantedSlots - availableSlots);
        if (!reclaimCount || !activeParties.length) return Promise.resolve([]);

        return this.refreshBackgroundPartyRequirements(activeParties, options)
            .then(() => {
                if (Number(options.deadlineAt || Infinity) <= Date.now()) {
                    options.markBudgetStop?.();
                    return null;
                }
                return LifeState.partyRequirementCounts(activeParties.map((party) => party.partyId));
            })
            .then((counts) => {
                if (!counts) return [];
                const countByPartyId = new Map(counts.map((count) => [count.partyId, count]));
                return activeParties
                    .filter((party) => Number(countByPartyId.get(party.partyId)?.requiredMembers || 0) === 0)
                    .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0))
                    .slice(0, reclaimCount);
            })
            .then((parties) => parties.reduce((chain, party) => (
                chain.then((reclaimed) => dissolveBackgroundParty(party, 'party_capacity_reclaimed', party.memberIds?.length || 0)
                    .then(() => [...reclaimed, party]))
            ), Promise.resolve([])));
    },

    recruitBackgroundMembers(candidates = [], options = {}) {
        const deadlineAt = Number(options.deadlineAt || Infinity);
        const budgetReached = () => {
            if (Date.now() < deadlineAt) return false;
            options.markBudgetStop?.();
            return true;
        };
        const claimed = new Set();
        const parties = BackgroundPartyState.active()
            .filter((party) => (party.memberIds || []).length < Config.partyMaxSize)
            .sort((a, b) => (a.memberIds || []).length - (b.memberIds || []).length);

        return statesForParties(parties.map((party) => party.partyId)).then((membersByParty) => parties.reduce((chain, party) => chain.then(() => {
            if (budgetReached()) return null;
            const members = membersByParty.get(String(party.partyId)) || [];
                if (members.length < Config.partyMinSize) return null;
                const partyObjective = party.stats?.objective || null;
                const nearby = candidates.filter((state) => (
                    !claimed.has(Number(state.characterId))
                    && (partyObjective
                        ? (partyObjectiveKeyForState(state) === partyObjective.objectiveKey
                            || partyObjectivesShareRoute(partyObjective, partyObjectiveForState(state))
                            || (state.stats?.partyRequest?.priority !== 'required'
                                && partyObjectiveSpotForState(state) === partyObjective.spotId))
                        : state.spotId === party.spotId)
                ));
                const recruits = PartyComposition.selectRecruits(members, nearby, { maxSize: Config.partyMaxSize });
                if (!recruits.length) return null;

                return recruits.reduce((memberChain, recruit) => (
                    memberChain.then(() => LifeState.assignParty(
                        recruit,
                        party.partyId,
                        PartyComposition.roleForState(recruit),
                        party.leaderId
                    ))
                ), Promise.resolve()).then(() => {
                    recruits.forEach((recruit) => claimed.add(Number(recruit.characterId)));
                    const allMembers = [...members, ...recruits];
                    return BackgroundPartyState.createOrUpdate({
                        ...party,
                        memberIds: allMembers.map((member) => member.characterId),
                        roleCoverage: PartyComposition.roleCoverage(allMembers),
                        stats: {
                            ...(party.stats || {}),
                            memberNames: allMembers.map((member) => member.name),
                            lastRecruitAt: Date.now()
                        }
                    }).then((updatedParty) => LifeEvents.record(party.leaderId, 'party_recruit', `${members[0].name} recruited ${recruits.map((recruit) => recruit.name).join(', ')} near ${party.spotId}`, {
                        partyId: party.partyId,
                        recruitIds: recruits.map((recruit) => recruit.characterId),
                        spotId: party.spotId
                    }, 1).then(() => {
                        Metrics.recordPartyRecruit(recruits.length);
                        console.info('BotPopulation :: recruited %d bot(s) into %s near %s', recruits.length, party.partyId, party.spotId || 'none');
                        return updatedParty;
                    }));
                });
            }), Promise.resolve())).then(() => claimed);
    },

    tickBudgeted() {
        if (this.resolving || this.partyFormationRunning || this.classProgressionMigrationRunning || this.coldCombatProfileMigrationRunning || Config.enabled === false || Config.backgroundResolverEnabled === false) {
            if (this.resolving || this.partyFormationRunning || this.classProgressionMigrationRunning || this.coldCombatProfileMigrationRunning) {
                Metrics.recordSchedulerSkip();
            }
            return Promise.resolve([]);
        }

        const startedAt = Date.now();
        const profile = this.schedulerProfile();
        Metrics.recordSchedulerProfile(profile);
        const budgetMs = profile.budgetMs;
        if (budgetMs <= 0) {
            Metrics.recordSchedulerBudgetStop();
            return Promise.resolve([]);
        }
        const deadlineAt = startedAt + budgetMs;
        this.resolving = true;
        return Database.cooperatively(() => this.resolveDueParties(deadlineAt)
            .then(() => this.reconcileMarketGoals(deadlineAt))
            .then(() => LifeState.dueCold(profile.maxResolvesPerTick))
            .then((states) => {
                Metrics.recordColdBatch(states.length, profile.maxResolvesPerTick);
                return this.runInSchedulerSlices(states, (state) => this.resolveColdState(state)
                .catch((error) => {
                    // A single bot may lose a race with a market or
                    // craft transaction. It must not abort every
                    // remaining cold resolve in this scheduler tick.
                    utils.infoWarn('BotPopulation', 'cold resolve failed for %s: %s', state.name, error?.message || error);
                    Metrics.recordSkippedResolve('cold_resolve_rejected');
                    return { ok: false, reason: 'resolve_rejected', state };
                }), deadlineAt);
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background scheduler failed: %s', err.message);
                return [];
            })
            .finally(() => {
                const elapsedMs = Date.now() - startedAt;
                Metrics.recordSchedulerRun(elapsedMs);
                if (elapsedMs >= Config.schedulerIntervalMs) {
                    utils.infoWarn(
                        'BotPopulation',
                        'background scheduler overran interval: %dms >= %dms',
                        elapsedMs,
                        Config.schedulerIntervalMs
                    );
                }
                this.resolving = false;
                this.maybeExpireStaleMarketStores();
                // The scheduler is known to run throughout normal operation;
                // use its post-resolve edge as a reliable fallback for the
                // bounded legacy-store transition timer.
                this.maybeMigrateLegacyMarketTowns();
                // Keep the bounded profile migration outside the active
                // scheduler slot. An independent timer can otherwise make a
                // normal five-second tick look busy and skip its resolves.
                this.maybeMigrateLegacyColdCombatProfiles();
                if (this.partyFormationPending) {
                    this.partyFormationPending = false;
                    this.formBackgroundParties();
                }
            }));
    },

    resolveDueParties(deadlineAt = Infinity) {
        if (Config.backgroundPartyEnabled === false) return Promise.resolve([]);

        return BackgroundPartyState.due(Config.maxPartyResolvesPerTick)
            .then((parties) => this.runInSchedulerSlices(parties, (party) => this.resolveBackgroundParty(party), deadlineAt));
    },

    reconcileMarketGoals(deadlineAt = Infinity) {
        return LifeState.marketGoalCandidates(Config.maxMarketGoalReconcilesPerTick)
            .then((states) => this.runInSchedulerSlices(states, (state) => {
                    const spot = SpotProfiles.findForState(state);
                    return GoalService.review(state, { spot }).then((goalSnapshot) => {
                        const travel = GoalExecutor.beginMarketTravel(state, goalSnapshot?.current);
                        if (!travel) return null;
                        return LifeState.upsertState(travel, 'reconciled_market_travel').then((saved) => {
                            if (saved) {
                                console.info('BotPopulation :: reconciled market travel for %s', state.name);
                            }
                            return saved;
                        });
                    });
                }, deadlineAt).then((results) => results.filter(Boolean)))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'market-goal reconcile failed: %s', err.message);
                return [];
            });
    },

    yieldSchedulerSlice(sliceStartedAt) {
        Metrics.recordSchedulerYield(Date.now() - sliceStartedAt);
        return new Promise((resolve) => setImmediate(resolve));
    },

    async runInSchedulerSlices(items, work, deadlineAt = Infinity) {
        const results = [];
        let sliceStartedAt = Date.now();
        const sliceMs = Math.max(1, Number(Config.schedulerSliceMs) || 12);

        for (const item of items || []) {
            if (Date.now() >= deadlineAt) {
                Metrics.recordSchedulerBudgetStop();
                break;
            }
            results.push(await work(item));
            if (Date.now() >= deadlineAt) {
                Metrics.recordSchedulerBudgetStop();
                break;
            }
            if (Date.now() - sliceStartedAt >= sliceMs) {
                await this.yieldSchedulerSlice(sliceStartedAt);
                sliceStartedAt = Date.now();
            }
        }

        return results;
    },

    resolveBackgroundParty(party) {
        const startedAt = Date.now();
        if (partySessionExpired(party, startedAt)) {
            return dissolveBackgroundParty(party, 'party_session_rotation', party.memberIds?.length || 0);
        }
        return LifeState.statesForParty(party.partyId).then((members) => {
            if (members.length < Config.partyMinSize) {
                const recordedIds = new Set((party.memberIds || []).map(Number));
                const reason = recordedIds.size !== members.length ? 'state_mismatch' : 'too_few_members';
                return dissolveBackgroundParty(party, reason, members.length);
            }

            const leader = members.find((state) => state.characterId === party.leaderId) || members[0];
            const objectiveSpotId = party.stats?.objective?.spotId || null;
            const objectiveSpot = objectiveSpotId ? SpotProfiles.findById(objectiveSpotId) : null;
            const spot = objectiveSpot || SpotProfiles.findForState({
                ...leader,
                spotId: party.spotId,
                party: {
                    ...(leader.party || {}),
                    partyId: party.partyId,
                    role: PartyComposition.roleForState(leader)
                },
                stats: {
                    ...(leader.stats || {}),
                    routeMode: 'party'
                }
            }, { mode: 'party', role: PartyComposition.roleForState(leader) }) || SpotProfiles.findForState(leader);
            if (!spot) {
                Metrics.recordSkippedResolve('party_missing_spot');
                return { ok: false, reason: 'missing_spot', party };
            }

            const elapsedMs = party.stats?.lastResolveAt ? Math.max(1000, Date.now() - party.stats.lastResolveAt) : 60000;
            const targetNpcId = partyTargetNpcId(party, leader);
            const result = BackgroundPartyResolver.resolve({
                party,
                members,
                spot,
                pressure: Director.pressureForState(leader),
                targetNpcId,
                elapsedMs
            });
            const deadMemberIds = new Set();

            return result.memberResults.reduce((chain, memberResult) => (
                chain.then((resolvedMembers) => LifeState.applyResolve(memberResult.state, memberResult.result)
                    .then((updated) => updated ? [...resolvedMembers, updated] : resolvedMembers))
            ), Promise.resolve([])).then((resolvedMembers) => {
                const deadMembers = resolvedMembers.filter((member) => member.activity === 'dead');
                deadMembers.forEach((member) => deadMemberIds.add(Number(member.characterId)));
                return deadMembers.reduce((chain, member) => (
                    chain.then(() => LifeState.leaveParty(member, 'death'))
                ), Promise.resolve()).then(() => resolvedMembers.filter((member) => member.activity !== 'dead'));
            }).then((resolvedMembers) => {
                let breakTaken = false;
                return resolvedMembers.reduce((chain, member) => (
                chain.then((activeMembers) => GoalService.review(member, { spot }).then((goalSnapshot) => {
                    if (breakTaken || !canTakePartyMarketBreak(party, resolvedMembers, member)) {
                        return [...activeMembers, member];
                    }
                    const travel = GoalExecutor.beginMarketTravel(member, goalSnapshot?.current);
                    if (!travel) return [...activeMembers, member];
                    return LifeState.leaveParty(travel, 'market_break').then((departed) => {
                        if (departed) breakTaken = true;
                        return departed ? activeMembers : [...activeMembers, member];
                    });
                }))
                ), Promise.resolve([]));
            }).then((activeMembers) => {
                if (activeMembers.length < Config.partyMinSize) {
                    const reason = deadMemberIds.size > 0 ? 'death' : 'market_break';
                    return dissolveBackgroundParty(party, reason, activeMembers.length);
                }
                return BackgroundPartyState.createOrUpdate({
                ...party,
                leaderId: (activeMembers.find((member) => member.characterId === party.leaderId) || PartyComposition.chooseLeader(activeMembers) || {}).characterId || party.leaderId,
                memberIds: activeMembers.map((member) => member.characterId),
                spotId: spot.id,
                nextResolveAt: result.nextResolveAt,
                cohesion: result.partyPatch.cohesion,
                risk: result.partyPatch.risk,
                roleCoverage: PartyComposition.roleCoverage(activeMembers),
                stats: {
                    ...(party.stats || {}),
                    ...(result.partyPatch.stats || {}),
                    lastMarketBreakAt: activeMembers.length < members.length ? Date.now() : party.stats?.lastMarketBreakAt || null,
                    route: spot.route || party.stats?.route || null
                }
                });
            }).then((updatedParty) => {
                Metrics.recordPartyResolve();
                Metrics.recordCombat(result.debug);
                const recruitment = PartyRecruitmentChat.maybeAnnounce(updatedParty, members, spot);
                const persistedParty = recruitment.announced
                    ? BackgroundPartyState.createOrUpdate(recruitment.party)
                    : Promise.resolve(updatedParty);
                return persistedParty.then((savedParty) => ({ party: savedParty || updatedParty, recruitment }));
            }).then(({ party: updatedParty }) => {
                return Promise.all(result.events.map((event) => (
                    LifeEvents.record(event.characterId || party.leaderId, event.type, event.summary, event.meta, event.weight)
                ))).then(() => ({
                    ok: true,
                    party: updatedParty,
                    debug: result.debug
                })).then((resolved) => {
                    GlobalChat.maybeAnnounce(leader, result.events);
                    return resolved;
                });
            });
        }).catch((err) => {
            utils.infoWarn('BotPopulation', 'background party resolve failed for %s: %s', party.partyId, err.message);
            Metrics.recordSkippedResolve('party_resolve_failed');
            return { ok: false, reason: 'resolve_failed', party };
        }).finally(() => {
            Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    resolveColdState(state) {
        const startedAt = Date.now();
        if (joinedBackgroundParty(state)) {
            Metrics.recordSkippedResolve('joined_party_before_resolve');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }
        const elapsedMs = state.timing?.lastResolvedAt ? Math.max(1000, startedAt - state.timing.lastResolvedAt) : 60000;
        // These transitions have no planning, market search, or inventory work
        // between their persisted deadline and the next state change.
        if (state.activity === 'traveling' || (state.activity === 'resting' && Number(state.stats?.restUntil || 0) > 0)) {
            const requestLifecycleState = expirePartyRequestForState(state, startedAt);
            const result = BackgroundResolver.resolveSolo({
                state: requestLifecycleState,
                spot: null,
                pressure: Director.pressureForState(state),
                elapsedMs,
                timestamp: startedAt
            });
            if (joinedBackgroundParty(state)) {
                Metrics.recordSkippedResolve('joined_party_during_transition');
                return Promise.resolve({ ok: false, reason: 'joined_party', state });
            }
            return LifeState.applyResolve(requestLifecycleState, result).then((updatedState) => {
                if (!updatedState) {
                    Metrics.recordSkippedResolve('transition_apply_failed');
                    return { ok: false, reason: 'apply_failed', state };
                }
                Metrics.recordBackgroundResolve();
                Metrics.recordCombat(result.debug);
                return LifeEvents.recordMany(state.characterId, result.events).then(() => ({
                    ok: true,
                    state: updatedState,
                    debug: result.debug
                }));
            }).finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        if (GearAcquisitionPlanner.isCraftService(state)) {
            const { equipmentPlan, ...serviceStats } = state.stats || {};
            const serviceState = {
                ...state,
                timing: { ...(state.timing || {}), nextResolveAt: null },
                stats: serviceStats
            };
            return LifeState.upsertState(serviceState, 'craft_service_idle')
                .then((saved) => ({ ok: true, state: saved || serviceState, debug: { activity: 'craft_service_idle' } }))
                .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        const staleShopping = state?.activity === 'shopping'
            && !state.stats?.marketReturn
            && state.currentRegion !== 'Giran';
        const passiveActivity = ['traveling', 'shopping', 'merchant', 'crafting', 'dead'].includes(state?.activity) && !staleShopping;
        const previousPlan = state.stats?.equipmentPlan;
        // A travelling bot does not fight at a spot during this resolve, but its
        // gear plan still needs the complete atlas.  Passing [] here turned every
        // in-progress craft route into `blocked` on its first travel tick.
        const spots = SpotProfiles.ensure();
        const reusablePartyRequest = !state.party?.partyId
            && previousPlan?.next
            && state.stats?.partyRequest?.status === 'open'
            && Number(state.stats.partyRequest.reviewAt || 0) > startedAt;
        const upgradedPlan = reusablePartyRequest
            ? previousPlan
            : GearAcquisitionPlanner.planFor(state, { spots });
        const previousRefresh = previousPlan?.recipeId
            && !reusablePartyRequest
            ? GearAcquisitionPlanner.planFor(state, { spots, recipeId: previousPlan.recipeId })
            : null;
        const rawAcquisitionPlan = GearAcquisitionPlanner.shouldFinishPreviousPlan(previousPlan, previousRefresh)
            ? { ...previousRefresh, finishBeforeUpgrade: true }
            : upgradedPlan;
        const sameTarget = Number(previousPlan?.target?.selfId || 0) === Number(rawAcquisitionPlan.target?.selfId || 0);
        const planStartedAt = sameTarget ? Number(previousPlan?.startedAt || startedAt) : startedAt;
        const acquisitionPlan = {
            ...rawAcquisitionPlan,
            startedAt: planStartedAt,
            marketFallback: rawAcquisitionPlan.status === 'active' && rawAcquisitionPlan.strategy === 'craft'
                && planStartedAt + 20 * 60 * 1000 <= Date.now()
        };
        const partyRequest = partyRequestForPlan(state, acquisitionPlan, startedAt);
        const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
        if (partyRequest) plannedStats.partyRequest = partyRequest;
        else delete plannedStats.partyRequest;
        const plannedState = {
            ...state,
            stats: plannedStats
        };
        const planEvents = CraftTelemetry.planEvents(state, previousPlan, acquisitionPlan);
        if (plannedState.activity === 'crafting') {
            return ColdCraftingService.craft(plannedState).then((craft) => {
                const completed = craft.reason === 'crafted' || craft.reason === 'component_crafted';
                const reason = craft.reason === 'component_crafted'
                    ? 'cold_component_craft_complete'
                    : craft.reason === 'crafted' ? 'cold_craft_complete' : 'cold_craft_wait';
                // A persisted plan can say ready_to_craft even when an earlier
                // component craft consumed the raw inputs for the next batch,
                // or a station may be temporarily unavailable. Do not pin the
                // bot at a station: re-enter hunting so the acquisition planner
                // can select the missing material again.
                const recoveredState = !completed
                    ? {
                        ...(craft.state || plannedState),
                        activity: 'hunting',
                        stats: {
                            ...((craft.state || plannedState).stats || {}),
                            travel: null
                        },
                        timing: {
                            ...((craft.state || plannedState).timing || {}),
                            nextResolveAt: Date.now() + 30000
                        }
                    }
                    : craft.state || plannedState;
                return LifeState.upsertState(recoveredState, reason).then((saved) => {
                    const supplemented = craft.supplementedMaterials || [];
                    const supplyEvent = supplemented.length
                        ? LifeEvents.record(state.characterId, 'craft_supplemented', `${state.name} received ${supplemented.map((item) => `${item.amount} ${item.name}`).join(', ')} for crafting`, {
                            recipeId: craft.recipeId,
                            materials: supplemented
                        }, 2)
                        : Promise.resolve(null);
                    if (!completed) return supplyEvent.then(() => ({ ok: true, state: saved || craft.state || plannedState, debug: craft }));
                    const eventType = craft.reason === 'component_crafted' ? 'component_craft' : 'equipment_craft';
                    const quantity = Math.max(1, Number(craft.batchCount || 1));
                    const summary = `${state.name} crafted ${quantity > 1 ? `${quantity}x ` : ''}${craft.productName} at ${craft.stationId}`;
                    return supplyEvent.then(() => LifeEvents.record(state.characterId, eventType, summary, {
                        recipeId: craft.recipeId,
                        productId: craft.productId,
                        stationId: craft.stationId
                    }, craft.reason === 'crafted' ? 3 : 2)).then(() => (
                        { ok: true, state: saved || craft.state || plannedState, debug: craft }
                    ));
                });
            })
                .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
        const requiredPartyRequest = partyRequest?.priority === 'required';
        const partyFallback = requiredPartyRequest && !passiveActivity
            ? GearAcquisitionPlanner.safeFallbackForPlan(state, acquisitionPlan, spots)
            : null;
        const fallbackSpot = requiredPartyRequest && !passiveActivity
            ? (partyFallback && SpotProfiles.findById(partyFallback.spotId)) || SpotProfiles.findForState({
                ...plannedState,
                spotId: null,
                stats: Object.fromEntries(Object.entries(plannedState.stats || {})
                    .filter(([key]) => key !== 'equipmentPlan'))
            })
            : null;
        const routedState = fallbackSpot
            ? { ...plannedState, activity: 'hunting', spotId: fallbackSpot.id }
            : plannedState;
        const currentSpotId = plannedState.spotId || null;
        const travellingState = ColdCraftingService.beginTravel(routedState) || routedState;
        const travel = travellingState.stats?.travel;
        const travelEvents = travellingState !== plannedState && travel?.stationId
            ? [CraftTelemetry.stationTravelEvent(plannedState, travel)]
            : [];
        const selectedSpot = passiveActivity
            ? null
            : fallbackSpot || SpotProfiles.findForState(travellingState);
        const huntingTravelState = selectedSpot && !passiveActivity
            ? beginHuntingTravel(travellingState, selectedSpot, startedAt, { currentSpotId })
            : null;
        const effectiveState = huntingTravelState || travellingState;
        const spot = effectiveState.activity === 'traveling' ? null : selectedSpot;
        if (!spot && !passiveActivity && effectiveState.activity !== 'traveling') {
            Metrics.recordSkippedResolve('missing_spot');
            Metrics.recordResolveDuration(Date.now() - startedAt);
            return Promise.resolve({ ok: false, reason: 'missing_spot', state });
        }

        const result = BackgroundResolver.resolveSolo({
            state: effectiveState,
            spot,
            pressure: Director.pressureForState(state),
            targetNpcId: requiredPartyRequest
                ? Number(partyFallback?.npcId || 0)
                : directDropTargetNpcId(acquisitionPlan),
            elapsedMs
        });

        if (joinedBackgroundParty(state)) {
            Metrics.recordSkippedResolve('joined_party_after_planning');
            return Promise.resolve({ ok: false, reason: 'joined_party', state });
        }

        return LifeState.applyResolve(effectiveState, result)
            .then((updatedState) => {
            if (!updatedState) {
                Metrics.recordSkippedResolve('cold_apply_failed');
                return { ok: false, reason: 'apply_failed', state };
            }

            Metrics.recordBackgroundResolve();
            Metrics.recordCombat(result.debug);
            if (updatedState.activity === 'crafting') {
                return { ok: true, state: updatedState, debug: result.debug };
            }
            return ColdMarketListingService.reconcileInventory(updatedState)
                .then((inventoryLifecycle) => ColdMarketListingService.resolve(inventoryLifecycle.state))
                .then((marketLifecycle) => {
                    const completedSale = marketLifecycle.closed && marketLifecycle.reason === 'sold_out';
                    const goalReady = completedSale
                        ? GoalService.complete(marketLifecycle.state.characterId)
                        : Promise.resolve(null);
                    return goalReady.then(() => marketLifecycle);
                }).then((marketLifecycle) => GoalService.current(marketLifecycle.state.characterId)
                    .then((goalSnapshot) => ColdMarketService.tryPurchase(marketLifecycle.state, goalSnapshot?.current)
                        .then((marketResult) => ({ marketLifecycle, marketResult, goal: goalSnapshot?.current || null }))))
                .then(({ marketLifecycle, marketResult, goal }) => {
                    const purchasedState = marketResult.state || marketLifecycle.state || updatedState;
                    const shouldOpenListing = marketResult.purchased || (!marketLifecycle.closed && goal?.type === 'sell_inventory');
                    const listingPromise = shouldOpenListing
                        ? ColdMarketListingService.open(purchasedState)
                        : Promise.resolve({ state: purchasedState, listed: false });
                    const marketStatePromise = listingPromise.then((listingResult) => {
                        const listingState = listingResult.state || purchasedState;
                        if (listingState.activity === 'merchant') return listingState;
                        if (listingResult.listed) return listingState;
                        const returnState = GoalExecutor.finishMarketVisit(listingState);
                        return returnState
                            ? LifeState.upsertState(returnState, 'market_visit_complete').then((saved) => saved || returnState)
                            : listingState;
                    });
                    return marketStatePromise.then((persistedState) => persistedState || purchasedState)
                        .then((marketState) => ColdMarketTradeChat.maybeAnnounce(marketState).then((result) => result.state || marketState))
                        .then((marketState) => GoalService.review(marketState, { spot }).catch((err) => {
                        utils.infoWarn('BotGoals', 'goal review failed for %s: %s', marketState.name, err.message);
                        return null;
                    }).then((goalSnapshot) => {
                        const travelState = GoalExecutor.beginMarketTravel(marketState, goalSnapshot?.current);
                        return travelState ? LifeState.upsertState(travelState, 'goal_market_travel') : marketState;
                    }));
                }).then((finalState) => {
                    const craftEvents = CraftTelemetry.progressEvents(state, acquisitionPlan, updatedState);
                    return LifeEvents.recordMany(state.characterId, [...planEvents, ...travelEvents, ...result.events, ...craftEvents])
                        .then(() => finalState);
                })
                .then((finalState) => {
                    GlobalChat.maybeAnnounce(finalState, result.events);
                    return {
                        ok: true,
                        state: finalState,
                        debug: result.debug
                    };
                });
        }).finally(() => {
            Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    summary() {
        return Status.summary();
    },

    logSummary(reason = 'summary') {
        const summary = this.summary();
        console.info('BotPopulation :: %s %s', reason, summary.line);
        return summary;
    }
};

module.exports = PopulationService;

const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
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

function groupBySpot(states) {
    const grouped = new Map();
    states.forEach((state) => {
        const planSpotId = state.stats?.equipmentPlan?.status === 'active'
            ? state.stats.equipmentPlan.next?.spotId
            : null;
        const spotId = planSpotId || state.spotId;
        if (!spotId) return;
        if (!grouped.has(spotId)) grouped.set(spotId, []);
        grouped.get(spotId).push(state);
    });

    return Array.from(grouped.values())
        .map((group) => group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)))
        .sort((a, b) => {
            const aPlanned = a.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            const bPlanned = b.filter((state) => state.stats?.equipmentPlan?.status === 'active').length;
            return bPlanned - aPlanned || b.length - a.length;
        });
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
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    partyFormationTimer: null,
    phasePolicyTimer: null,
    seedTimer: null,
    resolving: false,
    partyFormationRunning: false,
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
        Director.stop();
        Metrics.stopEventLoopMonitor();
        this.started = false;
    },

    scheduleGeneratedColdSeed(delayMs = Config.generatedColdSeedDelayMs) {
        if (Config.enabled === false || Config.generatedColdTarget <= 0 || this.seedTimer) return;

        this.seedTimer = setTimeout(() => {
            this.seedTimer = null;
            GeneratedColdSeeder.seedToTarget(Config.generatedColdTarget).then((result) => {
                if (result.seeded > 0) {
                    console.info(
                        'BotPopulation :: generated cold seed seeded=%d created=%d total=%d target=%d',
                        result.seeded,
                        result.created,
                        result.total,
                        result.desired
                    );
                }

                if (this.started && result.desired > 0 && result.total < result.desired && !result.error) {
                    this.scheduleGeneratedColdSeed(Config.generatedColdSeedDelayMs);
                }
            });
        }, Math.max(1000, Number(delayMs || 0)));

        if (typeof this.seedTimer.unref === 'function') {
            this.seedTimer.unref();
        }
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
                        const available = states.filter((state) => !['pk_hunting', 'traveling'].includes(state.activity));
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
        if (this.partyFormationRunning || Config.enabled === false || Config.backgroundPartyEnabled === false) {
            return Promise.resolve([]);
        }

        this.partyFormationRunning = true;
        return LifeState.coldPartyCandidates(Config.partyFormationCandidateLimit)
            .then((states) => this.recruitBackgroundMembers(states).then((recruitedIds) => ({
                states: states.filter((state) => !recruitedIds.has(Number(state.characterId)))
            })))
            .then(({ states }) => {
                const activeParties = BackgroundPartyState.counts().active || 0;
                const slots = Math.max(0, Config.maxBackgroundParties - activeParties);
                if (slots <= 0) return [];
                const maxNewParties = Math.min(slots, Config.partyFormationBatchSize);
                const groups = groupBySpot(states);
                const created = [];

                return groups.reduce((chain, group) => chain.then(() => {
                    if (created.length >= maxNewParties) return null;
                    if (group.length < Config.partyMinSize) return null;

                    const members = PartyComposition.selectMembers(group, {
                        minSize: Config.partyMinSize,
                        maxSize: Config.partyMaxSize
                    });
                    if (members.length < Config.partyMinSize) return null;

                    const leader = PartyComposition.chooseLeader(members);
                    const partySpot = SpotProfiles.findForState({
                        ...leader,
                        spotId: null,
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
                            route: partySpot?.route || null,
                            acquisitionGoal: leader.stats?.equipmentPlan?.status === 'active'
                                ? leader.stats.equipmentPlan
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
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background party formation failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.partyFormationRunning = false;
            });
    },

    recruitBackgroundMembers(candidates = []) {
        const claimed = new Set();
        const parties = BackgroundPartyState.active()
            .filter((party) => (party.memberIds || []).length < Config.partyMaxSize)
            .sort((a, b) => (a.memberIds || []).length - (b.memberIds || []).length);

        return parties.reduce((chain, party) => chain.then(() => LifeState.statesForParty(party.partyId)
            .then((members) => {
                if (members.length < Config.partyMinSize) return null;
                const nearby = candidates.filter((state) => (
                    !claimed.has(Number(state.characterId)) &&
                    state.spotId === party.spotId
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
            })), Promise.resolve()).then(() => claimed);
    },

    tickBudgeted() {
        if (this.resolving || Config.enabled === false || Config.backgroundResolverEnabled === false) {
            if (this.resolving) {
                Metrics.recordSchedulerSkip();
            }
            return Promise.resolve([]);
        }

        const startedAt = Date.now();
        this.resolving = true;
        return this.resolveDueParties()
            .then(() => this.reconcileMarketGoals())
            .then(() => LifeState.dueCold(Config.maxResolvesPerTick))
            .then((states) => {
                if (states.length === 0) return [];
                return states.reduce((chain, state) => (
                    chain.then((results) => this.resolveColdState(state)
                        .then((result) => {
                            results.push(result);
                            return results;
                        })
                        .catch((error) => {
                            // A single bot may lose a race with a market or
                            // craft transaction. It must not abort every
                            // remaining cold resolve in this scheduler tick.
                            utils.infoWarn('BotPopulation', 'cold resolve failed for %s: %s', state.name, error?.message || error);
                            Metrics.recordSkippedResolve();
                            results.push({ ok: false, reason: 'resolve_rejected', state });
                            return results;
                        }))
                ), Promise.resolve([]));
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
            });
    },

    resolveDueParties() {
        if (Config.backgroundPartyEnabled === false) return Promise.resolve([]);

        return BackgroundPartyState.due(Config.maxPartyResolvesPerTick)
            .then((parties) => {
                if (parties.length === 0) return [];
                return parties.reduce((chain, party) => (
                    chain.then((results) => this.resolveBackgroundParty(party).then((result) => {
                        results.push(result);
                        return results;
                    }))
                ), Promise.resolve([]));
            });
    },

    reconcileMarketGoals() {
        return LifeState.marketGoalCandidates(Config.maxMarketGoalReconcilesPerTick)
            .then((states) => states.reduce(
                (chain, state) => chain.then((results) => {
                    const spot = SpotProfiles.findForState(state);
                    return GoalService.review(state, { spot }).then((goalSnapshot) => {
                        const travel = GoalExecutor.beginMarketTravel(state, goalSnapshot?.current);
                        if (!travel) return results;
                        return LifeState.upsertState(travel, 'reconciled_market_travel').then((saved) => {
                            if (saved) {
                                console.info('BotPopulation :: reconciled market travel for %s', state.name);
                                results.push(saved);
                            }
                            return results;
                        });
                    });
                }),
                Promise.resolve([])
            ))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'market-goal reconcile failed: %s', err.message);
                return [];
            });
    },

    resolveBackgroundParty(party) {
        const startedAt = Date.now();
        return LifeState.statesForParty(party.partyId).then((members) => {
            if (members.length < Config.partyMinSize) {
                const recordedIds = new Set((party.memberIds || []).map(Number));
                const reason = recordedIds.size !== members.length ? 'state_mismatch' : 'too_few_members';
                return dissolveBackgroundParty(party, reason, members.length);
            }

            const leader = members.find((state) => state.characterId === party.leaderId) || members[0];
            const spot = SpotProfiles.findForState({
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
                Metrics.recordSkippedResolve();
                return { ok: false, reason: 'missing_spot', party };
            }

            const elapsedMs = party.stats?.lastResolveAt ? Math.max(1000, Date.now() - party.stats.lastResolveAt) : 60000;
            const result = BackgroundPartyResolver.resolve({
                party,
                members,
                spot,
                pressure: Director.pressureForState(leader),
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
            Metrics.recordSkippedResolve();
            return { ok: false, reason: 'resolve_failed', party };
        }).finally(() => {
            Metrics.recordResolveDuration(Date.now() - startedAt);
        });
    },

    resolveColdState(state) {
        const startedAt = Date.now();
        if (GearAcquisitionPlanner.isCraftService(state)) {
            const { equipmentPlan, ...serviceStats } = state.stats || {};
            const serviceState = {
                ...state,
                timing: { ...(state.timing || {}), nextResolveAt: Date.now() + 60000 },
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
        const upgradedPlan = GearAcquisitionPlanner.planFor(state, { spots });
        const previousRefresh = previousPlan?.recipeId
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
        const plannedState = {
            ...state,
            stats: { ...(state.stats || {}), equipmentPlan: acquisitionPlan }
        };
        const planEvents = CraftTelemetry.planEvents(state, previousPlan, acquisitionPlan);
        if (acquisitionPlan.requiresParty && !state.party?.partyId) {
            const partyWaitState = {
                ...plannedState,
                activity: 'resting',
                spotId: acquisitionPlan.next?.spotId || state.spotId,
                timing: { ...(state.timing || {}), nextResolveAt: Date.now() + 30000 }
            };
            return LifeState.upsertState(partyWaitState, 'acquisition_party_wait')
                .then((saved) => Promise.all(planEvents.map((event) => (
                    LifeEvents.record(state.characterId, event.type, event.summary, event.meta, event.weight)
                ))).then(() => ({
                    ok: true,
                    state: saved || partyWaitState,
                    debug: { activity: 'acquisition_party_wait', next: acquisitionPlan.next }
                })))
                .finally(() => Metrics.recordResolveDuration(Date.now() - startedAt));
        }
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
        const travellingState = ColdCraftingService.beginTravel(plannedState) || plannedState;
        const travelEvents = travellingState !== plannedState
            ? [CraftTelemetry.stationTravelEvent(plannedState, travellingState.stats?.travel)]
            : [];
        const spot = passiveActivity ? null : SpotProfiles.findForState(travellingState);
        if (!spot && !passiveActivity) {
            Metrics.recordSkippedResolve();
            Metrics.recordResolveDuration(Date.now() - startedAt);
            return Promise.resolve({ ok: false, reason: 'missing_spot', state });
        }

        const elapsedMs = state.timing?.lastResolvedAt ? Math.max(1000, Date.now() - state.timing.lastResolvedAt) : 60000;
        const result = BackgroundResolver.resolveSolo({
            state: travellingState,
            spot,
            pressure: Director.pressureForState(state),
            elapsedMs
        });

        return LifeState.applyResolve(travellingState, result).then((updatedState) => LifeState.refreshInventory(updatedState)
            .then((refreshedState) => LifeState.upsertState(refreshedState, 'inventory_refresh').then((saved) => saved || refreshedState)))
            .then((updatedState) => {
            if (!updatedState) {
                Metrics.recordSkippedResolve();
                return { ok: false, reason: 'apply_failed', state };
            }

            Metrics.recordBackgroundResolve();
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

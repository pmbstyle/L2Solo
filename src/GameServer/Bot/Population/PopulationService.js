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

function roleForState(state) {
    return state?.party?.role || state?.stats?.role || 'dps';
}

function roleCoverage(states) {
    return states.reduce((coverage, state) => {
        const role = roleForState(state);
        coverage[role] = (coverage[role] || 0) + 1;
        return coverage;
    }, {});
}

function groupBySpot(states) {
    const grouped = new Map();
    states.forEach((state) => {
        if (!state.spotId) return;
        if (!grouped.has(state.spotId)) grouped.set(state.spotId, []);
        grouped.get(state.spotId).push(state);
    });

    return Array.from(grouped.values())
        .map((group) => group.sort((a, b) => Number(a.level || 1) - Number(b.level || 1)))
        .sort((a, b) => b.length - a.length);
}

function chooseLeader(members) {
    return members.reduce((best, state) => {
        if (!best || Number(state.level || 1) > Number(best.level || 1)) return state;
        return best;
    }, null);
}

const PopulationService = {
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    partyFormationTimer: null,
    phasePolicyTimer: null,
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
        Director.stop();
        Metrics.stopEventLoopMonitor();
        this.started = false;
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

    cooldownSession(session, reason = 'manual') {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return Cooldown.cooldown(session, reason);
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

        const activated = [];
        let restingPresented = 0;
        let chain = Promise.resolve();

        players.forEach((playerSession) => {
            chain = chain.then(() => {
                if (activated.length >= Config.maxActivationsPerScan) return [];
                const actor = playerSession.actor;
                const loc = {
                    locX: actor.fetchLocX(),
                    locY: actor.fetchLocY(),
                    locZ: actor.fetchLocZ()
                };
                const remaining = Config.maxActivationsPerScan - activated.length;

                return LifeState.coldNear(loc, Config.activationRadius, remaining)
                    .then((states) => {
                        const maxRestingPresented = Math.max(1, Math.floor(states.length * Config.maxRestingActivationRatio));
                        return states.reduce((stateChain, state) => (
                            stateChain.then(() => {
                                const restingLike = this.isRestingActivationState(state);
                                const recoverOnActivation = restingLike && restingPresented >= maxRestingPresented;
                                if (restingLike && !recoverOnActivation) {
                                    restingPresented += 1;
                                }

                                return this.requestActivation(state, 'near_player', {
                                    recoverOnActivation,
                                    playerLoc: loc
                                });
                            }).then((result) => {
                                if (result.ok) activated.push(result);
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
        const candidates = BotManager.sessions
            .filter((session) => session.actor && session.accountId && String(session.accountId).startsWith('bot_'))
            .filter((session) => {
                if (session.plan === 'merchant') return false;
                const lastHotAt = session.populationHotAt || 0;
                return !lastHotAt || now - lastHotAt >= Config.cooldownGraceMs;
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

        const activeParties = BackgroundPartyState.counts().active || 0;
        const slots = Math.max(0, Config.maxBackgroundParties - activeParties);
        if (slots <= 0) return Promise.resolve([]);

        this.partyFormationRunning = true;
        const maxNewParties = Math.min(slots, Config.partyFormationBatchSize);

        return LifeState.coldPartyCandidates(Config.partyFormationCandidateLimit)
            .then((states) => {
                const groups = groupBySpot(states);
                const created = [];

                return groups.reduce((chain, group) => chain.then(() => {
                    if (created.length >= maxNewParties) return null;
                    if (group.length < Config.partyMinSize) return null;

                    const members = group.slice(0, Config.partyMaxSize);
                    if (members.length < Config.partyMinSize) return null;

                    const leader = chooseLeader(members);
                    const partyId = `bgp_${Date.now().toString(36)}_${leader.characterId}`;
                    const nextResolveAt = Date.now() + 45000 + Math.round(Math.random() * 90000);
                    const party = {
                        partyId,
                        leaderId: leader.characterId,
                        memberIds: members.map((state) => state.characterId),
                        spotId: leader.spotId,
                        startedAt: Date.now(),
                        nextResolveAt,
                        cohesion: 0.55 + Math.random() * 0.25,
                        risk: 0.18 + Math.random() * 0.22,
                        roleCoverage: roleCoverage(members),
                        stats: {
                            formedAt: Date.now(),
                            memberNames: members.map((state) => state.name)
                        }
                    };

                    return BackgroundPartyState.createOrUpdate(party).then((savedParty) => {
                        if (!savedParty) return null;

                        return members.reduce((memberChain, member) => (
                            memberChain.then(() => LifeState.assignParty(
                                member,
                                savedParty.partyId,
                                roleForState(member),
                                savedParty.leaderId
                            ))
                        ), Promise.resolve()).then(() => LifeEvents.record(leader.characterId, 'party', `${leader.name} formed a party near ${leader.spotId}`, {
                            partyId: savedParty.partyId,
                            spotId: savedParty.spotId,
                            memberIds: savedParty.memberIds
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

    tickBudgeted() {
        if (this.resolving || Config.enabled === false || Config.backgroundResolverEnabled === false) {
            return Promise.resolve([]);
        }

        this.resolving = true;
        return this.resolveDueParties()
            .then(() => LifeState.dueCold(Config.maxResolvesPerTick))
            .then((states) => {
                if (states.length === 0) return [];
                return states.reduce((chain, state) => (
                    chain.then((results) => this.resolveColdState(state).then((result) => {
                        results.push(result);
                        return results;
                    }))
                ), Promise.resolve([]));
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background scheduler failed: %s', err.message);
                return [];
            })
            .finally(() => {
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

    resolveBackgroundParty(party) {
        return LifeState.statesForParty(party.partyId).then((members) => {
            if (members.length < Config.partyMinSize) {
                return BackgroundPartyState.setStatus(party.partyId, 'dissolved')
                    .then(() => LifeState.clearParty(party.partyId))
                    .then(() => ({ ok: false, reason: 'too_few_members', party }));
            }

            const leader = members.find((state) => state.characterId === party.leaderId) || members[0];
            const spot = SpotProfiles.findById(party.spotId) || SpotProfiles.findForState(leader);
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

            return result.memberResults.reduce((chain, memberResult) => (
                chain.then(() => LifeState.applyResolve(memberResult.state, memberResult.result))
            ), Promise.resolve()).then(() => BackgroundPartyState.createOrUpdate({
                ...party,
                spotId: spot.id,
                nextResolveAt: result.nextResolveAt,
                cohesion: result.partyPatch.cohesion,
                risk: result.partyPatch.risk,
                roleCoverage: roleCoverage(members),
                stats: {
                    ...(party.stats || {}),
                    ...(result.partyPatch.stats || {})
                }
            })).then((updatedParty) => {
                Metrics.recordPartyResolve();
                return Promise.all(result.events.map((event) => (
                    LifeEvents.record(event.characterId || party.leaderId, event.type, event.summary, event.meta, event.weight)
                ))).then(() => ({
                    ok: true,
                    party: updatedParty,
                    debug: result.debug
                }));
            });
        }).catch((err) => {
            utils.infoWarn('BotPopulation', 'background party resolve failed for %s: %s', party.partyId, err.message);
            Metrics.recordSkippedResolve();
            return { ok: false, reason: 'resolve_failed', party };
        });
    },

    resolveColdState(state) {
        const spot = SpotProfiles.findForState(state);
        if (!spot) {
            Metrics.recordSkippedResolve();
            return Promise.resolve({ ok: false, reason: 'missing_spot', state });
        }

        const elapsedMs = state.timing?.lastResolvedAt ? Math.max(1000, Date.now() - state.timing.lastResolvedAt) : 60000;
        const result = BackgroundResolver.resolveSolo({
            state,
            spot,
            pressure: Director.pressureForState(state),
            elapsedMs
        });

        return LifeState.applyResolve(state, result).then((updatedState) => {
            if (!updatedState) {
                Metrics.recordSkippedResolve();
                return { ok: false, reason: 'apply_failed', state };
            }

            Metrics.recordBackgroundResolve();
            return LifeEvents.recordMany(state.characterId, result.events).then(() => ({
                ok: true,
                state: updatedState,
                debug: result.debug
            }));
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

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const ActivationPlacement = invoke('GameServer/Bot/Population/ActivationPlacement');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const pendingActivations = new Set();
const HOT_PLANS = new Set(['hunting', 'resting', 'shopping', 'merchant', 'pk_hunting']);

function activationPlan(state, options = {}) {
    const activity = state?.activity || 'hunting';
    if (options.recoverOnActivation || (options.readyOnActivation && (activity === 'dead' || activity === 'resting'))) {
        return 'hunting';
    }

    if (activity === 'dead' || activity === 'resting') return 'resting';
    if (activity === 'crafting') return 'merchant';
    if (HOT_PLANS.has(activity)) return activity;
    return 'hunting';
}

function distance2d(a, b) {
    if (!a || !b) return Infinity;
    const dx = Number(a.locX || 0) - Number(b.locX || 0);
    const dy = Number(a.locY || 0) - Number(b.locY || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function spotSnapshot(spot) {
    if (!spot) return null;
    return {
        id: spot.id,
        name: spot.name,
        center: { ...spot.center },
        minLevel: spot.minLevel,
        maxLevel: spot.maxLevel,
        avgLevel: spot.avgLevel,
        density: spot.density,
        npcNames: [...(spot.npcNames || [])]
    };
}

function activationDistance(placement, options) {
    const dist = distance2d(placement?.loc, options?.playerLoc);
    return Number.isFinite(dist) ? String(Math.round(dist)) : 'n/a';
}

function releaseBackgroundParty(state, reason) {
    const partyId = state?.party?.partyId;
    if (!partyId) return Promise.resolve(state);
    if (invoke('GameServer/Bot/Population/HotPartyLifecycle').pending.has(partyId)
        || BackgroundPartyState.find(partyId)?.status === 'hot') return Promise.reject(Error('party_transition_pending'));

    return BackgroundPartyState.setStatus(partyId, 'dissolved')
        .then(saved => {
            if (!saved) throw Error('background_party_release_failed');
            return LifeState.releaseDissolvedPartyMembers(partyId, `hot_activation_${reason}`);
        })
        .then((cleared) => {
            const refreshed = LifeState.cachedState(state.characterId);
            if (refreshed && !refreshed.party?.partyId) return refreshed;
            if (Number(cleared || 0) <= 0 || refreshed?.party?.partyId) {
                throw new Error(`background_party_release_failed:${partyId}`);
            }
            return {
                ...state,
                activity: state.activity === 'grouped' ? 'hunting' : state.activity,
                party: { ...(state.party || {}), partyId: null, leaderId: null }
            };
        });
}

function restoreColdAfterActivationFailure(state) {
    if (!state?.characterId) return Promise.resolve({ ok: false, reason: 'missing_state' });
    const current = LifeState.cachedState(state.characterId) || state;
    return ColdSimulationCoordinator.acceptColdState(current).then((accepted) => {
        if (!accepted?.ok) {
            utils.infoWarn('BotPopulation', 'failed to return %s to cold worker after activation failure: %s', state.name, accepted?.reason || 'unknown');
        }
        return accepted;
    }).catch((error) => {
        utils.infoWarn('BotPopulation', 'failed to return %s to cold worker after activation failure: %s', state.name, error?.message || error);
        return { ok: false, reason: error?.message || 'cold_restore_failed' };
    });
}

const HotActivation = {
    activate(stateOrName, reason = 'activation', options = {}) {
        const loadState = typeof stateOrName === 'string'
            ? LifeState.findByName(stateOrName)
            : Promise.resolve(stateOrName);

        return loadState.then((state) => {
            if (!state) return { ok: false, reason: 'missing_state' };
            if (state.stats?.coldCompetition?.wait?.combat && state.stats.coldCompetition.wait.until > Date.now()) {
                return { ok: false, reason: 'cold_pvp_settling' };
            }
            if (state.phase === 'hot') return { ok: false, reason: 'already_hot', state };
            if (state.party?.partyId && options.interruptBackgroundActivity !== true
                && !['remote_invite', 'party_invite'].includes(reason)) {
                return invoke('GameServer/Bot/Population/HotPartyLifecycle').activate(state.party.partyId, reason, options);
            }
            if (state.activity === 'pk_hunting'
                && options.pkEncounter !== true
                && options.interruptBackgroundActivity !== true) {
                return { ok: false, reason: 'pk_encounter_only', state };
            }
            if (state.activity === 'traveling' && options.interruptBackgroundActivity !== true) {
                return { ok: false, reason: 'in_transit', state };
            }
            if (!state.accountName) return { ok: false, reason: 'missing_account', state };
            if (pendingActivations.has(state.characterId)) {
                return { ok: false, reason: 'activation_pending', state };
            }
            const craftShop = state.activity === 'crafting' && state.stats?.craftShop
                ? CraftShopService.profileFor(state) : null;
            const marketStore = state.activity === 'merchant' ? state.stats?.marketStore : null;
            const placement = ActivationPlacement.resolve(state, {
                ...options,
                keepStoreLocation: options.keepStoreLocation || !!marketStore || !!craftShop,
                storeLoc: marketStore?.loc || craftShop?.loc || state.loc
            });
            // A failed placement must not dissolve a party, remove a market
            // listing or hand ownership away from the cold worker.
            if (!placement) return { ok: false, reason: 'no_safe_activation_placement', state };
            // Reserve the character before party cleanup or recipe sync can
            // yield. Otherwise two concurrent visibility/invite requests can
            // both pass the guard and create independent hot AI sessions.
            pendingActivations.add(state.characterId);

            const BotManager = invoke('GameServer/Bot/BotManager');
            let craftActivation = false;
            let releasedForActivation = false;
            return ColdSimulationCoordinator.fenceBot(state.characterId).then((fence) => {
                if (!fence.ok && fence.reason !== 'worker_not_ready') {
                    utils.infoWarn('ColdWorker', 'activation fence fallback for %s: %s', state.name, fence.reason);
                }
                return ColdSimulationOwner.handoffToMain(LifeState.cachedState(state.characterId) || state);
            }).then((handoff) => {
                if (!handoff.ok) throw new Error(`simulation_owner_handoff_failed:${handoff.reason}`);
                state = {
                    ...state,
                    simulation: {
                        ownerId: handoff.ownerId,
                        revision: handoff.revision,
                        leaseId: handoff.leaseId,
                        leaseUntil: handoff.leaseUntil
                    }
                };
                if (options.interruptBackgroundActivity === true
                    && ['traveling', 'pk_hunting'].includes(state.activity)) {
                    state = {
                        ...state,
                        activity: 'hunting',
                        timing: {
                            ...(state.timing || {}),
                            activityStartedAt: Date.now(),
                            nextResolveAt: Date.now() + 1000
                        },
                        stats: {
                            ...(state.stats || {}),
                            travel: null
                        }
                    };
                }
                return releaseBackgroundParty(state, reason);
            }).then((releasedState) => {
                state = releasedState;
                releasedForActivation = true;

                craftActivation = !!craftShop;
                const plan = activationPlan(state, options);
                if (marketStore) MarketOpportunity.removeColdStore(state.characterId);
                const recipesReady = craftShop
                    ? CraftShopService.ensureRecipes(state.characterId, craftShop)
                    : Promise.resolve();
                return recipesReady.then(() => Promise.resolve(BotManager.loadAndSpawnBot(state.accountName, {
                        name: state.name,
                        homeRegion: state.homeRegion,
                        newbieAnchor: !!state.stats?.newbieAnchor,
                        plan,
                        backgroundActivity: state.activity || 'hunting',
                        currentSpot: spotSnapshot(placement.spot),
                        spawnReady: true,
                        // Near-player ambient activation promises a ready
                        // actor. BotManager consumes this after enterWorld has
                        // loaded the final skill/equipment-derived stat caps,
                        // before publishing the final CharInfo or starting AI.
                        readyOnActivation: !marketStore && !craftShop && (
                            options.readyOnActivation === true || options.recoverOnActivation === true
                        ),
                        locX: placement.loc?.locX,
                        locY: placement.loc?.locY,
                        locZ: placement.loc?.locZ,
                        keepStoreLocation: !!marketStore || !!craftShop,
                        coldLifeState: !marketStore && !craftShop ? state : null,
                        populationLocationPolicy: reason === 'near_player' && !options.forceNearPlayer
                            ? 'physical' : 'return',
                        coldMarketState: marketStore ? state : null,
                        coldCraftState: craftShop ? state : null,
                        privateStore: marketStore ? {
                            storeType: Number(marketStore.storeType || 1),
                            budgetBacked: marketStore.budgetBacked === true,
                            buyerCharacterId: Number(marketStore.buyerCharacterId || 0) || null,
                            revision: Math.max(1, Number(marketStore.revision || 1)),
                            title: marketStore.autoTitle === false
                                ? marketStore.title
                                : marketStoreTitle(marketStore.items),
                            town: marketStore.town || state.currentRegion || null,
                            items: marketStore.items || []
                        } : null,
                        manufactureShop: craftShop
                    })).then((session) => {
                    if (!session) throw new Error('bot_spawn_failed');
                    const pendingTimer = setTimeout(() => {
                        pendingActivations.delete(state.characterId);
                    }, 10000);
                    pendingTimer.unref?.();

                    console.info(
                        'BotPopulation :: requested activation for %s reason=%s activity=%s plan=%s spot=%s loc=%d,%d,%d playerDist=%s ready=%s',
                        state.name,
                        reason,
                        state.activity || 'hunting',
                        plan,
                        placement.spot?.id || state.spotId || 'none',
                        placement.loc?.locX || 0,
                        placement.loc?.locY || 0,
                        placement.loc?.locZ || 0,
                        activationDistance(placement, options),
                        (options.recoverOnActivation || options.readyOnActivation) ? 'yes' : 'no'
                    );
                    Metrics.recordActivation();
                    return { ok: true, state, reason };
                }));
            }).catch((error) => {
                const restore = releasedForActivation
                    ? restoreColdAfterActivationFailure(state)
                    : Promise.resolve(null);
                return restore.then(() => {
                    pendingActivations.delete(state.characterId);
                    const failureReason = craftActivation ? 'craft_recipe_sync_failed' : 'activation_prepare_failed';
                    utils.infoWarn('BotPopulation', 'activation failed for %s: %s', state.name, error.message || error);
                    return { ok: false, reason: failureReason, state };
                });
            });
        });
    }
};

module.exports = HotActivation;

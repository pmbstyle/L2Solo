const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const ActivationPlacement = invoke('GameServer/Bot/Population/ActivationPlacement');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const pendingActivations = new Set();
const HOT_PLANS = new Set(['hunting', 'resting', 'shopping', 'merchant', 'pk_hunting']);

// An activation the bot's own state refuses (in transit, no placement a player
// would see): counted by reason (PopulationMetrics); with developer diagnostics one
// line names the bot, its place and spot, so a run shows which bots stay unseen.
function refused(reason, state) {
    Metrics.recordActivationRefusal(reason);
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
        'BotPopulation :: refused activation for %s reason=%s activity=%s spot=%s loc=%d,%d,%d',
        state?.name, reason, state?.activity || 'hunting', state?.spotId || 'none',
        Number(state?.loc?.locX) || 0, Number(state?.loc?.locY) || 0, Number(state?.loc?.locZ) || 0);
    return { ok: false, reason, state };
}

function activationPlan(state, options = {}) {
    const activity = state?.activity || 'hunting';
    if (options.recoverOnActivation || (options.readyOnActivation && (activity === 'dead' || activity === 'resting'))) {
        return 'hunting';
    }

    if (activity === 'dead' || activity === 'resting') return 'resting';
    if (activity === 'crafting' && state.stats?.mammonReturn) return 'shopping';
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

    return BackgroundPartyState.setStatus(partyId, 'dissolved', `hot_activation_${reason}`)
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
    if (current.phase !== 'cold') return Promise.resolve({ ok: false, reason: 'not_cold' });
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
        const transitionStartedAt = Date.now();
        const loadState = typeof stateOrName === 'string'
            ? LifeState.findByName(stateOrName)
            : Promise.resolve(stateOrName);

        return loadState.then((state) => {
            if (!state) return { ok: false, reason: 'missing_state' };
            const playerInvite = ['remote_invite', 'party_invite'].includes(reason);
            if (playerInvite && state.party?.partyId) return { ok: false, reason: 'already_grouped', state };
            const encounter = invoke('GameServer/Bot/Population/PvpEncounterRuntime').active(state);
            if (encounter) return invoke('GameServer/Bot/Population/PvpEncounterLifecycle').activate(encounter, reason, options);
            if (state.stats?.coldCompetition?.wait?.combat && state.stats.coldCompetition.wait.until > Date.now()) {
                return { ok: false, reason: 'cold_pvp_settling' };
            }
            if (state.phase === 'hot' && !(options.constParty && state.stats?.constPartySession)) return { ok: false, reason: 'already_hot', state };
            if (state.party?.partyId && options.interruptBackgroundActivity !== true
                && !['remote_invite', 'party_invite'].includes(reason)) {
                return invoke('GameServer/Bot/Population/HotPartyLifecycle').activate(state.party.partyId, reason, options);
            }
            if (state.activity === 'pk_hunting'
                && options.pkEncounter !== true
                && options.interruptBackgroundActivity !== true) {
                return { ok: false, reason: 'pk_encounter_only', state };
            }
            // A traveller a player invites or calls leaves its trip, as a hunter
            // leaves its spot (design 5.9). A walker (ColdTrip: a solo run to a
            // spot) a player comes near shows itself where the cold model has it, on
            // its road (ColdTrip.positionAt at one instant for the whole activation,
            // grounded by ActivationPlacement), and walks the rest of its run as a
            // hot body: it arrives once, at the walk's end. A walker bound for
            // anything but a hunt (a clan's waiting point) stays cold until it
            // arrives. A bot no longer a walker (it arrived while fenced) is taken
            // as it is. A gatekeeper trip's run begins at its teleport landing.
            const shownAt = Date.now();
            const onRoad = (s) => s?.activity === 'traveling' && !!s.stats?.travel?.run
                && (s.stats.travel.arrivalActivity || 'hunting') === 'hunting';
            const walker = reason === 'near_player' && onRoad(state);
            const appearance = (s) => walker && onRoad(s) ? { ...s, loc: ColdTrip.positionAt(s, shownAt) } : s;
            const placementOptions = (s, storeLoc) => ({
                ...options,
                keepStoreLocation: options.keepStoreLocation || !!craftShop || mammonVisit,
                storeLoc,
                ...(walker && onRoad(s) ? { roadFrom: s.stats.travel.run.from,
                    roadFromLanding: s.stats.travel.method === 'gatekeeper_spot' } : {})
            });
            const leavesTrip = walker || options.interruptBackgroundActivity === true
                || (['remote_invite', 'party_invite', 'remote_chat_come'].includes(reason)
                    && state.activity === 'traveling');
            if (state.activity === 'traveling' && !leavesTrip) return refused('in_transit', state);
            state = appearance(state);
            if (!state.accountName) return { ok: false, reason: 'missing_account', state };
            if (pendingActivations.has(state.characterId)) {
                return { ok: false, reason: 'activation_pending', state };
            }
            const mammonVisit = state.activity === 'crafting' && !!state.stats?.mammonReturn;
            const craftShop = state.activity === 'crafting' && !mammonVisit && state.stats?.craftShop
                ? CraftShopService.profileFor(state) : null;
            let placement = ActivationPlacement.resolve(state, placementOptions(state, craftShop?.loc || state.loc));
            // A failed placement must not dissolve a party, remove a market
            // listing or hand ownership away from the cold worker.
            // With playerLoc only a point within the activation radius of the
            // player is accepted.
            if (!placement) return refused('no_safe_activation_placement', state);
            // Reserve the character before party cleanup or recipe sync can
            // yield. Otherwise two concurrent visibility/invite requests can
            // both pass the guard and create independent hot AI sessions.
            pendingActivations.add(state.characterId);

            const BotManager = invoke('GameServer/Bot/BotManager');
            let craftActivation = false;
            let releasedForActivation = false;
            let fencedForActivation = false;
            let economyDecision = null;
            // The rest of a walker's run: the hot walk to its spot (BotManager).
            let walkTo = null;
            return ColdSimulationCoordinator.fenceBot(state.characterId).then((fence) => {
                fencedForActivation = true;
                if (!fence.ok && fence.reason !== 'worker_not_ready') {
                    utils.infoWarn('ColdWorker', 'activation fence fallback for %s: %s', state.name, fence.reason);
                }
                const current = appearance(LifeState.cachedState(state.characterId) || state);
                if (playerInvite && current.party?.partyId) throw Object.assign(Error('already_grouped'), { partyRefusal: true });
                const moved = current.spotId !== state.spotId || ['locX', 'locY', 'locZ']
                    .some(key => current.loc?.[key] !== state.loc?.[key]);
                state = current;
                // Still traveling but off a road: a walker began a trip with no run.
                if (current.activity === 'traveling' && (walker ? !onRoad(current) : !leavesTrip)) {
                    throw Object.assign(Error('in_transit'), { activationRefusal: 'in_transit' });
                }
                if (walker && onRoad(current)) {
                    const travel = current.stats.travel;
                    const spotId = travel.spotId || SpotService.findCurrentSpot(travel.run.to)?.id || null;
                    // Its cold trip rides with the walk: a body cooled before the walk ends goes
                    // on cold from where it stands (BotLifeState.writeColdRow).
                    walkTo = spotId ? { spotId, destination: { ...travel.run.to }, trip: travel } : null;
                }
                if (moved) {
                    placement = ActivationPlacement.resolve(current, placementOptions(current, craftShop?.loc || current.loc));
                    if (!placement) throw Object.assign(Error('no_safe_activation_placement'),
                        { activationRefusal: 'no_safe_activation_placement' });
                }
                if (!leavesTrip && !playerInvite && options.interruptBackgroundActivity !== true) {
                    const decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
                    economyDecision = decisions.current(current, fence.economyDecision) ? fence.economyDecision : null;
                }
                return ColdSimulationOwner.handoffToMain(current);
            }).then((handoff) => {
                if (!handoff.ok) throw new Error(`simulation_owner_handoff_failed:${handoff.reason}`);
                state = {
                    ...state,
                    simulation: { ...state.simulation, revision: handoff.revision }
                };
                if (leavesTrip && ['traveling', 'pk_hunting'].includes(state.activity)) {
                    state = {
                        ...state,
                        activity: 'hunting',
                        // A walker holds the spot it walks to, as a far traveller counts at its travel spot.
                        ...(walkTo ? { spotId: walkTo.spotId,
                            currentRegion: state.stats.travel.regionName || state.currentRegion } : {}),
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
                const recipesReady = craftShop
                    ? CraftShopService.ensureRecipes(state.characterId, craftShop)
                    : Promise.resolve();
                return recipesReady.then(() => Promise.resolve(BotManager.loadAndSpawnBot(state.accountName, {
                        name: state.name,
                        homeRegion: state.homeRegion,
                        plan,
                        backgroundActivity: state.activity || 'hunting',
                        // A walker stands on no spot until its walk ends there.
                        currentSpot: walkTo ? null : spotSnapshot(placement.spot),
                        walkTo,
                        spawnReady: true,
                        // Near-player ambient activation promises a ready
                        // actor. BotManager consumes this after enterWorld has
                        // loaded the final skill/equipment-derived stat caps,
                        // before publishing the final CharInfo or starting AI.
                        readyOnActivation: !craftShop && (
                            options.readyOnActivation === true || options.recoverOnActivation === true
                        ),
                        locX: placement.loc?.locX,
                        locY: placement.loc?.locY,
                        locZ: placement.loc?.locZ,
                        keepStoreLocation: !!craftShop || mammonVisit,
                        coldLifeState: !craftShop ? state : null,
                        economyDecision: !craftShop ? economyDecision : null,
                        populationLocationPolicy: reason === 'near_player' && !options.forceNearPlayer
                            ? 'physical' : 'return',
                        coldCraftState: craftShop ? state : null,
                        manufactureShop: craftShop
                    })).then((session) => {
                    if (!session) throw new Error('bot_spawn_failed');
                    const pendingTimer = setTimeout(() => {
                        pendingActivations.delete(state.characterId);
                    }, 10000);
                    pendingTimer.unref?.();

                    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
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
                    Metrics.recordActivation(Date.now() - transitionStartedAt);
                    return { ok: true, state, reason };
                }));
            }).catch((error) => {
                const restore = releasedForActivation || fencedForActivation
                    ? restoreColdAfterActivationFailure(state)
                    : Promise.resolve(null);
                return restore.then(() => {
                    pendingActivations.delete(state.characterId);
                    const failureReason = error.activationRefusal || (error.partyRefusal ? 'already_grouped'
                        : craftActivation ? 'craft_recipe_sync_failed' : 'activation_prepare_failed');
                    // A refusal found after the fence is counted by reason, as before it
                    // (refused); any other failure is logged.
                    if (error.activationRefusal) refused(error.activationRefusal, state);
                    else utils.infoWarn('BotPopulation', 'activation failed for %s: %s', state.name, error.message || error);
                    return { ok: false, reason: failureReason, state };
                });
            });
        });
    }
};

module.exports = HotActivation;

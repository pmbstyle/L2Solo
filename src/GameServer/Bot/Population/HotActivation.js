const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const pendingActivations = new Set();
const HOT_PLANS = new Set(['hunting', 'resting', 'shopping', 'merchant', 'pk_hunting']);

function activationPlan(state, options = {}) {
    const activity = state?.activity || 'hunting';
    if (options.recoverOnActivation || (options.readyOnActivation && (activity === 'dead' || activity === 'resting'))) {
        return 'hunting';
    }

    if (activity === 'dead' || activity === 'resting') return 'resting';
    if (HOT_PLANS.has(activity)) return activity;
    return 'hunting';
}

function distance2d(a, b) {
    if (!a || !b) return Infinity;
    const dx = Number(a.locX || 0) - Number(b.locX || 0);
    const dy = Number(a.locY || 0) - Number(b.locY || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function randomAround(loc, radius) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    const locX = Math.round(Number(loc.locX || 0) + Math.cos(angle) * dist);
    const locY = Math.round(Number(loc.locY || 0) + Math.sin(angle) * dist);
    const baseZ = Number(loc.locZ || 0);

    return {
        locX,
        locY,
        locZ: GeodataEngine.getHeight(locX, locY, baseZ)
    };
}

function pushAwayFromPlayer(loc, playerLoc) {
    if (!playerLoc || distance2d(loc, playerLoc) >= Config.activationMinPlayerDistance) return loc;

    const dx = Number(loc.locX || 0) - Number(playerLoc.locX || 0);
    const dy = Number(loc.locY || 0) - Number(playerLoc.locY || 0);
    const angle = Math.abs(dx) + Math.abs(dy) > 1 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2;
    const distance = Config.activationMinPlayerDistance + 120 + Math.random() * 220;
    const locX = Math.round(Number(playerLoc.locX || 0) + Math.cos(angle) * distance);
    const locY = Math.round(Number(playerLoc.locY || 0) + Math.sin(angle) * distance);
    const baseZ = Number(playerLoc.locZ || loc.locZ || 0);

    return {
        locX,
        locY,
        locZ: GeodataEngine.getHeight(locX, locY, baseZ)
    };
}

function validPlayerPlacement(loc, playerLoc) {
    if (!playerLoc) return true;
    const dist = distance2d(loc, playerLoc);
    return dist >= Config.activationMinPlayerDistance && dist <= Config.activationRadius;
}

function activationPlacement(state, options = {}) {
    if (options.keepStoreLocation && (options.storeLoc || state?.loc)) {
        const loc = options.storeLoc || state.loc;
        return { loc: { ...loc }, spot: SpotService.findCurrentSpot(loc) || null };
    }
    const spot = state?.spotId ? SpotService.findById(state.spotId) : null;
    const baseLoc = options.playerLoc
        ? (options.forceNearPlayer ? options.playerLoc : (state?.loc || spot?.center || { locX: 0, locY: 0, locZ: 0 }))
        : (spot?.center || state?.loc || { locX: 0, locY: 0, locZ: 0 });
    let candidate = null;

    for (let i = 0; i < Config.activationPlacementAttempts; i++) {
        candidate = spot && !options.playerLoc
            ? SpotService.randomPointNear(spot, Config.activationPlacementRadius)
            : randomAround(baseLoc, Config.activationPlacementRadius);

        if (validPlayerPlacement(candidate, options.playerLoc)) {
            return { loc: candidate, spot: SpotService.findCurrentSpot(candidate) || spot };
        }
    }

    const loc = pushAwayFromPlayer(baseLoc, options.playerLoc);

    return {
        loc,
        spot: SpotService.findCurrentSpot(loc) || spot
    };
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

const HotActivation = {
    activate(stateOrName, reason = 'activation', options = {}) {
        const loadState = typeof stateOrName === 'string'
            ? LifeState.findByName(stateOrName)
            : Promise.resolve(stateOrName);

        return loadState.then((state) => {
            if (!state) return { ok: false, reason: 'missing_state' };
            if (state.phase === 'hot') return { ok: false, reason: 'already_hot', state };
            if (state.activity === 'pk_hunting' && options.pkEncounter !== true) {
                return { ok: false, reason: 'pk_encounter_only', state };
            }
            if (state.activity === 'traveling') {
                return { ok: false, reason: 'in_transit', state };
            }
            if (!state.accountName) return { ok: false, reason: 'missing_account', state };
            if (pendingActivations.has(state.characterId)) {
                return { ok: false, reason: 'activation_pending', state };
            }

            const BotManager = invoke('GameServer/Bot/BotManager');
            if (state.party?.partyId) {
                BackgroundPartyState.setStatus(state.party.partyId, 'dissolved');
                LifeState.clearParty(state.party.partyId);
            }

            const plan = activationPlan(state, options);
            const marketStore = state.activity === 'merchant' ? state.stats?.marketStore : null;
            const placement = activationPlacement(state, {
                ...options,
                storeLoc: marketStore?.loc || state.loc
            });
            pendingActivations.add(state.characterId);
            if (marketStore) MarketOpportunity.removeColdStore(state.characterId);
            BotManager.loadAndSpawnBot(state.accountName, {
                name: state.name,
                homeRegion: state.homeRegion,
                newbieAnchor: !!state.stats?.newbieAnchor,
                plan,
                backgroundActivity: state.activity || 'hunting',
                currentSpot: spotSnapshot(placement.spot),
                spawnReady: true,
                locX: placement.loc?.locX,
                locY: placement.loc?.locY,
                locZ: placement.loc?.locZ,
                keepStoreLocation: !!marketStore,
                coldMarketState: marketStore ? state : null,
                privateStore: marketStore ? {
                    storeType: Number(marketStore.storeType || 1),
                    title: marketStore.title || 'Useful loot and old gear',
                    town: marketStore.town || state.currentRegion || null,
                    items: marketStore.items || []
                } : null
            });

            setTimeout(() => {
                pendingActivations.delete(state.characterId);
            }, 10000);

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
        });
    }
};

module.exports = HotActivation;

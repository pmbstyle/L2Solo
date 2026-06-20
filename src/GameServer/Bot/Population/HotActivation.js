const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const pendingActivations = new Set();
const HOT_PLANS = new Set(['hunting', 'resting', 'shopping', 'pk_hunting']);

function activationPlan(state) {
    const activity = state?.activity || 'hunting';
    if (activity === 'dead' || activity === 'resting') return 'resting';
    if (HOT_PLANS.has(activity)) return activity;
    return 'hunting';
}

const HotActivation = {
    activate(stateOrName, reason = 'activation') {
        const loadState = typeof stateOrName === 'string'
            ? LifeState.findByName(stateOrName)
            : Promise.resolve(stateOrName);

        return loadState.then((state) => {
            if (!state) return { ok: false, reason: 'missing_state' };
            if (state.phase === 'hot') return { ok: false, reason: 'already_hot', state };
            if (!state.accountName) return { ok: false, reason: 'missing_account', state };
            if (pendingActivations.has(state.characterId)) {
                return { ok: false, reason: 'activation_pending', state };
            }

            const BotManager = invoke('GameServer/Bot/BotManager');
            pendingActivations.add(state.characterId);
            BotManager.loadAndSpawnBot(state.accountName, {
                name: state.name,
                homeRegion: state.homeRegion,
                plan: activationPlan(state),
                backgroundActivity: state.activity || 'hunting',
                locX: state.loc?.locX,
                locY: state.loc?.locY,
                locZ: state.loc?.locZ
            });

            setTimeout(() => {
                pendingActivations.delete(state.characterId);
            }, 10000);

            console.info('BotPopulation :: requested activation for %s reason=%s', state.name, reason);
            Metrics.recordActivation();
            return { ok: true, state, reason };
        });
    }
};

module.exports = HotActivation;

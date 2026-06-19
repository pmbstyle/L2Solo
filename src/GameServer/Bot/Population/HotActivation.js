const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const HotActivation = {
    activate(stateOrName, reason = 'activation') {
        const loadState = typeof stateOrName === 'string'
            ? LifeState.findByName(stateOrName)
            : Promise.resolve(stateOrName);

        return loadState.then((state) => {
            if (!state) return { ok: false, reason: 'missing_state' };
            if (state.phase === 'hot') return { ok: false, reason: 'already_hot', state };
            if (!state.accountName) return { ok: false, reason: 'missing_account', state };

            const BotManager = invoke('GameServer/Bot/BotManager');
            BotManager.loadAndSpawnBot(state.accountName, {
                name: state.name,
                homeRegion: state.homeRegion,
                plan: state.activity || 'hunting',
                locX: state.loc?.locX,
                locY: state.loc?.locY,
                locZ: state.loc?.locZ
            });

            console.info('BotPopulation :: requested activation for %s reason=%s', state.name, reason);
            return { ok: true, state, reason };
        });
    }
};

module.exports = HotActivation;

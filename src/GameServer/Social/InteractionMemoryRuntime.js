const InteractionMemory = require('./InteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');

// The main-process instance. Cold workers create repository-free instances.
const memory = new InteractionMemory(Repository);
memory.clanSocial = invoke('GameServer/Clan/ClanSocialRuntime').view;
memory.events = new (require('./InteractionEventQueue'))(memory, {
    onCommit(ownerId) {
        const state = invoke('GameServer/Bot/Population/BotLifeState').cachedState(ownerId);
        if (state) {
            const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
            // Ordinary dirty rows are ignored during full bootstrap. Preserve
            // memory commits racing an already serialized page until it ends.
            coordinator.markDirty(state, { critical: coordinator.snapshotInFlightInitial === true,
                reason: 'interaction_memory' });
        }
    },
    onError(error) { utils.infoWarn('InteractionMemory', 'episode write failed: %s', error.message); }
});
module.exports = memory;

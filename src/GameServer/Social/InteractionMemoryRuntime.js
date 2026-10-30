const InteractionMemory = require('./InteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const RelationshipContext = require('./RelationshipContext');
const TableChannel = require('../Bot/Population/ColdTableChannel').shared;

// The main-process instance. Cold workers create repository-free instances.
const memory = new InteractionMemory(Repository);
memory.playingHours = id => {
    const record = invoke('GameServer/World/World').registeredActorById(id);
    return RelationshipContext.playedHours(record?.session || id);
};
memory.enrichEvent = event => {
    const World = invoke('GameServer/World/World');
    return RelationshipContext.enrich(event, World.registeredActorById(event.sourceId)?.session || event.sourceId,
        World.registeredActorById(event.targetId)?.actor);
};
memory.clanSocial = invoke('GameServer/Clan/ClanSocialRuntime').view;
memory.clanWars = invoke('GameServer/Clan/ClanWarRuntime').view;
// The 'memory' table (ColdTableChannel, key: owner id): every accepted
// snapshot (load, ensureMany, a committed episode, a bot's reflected commit,
// a clan discipline) is published once; the worker accepts it into its own
// instance (ColdSimulationWorker 'memory' watch).
TableChannel.register('memory', {
    key: row => row.ownerId,
    allRows: () => Array.from(memory.snapshots.keys(), id => memory.snapshot(id))
});
// The row is a deep copy: built only when a worker is attached to take it.
memory.onAccept = ownerId => TableChannel.changed('memory', () => memory.snapshot(ownerId));
memory.events = new (require('./InteractionEventQueue'))(memory, {
    onError(error) { utils.infoWarn('InteractionMemory', 'episode write failed: %s', error.message); }
});
module.exports = memory;

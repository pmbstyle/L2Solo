const Database = invoke('Database');
const Policy = require('./InteractionMemoryPolicy');

module.exports = {
    async loadMany(ownerIds) {
        if (!Array.isArray(ownerIds) || ownerIds.length > Policy.MAX_BATCH) throw new Error('interaction memory: invalid load batch');
        const ids = [...new Set(ownerIds.map(Policy.id))];
        if (!ids.length) return [];
        const snapshots = await Database.loadInteractionMemories(ids);
        const byId = new Map(snapshots.map(snapshot => [snapshot.ownerId, snapshot]));
        return ids.map(id => byId.get(id) || Policy.empty(id));
    },
    async load(ownerId) {
        Policy.id(ownerId);
        return (await Database.loadInteractionMemories([ownerId]))[0];
    },
    recordBatch(events) {
        if (!Array.isArray(events) || !events.length || events.length > Policy.MAX_BATCH) {
            return Promise.reject(new Error('interaction memory: invalid batch'));
        }
        return Database.commitInteractionMemory(events.map(Policy.event));
    }
};

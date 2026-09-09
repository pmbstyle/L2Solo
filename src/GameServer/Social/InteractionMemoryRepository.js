const Database = invoke('Database');
const Policy = require('./InteractionMemoryPolicy');

module.exports = {
    async loadMany(ownerIds) {
        if (!Array.isArray(ownerIds) || ownerIds.length > Policy.MAX_BATCH) throw new Error('interaction memory: invalid load batch');
        const ids = [...new Set(ownerIds.map(Policy.id))];
        if (!ids.length) return [];
        const rows = await Database.execute([`SELECT ownerId, snapshotJson FROM bot_interaction_memory
            WHERE ownerId IN (${ids.map(() => '?').join(',')})`, ids], 'social-memory:load-batch');
        const byId = new Map(rows.map(row => [Number(row.ownerId), Policy.validate(JSON.parse(row.snapshotJson))]));
        return ids.map(id => byId.get(id) || Policy.empty(id));
    },
    async load(ownerId) {
        Policy.id(ownerId);
        const rows = await Database.execute(['SELECT snapshotJson FROM bot_interaction_memory WHERE ownerId = ?', [ownerId]], 'social-memory:load');
        return rows.length ? Policy.validate(JSON.parse(rows[0].snapshotJson)) : Policy.empty(ownerId);
    },
    recordBatch(events) {
        if (!Array.isArray(events) || !events.length || events.length > Policy.MAX_BATCH) {
            return Promise.reject(new Error('interaction memory: invalid batch'));
        }
        return Database.commitInteractionMemory(events.map(Policy.event));
    }
};

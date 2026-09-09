const Database = invoke('Database');
const Policy = require('./InteractionMemoryPolicy');

module.exports = {
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

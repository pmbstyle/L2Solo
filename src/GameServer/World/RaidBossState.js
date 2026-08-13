const Database = invoke('Database');

let states = new Map();
let loaded = false;

function normalizeRow(row) {
    const npcId = Number(row?.npcId);
    const respawnTime = Number(row?.respawnTime);
    if (!Number.isInteger(npcId) || npcId <= 0 || !Number.isFinite(respawnTime) || respawnTime <= 0) return null;
    return {
        npcId,
        respawnTime,
        hp: Number.isFinite(Number(row?.hp)) ? Number(row.hp) : null,
        mp: Number.isFinite(Number(row?.mp)) ? Number(row.mp) : null,
        updatedAt: Number(row?.updatedAt) || 0
    };
}

async function load() {
    states = new Map();
    if (Database.isReady?.()) {
        const rows = await Database.fetchRaidBossStates();
        (rows || []).map(normalizeRow).filter(Boolean).forEach((row) => states.set(row.npcId, row));
    }
    loaded = true;
    return new Map(states);
}

function isLoaded() {
    return loaded;
}

function get(npcId) {
    return states.get(Number(npcId)) || null;
}

function isDelayed(npcId, now = Date.now()) {
    const state = get(npcId);
    return !!state && state.respawnTime > Number(now);
}

function markDefeated(npcOrId, respawnTime, hp = null, mp = null) {
    const npcId = Number(typeof npcOrId === 'object' ? npcOrId?.fetchSelfId?.() : npcOrId);
    const at = Number(respawnTime);
    if (!Number.isInteger(npcId) || npcId <= 0 || !Number.isFinite(at) || at <= 0) {
        return Promise.resolve(false);
    }

    const next = {
        npcId,
        respawnTime: at,
        hp: hp === null && typeof npcOrId === 'object' ? Number(npcOrId.fetchHp?.()) || 0 : (hp === null ? null : Number(hp)),
        mp: mp === null && typeof npcOrId === 'object' ? Number(npcOrId.fetchMp?.()) || 0 : (mp === null ? null : Number(mp)),
        updatedAt: Date.now()
    };
    states.set(npcId, next);
    if (!Database.isReady?.()) return Promise.resolve(true);
    return Database.upsertRaidBossState(npcId, at, next.hp, next.mp)
        .then(() => true)
        .catch((error) => {
            utils.infoWarn('RaidBoss', 'failed to persist respawn for NPC %d: %s', npcId, error.message);
            return false;
        });
}

function markSpawned(npcId) {
    const id = Number(npcId);
    if (!Number.isInteger(id) || id <= 0) return Promise.resolve(false);
    states.delete(id);
    if (!Database.isReady?.()) return Promise.resolve(true);
    return Database.clearRaidBossState(id)
        .then(() => true)
        .catch((error) => {
            utils.infoWarn('RaidBoss', 'failed to clear respawn for NPC %d: %s', id, error.message);
            return false;
        });
}

function snapshot() {
    return new Map(states);
}

function resetForTests() {
    states = new Map();
    loaded = false;
}

module.exports = {
    load,
    isLoaded,
    get,
    isDelayed,
    markDefeated,
    markSpawned,
    snapshot,
    resetForTests
};

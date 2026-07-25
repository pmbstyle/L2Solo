const Database = invoke('Database');

const FLUSH_INTERVAL_MS = 750;
const pending = new Map();
let timer = null;
let flushing = Promise.resolve();

function stateFor(characterId) {
    const id = Number(characterId || 0);
    if (!id) return null;
    if (!pending.has(id)) pending.set(id, { character: {}, items: {} });
    return pending.get(id);
}

function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        flushAll().catch((error) => utils.infoWarn('DB', 'buffered persistence flush failed: %s', error.message));
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
}

function merge(characterId, fields) {
    const state = stateFor(characterId);
    if (!state) return;
    Object.assign(state.character, fields);
    schedule();
}

function queueItemAmount(characterId, id, amount) {
    const state = stateFor(characterId);
    if (!state || !id) return;
    state.items[id] = { id: Number(id), amount: Number(amount), delete: Number(amount) <= 0 };
    schedule();
}

function take(characterId) {
    const id = Number(characterId || 0);
    const state = pending.get(id);
    if (!state) return null;
    pending.delete(id);
    return state;
}

function databaseReady() {
    return typeof Database.isReady !== 'function' || Database.isReady();
}

function flushCharacter(characterId) {
    if (!databaseReady()) {
        schedule();
        return flushing;
    }
    const state = take(characterId);
    if (!state) return flushing;
    flushing = flushing.then(() => Database.applyBufferedCharacterState(Number(characterId), state));
    return flushing;
}

function flushAll() {
    if (!databaseReady()) {
        schedule();
        return flushing;
    }
    const entries = [...pending.keys()]
        .map((id) => [id, take(id)])
        .filter(([, state]) => state);
    if (!entries.length) return flushing;
    flushing = flushing.then(() => Database.applyBufferedCharacterStates(entries));
    return flushing;
}

function pendingCount() {
    return pending.size;
}

Database.registerCharacterWriteFlush?.(flushCharacter);

module.exports = {
    itemAmount: queueItemAmount,
    experience(characterId, level, exp, sp) { merge(characterId, { level, exp, sp }); },
    location(characterId, coords = {}) { merge(characterId, { locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head ?? -1 }); },
    vitals(characterId, hp, maxHp, mp, maxMp) { merge(characterId, { hp, maxHp, mp, maxMp }); },
    karma(characterId, pvp, pk, karma) { merge(characterId, { pvp, pk, karma }); },
    flushCharacter,
    flushAll,
    pendingCount
};

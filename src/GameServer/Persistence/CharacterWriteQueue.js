const Database = invoke('Database');

const FLUSH_INTERVAL_MS = 750;
const pending = new Map();
// Snapshots are field patches. The latest one per character handed to a
// database write that has not settled yet (restore merges into it).
const queued = new Map();
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
    return Database.isReady();
}

// A failed write puts its snapshots back: under a newer snapshot already
// queued behind it, or into pending (fields merged since then win), where the
// flush timer retries them.
function restore(entries) {
    let requeued = false;
    for (const [id, state] of entries) {
        const later = queued.get(id);
        const target = later && later !== state ? later : pending.get(id);
        if (!target) {
            pending.set(id, state);
            requeued = true;
            continue;
        }
        target.character = { ...state.character, ...target.character };
        target.items = { ...state.items, ...target.items };
        if (target === pending.get(id)) requeued = true;
    }
    if (requeued) schedule();
}

// The returned write rejects when it fails; the shared chain does not, so one
// failure does not block the flushes and dependent work queued after it.
function write(entries, apply) {
    const result = flushing.then(apply)
        .catch((error) => {
            restore(entries);
            throw error;
        })
        .finally(() => {
            for (const [id, state] of entries) {
                if (queued.get(id) === state) queued.delete(id);
            }
        });
    for (const [id, state] of entries) queued.set(id, state);
    flushing = result.catch(() => null);
    return result;
}

function flushCharacter(characterId) {
    if (!databaseReady()) {
        schedule();
        return flushing;
    }
    const id = Number(characterId || 0);
    const state = take(id);
    // The character's snapshot is still being written: wait for it, then
    // write a snapshot it may have put back on failure, before the caller's
    // dependent work (which would otherwise be overwritten by the retry).
    if (!state) return queued.has(id) ? flushing.then(() => flushCharacter(id)) : flushing;
    return write([[id, state]], () => Database.applyBufferedCharacterState(id, state));
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
    return write(entries, () => Database.applyBufferedCharacterStates(entries));
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

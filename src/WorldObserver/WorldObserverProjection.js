const MAX_HISTORY = 256;

const state = {
    revision: 0,
    actors: new Map(),
    history: []
};

function keyFor(actor) {
    return `${String(actor?.kind || 'bot')}:${Number(actor?.id || 0)}`;
}

function signature(actor) {
    return JSON.stringify(actor);
}

function record(upserts = [], removals = []) {
    if (!upserts.length && !removals.length) return false;
    state.revision += 1;
    state.history.push({ revision: state.revision, upserts, removals });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    return true;
}

function reset(actors = []) {
    state.actors.clear();
    actors.forEach((actor) => {
        const key = keyFor(actor);
        if (!Number(actor?.id) || state.actors.has(key)) return;
        state.actors.set(key, { actor, signature: signature(actor) });
    });
    state.revision += 1;
    state.history = [];
    return snapshot();
}

function apply({ upserts = [], removals = [] } = {}) {
    const changed = [];
    const removed = [];
    upserts.forEach((actor) => {
        const key = keyFor(actor);
        if (!Number(actor?.id)) return;
        const nextSignature = signature(actor);
        const previous = state.actors.get(key);
        if (previous?.signature === nextSignature) return;
        state.actors.set(key, { actor, signature: nextSignature });
        changed.push(actor);
    });
    removals.forEach((entry) => {
        const key = typeof entry === 'string' ? entry : keyFor(entry);
        if (!state.actors.delete(key)) return;
        const [kind, id] = key.split(':');
        removed.push({ kind, id: Number(id) });
    });
    record(changed, removed);
    return { revision: state.revision, upserts: changed, removals: removed };
}

function changesSince(revision = 0) {
    const since = Math.max(0, Number(revision) || 0);
    if (since === state.revision) {
        return { revision: state.revision, reset: false, upserts: [], removals: [] };
    }
    const oldest = state.history[0]?.revision || state.revision;
    if (since <= 0 || since < oldest - 1 || since > state.revision) {
        return { revision: state.revision, reset: true, actors: actors() };
    }
    const upsertsByKey = new Map();
    const removalsByKey = new Map();
    state.history.filter((entry) => entry.revision > since).forEach((entry) => {
        entry.upserts.forEach((actor) => {
            const key = keyFor(actor);
            removalsByKey.delete(key);
            upsertsByKey.set(key, actor);
        });
        entry.removals.forEach((actor) => {
            const key = keyFor(actor);
            upsertsByKey.delete(key);
            removalsByKey.set(key, actor);
        });
    });
    return {
        revision: state.revision,
        reset: false,
        upserts: [...upsertsByKey.values()],
        removals: [...removalsByKey.values()]
    };
}

function actors() {
    return [...state.actors.values()].map((entry) => entry.actor);
}

function snapshot() {
    return { revision: state.revision, actors: actors(), history: state.history.length };
}

function clear() {
    state.revision = 0;
    state.actors.clear();
    state.history = [];
}

module.exports = {
    MAX_HISTORY,
    apply,
    changesSince,
    clear,
    keyFor,
    reset,
    snapshot
};

(function exposeWorldState(root, factory) {
    const worldState = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = worldState;
    if (root) root.WorldObserverWorldState = worldState;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function actorKey(actor = {}) {
        return `${actor.kind === 'player' ? 'player' : 'bot'}:${Number(actor.id || 0)}`;
    }

    function withoutKind(actor = {}) {
        const { kind, ...value } = actor;
        return value;
    }

    function decodeBootstrap(payload = {}) {
        if (payload.actorFormat !== 'row-v1' || !Array.isArray(payload.actorFields)) return payload;
        const decode = (row) => Object.fromEntries(payload.actorFields
            .map((field, index) => [field, row[index]])
            .filter(([, value]) => value !== null && value !== undefined));
        return {
            ...payload,
            bots: (payload.bots || []).map(decode),
            players: (payload.players || []).map(decode)
        };
    }

    function applyChanges(snapshot = {}, changes = {}, generatedAt = Date.now()) {
        const bots = new Map((snapshot.bots || []).map((actor) => [Number(actor.id), actor]));
        const players = new Map((snapshot.players || []).map((actor) => [Number(actor.id), actor]));
        const changedKeys = new Set();
        const actors = changes.reset ? (changes.actors || []) : (changes.upserts || []);

        if (changes.reset) {
            bots.clear();
            players.clear();
        }
        actors.forEach((actor) => {
            const target = actor.kind === 'player' ? players : bots;
            target.set(Number(actor.id), withoutKind(actor));
            changedKeys.add(actorKey(actor));
        });
        if (!changes.reset) {
            (changes.removals || []).forEach((actor) => {
                const target = actor.kind === 'player' ? players : bots;
                if (target.delete(Number(actor.id))) changedKeys.add(actorKey(actor));
            });
        }

        return {
            revision: Number(changes.revision || 0),
            changedKeys,
            snapshot: {
                ...snapshot,
                generatedAt,
                bots: [...bots.values()],
                players: [...players.values()]
            }
        };
    }

    return { actorKey, applyChanges, decodeBootstrap };
}));

// Observer-only read projection. Never attach this to the population/map feed.
const CACHE_MS = 5000;
const cache = new Map();
const names = new Map();
const trim = (map, limit) => { while (map.size > limit) map.delete(map.keys().next().value); };
const scores = row => row && Object.fromEntries(['affinity', 'trust', 'hostility', 'fear'].map(k => [k, row[k] || 0]));

async function identities(ids) {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const result = new Map(), missing = [], now = Date.now();
    for (const id of ids) {
        const state = Life.cachedState(id);
        if (state) result.set(id, { name: state.name, actorKind: 'bot' });
        else if (names.get(id)?.until > now) result.set(id, names.get(id).value);
        else missing.push(id);
    }
    if (missing.length) {
        const rows = await invoke('Database').execute([
            `SELECT id,name,username FROM characters WHERE id IN (${missing.map(() => '?').join(',')})`, missing
        ], 'observer:relationship-names');
        const found = new Map(rows.map(r => [Number(r.id), { name: r.name,
            actorKind: String(r.username || '').startsWith('bot_') ? 'bot' : 'player' }]));
        for (const id of missing) {
            const value = found.get(id) || { name: `Character #${id}`, actorKind: null };
            names.delete(id); names.set(id, { value, until: now + 60000 });
            result.set(id, value);
        }
        trim(names, 512);
    }
    return result;
}

async function build(id) {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const hot = invoke('GameServer/Bot/BotManager').findSessionById(id);
    const state = Life.cachedState(id) || (!hot?.actor && await Life.findByCharacterId(id));
    if (!state && !hot?.actor) return null;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    await memory.ensureMany([id]);
    const at = Date.now(), view = memory.inspect(id, at);
    const rows = view.relations.filter(row => row.kind === 'character').slice(0, 32);
    const targets = await identities(rows.map(row => row.targetId));
    return { ownerId: id, ready: view.ready, revision: view.revision, generatedAt: at,
        relations: rows.map(row => {
            const relation = memory.assess({ id }, { id: row.targetId }, {}, at);
            const clan = relation.clanSocial;
            return { targetId: row.targetId, ...targets.get(row.targetId), disposition: relation.disposition,
                personal: scores(row), reasons: row.reasons.slice(0, 3),
                sameClan: relation.sourceClanId > 0 && relation.sourceClanId === relation.targetClanId,
                clan: { ready: !!clan?.ready, id: relation.sourceClanId,
                    individual: scores(clan?.individual), collective: scores(clan?.collective),
                    effective: scores(clan?.effective) } };
        }) };
}

function detail(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve(null);
    const previous = cache.get(id);
    if (previous && (previous.pending || previous.until > Date.now())) return previous.promise;
    const entry = { pending: true, until: 0 };
    entry.promise = build(id).then(result => {
        entry.pending = false; entry.until = Date.now() + CACHE_MS;
        return result;
    }).catch(error => { if (cache.get(id) === entry) cache.delete(id); throw error; });
    cache.delete(id); cache.set(id, entry); trim(cache, 64);
    return entry.promise;
}

module.exports = { detail };

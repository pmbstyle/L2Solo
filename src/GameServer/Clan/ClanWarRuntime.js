'use strict';
const View = require('./ClanWarView');
const Rules = require('./ClanWarRules');
const TableChannel = require('../Bot/Population/ColdTableChannel').shared;
const view = new View();
let loading = null, lastRead = 0, clanRevision = -1;
const combatTimes = new Map();
TableChannel.register('clan_wars', { key: row => Rules.key(row.fromClanId, row.toClanId), allRows: () => view.all() });
function accept(row) {
    if (!row || !view.accept(row)) return false;
    TableChannel.changed('clan_wars', () => row);
    return true;
}
async function refresh(force = false) {
    const database = invoke('Database');
    if (!database.isReady()) return;
    if (loading) return loading;
    if (!force && Date.now() - lastRead < 5000) return;
    lastRead = Date.now();
    loading = (async () => {
        const cursor = view.revision, revision = invoke('GameServer/Clan/ClanService').membershipRevision();
        if (revision !== clanRevision) { await database.reconcileClanWars(); clanRevision = revision; }
        (await database.fetchClanWars(cursor)).forEach(accept);
    })().finally(() => { loading = null; });
    return loading;
}
function clanId(subject) {
    const ownerId = Number(subject?.fetchOwnerId?.() || 0);
    if (ownerId) {
        const owner = invoke('GameServer/World/World').registeredActorById?.(ownerId)?.actor;
        return owner ? Number(owner.fetchClanId?.() || 0) : 0;
    }
    return Number(subject?.fetchClanId?.() ?? subject?.clanId ?? subject?.stats?.clanId ?? 0);
}
const between = (a, b) => view.between(clanId(a), clanId(b));
function recordCombat(a, b, at = Date.now()) {
    if (invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(a)
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(b)) return;
    const from = clanId(a), to = clanId(b);
    if (!view.between(from, to).mutual) return;
    const key = Rules.pairKey(from, to);
    combatTimes.delete(key); combatTimes.set(key, at);
    while (combatTimes.size > 2048) combatTimes.delete(combatTimes.keys().next().value);
}
const combatAt = (a, b) => combatTimes.get(Rules.pairKey(a, b)) || 0;
function announce(row) {
    const Clans = invoke('GameServer/Clan/ClanService'), Response = invoke('GameServer/Network/Response');
    const a = Clans.findById(row.fromClanId), b = Clans.findById(row.toClanId);
    const text = `${a?.name || row.fromClanId} has ${row.active ? 'declared' : 'withdrawn'} war ${row.active ? 'on' : 'against'} ${b?.name || row.toClanId}.`;
    for (const clan of [a, b].filter(Boolean)) for (const session of Clans.onlineSessions(clan)) {
        if (session.actor) session.dataSendToMe(Response.speak(session.actor, { kind: 10, text }));
    }
    // Relation masks belong to the viewer. Send each visible pair its own packet.
    const World = invoke('GameServer/World/World');
    for (const session of World.user?.sessions || []) {
        if (!session.actor || World.isBotSession?.(session)) continue;
        const visible = World.fetchVisibleUsers?.(session, session.actor) || [];
        for (const other of visible) if (other.actor && [row.fromClanId, row.toClanId].includes(clanId(other.actor))) {
            session.dataSendToMe(Response.relationChanged(other.actor, session.actor));
        }
    }
}
async function transition(actor, targetClanId, action, options = {}) {
    const actorId = Number(actor?.fetchId?.() || 0), ownClanId = clanId(actor);
    const result = await invoke('Database').transitionClanWar({ actorId, targetClanId, action,
        expectedRevision: options.expectedRevision, autonomous: options.autonomous === true, reason: options.reason }, () => {
        if (clanId(actor) !== ownClanId || actor.fetchId() !== actorId || options.admit && !options.admit()) return 'actor_changed';
        if (action === 'withdraw' && invoke('GameServer/Clan/ClanService').onlineSessions({ id: ownClanId })
            .some(s => s.actor?.state?.fetchCombats?.() || s.actor?.state?.fetchHits?.() || s.actor?.state?.fetchCasts?.())) return 'clan_in_combat';
        return true;
    });
    if (result.ok && result.changed) { accept(result.row); if (options.announce !== false) announce(result.row); }
    return result;
}
function inspect() {
    return { revision: view.revision, declarations: view.all().filter(r => r.active).map(r => ({ ...r,
        ...view.between(r.fromClanId, r.toClanId) })) };
}
module.exports = { view, accept, refresh, clanId, between, transition, inspect, recordCombat, combatAt };

const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Arena = invoke('GameServer/World/ArenaCombatRules');

const MEMORY_MS = 15000;
const PARTY_RADIUS = 1800;
const MAX_AGGRESSORS = 32;

const id = actor => Number(actor?.fetchId?.() || 0);
const alive = actor => !!actor && actor.fetchIsOnline?.() !== false && !actor.isDead?.() && !actor.state?.fetchDead?.();
const distance = (a, b) => Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY(), (a.fetchLocZ?.() || 0) - (b.fetchLocZ?.() || 0));
const worldSessions = () => invoke('GameServer/World/World').user?.sessions || [];

function members(session) {
    const leader = session?.partyCompanion === true ? session.followPlayerSession : session;
    if (!leader) return [session];
    return [...new Set([leader, session, ...worldSessions()])].filter(candidate => (
        candidate && Risk.sameParty(session, candidate) && alive(candidate.actor)
    ));
}

function inPeace(actor) {
    return utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY());
}

function character(source) {
    if (!source?.fetchKind) return source;
    const ownerId = Number(source.fetchOwnerId?.() || 0);
    return ownerId ? worldSessions().find(session => id(session.actor) === ownerId)?.actor : null;
}

// Keep actual aggressors, not everyone flagged nearby or everyone in the
// attacker's party. A separate history per victim also survives retargeting.
function record(victim, source, now = Date.now()) {
    const attacker = character(source);
    const session = victim?.session;
    if (!session || !attacker || !id(attacker) || attacker === victim || !alive(attacker)) return false;
    if (!victim.fetchLocX || !victim.fetchLocY || !attacker.fetchLocX || !attacker.fetchLocY) return false;
    if (Arena.isArenaParticipant(victim) || Arena.isArenaParticipant(attacker) ||
        !Arena.canInteract(attacker, victim) || inPeace(victim) || inPeace(attacker)) return false;
    const party = members(session);
    if (party.some(member => id(member.actor) === id(attacker))) return false;
    // Wake the whole nearby defending party, including when its human leader
    // is hit. Damage wake coalescing bounds this independently per member.
    for (const member of party) {
        if (distance(member.actor, victim) > PARTY_RADIUS) continue;
        // Share the evidence before death cleanup can remove a fallen
        // member. Surviving allies still defend against the killing blow.
        const history = member.pvpAggressors || (member.pvpAggressors = new Map());
        history.delete(id(attacker));
        history.set(id(attacker), { at: now, victimId: id(victim) });
        while (history.size > MAX_AGGRESSORS) history.delete(history.keys().next().value);
        if (!member.aiActive || !String(member.accountId || '').startsWith('bot_')) continue;
        if (now - Number(member.lastPvpWakeAt || 0) < 750) continue;
        member.lastPvpWakeAt = now;
        invoke('GameServer/Bot/BotAI').promoteForPlayerInteraction(member, 'party_pvp_damage');
    }
    return true;
}

function context(session, now = Date.now()) {
    const party = members(session);
    const nearby = party.filter(member => distance(member.actor, session.actor) <= PARTY_RADIUS);
    const partyIds = new Set(party.map(member => id(member.actor)));
    const users = new Map(worldSessions().map(member => [id(member.actor), member.actor]));
    const found = new Map();
    for (const member of nearby) {
        for (const [attackerId, entry] of member.pvpAggressors || []) {
            const attacker = users.get(attackerId);
            if (!alive(attacker) || partyIds.has(attackerId) || inPeace(attacker) ||
                now - entry.at > MEMORY_MS || !nearby.some(ally => distance(ally.actor, attacker) <= PARTY_RADIUS)) {
                member.pvpAggressors.delete(attackerId);
                continue;
            }
            if (Arena.canInteract(session.actor, attacker) && !inPeace(session.actor)) found.set(attackerId, { actor: attacker, ...entry });
        }
    }
    const threats = [...found.values()].sort((a, b) => Risk.combatStrength(a.actor).power - Risk.combatStrength(b.actor).power || id(a.actor) - id(b.actor));
    const leaderId = Number(session.coldLifeState?.party?.leaderId || 0);
    const owner = session.partyCompanion === true ? session.followPlayerSession
        : party.find(member => id(member.actor) === leaderId) || [...party].sort((a, b) => id(a.actor) - id(b.actor))[0] || session;
    return { members: nearby, threats, owner };
}

module.exports = { record, context, members, character, alive, distance, inPeace, MEMORY_MS, PARTY_RADIUS };

const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Arena = invoke('GameServer/World/ArenaCombatRules');

const MEMORY_MS = 15000;
const PARTY_RADIUS = 1800;
const MAX_AGGRESSORS = 32;

const id = actor => Number(actor?.fetchId?.() || 0);
const alive = actor => !!actor && actor.fetchIsOnline?.() !== false && !actor.isDead?.() && !actor.state?.fetchDead?.();
const distance = (a, b) => Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY(), (a.fetchLocZ?.() || 0) - (b.fetchLocZ?.() || 0));
const index = () => invoke('GameServer/Bot/AI/BotPvpIndex');

function members(session, { includeDead = false } = {}) {
    if (!session) return [];
    const leader = session?.partyCompanion === true ? session.followPlayerSession : session;
    if (!leader) return [session];
    return index().members(session).filter(candidate => (
        candidate && Risk.sameParty(session, candidate) && (includeDead || alive(candidate.actor))
    ));
}

function inPeace(actor) {
    return utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY());
}

function character(source) {
    if (!source?.fetchKind) return source;
    const ownerId = Number(source.fetchOwnerId?.() || 0);
    return ownerId ? index().actor(ownerId) : null;
}

function protectedTarget(session, target, now = Date.now()) {
    const Effects = invoke('GameServer/Effects/EffectStore');
    if (Effects.list(target).some(effect => ['sleep', 'fear'].includes(effect.key) || ['sleep', 'fear'].includes(effect.category))) return true;
    // A companion party keeps its coordinator when the human leader dies.
    // Its living casters still own pending reservations stored on that session.
    return members(session, { includeDead: true }).some(member => ['sleep', 'fear'].some(effect =>
        Number(member.pvpControlClaims?.get(`${id(target)}:${effect}`) || 0) > now));
}

function focus(session, context, now = Date.now()) {
    const target = context.threats.find(entry => !protectedTarget(session, entry.actor, now))?.actor || null;
    context.owner.pvpFocus = target ? { id: id(target), at: now } : null;
    return target;
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
    if (Risk.sameParty(session, attacker.session) || party.some(member => id(member.actor) === id(attacker))) return false;
    // Keep an existing encounter alive while either side acts. This does
    // not invent an incoming attack or remember a victim as an aggressor.
    for (const member of members(attacker.session)) {
        const entry = member.pvpAggressors?.get(id(victim));
        if (entry && distance(member.actor, attacker) <= PARTY_RADIUS) entry.at = now;
    }
    const changed = invoke('GameServer/Social/PvpResponsibility').record(attacker, victim,
        party.filter(member => distance(member.actor, victim) <= PARTY_RADIUS), now);
    const remembered = invoke('GameServer/Bot/AI/BotEnemyMemory').record(victim, attacker, false, now);
    for (const member of changed) {
        if (member === session && remembered) continue; // The accepted enemy write includes the new causal fact.
        if (String(member.accountId || '').startsWith('bot_')) invoke('GameServer/Bot/Population/BotLifeState').rememberEnemies(member);
    }
    invoke('GameServer/Bot/AI/BotRevenge').onAttack(attacker, victim, now);
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
    const found = new Map();
    for (const member of nearby) {
        for (const [attackerId, entry] of member.pvpAggressors || []) {
            const attacker = index().actor(attackerId);
            if (!alive(attacker) || partyIds.has(attackerId) || inPeace(attacker) ||
                now - entry.at > MEMORY_MS || !nearby.some(ally => distance(ally.actor, attacker) <= PARTY_RADIUS)) {
                member.pvpAggressors.delete(attackerId);
                continue;
            }
            if (Arena.canInteract(session.actor, attacker) && !inPeace(session.actor)) found.set(attackerId, { actor: attacker, ...entry });
        }
    }
    const revengeTarget = session.pvpRevenge?.target;
    if (revengeTarget && invoke('GameServer/Bot/AI/BotRevenge').allows(session, revengeTarget, now)) {
        found.set(id(revengeTarget), { actor: revengeTarget, at: now, proactive: true });
    }
    const threats = [...found.values()].map(entry => ({ ...entry, power: Risk.combatStrength(entry.actor).power }))
        .sort((a, b) => a.power - b.power || id(a.actor) - id(b.actor));
    const leaderId = Number(session.coldLifeState?.party?.leaderId || 0);
    const owner = session.partyCompanion === true ? session.followPlayerSession
        : party.find(member => id(member.actor) === leaderId) || [...party].sort((a, b) => id(a.actor) - id(b.actor))[0] || session;
    return { members: nearby, threats, owner };
}

function canDefendWhileChaotic(session, target, now = Date.now()) {
    if (!(session?.actor?.fetchKarma?.() > 0)) return false;
    const entry = session.pvpAggressors?.get(id(target));
    return !!entry && now - entry.at <= MEMORY_MS && alive(target) &&
        distance(session.actor, target) <= PARTY_RADIUS;
}

module.exports = { record, context, members, character, alive, distance, inPeace, focus, protectedTarget, canDefendWhileChaotic, MEMORY_MS, PARTY_RADIUS };

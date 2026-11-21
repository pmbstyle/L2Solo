const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Threats = require('./BotPvpThreats');
const Awareness = require('./PartyAwareness');
const Arena = require('../../World/ArenaCombatRules');

const RADIUS = 2500;
const MAX_SIGHT_CHECKS = 24; // Per category, with known threats checked first.
const MAX_ROWS = 6;

function point(actor) {
    return [actor.fetchLocX?.(), actor.fetchLocY?.(), actor.fetchLocZ?.()];
}

function available(session) {
    const actor = session?.actor;
    return !!actor && !session.populationStaging && actor.fetchIsOnline?.() === true
        && Threats.alive(actor) && point(actor).every(Number.isFinite);
}

function sightings(origin, observer, candidates) {
    const nearby = [];
    for (const candidate of candidates) {
        const { actor } = candidate;
        const destination = point(actor);
        if (!destination.every(Number.isFinite) || !Awareness.withinCombatHeight(observer, actor)) continue;
        const distance = Math.hypot(...destination.map((value, index) => value - origin[index]));
        if (distance <= RADIUS) nearby.push({ ...candidate, destination, distance });
    }
    nearby.sort((a, b) => Number(!!b.threat) - Number(!!a.threat) || a.distance - b.distance
        || Number(a.actor.fetchId?.()) - Number(b.actor.fetchId?.()));
    const visible = nearby.slice(0, MAX_SIGHT_CHECKS)
        .filter(({ destination }) => Geodata.hasLineOfSight(...origin, ...destination));
    return { visible, limited: nearby.length > MAX_SIGHT_CHECKS };
}

function npcThreat(actor, npc, members, recent) {
    const target = members.get(Number(npc.fetchDestId?.()));
    if (target && Awareness.withinCombatHeight(target, npc)) {
        return target === actor ? 'targeting_you' : 'targeting_your_party';
    }
    if (npc === recent) return 'recently_hit_you';
    return Number(npc.getHating?.(actor) || 0) > 0 ? 'has_aggro_on_you' : null;
}

function groupMobs(visible) {
    const groups = new Map();
    for (const { actor, distance } of visible) {
        const name = actor.fetchName();
        const level = actor.fetchLevel?.();
        const raidBoss = actor.fetchIsRaidBoss?.() === true;
        const hostile = actor.fetchHostile?.() === true;
        const key = JSON.stringify([name, level, raidBoss, hostile]);
        const group = groups.get(key);
        if (group) {
            group.count++;
            group.nearest = Math.min(group.nearest, Math.round(distance));
        } else {
            groups.set(key, { name, level, raidBoss, hostile, count: 1, nearest: Math.round(distance) });
        }
    }
    return [...groups.values()].sort((a, b) => a.nearest - b.nearest);
}

function read(session) {
    if (!available(session)) return { ok: false, reason: 'local_view_unavailable' };
    const actor = session.actor;
    const origin = point(actor);
    const World = invoke('GameServer/World/World');
    const pvp = Threats.context(session, Date.now(), { observeOnly: true });
    const aggressors = new Map(pvp.threats.map(entry => [entry.actor, entry.victimId]));
    const members = new Map(pvp.members.map(({ actor: member }) => [Number(member.fetchId()), member]));
    const actorId = Number(actor.fetchId());
    members.set(actorId, actor);
    const recent = Awareness.recentIncomingNpc(session, RADIUS);
    const people = sightings(origin, actor, World.fetchVisibleUsers(session, actor)
        .filter(candidate => !candidate.populationStaging && Threats.alive(candidate.actor) && Arena.canInteract(actor, candidate.actor))
        .map(candidate => ({
            actor: candidate.actor, kind: World.isBotSession(candidate) ? 'bot' : 'player',
            threat: !aggressors.has(candidate.actor) ? null
                : Number(aggressors.get(candidate.actor)) === actorId ? 'recently_attacked_you' : 'recently_attacked_your_party'
        })));
    const npcs = sightings(origin, actor, World.fetchNpcsInRadius(origin[0], origin[1], RADIUS)
        .filter(npc => npc.fetchAttackable?.() === true && Threats.alive(npc) && !npc.fetchIsPet?.()
            && !npc.fetchIsSummon?.() && Arena.canInteract(actor, npc))
        .map(npc => ({ actor: npc, kind: 'mob', threat: npcThreat(actor, npc, members, recent) })));
    const mobs = groupMobs(npcs.visible);
    const threats = [...people.visible, ...npcs.visible].filter(entry => entry.threat)
        .sort((a, b) => a.distance - b.distance);
    const entity = ({ actor: seen, kind, distance }) => ({ name: seen.fetchName(), kind, distance: Math.round(distance) });
    return {
        ok: true, source: 'local_observation', radius: RADIUS,
        people: people.visible.slice(0, MAX_ROWS).map(entity),
        mobs: mobs.slice(0, MAX_ROWS),
        danger: threats.length ? 'confirmed' : 'none_seen',
        threats: threats.slice(0, MAX_ROWS).map(entry => ({ ...entity(entry), evidence: entry.threat })),
        limited: people.limited || npcs.limited || people.visible.length > MAX_ROWS || mobs.length > MAX_ROWS || threats.length > MAX_ROWS
    };
}

module.exports = { available, read };

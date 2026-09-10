const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('./InteractionMemoryPolicy');

const ATTACK_WINDOW_MS = 60000;
const episodes = new WeakMap();

// Called only for hostile actions/damage/death accepted by the native PvP path.
// Keep this independent of the three-slot revenge shortlist: a fourth
// aggressor still belongs in the wider personal relationship memory.
function record(session, targetId, killed, at, enemies = [], attacker = null) {
    const sourceId = Number(session?.actor?.fetchId?.());
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(targetId)
        || targetId <= 0 || sourceId === targetId || !Number.isSafeInteger(at) || at < 0) return false;
    const type = killed ? 'killed' : 'attacked';
    const encounter = session.pvpEncounter;
    const attach = (event, episode) => {
        const responsibility = encounter ? (encounter.sides[encounter.reason === 'revenge' ? 0 : 1].memberIds.includes(targetId)
            ? encounter.reason === 'revenge' ? 'aggression' : 'provoked' : 'defense')
            : attacker?.session?.pvpDefense ? 'defense'
                : attacker?.session?.pvpRevenge?.reason === 'mob_competition' ? 'provoked'
                    : attacker?.session?.pvpRevenge ? 'aggression' : 'unknown';
        return attacker ? require('../Clan/ClanSocialEvidence').attach(event, session.actor, attacker, episode, responsibility) : event;
    };
    if (encounter && encounter.sides.some(s => s.memberIds.includes(targetId))
        && encounter.sides.some(s => s.memberIds.includes(sourceId) && !s.memberIds.includes(targetId))) {
        const incident = `${sourceId}:${targetId}:${type}`;
        if (encounter.seen.includes(incident)) return false;
        const accepted = Memory.events.enqueue(attach({ key: `${encounter.key}:${incident}`, sourceId, targetId, type, at: encounter.startedAt }, encounter.key));
        if (accepted) encounter.seen.push(incident);
        return accepted;
    }
    const key = `${targetId}:${type}`;
    let recent = episodes.get(session);
    if (!recent) { recent = new Map(); episodes.set(session, recent); }
    let previous = recent.get(key);
    if (!previous) {
        const relation = Memory.views.get(sourceId)?.relation('character', targetId, at);
        const saved = Math.max(-1, ...(relation?.reasons || []).filter(r => r.type === type).map(r => r.at),
            ...(!killed ? enemies.filter(e => e.id === targetId && e.attacks).map(e => e.lastAttackAt) : []));
        if (saved >= 0) previous = { at: saved, accepted: true };
    }
    if (previous?.accepted && (killed ? at <= previous.at : at - previous.at < ATTACK_WINDOW_MS)) return false;
    // Queue pressure must not consume the incident or change its retry key.
    const eventAt = previous && !previous.accepted ? previous.at : at;
    const episode = attacker?.session?.pvpRevenge?.startedAt || attacker?.session?.pvpRevenge?.expiresAt || Math.floor(eventAt / ATTACK_WINDOW_MS);
    const event = previous?.event || attach({ key: `pvp:${type}:${sourceId}:${targetId}:${eventAt}`, sourceId, targetId, type, at: eventAt },
        `hot:${Math.min(sourceId, targetId)}:${Math.max(sourceId, targetId)}:${episode}`);
    const accepted = Memory.events.enqueue(event);
    recent.delete(key);
    recent.set(key, { at: eventAt, accepted, ...(accepted ? {} : { event }) });
    while (recent.size > Policy.LIMITS.character * 2) recent.delete(recent.keys().next().value);
    return accepted;
}

module.exports = { record, ATTACK_WINDOW_MS };

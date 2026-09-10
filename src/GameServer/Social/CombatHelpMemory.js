const { attach } = require('../Clan/ClanSocialEvidence');
const pending = new WeakMap();
function record(helper, target, result, before, at = Date.now()) {
    const session = target?.session, sourceId = Number(target?.fetchId?.()), targetId = Number(helper?.fetchId?.());
    if (!String(session?.accountId || '').startsWith('bot_') || session.staticService || session.arenaEphemeral
        || !sourceId || !targetId || sourceId === targetId || helper?.fetchKind || target?.fetchKind
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(helper)
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(target)) return false;
    const type = result.resurrected === true && !target.state.fetchDead() ? 'resurrected'
        : result.heal > 0 && before.hp > 0 && before.hp < before.maxHp * 0.4 && before.combat ? 'healed' : null;
    if (!type) return false;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const relation = memory.views.get(sourceId)?.relation('character', targetId, at);
    if (relation?.reasons.some(r => r.type === type && at - r.at < 1800000)) return false;
    let queued = pending.get(session);
    if (!queued) { queued = new Map(); pending.set(session, queued); }
    const key = `${targetId}:${type}`, previous = queued.get(key);
    if (previous?.accepted && at - previous.event.at < 1800000) return false;
    const event = previous && !previous.accepted ? previous.event : attach({ key: `help:${sourceId}:${targetId}:${type}:${at}`,
        sourceId, targetId, type, at }, target, helper, `help:${sourceId}:${targetId}:${Math.floor(at / 1800000)}`, 'cooperation', true);
    const accepted = memory.events.enqueue(event);
    queued.delete(key); queued.set(key, { event, accepted });
    while (queued.size > 32) queued.delete(queued.keys().next().value);
    return accepted;
}
module.exports = { record };

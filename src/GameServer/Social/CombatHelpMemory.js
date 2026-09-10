const { attach } = require('../Clan/ClanSocialEvidence');
const Policy = require('./CombatHelpPolicy');
const pending = new WeakMap();
const threats = new WeakMap();
function record(helper, target, result, before, at = Date.now()) {
    const type = result.resurrected === true && target?.fetchHp?.() > 0 && !target?.state?.fetchDead?.() ? 'resurrected'
        : result.heal > 0 && before?.combat && Policy.meaningfulHeal(before.hp, target?.fetchHp?.(), before.maxHp) ? 'healed' : null;
    return type ? remember(helper, target, type, at) : false;
}
function remember(helper, target, type, at) {
    const session = target?.session, sourceId = Number(target?.fetchId?.()), targetId = Number(helper?.fetchId?.());
    if (!String(session?.accountId || '').startsWith('bot_') || session.staticService || session.arenaEphemeral
        || !sourceId || !targetId || sourceId === targetId || helper?.fetchKind || target?.fetchKind
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(helper)
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(target)) return false;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const relation = memory.views.get(sourceId)?.relation('character', targetId, at);
    if (!Policy.eligible(relation, type, at)) return false;
    let queued = pending.get(session);
    if (!queued) { queued = new Map(); pending.set(session, queued); }
    const key = `${targetId}:${type}`, previous = queued.get(key);
    if (previous?.accepted && at - previous.event.at < Policy.COOLDOWN_MS) return false;
    const event = previous && !previous.accepted ? previous.event : attach({ key: `help:${sourceId}:${targetId}:${type}:${at}`,
        sourceId, targetId, type, at }, target, helper, `help:${sourceId}:${targetId}:${Math.floor(at / Policy.COOLDOWN_MS)}`, 'cooperation', true);
    const accepted = memory.events.enqueue(event);
    queued.delete(key); queued.set(key, { event, accepted });
    while (queued.size > 32) queued.delete(queued.keys().next().value);
    return accepted;
}
function recordDamage(threat, victim, damage, at = Date.now()) {
    if (!(damage > 0) || !threat || threat === victim || victim?.fetchKind
        || !String(victim?.session?.accountId || '').startsWith('bot_') || victim.fetchHp?.() <= 0) return;
    if (invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(victim)) return;
    const current = threats.get(threat);
    if (current?.victim.deref() === victim) current.at = at;
    else threats.set(threat, { victim: new WeakRef(victim), victimId: Number(victim.fetchId()), at });
}
function threatSnapshot(threat, at = Date.now()) {
    const recent = threats.get(threat);
    const saved = threat?.session?.coldLifeState?.stats?.coldPvp;
    const victimId = recent?.victimId || Number(saved?.lastVictimId || 0);
    const time = recent?.at ?? Number(saved?.lastVictimAt || 0);
    return victimId && time <= at && at - time < Policy.THREAT_MS ? { lastVictimId: victimId, lastVictimAt: time }
        : { lastVictimId: 0, lastVictimAt: 0 };
}
function recordDefeat(helper, threat, at = Date.now()) {
    if (!helper || !threat || !(threat.fetchHp?.() <= 0) || threat.fetchIsRaidBoss?.() || threat.minionBossObjectId) return false;
    const saved = threatSnapshot(threat, at);
    const victim = threats.get(threat)?.victim.deref()
        || (saved.lastVictimId ? invoke('GameServer/Bot/AI/BotPvpIndex').actor(saved.lastVictimId) : null);
    const character = invoke('GameServer/Bot/AI/BotPvpThreats').character(helper);
    if (!saved.lastVictimId || !victim || !character || victim === character || victim.fetchIsOnline?.() === false
        || !Policy.injured(victim.fetchHp?.(), victim.fetchMaxHp?.())
        || !(Math.hypot(character.fetchLocX?.() - victim.fetchLocX?.(), character.fetchLocY?.() - victim.fetchLocY?.(),
            character.fetchLocZ?.() - victim.fetchLocZ?.()) <= 1800)) return false;
    return remember(character, victim, 'helped_in_combat', at);
}
module.exports = { record, recordDamage, recordDefeat, threatSnapshot };

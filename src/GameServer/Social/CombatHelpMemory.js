const { attach } = require('../Clan/ClanSocialEvidence');
const Policy = require('./CombatHelpPolicy');
const Aid = require('./OpponentAidPolicy');
const pending = new WeakMap();
const threats = new WeakMap();
function record(helper, target, result, before, at = Date.now()) {
    const type = result.resurrected === true && target?.fetchHp?.() > 0 && !target?.state?.fetchDead?.() ? 'resurrected'
        : result.heal > 0 && before?.combat && Policy.meaningfulHeal(before.hp, target?.fetchHp?.(), before.maxHp) ? 'healed' : null;
    if (!type) return false;
    const grateful = remember(helper, target, type, at);
    const offended = recordOpponentAid(helper, target, at);
    return grateful || offended;
}
function remember(helper, target, type, at, responsibility = 'cooperation', episode = null) {
    const session = target?.session, sourceId = Number(target?.fetchId?.()), targetId = Number(helper?.fetchId?.());
    if (!String(session?.accountId || '').startsWith('bot_') || session.staticService || session.arenaEphemeral
        || !sourceId || !targetId || sourceId === targetId || helper?.fetchKind || target?.fetchKind
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(helper)
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(target)) return false;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const relation = memory.views.get(sourceId)?.relation('character', targetId, at);
    if (type === 'aided_opponent' ? !Aid.eligible(relation, at) : !Policy.eligible(relation, type, at)) return false;
    let queued = pending.get(session);
    if (!queued) { queued = new Map(); pending.set(session, queued); }
    const key = `${targetId}:${type}`, previous = queued.get(key);
    if (previous?.accepted && at - previous.event.at < Policy.COOLDOWN_MS) return false;
    const event = previous && !previous.accepted ? previous.event : attach({ key: `help:${sourceId}:${targetId}:${type}:${at}`,
        sourceId, targetId, type, at }, target, helper, episode || `help:${sourceId}:${targetId}:${Math.floor(at / Policy.COOLDOWN_MS)}`, responsibility, true);
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
    // A summon owner's received healing also supports the owner's actual victim.
    const owner = threat.fetchKind && invoke('GameServer/Bot/AI/BotPvpThreats').character(threat);
    if (owner && owner !== threat) recordDamage(owner, victim, damage, at);
}
function recordOpponentAid(helper, recipient, at) {
    if (!helper || !recipient || helper === recipient || helper.fetchKind || recipient.fetchKind
        || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(recipient)) return false;
    const saved = threatSnapshot(recipient, at);
    const id = Aid.victimId(saved, Number(helper.fetchId?.()), at);
    if (!id) return false;
    const victim = threats.get(recipient)?.victim.deref() || invoke('GameServer/Bot/AI/BotPvpIndex').actor(id);
    if (!victim || Number(victim.fetchId?.()) !== id || victim.fetchIsOnline?.() === false || !(victim.fetchHp?.() > 0)
        || !(Math.hypot(recipient.fetchLocX?.() - victim.fetchLocX?.(), recipient.fetchLocY?.() - victim.fetchLocY?.(),
            recipient.fetchLocZ?.() - victim.fetchLocZ?.()) <= 1800)) return false;
    const targetId = Number(recipient.fetchId?.()), encounter = recipient.session?.pvpEncounter;
    const side = encounter?.sides.findIndex(s => s.memberIds.includes(targetId));
    const opposed = side >= 0 && encounter.sides.some((s, i) => i !== side && s.memberIds.includes(id));
    const responsibility = opposed ? side === (encounter.reason === 'revenge' ? 0 : 1)
        ? encounter.reason === 'revenge' ? 'aggression' : 'provoked' : 'defense'
        : recipient.session?.pvpDefense ? 'defense' : 'unknown';
    return remember(helper, victim, 'aided_opponent', at, responsibility, opposed ? encounter.key : null);
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

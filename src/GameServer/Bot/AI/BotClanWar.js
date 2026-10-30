'use strict';
const War = invoke('GameServer/Clan/ClanWarRuntime');
function tryStart(session, now = Date.now()) {
    const bot = session?.actor;
    if (!require('../../Clan/ClanWarConfig').enabled || !bot || !War.view.hasMutual(War.clanId(bot))
        || session.partyCompanion || session.followPlayerSession || session.staticService || session.arenaEphemeral
        || session.pvpDefense || session.pvpRevenge || session.pendingPvpProvocation || session.pvpEncounter
        || !['hunting', 'following', 'resting'].includes(session.plan)
        || now < Number(session.nextClanWarScanAt || 0)
        || invoke('GameServer/Bot/Population/PopulationConfig').pvpAggression <= 0
        || !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(bot)) return false;
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    if (Threats.inPeace(bot) || invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(bot)) return false;
    session.nextClanWarScanAt = now + 5000;
    const targets = (invoke('GameServer/World/World').fetchVisibleUsers(session, bot) || []).map(s => s.actor).filter(target =>
        target && target !== bot && Threats.alive(target) && War.between(bot, target).mutual
        && Threats.distance(bot, target) <= 900 && !Threats.inPeace(target)
        && !invoke('GameServer/Bot/AI/BotPvpRisk').sameParty(session, target.session)
        && invoke('GameServer/World/ArenaCombatRules').canInteract(bot, target));
    if (!targets.length) return false;
    const target = targets.sort((a, b) => Threats.distance(bot, a) - Threats.distance(bot, b))[0];
    const mayJoin = member => member === session || String(member.accountId || '').startsWith('bot_')
        && !member.partyCompanion && !member.followPlayerSession && !member.staticService && !member.arenaEphemeral
        && !member.pvpDefense && !member.pvpRevenge && !member.pvpEncounter
        && invoke('GameServer/Bot/AI/BotRevenge').eligible(member, target)
        && War.between(member.actor, target).mutual && Threats.distance(bot, member.actor) <= Threats.PARTY_RADIUS;
    const decision = invoke('GameServer/Bot/AI/BotPvpRisk').defenseDecision(session, [target], {
        key: ['clan_war', bot.fetchId(), target.fetchId(), War.between(bot, target).revision, Math.floor(now / 30000)],
        allyAllowed: mayJoin });
    if (decision.action !== 'fight') return false;
    session.pvpRevenge = { target, initiator: session, reason: 'clan_war', expiresAt: now + 30000 };
    // Only tagged enemies grant first-strike participation to the tagged party members.
    for (const member of Threats.members(session)) if (member !== session && mayJoin(member)) {
        member.pvpRevenge = { target, initiator: session, reason: 'clan_war', expiresAt: now + 30000 };
    }
    return true;
}
module.exports = { tryStart };

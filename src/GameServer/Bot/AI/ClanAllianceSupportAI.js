const Service = invoke('GameServer/Clan/ClanAllianceService');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');

function leaderFor(session) {
    const leader = session.followPlayerSession?.actor;
    if (!session.partyCompanion || !leader || leader.isDead?.() || leader.fetchIsOnline?.() === false
        || !leader.effects?.clan_alliance_poison) return null;
    if (!['healer', 'buffer'].includes(Roles.inferRole(session.actor))) return null;
    const state = Service.records.get(Service.clanOf(session.followPlayerSession));
    if (!['gathering', 'cured'].includes(state?.stage) || state.leaderId !== leader.fetchId()) return null;
    const member = state.members.find(m => m.id === Service.idOf(session));
    if (member && (!member.delivered || member.blood && !member.bloodDelivered)) return null;
    return leader;
}

function seated(session, bot, value) {
    if (bot.state.fetchSeated?.() === value) return;
    bot.state.setSeated(value);
    session.dataSendToOthers?.(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
}

function tick(session, bot, Generics) {
    const leader = leaderFor(session);
    if (!leader || bot.isDead?.()) {
        if (session.clanAllianceSupportLeaderId) {
            delete session.clanAllianceSupportLeaderId;
            delete session.clanAllianceSupportRetryAt;
        }
        return false;
    }
    if (session.clanAllianceSupportLeaderId !== leader.fetchId()) {
        session.clanAllianceSupportLeaderId = leader.fetchId();
        bot.attack?.abortCast?.(session, bot);
        bot.attack?.clearTimers?.();
        bot.state.setCasts?.(false);
        bot.state.setHits?.(false);
        bot.automation?.abortAll?.(bot);
        invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, bot);
        session.pendingSupportApproach = undefined;
        session.pendingPartyChatResult = undefined;
        session.currentTargetId = undefined;
        session.returnToPartyAfterSupport = false;
        if (session.spotRelocation) invoke('GameServer/Bot/AI/BotSpotTravel').cancel(session, bot, 'poisoned_leader');
        const attempt = session.followPlayerSession.partyRevivalAttempt;
        if (attempt?.providerId === bot.fetchId()) session.followPlayerSession.partyRevivalAttempt = null;
        bot.unselect?.();
    }
    session.plan = 'following';
    session.intent = 'support_poisoned_leader';
    const decision = (action, reason) => {
        session.roleDecision = { role: Roles.inferRole(bot), action, reason, targetId: leader.fetchId(), at: Date.now() };
    };
    if (bot.state.fetchCasts?.()) return true;
    const impairments = invoke('GameServer/Effects/EffectStore').impairments(bot);
    if (impairments.disabled) { decision('cannot_heal', 'debuff_control'); return true; }
    const distance = Math.hypot(bot.fetchLocX() - leader.fetchLocX(), bot.fetchLocY() - leader.fetchLocY(), bot.fetchLocZ() - leader.fetchLocZ());
    const hp = leader.fetchHp() / Math.max(1, leader.fetchMaxHp());
    const available = Capabilities.healSkills(bot).filter(skill => skill.fetchTargetKind() === 'friendly'
        && bot.canUseSkill?.(skill) !== false && bot.fetchMp() >= Number(skill.fetchConsumedMp?.() || 0));
    const preferred = Capabilities.selectHealSkill(bot, { emergency: hp < 0.45 });
    const skill = available.includes(preferred) ? preferred : available[0];
    if (hp < 0.85 && skill && !impairments.silenced && distance <= Number(skill.fetchDistance())) {
        if (Date.now() < Number(session.clanAllianceSupportRetryAt || 0)) return true;
        bot.automation?.abortAll?.(bot);
        seated(session, bot, false);
        session.currentTargetId = leader.fetchId();
        bot.select?.({ id: leader.fetchId() });
        session.clanAllianceSupportRetryAt = Date.now() + 1000;
        Generics.skillExec(session, bot, { id: leader.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });
        decision('heal_party', 'poisoned_leader');
        return true;
    }
    const approachRadius = skill ? Math.min(200, Math.max(32, Number(skill.fetchDistance()) - 32)) : 200;
    if (distance > Math.max(250, approachRadius) || hp < 0.85 && skill && distance > Number(skill.fetchDistance())) {
        seated(session, bot, false);
        Navigation.move(session, bot, Service.loc(leader), 'poisoned_leader', { targetActor: leader, arrivalRadius: approachRadius });
        decision('follow_leader', 'poisoned_leader');
        return true;
    }
    bot.automation?.abortAll?.(bot);
    session.currentTargetId = undefined;
    const recoverMp = bot.fetchMp() < bot.fetchMaxMp() * 0.8;
    seated(session, bot, recoverMp);
    decision(recoverMp ? 'save_mp' : 'hold_position', 'poisoned_leader');
    return true;
}

module.exports = { leaderFor, tick };

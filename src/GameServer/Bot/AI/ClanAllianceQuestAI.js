const Service = invoke('GameServer/Clan/ClanAllianceService');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
const Rules = Service.Rules;

function move(session, target, reason) {
    const actor = session.actor;
    if (Service.near(actor, target, 180)) return true;
    const destination = Service.loc(target);
    if (session.spotRelocation) { Travel.tick(session, actor); return false; }
    // Ordinary travel uses a nearby town gatekeeper, then physical movement.
    // The quest never awards progress from a travel timer or simulated fight.
    if (Math.hypot(actor.fetchLocX() - destination.locX, actor.fetchLocY() - destination.locY) > 5000) {
        const town = invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(actor);
        if (Travel.startViaTownGatekeeper(session, actor, { id: `alliance-${reason}`, name: 'clan quest destination', center: destination }, destination, town ? { townName: town } : {})) return false;
    }
    Navigation.move(session, actor, destination, `clan_alliance_${reason}`, { targetActor: target, arrivalRadius: 180 });
    return false;
}
function request(session, work) {
    if (session.clanAlliancePending) return;
    session.clanAlliancePending = true;
    Promise.resolve().then(work).catch(error => utils.infoWarn('ClanQuest', 'member task failed: %s', error.message))
        .finally(() => { session.clanAlliancePending = false; });
}
function tick(session, bot, Generics, ai) {
    if (!session.clanAllianceQuest) return false;
    const clanId = Service.clanOf(session);
    const state = Service.records.get(clanId);
    const member = state?.members?.find(m => m.id === Service.idOf(session));
    if (!Service.active(state) || !member || clanId !== session.clanAllianceQuest.clanId) {
        session.clanAllianceQuest = null;
        return false;
    }
    if (bot.isDead()) return false;
    const leader = Service.sessions().find(s => Service.idOf(s) === state.leaderId && Service.online(s));
    if (!leader || leader.actor.isDead()) return true;
    if (session.clanAlliancePending) return true;
    // Recheck authoritative membership periodically so a departure, leadership
    // transfer, or resumed game cannot leave an old assignment running.
    if (Date.now() >= Number(session.clanAllianceRefreshAt || 0)) {
        session.clanAllianceRefreshAt = Date.now() + 5000;
        request(session, () => Service.snapshot(session));
        return true;
    }
    if (bot.state.fetchCasts?.()) return true;
    const threat = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session, 2000);
    if (threat) {
        if (session.spotRelocation) Travel.cancel(session, bot, 'clan_quest_defense');
        session.currentTargetId = threat.fetchId();
        if (bot.state.fetchSeated?.()) {
            bot.state.setSeated(false);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
        }
        ai.executeCombat(session, bot, threat, Generics);
        return true;
    }
    const hp = bot.fetchHp?.() / Math.max(1, bot.fetchMaxHp?.());
    const mp = bot.fetchMp?.() / Math.max(1, bot.fetchMaxMp?.());
    if (hp < 0.35 || mp < 0.2 || session.clanAllianceRecovering && (hp < 0.85 || mp < 0.8)) {
        session.clanAllianceRecovering = true;
        bot.automation?.abortAll?.(bot);
        if (!bot.state.fetchSeated?.()) {
            bot.state.setSeated(true);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
        }
        return true;
    }
    session.clanAllianceRecovering = false;
    if (bot.state.fetchSeated?.()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
    }
    if (state.stage === 'loyalty' && !member.pledged) {
        const altar = Service.targetNpc(Rules.NPC.altar, bot);
        if (altar && move(session, altar, 'altar')) request(session, () => Service.transition(session, 'pledge'));
        return true;
    }
    const returning = state.stage === 'loyalty' || state.stage === 'cured'
        || state.stage === 'gathering' && member.herb && (!member.blood || state.bloodObtained);
    if (returning) {
        if (move(session, leader.actor, 'leader')) {
            const needsDelivery = state.stage === 'loyalty' && !member.loyaltyDelivered
                || state.stage === 'gathering' && (!member.delivered || member.blood && !member.bloodDelivered);
            if (needsDelivery) request(session, () => Service.transition(session, 'deliver'));
            else if (state.stage === 'gathering' || state.stage === 'loyalty') {
                // Once the courier has returned, normal party healing/support
                // can keep the poisoned leader alive while others are away.
                return false;
            }
        }
        return true;
    }
    if (state.stage !== 'gathering') return true;
    let target;
    if (!member.herb) target = Service.targetNpc(member.npcId, bot);
    else if (member.blood && !state.bloodObtained) {
        const athrea = Service.targetNpc(Rules.NPC.athrea, bot);
        if (state.chests?.bingo >= 4) {
            if (athrea && move(session, athrea, 'athrea')) request(session, () => Service.transition(session, 'blood'));
            return true;
        }
        if (!state.chests || state.chests.deadline <= Date.now()) {
            if (athrea && move(session, athrea, 'athrea')) request(session, () => Service.transition(session, 'chests'));
            return true;
        }
        const world = invoke('GameServer/World/World');
        target = world.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 2000)
            .filter(npc => npc.allianceChestToken === state.chests.token && Number(npc.questSpawn?.ownerId) === Service.idOf(session) && !npc.isDead())
            .sort((a, b) => Math.hypot(a.fetchLocX() - bot.fetchLocX(), a.fetchLocY() - bot.fetchLocY()) - Math.hypot(b.fetchLocX() - bot.fetchLocX(), b.fetchLocY() - bot.fetchLocY()))[0];
    }
    if (!target || target.isDead?.()) return true;
    if (!Service.near(bot, target, 1500)) { move(session, target, 'hunt'); return true; }
    if (bot.state.fetchSeated?.()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
    }
    session.currentTargetId = target.fetchId();
    session.lastDecision = { action: 'clan_quest_hunt', targetId: target.fetchId(), itemId: member.itemId, at: Date.now() };
    ai.executeCombat(session, bot, target, Generics);
    return true;
}
module.exports = { tick, move };

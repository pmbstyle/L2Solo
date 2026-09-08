const Service = invoke('GameServer/Clan/ClanAllianceService');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
const Rules = Service.Rules;

function returnLanding(session, target) {
    const geo = invoke('GameServer/Geodata/GeodataEngine');
    const center = Service.loc(target);
    const start = Service.idOf(session) % 8;
    for (const radius of [600, 400, 240]) {
        for (let i = 0; i < 8; i++) {
            const angle = (start + i) * Math.PI / 4;
            const x = Math.round(center.locX + Math.cos(angle) * radius);
            const y = Math.round(center.locY + Math.sin(angle) * radius);
            const z = geo.getHeight(x, y, center.locZ);
            if (Number.isFinite(z) && Math.abs(z - center.locZ) <= 128
                && geo.hasLineOfSight(x, y, z, center.locX, center.locY, center.locZ)) {
                return { locX: x, locY: y, locZ: z };
            }
        }
    }
    return null;
}

function travel(session, target, reason) {
    const actor = session.actor;
    session.currentTargetId = null;
    const landing = reason === 'leader' ? returnLanding(session, target) : Service.loc(target);
    if (landing) return Travel.startViaEscape(session, actor, { id: `alliance-${reason}`, name: 'clan quest destination', center: landing }, landing);
    Service.report(session, 'return_landing_blocked', 'I cannot find a safe landing near you. Please move to open ground so I can return.');
    return false;
}
function move(session, target, reason) {
    const actor = session.actor;
    if (session.spotRelocation) { Travel.tick(session, actor); return false; }
    if (Service.near(actor, target, 180)) return true;
    const destination = Service.loc(target);
    // Couriers escape to town, then take a gatekeeper to the quest target.
    // Retry transport instead of falling back to a cross-country walk.
    if (Math.hypot(actor.fetchLocX() - destination.locX, actor.fetchLocY() - destination.locY) > 1500) {
        travel(session, target, reason);
        return false;
    }
    const navigation = Navigation.move(session, actor, destination, `clan_alliance_${reason}`, { targetActor: target, arrivalRadius: 180 });
    if (navigation?.status === 'exhausted') travel(session, target, reason);
    return false;
}
function request(session, work) {
    if (session.clanAlliancePending) return;
    session.clanAlliancePending = true;
    Promise.resolve().then(work).then(result => {
        if (result?.ok === false) {
            session.clanAllianceRetryAt = Date.now() + 10000;
            Service.report(session, `blocked_${result.code}`, result.code === 'chest_retry_costs_10000_adena'
                ? 'I need 10,000 Adena to retry Athrea\'s chest trial.'
                : 'My quest step is not ready. I will recheck the assignment shortly.');
        }
    }).catch(error => {
        session.clanAllianceRetryAt = Date.now() + 10000;
        utils.infoWarn('ClanQuest', 'member task failed: %s', error.message);
    })
        .finally(() => { session.clanAlliancePending = false; });
}
function actionKey(state, member) {
    if (state.stage === 'loyalty') return !member.pledged ? 'altar' : Rules.ritualComplete(state) ? 'return_loyalty' : 'wait_ritual';
    if (!member.herb) return 'herb';
    if (!member.blood || state.bloodObtained) return 'return_ingredients';
    if (state.chests?.bingo >= 4) return 'claim_blood';
    return state.chests?.deadline > Date.now() ? `chests_${state.chests.token}` : 'start_chests';
}
function tick(session, bot, Generics, ai) {
    if (!session.clanAllianceQuest) return false;
    const clanId = Service.clanOf(session);
    const state = Service.records.get(clanId);
    const member = state?.members?.find(m => m.id === Service.idOf(session));
    if (!Service.active(state) || !member || clanId !== session.clanAllianceQuest.clanId) {
        Service.stopAssignmentAction(session, 'clan_quest_invalid');
        session.clanAllianceQuest = null;
        return false;
    }
    if (bot.isDead()) return false;
    if (Date.now() < Number(session.clanAllianceRespawnUntil || 0)) return true;
    const leader = Service.sessions().find(s => Service.idOf(s) === state.leaderId && Service.online(s));
    if (!leader || leader.actor.isDead()) { Service.stopAssignmentAction(session, 'clan_quest_leader_unavailable'); return true; }
    if (session.clanAlliancePending) return true;
    // Recheck authoritative membership periodically so a departure, leadership
    // transfer, or resumed game cannot leave an old assignment running.
    if (Date.now() >= Number(session.clanAllianceRefreshAt || 0)) {
        session.clanAllianceRefreshAt = Date.now() + 5000;
        request(session, () => Service.snapshot(session));
        return true;
    }
    const deliveryComplete = state.stage === 'loyalty' ? member.loyaltyDelivered
        : state.stage === 'gathering' && member.delivered && (!member.blood || member.bloodDelivered);
    if (deliveryComplete && !session.spotRelocation) {
        if (state.stage === 'loyalty') {
            const delivered = state.members.filter(m => m.loyaltyDelivered).length;
            const ready = Rules.ritualComplete(state) && delivered === 3;
            Service.report(session, ready ? 'waiting_poison' : 'waiting_symbols', ready
                ? 'All three Symbols of Loyalty are delivered. Waiting for you to drink the poison.'
                : 'My Symbol of Loyalty is handed over. Waiting for the remaining couriers.');
        }
        return false;
    }
    // A herb drop, finished chest game or expired attempt invalidates the old
    // attack even while its cast/weapon callback is still pending.
    const nextAction = actionKey(state, member);
    if (session.clanAllianceActionKey && session.clanAllianceActionKey !== nextAction) {
        Service.stopAssignmentAction(session);
        delete session.clanAllianceRetryAt;
    }
    session.clanAllianceActionKey = nextAction;
    if (bot.state.fetchCasts?.()) return true;
    const threat = invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(session, 2000);
    if (threat) {
        if (session.spotRelocation) Travel.cancel(session, bot, 'clan_quest_defense');
        session.currentTargetId = threat.fetchId();
        if (bot.state.fetchSeated?.()) {
            bot.state.setSeated(false);
            session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
        }
        ai.executeCombat(session, bot, threat, Generics, { basicAttackOnly: !!threat.allianceChestToken });
        return true;
    }
    if (Number(session.clanAllianceRetryAt || 0) > Date.now()) return true;
    if (state.stage === 'loyalty' && member.pledged && !Rules.ritualComplete(state)) {
        Service.report(session, 'waiting_ritual', 'My sacrifice is complete. Waiting for all three offerings before delivering the symbols.');
        return true;
    }
    const hp = bot.fetchHp?.() / Math.max(1, bot.fetchMaxHp?.());
    const mp = bot.fetchMp?.() / Math.max(1, bot.fetchMaxMp?.());
    const needsMana = nextAction === 'herb';
    if (hp < 0.35 || needsMana && mp < 0.2 || session.clanAllianceRecovering && (hp < 0.85 || needsMana && mp < 0.8)) {
        Service.report(session, 'recovering', needsMana ? 'I need to recover HP and MP before continuing my assignment.'
            : 'I need to recover HP before continuing my assignment.');
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
        Service.report(session, 'altar', 'I am heading to the altar for the loyalty offering.');
        const altar = Service.targetNpc(Rules.NPC.altar, bot);
        if (altar && move(session, altar, 'altar')) request(session, () => Service.transition(session, 'pledge'));
        return true;
    }
    const returning = state.stage === 'loyalty' || state.stage === 'cured'
        || state.stage === 'gathering' && member.herb && (!member.blood || state.bloodObtained);
    if (returning) {
        const delivered = state.stage === 'loyalty' ? member.loyaltyDelivered : member.delivered && (!member.blood || member.bloodDelivered);
        Service.report(session, delivered ? 'delivered' : `returning_${state.stage}`, state.stage === 'loyalty'
            ? 'I have my Symbol of Loyalty. Returning to hand it to you before the poison trial.'
            : delivered ? 'My ingredients are delivered. I am ready to help the party.' : 'I have the antidote ingredients. Returning to you now.');
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
    if (!member.herb) {
        Service.report(session, 'hunting', `I am going to ${Rules.HERBS.find(h => h.itemId === member.itemId).area} for ${Rules.ITEMS[member.itemId]}.`);
        target = Service.targetNpc(member.npcId, bot);
    }
    else if (member.blood && !state.bloodObtained) {
        const athrea = Service.targetNpc(Rules.NPC.athrea, bot);
        if (state.chests?.bingo >= 4) {
            Service.report(session, 'claim_blood', 'Four BINGOs found. Collecting Blood of Eva from Athrea.');
            if (athrea && move(session, athrea, 'athrea')) request(session, () => Service.transition(session, 'blood'));
            return true;
        }
        if (!state.chests || state.chests.deadline <= Date.now()) {
            Service.report(session, 'athrea', 'I have my herb. Heading to Athrea for Blood of Eva.');
            if (athrea && move(session, athrea, 'athrea')) request(session, () => Service.transition(session, 'chests'));
            return true;
        }
        Service.report(session, `chests_${state.chests.token}_${state.chests.bingo}`,
            `Athrea attempt ${state.chestAttempts}: ${state.chests.bingo}/4 BINGOs. Still collecting Blood of Eva.`);
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
    ai.executeCombat(session, bot, target, Generics, { basicAttackOnly: !!target.allianceChestToken });
    return true;
}
module.exports = { tick, move };

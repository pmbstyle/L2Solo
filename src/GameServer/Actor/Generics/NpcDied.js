const World = invoke('GameServer/World/World');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const RaidBossMinionManager = invoke('GameServer/World/RaidBossMinionManager');

const PARTY_REWARD_RADIUS = 2500;
// C4/L2J party reward curve. The total reward grows with the eligible party,
// then is split by squared level rather than being divided equally.
const PARTY_EXP_SP_BONUS = [1, 1.30, 1.39, 1.50, 1.54, 1.58, 1.63, 1.67, 1.71];

function distance2d(a, b) {
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt(dx * dx + dy * dy);
}

function isAliveOnline(session) {
    const actor = session?.actor;
    return actor && actor.fetchIsOnline?.() === true && !actor.isDead();
}

function uniqueSessions(sessions) {
    const seen = new Set();
    return sessions.filter((memberSession) => {
        if (!memberSession || seen.has(memberSession)) return false;
        seen.add(memberSession);
        return true;
    });
}

function partyLeaderSession(killerSession) {
    if (killerSession?.partyCompanion === true && killerSession.followPlayerSession) {
        return killerSession.followPlayerSession;
    }
    return killerSession;
}

function ownerSessionForSummon(actor) {
    if (actor?.fetchIsSummon?.() !== true) return null;
    const ownerId = actor.fetchOwnerId?.();
    if (!ownerId) return null;
    return (World.user?.sessions || []).find((session) => session.actor?.fetchId?.() === ownerId) || null;
}

function rewardParticipants(killerSession, killer, npc) {
    const leaderSession = partyLeaderSession(killerSession);
    const leader = leaderSession?.actor;
    if (!leader) return killer && !killer.isDead() ? [killerSession] : [];

    const members = [leaderSession, killerSession];
    World.user.sessions.forEach((candidate) => {
        if (
            candidate !== leaderSession &&
            candidate.partyCompanion === true &&
            candidate.followPlayerSession === leaderSession
        ) {
            members.push(candidate);
        }
    });

    const nearbyMembers = uniqueSessions(members)
        .filter(isAliveOnline)
        .filter((memberSession) => distance2d(memberSession.actor, npc) <= PARTY_REWARD_RADIUS);

    if (nearbyMembers.length > 0) return nearbyMembers;
    if (killer && !killer.isDead()) return [killerSession];
    return [];
}

function levelOf(session) {
    return Math.max(1, Number(session?.actor?.fetchLevel?.() || 1));
}

function partyBonus(memberCount) {
    const index = Math.max(0, Math.min(PARTY_EXP_SP_BONUS.length - 1, Number(memberCount || 1) - 1));
    return PARTY_EXP_SP_BONUS[index];
}

function validPartyMembers(participants) {
    if (participants.length < 2) return participants;

    // L2J's automatic cutoff excludes members whose level is so far below
    // the group that they would otherwise be power-levelled for free.
    const squaredLevelSum = participants.reduce((sum, memberSession) => {
        const level = levelOf(memberSession);
        return sum + (level * level);
    }, 0);
    const previousBonus = partyBonus(participants.length - 1);
    const currentBonus = partyBonus(participants.length);
    const cutoff = squaredLevelSum * (1 - (1 / (1 + currentBonus - previousBonus)));

    return participants.filter((memberSession) => {
        const level = levelOf(memberSession);
        return (level * level) >= cutoff;
    });
}

function partyRewardShares(participants, exp, sp) {
    const validMembers = validPartyMembers(participants);
    if (validMembers.length === 0) return [];

    const totalWeight = validMembers.reduce((sum, memberSession) => {
        const level = levelOf(memberSession);
        return sum + (level * level);
    }, 0);
    const bonus = partyBonus(validMembers.length);
    const totalExp = Math.max(0, Number(exp || 0)) * bonus;
    const totalSp = Math.max(0, Number(sp || 0)) * bonus;

    return validMembers.map((memberSession) => {
        const level = levelOf(memberSession);
        const weight = (level * level) / totalWeight;
        return {
            session: memberSession,
            exp: Math.max(0, Math.round(totalExp * weight)),
            sp: Math.max(0, Math.round(totalSp * weight))
        };
    });
}

function npcDied(session, actor, npc) {
    const Generics = invoke(path.actor);

    if (npc.minionBossObjectId) {
        RaidBossMinionManager.onMinionDeath(World, npc);
    }

    if (npc.fetchIsSummon?.() === true) {
        World.npc.spawns = World.npc.spawns.filter((spawn) => spawn.fetchId() !== npc.fetchId());
        session.dataSendToMeAndOthers?.(invoke('GameServer/Network/Response').deleteOb(npc.fetchId()), npc);
        if (actor?.fetchIsSummon?.() === true) actor.attack?.clearTimers?.();
        return;
    }

    const ownerSession = ownerSessionForSummon(actor);
    if (ownerSession) {
        session = ownerSession;
    }

    World.removeNpc(session, npc);
    Generics.abortCombatState(session, actor);

    if (actor.isDead()) return;

    const rewardActor = ownerSession?.actor || actor;
    const participants = rewardParticipants(session, rewardActor, npc);
    if (session?.accountId?.startsWith?.('bot_')) {
        Promise.resolve(BotEventJournal.record({
            botId: session.actor?.fetchId?.(),
            eventType: 'kill',
            summary: `${session.actor?.fetchName?.() || 'Bot'} defeated ${npc.fetchName?.() || 'a monster'}.`,
            weight: 1,
            dedupeKey: `kill:${session.actor?.fetchId?.()}:${npc.fetchTemplateId?.() || npc.fetchId?.()}`,
            coalesceWindowMs: 30000,
            meta: { npcId: npc.fetchId?.(), npcName: npc.fetchName?.() || null }
        })).catch(() => {});
    }
    const rewards = partyRewardShares(participants, npc.fetchAcquiredExp(), npc.fetchRewardSp());

    // C4's ordinary quest callback is attributed to the actual killer, not to
    // every party member that receives shared EXP.
    invoke('GameServer/Quest/QuestService').onKill(session, npc).catch((error) => {
        utils.infoWarn('Quest', 'kill callback failed: %s', error.message);
    });

    rewards.forEach(({ session: memberSession, exp, sp }) => {
        Generics.experienceReward(memberSession, memberSession.actor, exp, sp);
    });
}

module.exports = npcDied;
module.exports.PARTY_EXP_SP_BONUS = PARTY_EXP_SP_BONUS;
module.exports.partyRewardShares = partyRewardShares;
module.exports.validPartyMembers = validPartyMembers;

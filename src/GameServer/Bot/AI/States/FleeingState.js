const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');

const MIN_RETREAT_MS = 1000;
const RETREAT_REPATH_COOLDOWN_MS = 750;
const MAX_RETREAT_MS = 30000;
const NPC_CHASE_BREAK_DISTANCE = 1500;
const RAID_PARTY_HOLD_DISTANCE = 1800;

function stillMoving(session, bot) {
    return !!session.moveTimer || !!bot.state?.fetchTowards?.();
}

function needsRecovery(bot) {
    return bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < 0.35 ||
        bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) < 0.20;
}

function distance2d(first, second) {
    const dx = first.fetchLocX() - second.fetchLocX();
    const dy = first.fetchLocY() - second.fetchLocY();
    return Math.sqrt((dx * dx) + (dy * dy));
}

function activePursuer(session, bot) {
    const threatId = session.lastRetreatPlan?.threatId;
    if (threatId === null || threatId === undefined) return null;

    const World = invoke('GameServer/World/World');
    const npc = (World.npc?.spawns || []).find((spawn) => Number(spawn.fetchId?.()) === Number(threatId));
    if (!npc || npc.fetchAttackable?.() !== true || npc.isDead?.() || npc.state?.fetchDead?.()) return null;
    if (Number(npc.fetchDestId?.()) !== Number(bot.fetchId())) return null;
    return distance2d(npc, bot) < NPC_CHASE_BREAK_DISTANCE ? npc : null;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (!session.fleeStart) {
            session.fleeStart = Date.now();
        }

        const now = Date.now();
        const moving = stillMoving(session, bot);
        const partyRaidThreat = session.raidSafetyResumePlan === 'following' && session.followPlayerSession
            ? PartyAwareness.findThreatTargetingPartyProjected(session.followPlayerSession)
            : null;
        if (partyRaidThreat?.type === 'raid') {
            const threatChanged = Number(partyRaidThreat.actor.fetchId?.()) !== Number(session.lastRetreatPlan?.threatId);
            const canRepath = now - Number(session.lastRetreatRepathAt || 0) >= RETREAT_REPATH_COOLDOWN_MS;
            if (distance2d(partyRaidThreat.actor, bot) < RAID_PARTY_HOLD_DISTANCE && canRepath && (!moving || threatChanged)) {
                session.lastRetreatRepathAt = now;
                BotRetreatPlanner.retreat(session, bot, partyRaidThreat.actor);
            }
            // A companion must not run back to a leader who is still tanking a
            // raid entity. Hold outside the danger area until that threat ends.
            return;
        }
        const incomingThreat = PartyAwareness.recentIncomingNpc(session);
        const retreatThreat = incomingThreat || activePursuer(session, bot);
        const threatChanged = retreatThreat &&
            Number(retreatThreat.fetchId()) !== Number(session.lastRetreatPlan?.threatId);
        const canRepath = now - Number(session.lastRetreatRepathAt || 0) >= RETREAT_REPATH_COOLDOWN_MS;
        const retreatExpired = now - session.fleeStart >= MAX_RETREAT_MS;

        // A fresh add invalidates the old escape direction immediately. If the
        // original attacker is still landing hits after a completed leg, keep
        // opening distance instead of blindly returning to combat. The hard
        // timeout also replaces a potentially stale movement command, but it
        // must never end the escape while the NPC still owns this target.
        if (retreatThreat && canRepath && (!moving || threatChanged || retreatExpired)) {
            if (retreatExpired) {
                bot.automation?.abortAll?.(bot);
                session.fleeStart = now;
            }
            session.lastRetreatRepathAt = now;
            BotRetreatPlanner.retreat(session, bot, retreatThreat);
            return;
        }

        // Preserve a bounded escape state even if a movement timer or native
        // motion flag becomes stale. Thirty seconds leaves room for slowed
        // actors and routed terrain without returning to the old seven-second
        // mid-run combat reset.
        if (retreatExpired) {
            bot.automation?.abortAll?.(bot);
        } else if (moving || now - session.fleeStart < MIN_RETREAT_MS) {
            return;
        }

        const raidSafetyResumePlan = session.raidSafetyResumePlan;
        session.plan = raidSafetyResumePlan === 'following' && session.partyCompanion === true && session.followPlayerSession
            ? 'following'
            : (needsRecovery(bot) || raidSafetyResumePlan === 'resting' ? 'resting' : 'hunting');
        session.raidSafetyResumePlan = undefined;
        session.fleeStart = undefined;
        session.lastRetreatRepathAt = undefined;
        session.incomingThreatId = undefined;
        session.incomingThreatAt = undefined;
    }
};

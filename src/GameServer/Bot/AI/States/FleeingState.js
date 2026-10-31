const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const EscapePolicy = invoke('GameServer/Bot/AI/BotEscapePolicy');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const NpcObjectIndex = require('../../../World/NpcObjectIndex');

const MIN_RETREAT_MS = 1000;
const RETREAT_REPATH_COOLDOWN_MS = 750;
const MAX_RETREAT_MS = 30000;
const NPC_CHASE_BREAK_DISTANCE = EscapePolicy.CHASE_BREAK_DISTANCE;
const RAID_PARTY_HOLD_DISTANCE = 1800;
const RETREAT_PROGRESS_MS = 8000;
const MIN_RETREAT_DISTANCE_GAIN = 64;

function stillMoving(session, bot) {
    return !!session.moveTimer || !!bot.state?.fetchTowards?.();
}

function needsRecovery(session, bot) {
    return RestPolicy.needsRetreat(bot,
        bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
        bot.fetchMp() / Math.max(1, bot.fetchMaxMp()),
        { locked: !!session.recoveryLocked });
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
    const npc = NpcObjectIndex.find(World, Number(threatId));
    if (!npc || npc.fetchAttackable?.() !== true || npc.isDead?.() || npc.state?.fetchDead?.()) return null;
    if (Number(npc.fetchDestId?.()) !== Number(bot.fetchId())) return null;
    return distance2d(npc, bot) < NPC_CHASE_BREAK_DISTANCE ? npc : null;
}

function failedProgress(session, bot, threat, now) {
    const distance = distance2d(bot, threat);
    const sample = session.retreatProgress;
    if (!sample || sample.fleeStart !== session.fleeStart) {
        session.retreatProgress = { threatId: threat.fetchId(), fleeStart: session.fleeStart, at: now, distance };
        return false;
    }
    if (now - sample.at < RETREAT_PROGRESS_MS) return false;
    if (distance - sample.distance < MIN_RETREAT_DISTANCE_GAIN) return true;
    session.retreatProgress = { ...sample, at: now, distance };
    return false;
}

function defendFromPursuer(session, bot, threat, reason, Generics, BotAI) {
    EscapePolicy.rememberFailure(session, bot, threat, reason);
    bot.automation?.abortAll?.(bot);
    session.plan = session.partyCompanion === true && session.followPlayerSession ? 'following' : 'hunting';
    session.fleeStart = undefined;
    session.lastRetreatRepathAt = undefined;
    session.retreatProgress = undefined;
    session.raidSafetyResumePlan = undefined;
    // Preserve the attacker across the state transition even if its last hit
    // is no longer recent. Recovery must not sit the bot back down under it.
    session.incomingThreatId = threat.fetchId();
    session.incomingThreatAt = Date.now();
    session.dangerMoment = undefined;
    session.lastDecision = { action: 'defend_self', reason, targetId: threat.fetchId(), at: Date.now() };
    if (session.plan === 'following') return;
    session.currentTargetId = threat.fetchId();
    bot.select({ id: threat.fetchId() });
    BotAI.executeCombat(session, bot, threat, Generics);
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.followPlayerSession?.partyRaidEngagement?.phase === 'retreat'
            && invoke('GameServer/Bot/AI/PlayerPartyRaid').tick(session, bot, Generics, BotAI)) return;
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
        const pursuer = activePursuer(session, bot);
        const threats = EscapePolicy.threatsFor(bot, incomingThreat || pursuer);
        const retreatThreat = incomingThreat || pursuer || threats[0];
        // Raid escape rules stay in charge of their own encounters.
        // Ordinary NPC escapes must be feasible even when initiated by the
        // low-resource fallback or before a speed buff/slow changed the race.
        const raidEscape = !!session.raidSafetyResumePlan
            || threats.some(threat => BotRaidSafety.isProtectedRaidEntity(threat));
        if (retreatThreat && !raidEscape) {
            const escape = EscapePolicy.assess(session, bot, threats);
            // Measure the nearest pursuer so alternating hits from two mobs
            // cannot keep resetting the progress deadline.
            const progressThreat = threats.reduce((nearest, threat) =>
                distance2d(bot, threat) < distance2d(bot, nearest) ? threat : nearest, retreatThreat);
            const stalled = escape.possible && failedProgress(session, bot, progressThreat, now);
            if (!escape.possible || stalled) {
                defendFromPursuer(session, bot, escape.threat || progressThreat,
                    escape.reason || 'retreat_no_progress', Generics, BotAI);
                return;
            }
        }
        const threatChanged = retreatThreat &&
            Number(retreatThreat.fetchId()) !== Number(session.lastRetreatPlan?.threatId);
        const canRepath = now - Number(session.lastRetreatRepathAt || 0) >= RETREAT_REPATH_COOLDOWN_MS;
        const retreatExpired = now - session.fleeStart >= MAX_RETREAT_MS;

        // A fresh add invalidates the old escape direction immediately. If the
        // original attacker is still landing hits after a completed leg, keep
        // opening distance instead of blindly returning to combat. The hard
        // timeout also replaces a potentially stale movement command. The
        // progress check above ends ordinary escapes that cannot open a gap.
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
        const recoveryNeeded = needsRecovery(session, bot);
        if (!recoveryNeeded && session.recoveryLocked) session.recoveryLocked = false;
        session.plan = raidSafetyResumePlan === 'following' && session.partyCompanion === true && session.followPlayerSession
            ? 'following'
            : (recoveryNeeded || raidSafetyResumePlan === 'resting' ? 'resting' : 'hunting');
        session.raidSafetyResumePlan = undefined;
        session.fleeStart = undefined;
        session.lastRetreatRepathAt = undefined;
        session.retreatProgress = undefined;
        session.retreatFailure = undefined;
        session.incomingThreatId = undefined;
        session.incomingThreatAt = undefined;
    }
};

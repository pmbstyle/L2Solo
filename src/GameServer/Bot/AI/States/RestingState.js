const ServerResponse = invoke('GameServer/Network/Response');
const SpeckMath      = invoke('GameServer/SpeckMath');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

const REST_FOLLOW_WAKE_DISTANCE = 600;
const RECOVERY_HP_RATIO = 0.35;
const RECOVERY_MP_RATIO = 0.20;
const EMERGENCY_RETREAT_DISTANCE = 850;

function point(actor) {
    return new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
}

function standUp(session, bot) {
    if (!bot.state.fetchSeated()) return false;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function recordWakeDecision(session, bot, action, reason, extra = {}) {
    session.roleDecision = {
        role: BotRoles.inferRole(bot),
        action,
        reason,
        at: Date.now(),
        ...extra
    };
}

function needsRecovery(bot) {
    return bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < RECOVERY_HP_RATIO
        || bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) < RECOVERY_MP_RATIO;
}

function retreatFromThreat(session, bot, threat) {
    const from = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    const dx = from.locX - threat.fetchLocX();
    const dy = from.locY - threat.fetchLocY();
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const to = {
        locX: Math.round(from.locX + (dx / length) * EMERGENCY_RETREAT_DISTANCE),
        locY: Math.round(from.locY + (dy / length) * EMERGENCY_RETREAT_DISTANCE),
        locZ: from.locZ
    };

    standUp(session, bot);
    session.plan = 'fleeing';
    session.fleeStart = Date.now();
    session.currentTargetId = undefined;
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    bot.unselect?.();
    bot.moveTo?.({ from, to });
    recordWakeDecision(session, bot, 'retreat', 'critical_resources_under_attack', {
        targetId: threat.fetchId(),
        hpRatio: bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
        mpRatio: bot.fetchMp() / Math.max(1, bot.fetchMaxMp())
    });
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.followPlayerSession && session.partyCompanion === true) {
            const playerSession = session.followPlayerSession;
            const player = playerSession?.actor;

            if (!player || !player.fetchIsOnline()) {
                session.plan = 'hunting';
                session.roleDecision = null;
                BotAI.say(session, "My companion has disconnected. Heading back to hunt.");
                return;
            }

            const distance = point(bot).distance(point(player));
            const threat = PartyAwareness.findThreatTargetingParty(playerSession);
            const leaderTargetId = PartyAwareness.leaderCombatTargetId(playerSession);
            const leaderSeated = player.state?.fetchSeated?.() === true;
            const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
            const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
            const recovered = hpRatio >= 0.95 && mpRatio >= 0.95;

            // A recovering companion must stay seated even when its leader is
            // far away.  Otherwise RestingState stands it up to follow, then
            // FollowingState immediately seats it again for low HP/MP.
            const shouldFollowLeader = recovered && (
                distance > REST_FOLLOW_WAKE_DISTANCE || !leaderSeated
            );
            if (threat || leaderTargetId || shouldFollowLeader) {
                session.plan = 'following';
                session.currentTargetId = threat?.actor?.fetchId?.() || leaderTargetId || undefined;
                session.townGossip = false;
                standUp(session, bot);
                recordWakeDecision(
                    session,
                    bot,
                    threat || leaderTargetId ? 'assist_party' : 'follow_leader',
                    threat ? 'party_under_attack' : (leaderTargetId ? 'leader_target' : (distance > REST_FOLLOW_WAKE_DISTANCE ? 'leader_moved' : 'leader_stood_ready')),
                    threat
                        ? { targetId: session.currentTargetId, protectedId: threat.targetId }
                        : { targetId: session.currentTargetId || null, distance: Math.round(distance) }
                );
                return;
            }
        }

        if (!session.followPlayerSession && session.partyCompanion !== true) {
            const threat = PartyAwareness.recentIncomingNpc(session);
            if (threat) {
                if (needsRecovery(bot)) {
                    retreatFromThreat(session, bot, threat);
                    return;
                }
                session.plan = 'hunting';
                session.currentTargetId = threat.fetchId();
                session.townGossip = false;
                standUp(session, bot);
                bot.select({ id: threat.fetchId() });
                recordWakeDecision(session, bot, 'defend_self', 'incoming_threat', {
                    targetId: threat.fetchId()
                });
                BotAI.executeCombat(session, bot, threat, Generics);
                return;
            }
        }

        if (session.townGossip) {
            // 3% chance per tick to attempt conversation when resting near other bots
            if (Math.random() < 0.03) {
                try {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    BotManager.checkAndStartConversation(session);
                } catch (err) {
                    console.error("Conversation check error:", err);
                }
            }
            return; // Stay seated and do nothing else
        }

        const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
        const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
        if (hpRatio >= 0.95 && mpRatio >= 0.95) {
            bot.state.setSeated(false);
            session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            if (session.followPlayerSession && session.partyCompanion === true) {
                session.plan = 'following';
                BotAI.say(session, "Fully rested! Ready to follow you again.");
            } else {
                session.plan = 'hunting';
                BotAI.say(session, "Fully rested! Ready to hunt again.");
            }
        } else {
            // 3% chance per tick to attempt conversation when resting near other bots
            if (Math.random() < 0.03) {
                try {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    BotManager.checkAndStartConversation(session);
                } catch (err) {
                    console.error("Conversation check error:", err);
                }
            }
        }
    }
};

const ServerResponse = invoke('GameServer/Network/Response');
const SpeckMath      = invoke('GameServer/SpeckMath');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

const REST_FOLLOW_WAKE_DISTANCE = 600;

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

            if (threat || distance > REST_FOLLOW_WAKE_DISTANCE) {
                session.plan = 'following';
                session.currentTargetId = threat?.actor?.fetchId?.();
                session.townGossip = false;
                standUp(session, bot);
                recordWakeDecision(
                    session,
                    bot,
                    threat ? 'assist_party' : 'follow_leader',
                    threat ? 'party_under_attack' : 'leader_moved',
                    threat ? { targetId: session.currentTargetId, protectedId: threat.targetId } : { distance: Math.round(distance) }
                );
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

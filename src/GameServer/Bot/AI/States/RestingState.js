const ServerResponse = invoke('GameServer/Network/Response');
const SpeckMath      = invoke('GameServer/SpeckMath');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

const REST_FOLLOW_WAKE_DISTANCE = 600;
const RECOVERY_HP_RATIO = 0.35;
const RECOVERY_MP_RATIO = 0.20;
const FULL_RECOVERY_RATIO = 0.95;
const EMERGENCY_RETREAT_DISTANCE = 850;
const MANA_REGEN_CAST_RETRY_MS = 8000;
const NEWBIE_GUIDE_TOWN_RADIUS = 7500;
const NEWBIE_GUIDE_RECOVERY_MAX_LEVEL = 20;
const PARTY_REST_FORMATION_TOLERANCE = 45;

function point(actor) {
    return new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
}

function distanceToPartyFormation(session, bot, player) {
    const target = PartyCompanionService.formationTargetFor(session) || {
        locX: player.fetchLocX(),
        locY: player.fetchLocY()
    };
    const dx = bot.fetchLocX() - target.locX;
    const dy = bot.fetchLocY() - target.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
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

function sitDown(session, bot) {
    if (bot.state.fetchSeated()) return false;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function maybeCastManaRegeneration(session, bot, Generics) {
    const mpRatio = bot.fetchMp() / Math.max(1, bot.fetchMaxMp());
    if (mpRatio >= 0.8 || Date.now() < Number(session.nextManaRegenAt || 0)) return false;

    const skill = (bot.skillset?.fetchSkills?.() || [])
        .find((entry) => !entry.fetchPassive?.()
            && entry.fetchSemantic?.()?.effect === 'mana_regeneration'
            && entry.fetchTargetKind?.() === 'self');
    if (!skill || EffectStore.remainingMs(bot, 'mana_regeneration') > 0) return false;
    if (Number(bot.fetchMp()) < Number(skill.fetchConsumedMp?.() || 0) || bot.state.fetchCasts?.()) return false;

    standUp(session, bot);
    session.nextManaRegenAt = Date.now() + MANA_REGEN_CAST_RETRY_MS;
    Generics.skillExec(session, bot, { id: bot.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });
    recordWakeDecision(session, bot, 'cast_mana_regeneration', 'recover_mp', { skillId: skill.fetchSelfId() });
    return true;
}

function needsRecovery(session, bot) {
    const hpThreshold = session.recoveryLocked ? FULL_RECOVERY_RATIO : RECOVERY_HP_RATIO;
    const mpThreshold = session.recoveryLocked ? FULL_RECOVERY_RATIO : RECOVERY_MP_RATIO;
    return bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < hpThreshold
        || (BotRoles.shouldRestForMana(bot)
            && bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) < mpThreshold);
}

function canRecoverAtNewbieGuide(bot, BotAI) {
    if (Number(bot?.fetchLevel?.() || 0) > NEWBIE_GUIDE_RECOVERY_MAX_LEVEL) return false;
    const guide = BotAI.getClosestNewbieGuide?.(bot.fetchLocX(), bot.fetchLocY());
    if (!guide) return false;

    const dx = bot.fetchLocX() - guide.locX;
    const dy = bot.fetchLocY() - guide.locY;
    return Math.sqrt((dx * dx) + (dy * dy)) <= NEWBIE_GUIDE_TOWN_RADIUS;
}

function beginNewbieGuideRecovery(session, bot, playerSession) {
    session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.preBuffPlan = 'following';
    session.resumeAfterBuff = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: session.botStay === true,
        stayLocation: session.stayLocation ? { ...session.stayLocation } : null,
        role: BotRoles.inferRole(bot)
    };
    session.plan = 'getting_buffed';
    session.currentTargetId = undefined;
    bot.unselect?.();
    standUp(session, bot);
    bot.automation?.abortAll?.(bot);
}

function retreatFromThreat(session, bot, threat) {
    standUp(session, bot);
    session.plan = 'fleeing';
    session.recoveryLocked = true;
    session.fleeStart = Date.now();
    session.currentTargetId = undefined;
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    bot.unselect?.();
    BotRetreatPlanner.retreat(session, bot, threat, { distance: EMERGENCY_RETREAT_DISTANCE });
    recordWakeDecision(session, bot, 'retreat', 'critical_resources_under_attack', {
        targetId: threat.fetchId(),
        hpRatio: bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
        mpRatio: bot.fetchMp() / Math.max(1, bot.fetchMaxMp())
    });
}

module.exports = {
    maybeCastManaRegeneration,
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
            const partyRaid = BotRaidSafety.syncPlayerPartyRaid(playerSession);
            if (partyRaid?.phase === 'opening') {
                delete session.explicitRestOrder;
                session.plan = 'following';
                session.currentTargetId = undefined;
                standUp(session, bot);
                recordWakeDecision(session, bot, 'prepare_raid', 'player_designated_raid_target', {
                    targetId: partyRaid.bossId,
                    openerId: partyRaid.openerId || null
                });
                return;
            }
            const threat = PartyAwareness.findThreatTargetingPartyProjected(playerSession);
            if (threat?.type === 'raid' && BotRaidSafety.retreat(session, bot, threat.actor, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                recordWakeDecision(session, bot, 'retreat', 'raid_entity_protected', {
                    targetId: threat.actor.fetchId?.() || null
                });
                return;
            }
            const partySettings = PartyCompanionService.getSettings(playerSession);
            const leaderTargetId = PartyAwareness.leaderCombatTargetId(playerSession);
            PartyPulling.observeLeaderTarget(playerSession, partySettings, leaderTargetId);
            const pulling = PartyPulling.current(playerSession, partySettings);
            const heldPullTargetId = pulling.target && !pulling.engageable
                ? pulling.target.fetchId()
                : null;
            const threatIsHeldPull = Number(threat?.actor?.fetchId?.()) === Number(heldPullTargetId);
            const leaderTargetIsHeldPull = Number(leaderTargetId) === Number(heldPullTargetId);
            const combatTargetId = !threatIsHeldPull && threat?.actor?.fetchId?.()
                ? threat.actor.fetchId()
                : (!leaderTargetIsHeldPull ? leaderTargetId : undefined);
            const leaderSeated = player.state?.fetchSeated?.() === true;
            const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
            const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
            const recovered = hpRatio >= 0.95 && (
                !BotRoles.shouldRestForMana(bot) || mpRatio >= 0.95
            );

            // A companion can join while it is already sitting from a prior
            // hunt. If it is in a starter town, send low-level bots to the
            // Newbie Guide instead of making the new party wait for normal
            // seated regeneration. This checks the bot's own position, so it
            // never leaves a farming spot just because the leader is in town.
            if (!session.explicitRestOrder && !combatTargetId && !recovered && canRecoverAtNewbieGuide(bot, BotAI)) {
                beginNewbieGuideRecovery(session, bot, playerSession);
                recordWakeDecision(session, bot, hpRatio < 0.95 ? 'recover_hp' : 'recover_mp', 'newbie_guide_recovery');
                BotAI.say(session, "I'm recovering at the Newbie Guide, then I'll return to you.");
                return;
            }

            // When the whole party rests, regroup first. FollowingState checks
            // the seated leader before its low-resource branch, so the bot
            // moves into formation and then sits there without oscillating.
            // A companion resting alone still finishes recovery in place.
            const shouldRegroupForPartyRest = !session.explicitRestOrder &&
                leaderSeated &&
                distance > 250 &&
                distanceToPartyFormation(session, bot, player) > PARTY_REST_FORMATION_TOLERANCE;
            const shouldFollowLeader = shouldRegroupForPartyRest || (recovered && (
                distance > REST_FOLLOW_WAKE_DISTANCE || !leaderSeated
            ));
            if (combatTargetId || shouldFollowLeader) {
                delete session.explicitRestOrder;
                session.plan = 'following';
                session.currentTargetId = combatTargetId || undefined;
                session.townGossip = false;
                standUp(session, bot);
                recordWakeDecision(
                    session,
                    bot,
                    combatTargetId ? 'assist_party' : 'follow_leader',
                    (threat && !threatIsHeldPull)
                        ? 'party_under_attack'
                        : (combatTargetId ? 'leader_target' : (distance > REST_FOLLOW_WAKE_DISTANCE ? 'leader_moved' : 'leader_stood_ready')),
                    threat && !threatIsHeldPull
                        ? { targetId: session.currentTargetId, protectedId: threat.targetId }
                        : { targetId: session.currentTargetId || null, distance: Math.round(distance) }
                );
                return;
            }
        }

        if (!session.followPlayerSession && session.partyCompanion !== true) {
            const threat = PartyAwareness.npcThreateningActor(session);
            if (threat) {
                if (BotRaidSafety.retreat(session, bot, threat, { distance: EMERGENCY_RETREAT_DISTANCE })) {
                    recordWakeDecision(session, bot, 'retreat', 'raid_entity_protected', {
                        targetId: threat.fetchId?.() || null
                    });
                    return;
                }
                if (needsRecovery(session, bot)) {
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
        const restingWithLeader = session.partyCompanion === true
            && session.followPlayerSession?.actor?.state?.fetchSeated?.() === true;
        if (hpRatio >= 0.95 && (
            !BotRoles.shouldRestForMana(bot) || mpRatio >= 0.95
        ) && !restingWithLeader) {
            session.recoveryLocked = false;
            delete session.explicitRestOrder;
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
            // skillExec marks the actor as casting immediately.  Do not sit
            // on the next brain tick while the native self-cast is still live.
            if (bot.state.fetchHits?.() || bot.state.fetchCasts?.()) return;
            if (maybeCastManaRegeneration(session, bot, Generics)) return;
            sitDown(session, bot);
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

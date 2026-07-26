const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const TradeService   = invoke('GameServer/Bot/TradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

const FOLLOW_RUN_DISTANCE = 250;
const FOLLOW_RETARGET_DISTANCE = 900;
const FOLLOW_TARGET_DRIFT = 650;
const FOLLOW_TELEPORT_DISTANCE = 4500;
// Newbie Guides only exist in the starter villages.  A companion should not
// abandon a player in the field just because its starter buffs have expired.
const NEWBIE_GUIDE_TOWN_RADIUS = 7500;
const NEWBIE_GUIDE_RECOVERY_MAX_LEVEL = 20;
const COMPANION_TOWN_ERRAND_RADIUS = 7500;
const COMPANION_TOWN_ERRAND_COOLDOWN_MS = 60000;

function ratio(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(1, value / max));
}

function isBusy(bot) {
    return !!(bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts());
}

function point(actor) {
    return new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
}

function loc(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isAtNewbieGuideTown(player, BotAI) {
    const guide = BotAI.getClosestNewbieGuide?.(player.fetchLocX(), player.fetchLocY());
    if (!guide) return false;

    return distance2d(
        { locX: player.fetchLocX(), locY: player.fetchLocY() },
        guide
    ) <= NEWBIE_GUIDE_TOWN_RADIUS;
}

function canRecoverAtNewbieGuide(bot, BotAI) {
    return Number(bot?.fetchLevel?.() || 0) <= NEWBIE_GUIDE_RECOVERY_MAX_LEVEL &&
        isAtNewbieGuideTown(bot, BotAI);
}

function beginNewbieGuideVisit(session, bot, playerSession, role) {
    session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.preBuffPlan = 'following';
    session.resumeAfterBuff = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: session.botStay === true,
        stayLocation: session.stayLocation ? { ...session.stayLocation } : null,
        role
    };
    session.plan = 'getting_buffed';
    session.currentTargetId = undefined;
    bot.unselect();
    bot.automation.abortAll(bot);
}

function townForCompanionErrand(player, BotAI) {
    const town = BotAI.getClosestTown?.(player.fetchLocX(), player.fetchLocY());
    if (!town) return null;

    return distance2d(
        { locX: player.fetchLocX(), locY: player.fetchLocY() },
        { locX: town.x, locY: town.y }
    ) <= COMPANION_TOWN_ERRAND_RADIUS ? town : null;
}

function actorAdena(bot) {
    const adena = bot.backpack?.fetchItemFromSelfId?.(57);
    return Number(adena?.fetchAmount?.() || 0);
}

function plannedMarketPurchase(session, bot, town) {
    const plan = session.coldLifeState?.stats?.equipmentPlan;
    const selfId = Number(plan?.strategy === 'market' ? plan.target?.selfId : 0);
    if (!selfId) return null;
    if (bot.backpack?.fetchItemFromSelfId?.(selfId)) return null;

    const offer = MarketOpportunity.findOffers(selfId, {
        town: town.name,
        buyerCharacterId: bot.fetchId()
    }).find((candidate) => (
        Number(candidate.price) <= actorAdena(bot) &&
        candidate.sourceType === 'private_store' &&
        candidate.session?.actor &&
        String(candidate.session.accountId || '').startsWith('bot_')
    ));
    // Hot companions can transact only with a live bot merchant. Cold
    // listings have no world actor to walk to, while player-store settlement
    // still belongs to the native client request path.
    if (!offer) return null;

    return {
        kind: 'market_purchase',
        itemId: selfId,
        itemName: offer.itemName,
        price: Number(offer.price),
        target: {
            actorId: offer.session.actor.fetchId(),
            name: offer.session.actor.fetchName(),
            locX: offer.session.actor.fetchLocX(),
            locY: offer.session.actor.fetchLocY(),
            locZ: offer.session.actor.fetchLocZ(),
            town: offer.town || town.name
        }
    };
}

function companionTownErrand(session, bot, player, BotAI) {
    if (Date.now() - Number(session.lastCompanionTownErrandAt || 0) < COMPANION_TOWN_ERRAND_COOLDOWN_MS) return null;
    const town = townForCompanionErrand(player, BotAI);
    if (!town) return null;

    const purchase = plannedMarketPurchase(session, bot, town);
    if (purchase) return purchase;

    const buyer = TradeService.findBestBuyerForActor(bot, World.user?.sessions || [], { town });
    if (buyer) {
        return {
            kind: 'sell_resources',
            target: {
                actorId: buyer.actor.fetchId(),
                name: buyer.actor.fetchName(),
                locX: buyer.actor.fetchLocX(),
                locY: buyer.actor.fetchLocY(),
                locZ: buyer.actor.fetchLocZ(),
                town: buyer.store.town || town.name
            }
        };
    }

    if (!ShotStock.needsActorRestock(bot, 0)) return null;
    return {
        kind: 'restock_shots',
        target: {
            actorId: null,
            name: `${town.name} general shop`,
            locX: town.x,
            locY: town.y,
            locZ: town.z,
            town: town.name
        }
    };
}

function beginCompanionTownErrand(session, bot, playerSession, errand, BotAI) {
    session.lastCompanionTownErrandAt = Date.now();
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.resumeAfterShopping = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: session.botStay === true,
        stayLocation: session.stayLocation ? { ...session.stayLocation } : null
    };
    session.companionShopping = errand;
    session.shoppingTarget = errand.target;
    session.shoppingDoneAnnounced = false;
    session.plan = 'shopping';
    session.currentTargetId = undefined;
    bot.unselect();
    bot.automation.abortAll(bot);

    const detail = errand.kind === 'market_purchase'
        ? `${errand.itemName} from ${errand.target.name}`
        : errand.kind === 'sell_resources'
            ? `sell these resources to ${errand.target.name}`
            : 'restock my shots';
    BotAI.say(session, `I can ${detail} here. Give me a moment, then I'll return.`);
}

function shouldKeepCurrentFollowMove(session, bot, player, leaderDistance) {
    const isMoving = !!session.moveTimer || bot.state.fetchTowards();
    if (!isMoving) return false;
    if ((session.stuckTicks || 0) >= 2) return false;
    if (leaderDistance > FOLLOW_RETARGET_DISTANCE) return false;

    const target = session.lastFollowMoveTarget;
    if (!target) return false;
    return distance2d(target, loc(player)) <= FOLLOW_TARGET_DRIFT;
}

function standUp(session, bot) {
    if (!bot.state.fetchSeated()) return false;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function sitDown(session, bot) {
    if (bot.state.fetchSeated()) return false;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function recordRoleDecision(session, bot, action, reason, extra = {}) {
    const role = BotRoles.inferRole(bot);
    const previous = session.roleDecision;
    const current = {
        role,
        action,
        reason,
        at: Date.now(),
        ...extra
    };

    session.roleDecision = current;

    const signature = `${role}:${action}:${reason}`;
    const shouldLog = !previous ||
        `${previous.role}:${previous.action}:${previous.reason}` !== signature ||
        current.at - (session.lastRoleDecisionLogAt || 0) > 10000;

    if (shouldLog) {
        session.lastRoleDecisionLogAt = current.at;
        console.info("BotRole :: %s %s/%s (%s)", bot.fetchName(), action, reason, role);
    }
}

function castSkillOn(session, bot, Generics, target, skillId, ctrl) {
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    Generics.skillExec(session, bot, { id: target.fetchId(), selfId: skillId, ctrl });
}

function partyActorIds(leaderSession) {
    return new Set(PartyAwareness.partyActors(leaderSession)
        .map((actor) => actor.fetchId())
        .filter((id) => id !== null && id !== undefined));
}

function partyAggroCount(leaderSession) {
    const ids = partyActorIds(leaderSession);
    if (ids.size === 0) return 0;

    const seen = new Set();
    return PartyAwareness.partyActors(leaderSession).flatMap((actor) => (
        World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 900)
    ))
        .filter((npc) => {
            const id = npc.fetchId?.() || npc;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .filter((npc) => npc.fetchAttackable() && !npc.isDead() && ids.has(npc.fetchDestId()))
        .length;
}

function unsafeSupportMoment(bot, activeMobs) {
    // A selected target is not combat. Both the leader and companions retain
    // target ids after inspecting a creature or after a completed cast; using
    // those ids here made an idle party wait forever to refresh its buffs.
    // Only an NPC actually targeting the party, or this bot's active native
    // action, is unsafe for support.
    return activeMobs > 0 || isBusy(bot);
}

function partyMembersInSupportRange(leaderSession, bot, maxDistance = 900) {
    return PartyAwareness.partySessions(leaderSession)
        .filter((memberSession) => memberSession.actor && !memberSession.actor.isDead?.())
        .map((memberSession) => ({
            session: memberSession,
            actor: memberSession.actor,
            hpRatio: ratio(memberSession.actor.fetchHp(), memberSession.actor.fetchMaxHp()),
            mpRatio: ratio(memberSession.actor.fetchMp(), memberSession.actor.fetchMaxMp()),
            distance: point(bot).distance(point(memberSession.actor))
        }))
        .filter((entry) => entry.distance <= maxDistance);
}

function weakestPartyMember(leaderSession, bot, preferredActor = null, maxDistance = 900) {
    const members = partyMembersInSupportRange(leaderSession, bot, maxDistance)
        .filter((entry) => entry.actor !== bot)
        .sort((a, b) => a.hpRatio - b.hpRatio);
    const preferred = members.find((entry) => entry.actor === preferredActor);
    return preferred?.hpRatio < 0.95 ? preferred : (members[0] || null);
}

function weakestPartyVitals(leaderSession, bot) {
    return partyMembersInSupportRange(leaderSession, bot)
        .reduce((lowest, entry) => !lowest || entry.hpRatio < lowest.hpRatio ? entry : lowest, null);
}

function partySupportMembers(leaderSession, puller) {
    return PartyPulling.supportMembers(leaderSession, puller);
}

function pullBlockReason(session, botVitals, partyVitals, activeMobs) {
    if (session.autoTaunt === false) return 'manual_pull_off';
    if (session.botStay) return 'stay_order';
    if (session.currentTargetId) return 'already_assisting';
    if (partyVitals?.hpRatio < 0.65) return 'party_low_hp';
    if (botVitals.hpRatio < 0.55) return 'tank_low_hp';
    if (botVitals.mpRatio < 0.25) return 'save_mp';
    if (activeMobs >= 2) return 'active_mobs';
    return null;
}

function assistActionForRole(role) {
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    if (role === 'buffer') return 'buff_support';
    if (role === 'dagger') return 'flank_target';
    return 'assist_leader';
}

function assistReasonForRole(role) {
    if (role === 'dagger') return 'close_assist';
    return 'leader_target';
}

function followTargetFor(session, player) {
    return PartyCompanionService.formationTargetFor(session) || {
        locX: player.fetchLocX(),
        locY: player.fetchLocY(),
        locZ: player.fetchLocZ()
    };
}

function supportBuffPhrase(skill, playerName) {
    return `${skill.fetchName()} on ${playerName}.`;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const playerSession = session.followPlayerSession;
        if (session.partyCompanion !== true) {
            session.plan = 'hunting';
            session.followPlayerSession = null;
            session.roleDecision = null;
            return;
        }

        if (!playerSession || !playerSession.actor || !playerSession.actor.fetchIsOnline()) {
            session.plan = 'hunting';
            session.roleDecision = null;
            BotAI.say(session, "My companion has disconnected. Heading back to hunt.");
            return;
        }

        const player = playerSession.actor;
        const role = BotRoles.inferRole(bot);
        const distance = point(bot).distance(point(player));
        const partySettings = PartyCompanionService.getSettings(playerSession);
        const combatMode = partySettings.combatMode || 'assist';
        const selectedLeaderTargetId = PartyAwareness.leaderCombatTargetId(playerSession);
        // A player-designated pull is intentional even when the ordinary
        // combat posture is Protect or Passive.  Those modes should not make
        // the party ignore the leader's selected pull target.
        const configuredLeaderTargetId = combatMode === 'assist' || partySettings.pullMode === 'leader'
            ? selectedLeaderTargetId
            : undefined;
        PartyPulling.observeLeaderTarget(playerSession, partySettings, configuredLeaderTargetId);
        let pulling = PartyPulling.current(playerSession, partySettings);
        const rawPartyThreat = PartyAwareness.findThreatTargetingParty(playerSession);
        const holdingPulledTarget = pulling.target && !pulling.engageable;
        const rawThreatIsHeldPull = holdingPulledTarget &&
            Number(rawPartyThreat?.actor?.fetchId?.()) === Number(pulling.target.fetchId());
        const partyThreat = pulling.engageable && pulling.target
            ? {
                type: 'npc',
                actor: pulling.target,
                targetId: pulling.puller.actor.fetchId(),
                source: 'party_pull'
            }
            : (rawThreatIsHeldPull || (combatMode === 'passive' && rawPartyThreat?.targetId !== bot.fetchId())
            ? null
            : rawPartyThreat);
        const leaderTargetId = pulling.enabled ? undefined : configuredLeaderTargetId;
        const impairments = EffectStore.impairments(bot);

        if (impairments.disabled) {
            session.currentTargetId = undefined;
            bot.unselect();
            recordRoleDecision(session, bot, 'disabled', 'debuff_control');
            return;
        }

        const currentLoc = { x: bot.fetchLocX(), y: bot.fetchLocY() };
        if (!session.lastTickLoc) {
            session.lastTickLoc = currentLoc;
            session.stuckTicks = 0;
        }

        const movedDist = Math.sqrt((currentLoc.x - session.lastTickLoc.x) ** 2 + (currentLoc.y - session.lastTickLoc.y) ** 2);
        session.lastTickLoc = currentLoc;

        const isMoving = !!session.moveTimer || bot.state.fetchTowards();
        if (isMoving && movedDist < 10) {
            session.stuckTicks = (session.stuckTicks || 0) + 1;
        } else {
            session.stuckTicks = 0;
        }

        if (bot.state.fetchSeated() && (partyThreat || leaderTargetId || distance > FOLLOW_RUN_DISTANCE)) {
            session.plan = 'following';
            session.currentTargetId = partyThreat?.actor?.fetchId?.() || leaderTargetId || undefined;
            standUp(session, bot);
            recordRoleDecision(
                session,
                bot,
                partyThreat || leaderTargetId ? assistActionForRole(role) : 'follow_leader',
                partyThreat ? 'party_under_attack' : (leaderTargetId ? assistReasonForRole(role) : 'leader_moved')
            );
            return;
        }

        if (impairments.rooted && !partyThreat && !leaderTargetId && distance > FOLLOW_RUN_DISTANCE) {
            recordRoleDecision(session, bot, 'hold_position', 'rooted');
            return;
        }

        if (session.stuckTicks >= 3 || distance > FOLLOW_TELEPORT_DISTANCE) {
            session.stuckTicks = 0;
            recordRoleDecision(session, bot, 'follow_leader', distance > FOLLOW_TELEPORT_DISTANCE ? 'catch_up' : 'unstuck');
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            if (TeleportTo && typeof TeleportTo === 'function') {
                const targetLoc = {
                    ...followTargetFor(session, player)
                };
                TeleportTo(session, bot, targetLoc);
                if (Math.random() < 0.20) {
                    BotAI.say(session, "Whew, caught up with you!");
                }
            }
            return;
        }

        const botVitals = {
            hpRatio: ratio(bot.fetchHp(), bot.fetchMaxHp()),
            mpRatio: ratio(bot.fetchMp(), bot.fetchMaxMp())
        };
        const leaderVitals = {
            hpRatio: ratio(player.fetchHp(), player.fetchMaxHp()),
            mpRatio: ratio(player.fetchMp(), player.fetchMaxMp())
        };
        const partyVitals = weakestPartyVitals(playerSession, bot) || leaderVitals;
        const leaderSeated = player.state?.fetchSeated?.() === true;
        const botRecovering = botVitals.hpRatio < 0.95 || botVitals.mpRatio < 0.95;

        if (!partyThreat && !leaderTargetId && leaderSeated) {
            session.currentTargetId = undefined;
            bot.unselect();

            if (distance > FOLLOW_RUN_DISTANCE) {
                standUp(session, bot);
                recordRoleDecision(session, bot, 'rest_with_leader', 'move_near_sitting_leader');
                if (!shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                    const followTarget = followTargetFor(session, player);
                    session.lastFollowMoveTarget = followTarget;
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: followTarget
                    });
                }
                return;
            }

            session.lastFollowMoveTarget = null;
            sitDown(session, bot);
            recordRoleDecision(session, bot, 'rest_with_leader', 'leader_sitting');
            return;
        }

        if (!partyThreat && !leaderTargetId && bot.state.fetchSeated() && !leaderSeated && !botRecovering) {
            standUp(session, bot);
            recordRoleDecision(session, bot, 'follow_leader', 'leader_stood_ready');
            return;
        }

        if (!partyThreat && !leaderTargetId && (botVitals.hpRatio < 0.30 || botVitals.mpRatio < 0.15)) {
            // Do not leave a hunting field just to recover.  This shortcut is
            // available only when the companion is already in a starter town
            // with a Newbie Guide, where characters through level 20 can
            // recover and renew their blessing before returning to the party.
            if (canRecoverAtNewbieGuide(bot, BotAI)) {
                beginNewbieGuideVisit(session, bot, playerSession, role);
                recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'newbie_guide_recovery');
                BotAI.say(session, "I'm low on HP/MP. Recovering at the Newbie Guide, then I'll return.");
                return;
            }

            session.plan = 'resting';
            session.currentTargetId = undefined;
            bot.unselect();
            sitDown(session, bot);
            recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'resting');
            BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
            return;
        }

        let acted = false;
        let keepRoleDecision = false;

        const buffsNeedRefresh = BotBuffs.needsNewbieRefresh(bot);
        if (buffsNeedRefresh) {
            const unsafeToRefresh = unsafeSupportMoment(bot, partyAggroCount(playerSession));

            if (unsafeToRefresh) {
                recordRoleDecision(session, bot, 'refresh_buffs', 'wait_for_safe_moment', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                keepRoleDecision = true;
            } else if (!isAtNewbieGuideTown(player, BotAI)) {
                recordRoleDecision(session, bot, 'refresh_buffs', 'wait_for_newbie_guide_town', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                keepRoleDecision = true;
            } else {
                beginNewbieGuideVisit(session, bot, playerSession, role);
                recordRoleDecision(session, bot, 'refresh_buffs', 'newbie_blessing', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                BotAI.say(session, "My newbie buffs are fading. Refreshing quickly, then I'll return.");
                return;
            }
        }

        if (!partyThreat && !leaderTargetId && !isBusy(bot)) {
            const errand = companionTownErrand(session, bot, player, BotAI);
            if (errand) {
                beginCompanionTownErrand(session, bot, playerSession, errand, BotAI);
                recordRoleDecision(session, bot, 'town_errand', errand.kind, {
                    town: errand.target.town,
                    itemId: errand.itemId || null
                });
                return;
            }
        }

        const supportBuffTarget = BotSupportPlanner.nextAction(
            bot,
            partySupportMembers(playerSession, pulling.puller),
            PartyPulling.supportProviders(playerSession)
        );
        const rebuff = !partyThreat && !leaderTargetId && !isBusy(bot)
            ? BotSupportPlanner.rebuffRequest(bot, PartyPulling.supportProviders(playerSession))
            : null;
        if (rebuff && rebuff.provider !== bot && Date.now() - (session.lastRebuffRequestAt || 0) > 90000) {
            session.lastRebuffRequestAt = Date.now();
            BotAI.say(session, `${rebuff.provider.fetchName()}, could you refresh ${rebuff.skill.fetchName()}?`);
        }
        if (!acted && supportBuffTarget) {
            const activeMobs = partyAggroCount(playerSession);
            if (unsafeSupportMoment(bot, activeMobs)) {
                recordRoleDecision(session, bot, 'buff_party', 'wait_for_safe_moment', {
                    buff: supportBuffTarget.effect,
                    targetId: supportBuffTarget.target.fetchId(),
                    activeMobs
                });
                keepRoleDecision = true;
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (bot.fetchMp() < supportBuffTarget.skill.fetchConsumedMp() || botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_buff', {
                    buff: supportBuffTarget.effect,
                    targetId: supportBuffTarget.target.fetchId()
                });
                keepRoleDecision = true;
            } else {
                acted = true;
                // A queued cast is not a buff yet. The reservation begins in
                // Attack.remoteHit once the native cast has actually started.
                BotSupportPlanner.queueSupportCast(session, supportBuffTarget);
                castSkillOn(session, bot, Generics, supportBuffTarget.target, supportBuffTarget.skill.fetchSelfId(), false);
                recordRoleDecision(session, bot, 'buff_party', supportBuffTarget.effect, {
                    buff: supportBuffTarget.effect,
                    skillId: supportBuffTarget.skill.fetchSelfId(),
                    targetId: supportBuffTarget.target.fetchId()
                });
                if (Math.random() < 0.30) {
                    BotAI.say(session, supportBuffPhrase(supportBuffTarget.skill, supportBuffTarget.target.fetchName()));
                }
            }
        }

        if (Math.random() < 0.015) {
            const chatterPhrases = [
                "Nice combat, leader!",
                "Following you! Let's get some good exp.",
                "My mana is looking good, keep pulling!",
                "Are we going to Dion or Gludio next?",
                "Lineage 2 is so nostalgic, love this party.",
                "Anyone got any healing potions?",
                "I've got your back, don't worry!",
                "Let's clean up this spawn!"
            ];
            const classPhrases = {
                healer: [
                    "Healing is ready. Watch your HP!",
                    "Don't worry about HP, I'm casting heals.",
                    "Mana is okay, but don't pull the whole room!"
                ],
                tank: [
                    "I will take the aggro, stay behind me!",
                    "Aggression is ready! Pulling them off you.",
                    "I'm tanking this beast!"
                ],
                buffer: [
                    "I'll keep the party buffed.",
                    "Buffs are ready when we have a safe moment.",
                    "Save a little mana before the next pull."
                ],
                dagger: [
                    "I'll stay close and hit their weak side.",
                    "Mark a target and I'll get in close.",
                    "No bow tricks from me, just blades."
                ]
            };
            const pool = chatterPhrases.concat(classPhrases[role] || []);
            const text = pool[Math.floor(Math.random() * pool.length)];
            BotAI.say(session, text);
        }

        if (role === 'healer') {
            const skill = BotSkillCapabilities.healSkill(bot);
            const canCast = !!skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot) && !impairments.silenced;
            const woundedPartyMember = weakestPartyMember(playerSession, bot, pulling.puller?.actor);

            if (woundedPartyMember?.hpRatio < 0.45 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_party', 'emergency_heal', { targetId: woundedPartyMember.actor.fetchId() });
                castSkillOn(session, bot, Generics, woundedPartyMember.actor, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Emergency heal on " + woundedPartyMember.actor.fetchName() + "!");
                }
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio >= 0.35 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_party', 'top_off', { targetId: woundedPartyMember.actor.fetchId() });
                castSkillOn(session, bot, Generics, woundedPartyMember.actor, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing " + woundedPartyMember.actor.fetchName() + "!");
                }
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', woundedPartyMember.hpRatio < 0.45 ? 'low_mp_emergency' : 'party_not_critical');
                keepRoleDecision = true;
            } else if (botVitals.hpRatio < 0.55 && botVitals.mpRatio >= 0.25 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_self', 'self_preservation', { targetId: bot.fetchId() });
                castSkillOn(session, bot, Generics, bot, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing myself!");
                }
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (botVitals.mpRatio < 0.25) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp');
                keepRoleDecision = true;
            } else if (!skill && woundedPartyMember?.hpRatio < 0.70) {
                recordRoleDecision(session, bot, 'cannot_heal', 'no_learned_heal');
                keepRoleDecision = true;
            }
        }

        if (!acted && pulling.enabled && pulling.puller?.session === session && pulling.puller.kind === 'bot') {
            const pullAction = PartyPulling.tickBotPuller(session, bot, playerSession, partySettings, Generics, BotAI);
            pulling = PartyPulling.current(playerSession, partySettings);
            if (pullAction.handled) {
                const reason = pullAction.paused || pullAction.action || (pullAction.idle ? 'no_targets' : 'waiting');
                recordRoleDecision(session, bot, 'party_pull', reason, {
                    targetId: pullAction.target?.fetchId?.() || pulling.target?.fetchId?.() || null,
                    phase: pulling.phase || null
                });
                return;
            }
        }

        if (!acted && pulling.enabled && pulling.target && !pulling.engageable) {
            session.currentTargetId = undefined;
            bot.unselect();
            recordRoleDecision(session, bot, 'hold_for_pull', pulling.paused || 'mob_not_in_range', {
                targetId: pulling.target.fetchId(),
                pullerId: pulling.puller?.actor?.fetchId?.() || null
            });
            return;
        }

        if (!acted && role === 'tank') {
            const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 800);
            const monsterToAggro = partyThreat?.type === 'npc'
                ? partyThreat.actor
                : nearbyNpcs.find((npc) => npc.fetchAttackable() && !npc.isDead() && partyActorIds(playerSession).has(npc.fetchDestId()));

            if (monsterToAggro) {
                const skill = BotSkillCapabilities.aggressionSkill(bot);
                if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                    acted = true;
                    recordRoleDecision(session, bot, 'protect_leader', 'leader_targeted', { targetId: monsterToAggro.fetchId() });
                    castSkillOn(session, bot, Generics, monsterToAggro, skill.fetchSelfId(), true);
                    if (Math.random() < 0.20) {
                        BotAI.say(session, "Hey, " + monsterToAggro.fetchName() + "! Attack me instead!");
                    }
                } else if (!skill) {
                    recordRoleDecision(session, bot, 'cannot_taunt', 'no_learned_aggression');
                    keepRoleDecision = true;
                } else if (botVitals.mpRatio < 0.25) {
                    recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_taunt');
                    keepRoleDecision = true;
                }
            }
        }

        if (!acted && role === 'tank' && !PartyPulling.enabled(partySettings)) {
            const activeMobs = partyAggroCount(playerSession);
            const blockReason = pullBlockReason(session, botVitals, partyVitals, activeMobs);

            if (blockReason) {
                recordRoleDecision(session, bot, 'avoid_overpull', blockReason, { activeMobs });
                keepRoleDecision = true;
            } else {
                const nearbyNpcs = World.fetchNpcsInRadius(player.fetchLocX(), player.fetchLocY(), 900);
                let targetMonster = null;
                let closestDist = 900;

                for (const npc of nearbyNpcs) {
                    if (npc.fetchAttackable() && !npc.isDead() && npc.fetchDestId() === undefined) {
                        const distToBot = point(bot).distance(point(npc));
                        if (distToBot < closestDist) {
                            closestDist = distToBot;
                            targetMonster = npc;
                        }
                    }
                }

                if (targetMonster) {
                    const skill = BotSkillCapabilities.aggressionSkill(bot);
                    if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                        acted = true;
                        recordRoleDecision(session, bot, 'pull_target', 'safe_pull', {
                            targetId: targetMonster.fetchId(),
                            activeMobs
                        });
                        castSkillOn(session, bot, Generics, targetMonster, skill.fetchSelfId(), true);
                        if (Math.random() < 0.30) {
                            BotAI.say(session, "Pulling " + targetMonster.fetchName() + " to the group!");
                        }
                    } else if (!skill) {
                        recordRoleDecision(session, bot, 'avoid_pull', 'no_learned_aggression');
                        keepRoleDecision = true;
                    }
                }
            }
        }

        if (!acted && partyThreat?.actor) {
            const target = partyThreat.actor;
            const targetId = target.fetchId();

            if (session.currentTargetId !== targetId) {
                session.currentTargetId = targetId;
                bot.select({ id: targetId });
                recordRoleDecision(session, bot, assistActionForRole(role), 'party_under_attack', {
                    targetId,
                    targetType: partyThreat.type,
                    protectedId: partyThreat.targetId
                });
                if (Math.random() < 0.20) {
                    BotAI.say(session, "I'm helping the party!");
                }
            }

            if (!isBusy(bot)) {
                if (partyThreat.type === 'player') {
                    BotAI.executePvPCombat(session, bot, target, Generics);
                } else {
                    BotAI.executeCombat(session, bot, target, Generics);
                }
            }
            acted = true;
        }

        if (!acted) {
            const playerTargetId = leaderTargetId;
            if (playerTargetId && playerTargetId !== bot.fetchId() && playerTargetId !== player.fetchId()) {
                acted = true;
                World.fetchUser(playerTargetId).then((user) => {
                    if (PartyAwareness.leaderCombatTargetId(playerSession) !== playerTargetId) return;
                    if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                    const targetIsTeammate = user.session && (
                        user.session === playerSession ||
                        (user.session.followPlayerSession === playerSession && user.session.partyCompanion === true)
                    );

                    const isAttackablePvPTarget = user.fetchKarma() > 0 || user.fetchPvpFlag() > 0;

                    if (!user.state.fetchDead() && !targetIsTeammate && isAttackablePvPTarget) {
                        if (session.botStay && session.stayLocation) {
                            const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                .distance(new SpeckMath.Point3D(user.fetchLocX(), user.fetchLocY(), user.fetchLocZ()));
                            if (stayDist > 900) {
                                recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                return;
                            }
                        }

                        if (session.currentTargetId !== playerTargetId) {
                            session.currentTargetId = playerTargetId;
                            bot.select({ id: playerTargetId });
                            recordRoleDecision(session, bot, assistActionForRole(role), 'pvp_target', { targetId: playerTargetId });
                            if (Math.random() < 0.20) {
                                BotAI.say(session, "Assisting you in PvP! Attacking " + user.fetchName() + "!");
                            }
                        }
                        if (isBusy(bot)) {
                            return;
                        }
                        BotAI.executePvPCombat(session, bot, user, Generics);
                    } else {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    }
                }).catch(() => {
                    World.fetchNpc(playerTargetId).then((npc) => {
                        if (PartyAwareness.leaderCombatTargetId(playerSession) !== playerTargetId) return;
                        if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                        if (npc.fetchAttackable() && !npc.isDead()) {
                            if (session.botStay && session.stayLocation) {
                                const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                    .distance(new SpeckMath.Point3D(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()));
                                if (stayDist > 900) {
                                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                    return;
                                }
                            }

                            if (session.currentTargetId !== playerTargetId) {
                                session.currentTargetId = playerTargetId;
                                bot.select({ id: playerTargetId });
                                recordRoleDecision(session, bot, assistActionForRole(role), assistReasonForRole(role), { targetId: playerTargetId });
                                if (Math.random() < 0.20) {
                                    BotAI.say(session, "Assisting you! Smashing that " + npc.fetchName() + "!");
                                }
                            }
                            if (isBusy(bot)) {
                                return;
                            }
                            BotAI.executeCombat(session, bot, npc, Generics);
                        } else {
                            if (session.currentTargetId === playerTargetId) {
                                session.currentTargetId = undefined;
                                bot.unselect();
                            }
                        }
                    }).catch(() => {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    });
                });
            } else {
                session.currentTargetId = undefined;
                bot.unselect();
            }
        }

        if (!session.currentTargetId && !acted) {
            if (session.botStay && session.stayLocation) {
                session.lastFollowMoveTarget = null;
                const stayDist = point(bot).distance(new SpeckMath.Point3D(
                    session.stayLocation.locX,
                    session.stayLocation.locY,
                    session.stayLocation.locZ
                ));
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                }
                if (stayDist > 100) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: session.stayLocation.locX, locY: session.stayLocation.locY, locZ: session.stayLocation.locZ }
                    });
                }
            } else if (distance > FOLLOW_RUN_DISTANCE) {
                if (impairments.rooted) {
                    recordRoleDecision(session, bot, 'hold_position', 'rooted');
                    return;
                }
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'follow_leader', 'keep_range');
                }
                if (shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                    session.lastFollowMoveHeldAt = Date.now();
                    return;
                }
                const followTarget = followTargetFor(session, player);
                session.lastFollowMoveTarget = followTarget;
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: followTarget
                });
            } else {
                session.lastFollowMoveTarget = null;
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'ready');
                }
            }
        }
    }
};

const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const DecisionService = invoke('GameServer/Bot/AI/BotDecisionService');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const BotTargetScorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const BotPvpRisk      = invoke('GameServer/Bot/AI/BotPvpRisk');
const BotRoles        = invoke('GameServer/Bot/AI/BotRoles');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const BotTownTravel  = invoke('GameServer/Bot/AI/BotTownTravel');
const BotSpotTravel  = invoke('GameServer/Bot/AI/BotSpotTravel');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');

const TARGET_STALL_TICKS = 5;
const TARGET_RETRY_COOLDOWN_MS = 15000;
const TARGET_PROGRESS_DISTANCE = 40;
const TARGET_SPOT_GRID_SIZE = 6000;
const TARGET_GEODATA_CHECK_LIMIT = 4;
const EMERGENCY_RETREAT_HP_RATIO = 0.35;
const EMERGENCY_RETREAT_MP_RATIO = 0.20;
const EMERGENCY_RETREAT_DISTANCE = 850;
const MAX_WALK_SPOT_DISTANCE = 12000;
const SPOT_ARRIVAL_RADIUS = 1000;
const MAX_SPOT_RELOCATION_MS = 120000;

function isSoloHunter(session) {
    return session.plan === 'hunting' && session.partyCompanion !== true && !session.followPlayerSession;
}

function isPartyCompanion(session) {
    return session.partyCompanion === true && !!session.followPlayerSession;
}

function isClaimedByOtherSoloBot(session, npc) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const npcId = npc.fetchId();

    return BotManager.sessions.some((otherSession) => {
        if (otherSession === session || !otherSession.actor || !isSoloHunter(otherSession)) return false;
        if (otherSession.currentTargetId !== npcId) return false;
        return !otherSession.actor.state.fetchDead();
    });
}

function startShopping(session, bot, BotAI, reason) {
    if (isPartyCompanion(session)) {
        session.plan = 'following';
        session.shoppingTarget = undefined;
        session.shoppingDoneAnnounced = false;
        BotAI.say(session, "Staying with the party. I can sell loot later.");
        return false;
    }

    return BotTownTravel.request(session, bot, BotAI, reason);
}

function findPreferredMonster(session, bot, radius, options = {}) {
    const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), radius);
    const clanCounts = nearbyNpcs.reduce((counts, npc) => {
        const clan = npc.fetchClanName?.();
        if (clan) counts.set(clan, (counts.get(clan) || 0) + 1);
        return counts;
    }, new Map());
    const spotIdAt = (actor) => `${Math.floor(actor.fetchLocX() / TARGET_SPOT_GRID_SIZE)}_${Math.floor(actor.fetchLocY() / TARGET_SPOT_GRID_SIZE)}`;
    const currentSpotId = session.currentSpot?.id || spotIdAt(bot);

    const candidates = nearbyNpcs
        .filter((npc) => !options.excludeTargetId || npc.fetchId() !== options.excludeTargetId)
        .map((npc) => {
            const claimed = isClaimedByOtherSoloBot(session, npc);
            const npcSpotId = spotIdAt(npc);
            const clan = npc.fetchClanName?.();
            const scoreContext = {
                attackable: npc.fetchAttackable(),
                dead: npc.isDead(),
                retryCooldown: targetOnCooldown(session, npc.fetchId()),
                botLevel: bot.fetchLevel(),
                npcLevel: npc.fetchLevel?.() || bot.fetchLevel(),
                distance: targetDistance(bot, npc),
                verticalGap: Math.abs(bot.fetchLocZ() - npc.fetchLocZ()),
                currentSpotId,
                npcSpotId,
                claimed,
                socialAllies: clan ? Math.max(0, (clanCounts.get(clan) || 1) - 1) : 0
            };
            return { npc, evaluation: BotTargetScorer.score(scoreContext), scoreContext, claimed };
        })
        .filter((candidate) => !options.freeOnly || !candidate.claimed);

    const preRanked = BotTargetScorer.rank(candidates);
    const checkedIds = new Set(preRanked
        .slice(0, TARGET_GEODATA_CHECK_LIMIT)
        .map((candidate) => candidate.npc.fetchId()));
    const ranked = BotTargetScorer.rank(candidates.map((candidate) => {
        if (!checkedIds.has(candidate.npc.fetchId())) return candidate;
        const directPath = GeodataEngine.hasLineOfSight(
            bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ(),
            candidate.npc.fetchLocX(), candidate.npc.fetchLocY(), candidate.npc.fetchLocZ()
        );
        return {
            ...candidate,
            evaluation: BotTargetScorer.score({ ...candidate.scoreContext, directPath })
        };
    }));

    const selected = ranked[0] || null;
    session.lastTargetEvaluation = selected ? {
        targetId: selected.npc.fetchId(),
        targetName: selected.npc.fetchName(),
        score: selected.evaluation.score,
        reasons: selected.evaluation.reasons,
        at: Date.now()
    } : null;
    return selected?.npc || null;
}

function targetDistance(bot, target) {
    return new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
        .distance(new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()));
}

function targetOnCooldown(session, targetId) {
    const until = Number(session.targetRetryAfter?.[targetId] || 0);
    if (!until) return false;
    if (Date.now() < until) return true;
    delete session.targetRetryAfter[targetId];
    return false;
}

function botLocation(bot) {
    return { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
}

function finishWalkRelocation(session, bot, spot) {
    const arrivedSpot = SpotService.findById(spot.id) || spot;
    SpotService.assignSpot(session, arrivedSpot);
    session.initialSpawnCoord = { ...arrivedSpot.center };
    session.spotRelocation = undefined;
    session.townRoutePlan = null;
    session.lastSpotRelocation = { spotId: arrivedSpot.id, method: 'walk', at: Date.now() };
}

function expireSpotRelocation(session, bot, relocation) {
    session.spotRelocation = undefined;
    bot?.state?.setCasts?.(false);
    session.lastSpotRelocation = {
        spotId: relocation.spotId,
        method: `${relocation.method || 'walk'}_timeout`,
        at: Date.now()
    };
}

function expireTimedOutSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    const startedAt = Number(relocation.startedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < MAX_SPOT_RELOCATION_MS) return false;
    expireSpotRelocation(session, bot, relocation);
    return true;
}

function issueWalkRelocation(session, bot, relocation) {
    const from = botLocation(bot);
    relocation.lastCommandAt = Date.now();
    bot.moveTo({ from, to: { ...relocation.destination } });
}

function tickSpotRelocation(session, bot) {
    const relocation = session.spotRelocation;
    if (!relocation) return false;
    if (expireTimedOutSpotRelocation(session, bot)) return false;
    if (relocation.method === 'soe_gatekeeper') return true;

    const distance = SpotService.distance2d(botLocation(bot), relocation.destination);
    if (distance <= SPOT_ARRIVAL_RADIUS) {
        finishWalkRelocation(session, bot, SpotService.findById(relocation.spotId) || { id: relocation.spotId, center: relocation.destination });
        return false;
    }
    if (bot.state.fetchTowards() || session.moveTimer) return true;
    if (Date.now() - Number(relocation.lastCommandAt || 0) >= 1000) issueWalkRelocation(session, bot, relocation);
    return true;
}

function beginSpotRelocation(session, bot, spot, BotAI) {
    const destination = { ...spot.center };
    session.currentTargetId = undefined;
    bot.unselect?.();
    session.noTargetTicks = 0;
    session.lastSpotMoveAt = Date.now();

    if (SpotService.distance2d(botLocation(bot), destination) > MAX_WALK_SPOT_DISTANCE) {
        BotSpotTravel.start(session, bot, spot, destination);
        if (Math.random() < 0.65) BotAI.say(session, `No good mobs here. Using a gatekeeper to reach ${SpotService.describe(spot)}.`);
        return;
    }

    session.spotRelocation = {
        mode: 'walk',
        method: 'walk',
        spotId: spot.id,
        destination,
        startedAt: Date.now(),
        lastCommandAt: 0
    };
    if (Math.random() < 0.65) BotAI.say(session, `No good mobs here. Moving to ${SpotService.describe(spot)}.`);
    issueWalkRelocation(session, bot, session.spotRelocation);
}

function reconcilePhysicalSpot(session, bot) {
    if (session.spotRelocation) return;
    const physical = SpotService.findCurrentSpot(botLocation(bot));
    if (physical && session.currentSpot?.id !== physical.id) SpotService.assignSpot(session, physical);
}

function assignTarget(session, bot, target) {
    const targetId = target.fetchId();
    if (session.currentTargetId !== targetId) {
        session.targetTrackId = targetId;
        session.targetAcquiredAt = Date.now();
        session.targetLastDistance = targetDistance(bot, target);
        session.targetStallTicks = 0;
    }
    session.currentTargetId = targetId;
    bot.select({ id: targetId });
}

function clearTarget(session, bot, targetId, retryCooldown = false) {
    if (session.currentTargetId !== targetId) return false;
    if (retryCooldown) {
        session.targetRetryAfter = session.targetRetryAfter || {};
        session.targetRetryAfter[targetId] = Date.now() + TARGET_RETRY_COOLDOWN_MS;
    }
    session.currentTargetId = undefined;
    session.targetTrackId = undefined;
    session.targetAcquiredAt = undefined;
    session.targetLastDistance = undefined;
    session.targetStallTicks = 0;
    bot.unselect();
    return true;
}

function needsEmergencyRetreat(bot) {
    return bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < EMERGENCY_RETREAT_HP_RATIO
        || bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) < EMERGENCY_RETREAT_MP_RATIO;
}

function retreatFromThreat(session, bot, threat) {
    if (bot.state.fetchSeated()) {
        bot.state.setSeated(false);
        session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    }
    clearTarget(session, bot, session.currentTargetId);
    session.plan = 'fleeing';
    session.fleeStart = Date.now();
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    BotRetreatPlanner.retreat(session, bot, threat, { distance: EMERGENCY_RETREAT_DISTANCE });
}

function targetProgressing(session, bot, target) {
    const targetId = target.fetchId();
    const distance = targetDistance(bot, target);
    if (session.targetTrackId !== targetId) {
        session.targetTrackId = targetId;
        session.targetAcquiredAt = Date.now();
        session.targetLastDistance = distance;
        session.targetStallTicks = 0;
        return true;
    }

    const moving = bot.state.fetchTowards();
    const fighting = bot.state.fetchHits() || bot.state.fetchCasts() || distance <= 180;
    const movedCloser = Number(session.targetLastDistance || Infinity) - distance >= TARGET_PROGRESS_DISTANCE;
    session.targetLastDistance = distance;
    const shouldMeasureStall = moving || distance > 900;
    session.targetStallTicks = fighting || movedCloser || !shouldMeasureStall
        ? 0
        : (session.targetStallTicks || 0) + 1;
    return session.targetStallTicks < TARGET_STALL_TICKS;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        if (session.pendingTownTrip) {
            const trip = startShopping(session, bot, BotAI, session.pendingTownTrip.reason);
            if (trip !== 'deferred') return;
        }

        // 1. Expire buffs check for hunting bots
        if (!session.followPlayerSession) {
            if (BotBuffs.needsNewbieRefresh(bot, 0)) {
                session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                session.preBuffPlan = 'hunting';
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.automation.abortAll(bot);
                BotAI.say(session, "My newbie blessings have expired! Heading to the Newbie Guide to get buffed.");
                return;
            }
        }

        if (isSoloHunter(session) && ShotStock.needsActorRestock(bot, 0)) {
            const plan = ShotStock.planForActor(bot);
            const trip = startShopping(session, bot, BotAI, `Out of ${ShotStock.describe(plan)}. Heading to town to restock.`);
            if (trip !== 'deferred') return;
        }

        // 2. PK Spotting & Fleeing Check
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        let spottedPk = null;
        let pkDistance = 99999;

        World.user.sessions.forEach((user) => {
            const other = user.actor;
            if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() > 0) {
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                if (dist < 1500 && dist < pkDistance) {
                    pkDistance = dist;
                    spottedPk = other;
                }
            }
        });

        if (spottedPk) {
            const allies = World.user.sessions.filter((otherSession) => {
                const other = otherSession.actor;
                if (!BotPvpRisk.isCombatAlly(session, otherSession, spottedPk)) return false;
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                return dist < 1000;
            });
            const pvpDecision = BotPvpRisk.evaluate({
                botLevel: bot.fetchLevel(),
                threatLevel: spottedPk.fetchLevel(),
                hpRatio: bot.fetchHp() / Math.max(1, bot.fetchMaxHp()),
                mpRatio: bot.fetchMp() / Math.max(1, bot.fetchMaxMp()),
                allies: allies.length,
                targetedByThreat: spottedPk.fetchDestId?.() === bot.fetchId(),
                role: BotRoles.inferRole(bot)
            });
            session.lastPvpDecision = {
                ...pvpDecision,
                threatId: spottedPk.fetchId(),
                threatName: spottedPk.fetchName(),
                allies: allies.map((ally) => ally.actor.fetchId()),
                at: Date.now()
            };

            if (pvpDecision.action === 'fight') {
                if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'pk_combat');
                // Fight back!
                if (session.currentTargetId !== spottedPk.fetchId()) {
                    session.currentTargetId = spottedPk.fetchId();
                    bot.select({ id: spottedPk.fetchId() });
                    
                    if (Math.random() < 0.25) {
                        BotAI.say(session, `Everyone, attack the PK! Get ${spottedPk.fetchName()}!`);
                    }
                }
                if (!bot.state.fetchTowards() && !bot.state.fetchHits() && !bot.state.fetchCasts()) {
                    BotAI.executePvPCombat(session, bot, spottedPk, Generics);
                }
                return; // Skip rest of AI tick while fighting back PK!
            } else {
                if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'pk_flee');
                // Flee in panic!
                if (session.plan !== 'fleeing') {
                    session.plan = 'fleeing';
                    session.fleeStart = Date.now();
                    session.currentTargetId = undefined;
                    
                    const alarmPhrases = [
                        `Oh no! PK alert! ${spottedPk.fetchName()} is near! Run!`,
                        `Help! Red name ${spottedPk.fetchName()} is hunting here!`,
                        `PK! PK spotted! Flee for your lives!`,
                        `Ahhh! ${spottedPk.fetchName()} is going to PK us! Help!`
                    ];
                    BotAI.say(session, alarmPhrases[Math.floor(Math.random() * alarmPhrases.length)]);
                    
                    // Stand up if seated
                    if (bot.state.fetchSeated()) {
                        bot.state.setSeated(false);
                        session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
                    }

                    BotRetreatPlanner.retreat(session, bot, spottedPk, {
                        distance: EMERGENCY_RETREAT_DISTANCE
                    });
                }
                return; // Skip rest of AI tick while fleeing!
            }
        }

        // 3. Immediate self-defense outranks recovery. Sitting while a mob is
        // actively hitting the bot only turns the recovery state into a death loop.
        const incomingMonster = PartyAwareness.recentIncomingNpc(session);
        if (incomingMonster) {
            if (session.spotRelocation) BotSpotTravel.cancel(session, bot, 'incoming_threat');
            if (needsEmergencyRetreat(bot)) {
                retreatFromThreat(session, bot, incomingMonster);
                return;
            }
            assignTarget(session, bot, incomingMonster);
            if (bot.state.fetchSeated()) {
                bot.state.setSeated(false);
                session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            }
            BotAI.executeCombat(session, bot, incomingMonster, Generics);
            return;
        }

        // Expire a stuck walk/SoE transition even when the bot is too weak to
        // leave its recovery state yet. The movement gate below still yields
        // to HP/MP recovery for live relocations.
        expireTimedOutSpotRelocation(session, bot);

        // 4. HP/MP resting check
        const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
        const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
        if (hpRatio < 0.35 || mpRatio < 0.20) {
            if (session.currentTargetId) clearTarget(session, bot, session.currentTargetId);
            session.lastTargetEvaluation = undefined;
            session.lastCombatDecision = undefined;
            session.lastPvpDecision = undefined;
            session.plan = 'resting';
            bot.state.setSeated(true);
            session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
            return;
        }

        // A hunting-ground relocation owns the movement/combat window. Do not
        // attack starter mobs while walking or casting SoE to a better field.
        // Recovery above intentionally wins so a bot cannot walk while dying.
        if (tickSpotRelocation(session, bot)) return;

        if (isSoloHunter(session) && Math.random() < 0.005) { // ~0.5% chance per tick (~10 minutes)
            const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
            const trip = startShopping(session, bot, BotAI, `My bags are full of loot. Heading to ${closestTown.name} to sell and restock.`);
            if (trip !== 'deferred') return;
        }

        // 5. Hunt/Attack Combat execution
        if (session.currentTargetId) {
            const targetId = session.currentTargetId;
            World.fetchUser(targetId).then((targetActor) => {
                if (session.currentTargetId !== targetId) return;
                if (targetActor && targetActor.fetchIsOnline() && !targetActor.state.fetchDead()) {
                    if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                        return;
                    }
                    BotAI.executePvPCombat(session, bot, targetActor, Generics);
                } else {
                    clearTarget(session, bot, targetId);
                }
            }).catch(() => {
                World.fetchNpc(targetId).then((npc) => {
                    if (session.currentTargetId !== targetId) return;
                    if (npc.isDead()) {
                        if (Math.random() < 0.20) {
                            BotAI.say(session, BotAI.getRandomPhrase('victory'));
                        }
                        clearTarget(session, bot, targetId);
                    } else {
                        if (!targetProgressing(session, bot, npc)) {
                            clearTarget(session, bot, targetId, true);
                            session.lastDecision = {
                                action: 'abandon_target',
                                reason: 'no_progress',
                                targetId,
                                retryAfter: session.targetRetryAfter?.[targetId] || null
                            };
                            return;
                        }
                        if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                            return;
                        }

                        if (isClaimedByOtherSoloBot(session, npc)) {
                            const alternateMonster = findPreferredMonster(session, bot, 2500, {
                                excludeTargetId: npc.fetchId(),
                                freeOnly: true
                            });
                            if (alternateMonster) {
                                assignTarget(session, bot, alternateMonster);
                                BotAI.executeCombat(session, bot, alternateMonster, Generics);
                                return;
                            }
                        }

                        BotAI.executeCombat(session, bot, npc, Generics);
                    }
                }).catch(() => {
                    clearTarget(session, bot, targetId);
                });
            });
        } else {
            reconcilePhysicalSpot(session, bot);
            // Prefer unclaimed mobs so solo bots do not form accidental trains.
            const closestMonster = findPreferredMonster(session, bot, 2500);

            if (closestMonster) {
                session.noTargetTicks = 0;
                assignTarget(session, bot, closestMonster);

                if (!session.currentSpot) {
                    const spot = SpotService.findCurrentSpot({
                        locX: bot.fetchLocX(),
                        locY: bot.fetchLocY(),
                        locZ: bot.fetchLocZ()
                    });
                    SpotService.assignSpot(session, spot);
                }

                if (Math.random() < 0.15) {
                    BotAI.say(session, BotAI.getRandomPhrase('foundTarget', closestMonster.fetchName()));
                }
                BotAI.executeCombat(session, bot, closestMonster, Generics);
            } else {
                session.noTargetTicks = (session.noTargetTicks || 0) + 1;

                if (isPartyCompanion(session)) {
                    session.plan = 'following';
                    session.noTargetTicks = 0;
                    session.lastDecision = {
                        action: 'follow_leader',
                        reason: 'party_hunt_no_targets',
                        spotId: session.currentSpot?.id || null,
                        spotName: session.currentSpot?.name || null
                    };
                    return;
                }

                const currentSpot = SpotService.findCurrentSpot({
                    locX: bot.fetchLocX(),
                    locY: bot.fetchLocY(),
                    locZ: bot.fetchLocZ()
                });
                if (!session.currentSpot && currentSpot) {
                    SpotService.assignSpot(session, currentSpot);
                }

                const decision = DecisionService.suggest(BotAI.getStatus(session), session);
                session.lastDecision = {
                    action: decision.action,
                    reason: decision.reason,
                    spotId: decision.spot?.id || null,
                    spotName: decision.spot?.name || null
                };

                if (decision.action === 'move_to_spot' && decision.spot) {
                    beginSpotRelocation(session, bot, decision.spot, BotAI);
                    return;
                }

                // Wandering to search for monsters in starting zones if none nearby
                if (Math.random() < 0.50) {
                    if (!session.initialSpawnCoord) {
                        session.initialSpawnCoord = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                    }
                    const baseCoord = session.initialSpawnCoord;
                    
                    // Wander up to 2500 units away from their initial spawn coordinate to hunt!
                    const wanderX = baseCoord.locX + utils.oneFromSpan(-2500, 2500);
                    const wanderY = baseCoord.locY + utils.oneFromSpan(-2500, 2500);
                    
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: wanderX, locY: wanderY, locZ: bot.fetchLocZ() }
                    });
                }
            }
        }
    }
};

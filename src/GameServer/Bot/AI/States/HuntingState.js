const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const DecisionService = invoke('GameServer/Bot/AI/BotDecisionService');

function isSoloHunter(session) {
    return session.plan === 'hunting' && session.partyCompanion !== true && !session.followPlayerSession;
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

function findPreferredMonster(session, bot, radius, options = {}) {
    let closestFreeMonster = null;
    let closestFreeDistance = radius;
    let closestClaimedMonster = null;
    let closestClaimedDistance = radius;

    const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), radius);
    nearbyNpcs.forEach((npc) => {
        if (!npc.fetchAttackable() || npc.isDead()) return;
        if (options.excludeTargetId && npc.fetchId() === options.excludeTargetId) return;

        const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()));

        if (isClaimedByOtherSoloBot(session, npc)) {
            if (!options.freeOnly && distance < closestClaimedDistance) {
                closestClaimedDistance = distance;
                closestClaimedMonster = npc;
            }
            return;
        }

        if (distance < closestFreeDistance) {
            closestFreeDistance = distance;
            closestFreeMonster = npc;
        }
    });

    return closestFreeMonster || closestClaimedMonster;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        // 1. Expire buffs check for hunting bots
        if (bot.fetchLevel() <= 25 && bot.fetchKarma() === 0 && !session.followPlayerSession) {
            const buffsExpired = !bot.activeBuffs || !bot.activeBuffs.windWalk || Date.now() > bot.activeBuffs.windWalk;
            if (buffsExpired) {
                session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.automation.abortAll(bot);
                BotAI.say(session, "My newbie blessings have expired! Heading to the Newbie Guide to get buffed.");
                return;
            }
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
            // Count friendly (white) units nearby
            let friendlyCount = 1;
            World.user.sessions.forEach((user) => {
                const other = user.actor;
                if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() === 0) {
                    const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                    if (dist < 1000) {
                        friendlyCount++;
                    }
                }
            });

            // Fight or Flight evaluation
            if (bot.fetchLevel() >= spottedPk.fetchLevel() || friendlyCount >= 2) {
                // Fight back!
                if (session.currentTargetId !== spottedPk.fetchId()) {
                    session.currentTargetId = spottedPk.fetchId();
                    bot.select({ id: spottedPk.fetchId() });
                    
                    if (Math.random() < 0.25) {
                        BotAI.say(session, `Everyone, attack the PK! Get ${spottedPk.fetchName()}!`);
                    }
                    BotAI.executePvPCombat(session, bot, spottedPk, Generics);
                }
                return; // Skip rest of AI tick while fighting back PK!
            } else {
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

                    // Run in opposite direction
                    const dx = bot.fetchLocX() - spottedPk.fetchLocX();
                    const dy = bot.fetchLocY() - spottedPk.fetchLocY();
                    const length = Math.sqrt(dx*dx + dy*dy) || 1;
                    const fleeX = Math.round(bot.fetchLocX() + (dx / length) * 850);
                    const fleeY = Math.round(bot.fetchLocY() + (dy / length) * 850);
                    const fleeZ = GeodataEngine.getHeight(fleeX, fleeY, bot.fetchLocZ());
                    
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: fleeX, locY: fleeY, locZ: fleeZ }
                    });

                    setTimeout(() => {
                        if (session.plan === 'fleeing') {
                            session.plan = 'hunting';
                        }
                    }, 7000); // Flee for 7 seconds
                }
                return; // Skip rest of AI tick while fleeing!
            }
        }

        // 3. HP/MP resting check
        const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
        const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
        if (hpRatio < 0.35 || mpRatio < 0.20) {
            session.plan = 'resting';
            bot.state.setSeated(true);
            session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
            return;
        }

        if (Math.random() < 0.005) { // ~0.5% chance per tick (~10 minutes)
            const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());
            session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
            session.plan = 'shopping';
            session.shopTimer = Date.now();
            session.shoppingTarget = undefined;
            BotAI.say(session, `My bags are full of loot. Walking back to ${closestTown.name} to sell and restock.`);
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: closestTown.x, locY: closestTown.y, locZ: closestTown.z }
            });
            return;
        }

        // 5. Hunt/Attack Combat execution
        if (session.currentTargetId) {
            World.fetchUser(session.currentTargetId).then((targetActor) => {
                if (targetActor && targetActor.fetchIsOnline() && !targetActor.state.fetchDead()) {
                    if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                        return;
                    }
                    BotAI.executePvPCombat(session, bot, targetActor, Generics);
                } else {
                    session.currentTargetId = undefined;
                    bot.unselect();
                }
            }).catch(() => {
                World.fetchNpc(session.currentTargetId).then((npc) => {
                    if (npc.isDead()) {
                        if (Math.random() < 0.20) {
                            BotAI.say(session, BotAI.getRandomPhrase('victory'));
                        }
                        session.currentTargetId = undefined;
                        bot.unselect();
                    } else {
                        if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                            return;
                        }

                        if (isClaimedByOtherSoloBot(session, npc)) {
                            const alternateMonster = findPreferredMonster(session, bot, 2500, {
                                excludeTargetId: npc.fetchId(),
                                freeOnly: true
                            });
                            if (alternateMonster) {
                                session.currentTargetId = alternateMonster.fetchId();
                                bot.select({ id: alternateMonster.fetchId() });
                                BotAI.executeCombat(session, bot, alternateMonster, Generics);
                                return;
                            }
                        }

                        BotAI.executeCombat(session, bot, npc, Generics);
                    }
                }).catch(() => {
                    session.currentTargetId = undefined;
                    bot.unselect();
                });
            });
        } else {
            // Prefer unclaimed mobs so solo SimPlayers do not form accidental trains.
            const closestMonster = findPreferredMonster(session, bot, 2500);

            if (closestMonster) {
                session.noTargetTicks = 0;
                session.currentTargetId = closestMonster.fetchId();
                bot.select({ id: closestMonster.fetchId() });

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
                    const assignedSpot = SpotService.assignSpot(session, decision.spot);
                    const targetLoc = SpotService.randomPointNear(decision.spot);

                    session.initialSpawnCoord = { ...assignedSpot.center };
                    session.lastSpotMoveAt = Date.now();
                    session.noTargetTicks = 0;

                    if (Math.random() < 0.65) {
                        BotAI.say(session, `No good mobs here. Moving to ${SpotService.describe(decision.spot)}.`);
                    }

                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: targetLoc
                    });
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

const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const SpeckMath      = invoke('GameServer/SpeckMath');

const CHAT_PHRASES = {
    foundTarget: [
        "Let's hunt some %s!",
        "Aha! %s spotted!",
        "Going to smash this %s!",
        "Look at that juicy %s."
    ],
    victory: [
        "Easy fight! Next!",
        "Take that!",
        "Leveling up is so fun.",
        "Another one down."
    ],
    hurt: [
        "Ouch! That %s hits hard!",
        "Need healing ASAP!",
        "Whoa! My HP is dropping!",
        "Heal me please!"
    ],
    revived: [
        "I'm back! Let's try again.",
        "Death is just a setback.",
        "Who got the raise?",
        "Ready to rumble!"
    ]
};

function getRandomPhrase(category, ...args) {
    const list = CHAT_PHRASES[category];
    const phrase = list[Math.floor(Math.random() * list.length)];
    return require('util').format(phrase, ...args);
}

const BotAI = {
    init(session) {
        session.aiInterval = setInterval(() => {
            try {
                this.tick(session);
            } catch (err) {
                console.error("Bot AI Tick Error:", err);
            }
        }, 3000); // Ticks every 3 seconds
    },

    stop(session) {
        clearInterval(session.aiInterval);
    },

    tick(session) {
        const bot = session.actor;
        if (!bot) return;

        // Tiny chance to shout globally (e.g. 0.0005 chance per tick - roughly once every 2000 ticks or ~100 minutes per bot)
        if (Math.random() < 0.0005) {
            try {
                const BotManager = invoke('GameServer/Bot/BotManager');
                BotManager.handleBotGlobalShout(session);
            } catch (err) {
                console.error("Bot global shout error:", err);
            }
        }

        // If bot is a companion, dynamically refresh player's party HUD sidebar HP/MP bars
        if (session.plan === 'following' && session.followPlayerSession) {
            const playerSession = session.followPlayerSession;
            if (playerSession && playerSession.actor && playerSession.actor.fetchIsOnline()) {
                playerSession.dataSendToMe(
                    ServerResponse.partySmallWindowAll(
                        playerSession.actor.fetchId(),
                        0,
                        [bot]
                    )
                );
            }
        }

        const Generics = invoke(path.actor);

        // 1. Handle Death State
        if (bot.isDead()) {
            if (!session.deathTimerStart) {
                session.deathTimerStart = Date.now();
                this.say(session, "Oops... I died! Resurrecting shortly.");
            }

            // Revive after 10 seconds of death
            if (Date.now() - session.deathTimerStart > 12000) {
                Generics.revive(session, bot);
                bot.fillupVitals(); // Restore full HP/MP
                session.deathTimerStart = undefined;
                session.currentTargetId = undefined;
                session.plan = 'hunting'; // Reset plan
                
                // Teleport back to spawn coordinate to prevent getting stuck in deep water
                const spawns = newbieSpawnCoords(bot.fetchClassId());
                const coords = spawns[Math.floor(Math.random() * spawns.length)];
                Generics.teleportTo(session, bot, coords);
                
                this.say(session, getRandomPhrase('revived'));
            }
            return;
        }

        // 2. Initialize default plan if not set
        if (!session.plan) {
            session.plan = 'hunting';
        }

        // Handle Fleeing States
        if (session.plan === 'fleeing' || session.plan === 'pk_fleeing') {
            return; // Skip normal ticks while fleeing
        }

        // Handle getting_buffed plan for town guides
        if (session.plan === 'getting_buffed') {
            const guidePt = new SpeckMath.Point3D(-84081, 243227, -3723);
            const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
            const dist = botPt.distance(guidePt);

            if (dist > 250) {
                if (Math.random() < 0.20 || !bot.state.inMotion()) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: -84081, locY: 243227, locZ: -3723 }
                    });
                }
            } else {
                if (!bot.activeBuffs) {
                    bot.activeBuffs = {};
                }
                const duration = Date.now() + 20 * 60 * 1000;
                bot.activeBuffs.windWalk = duration;
                bot.activeBuffs.shield = duration;
                bot.activeBuffs.haste = duration;

                bot.setHp(bot.fetchMaxHp());
                bot.setMp(bot.fetchMaxMp());
                bot.statusUpdateVitals(bot);
                
                invoke(path.actor).calculateStats(session, bot);
                session.dataSendToMe(ServerResponse.userInfo(bot));
                
                this.say(session, "Thank you, Newbie Guide! Fully blessed and ready to hunt!");
                session.plan = 'hunting';
            }
            return;
        }

        // Expire buffs check for hunting bots
        if (session.plan === 'hunting' && bot.fetchLevel() <= 25 && bot.fetchKarma() === 0 && !session.followPlayerSession) {
            const buffsExpired = !bot.activeBuffs || !bot.activeBuffs.windWalk || Date.now() > bot.activeBuffs.windWalk;
            if (buffsExpired) {
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.automation.abortAll(bot);
                this.say(session, "My newbie blessings have expired! Heading to the Newbie Guide to get buffed.");
                return;
            }
        }

        // ================= PK Spotting & Hunting AI Checks =================
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

        if (session.plan !== 'pk_hunting') {
            // NORMAL BOTS: Check for nearby red-named players/bots
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
                            this.say(session, `Everyone, attack the PK! Get ${spottedPk.fetchName()}!`);
                        }
                        this.executePvPCombat(session, bot, spottedPk, Generics);
                    }
                } else {
                    // Flee in panic!
                    if (session.plan !== 'fleeing') {
                        session.plan = 'fleeing';
                        session.currentTargetId = undefined;
                        
                        const alarmPhrases = [
                            `Oh no! PK alert! ${spottedPk.fetchName()} is near! Run!`,
                            `Help! Red name ${spottedPk.fetchName()} is hunting here!`,
                            `PK! PK spotted! Flee for your lives!`,
                            `Ahhh! ${spottedPk.fetchName()} is going to PK us! Help!`
                        ];
                        this.say(session, alarmPhrases[Math.floor(Math.random() * alarmPhrases.length)]);
                        
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
                        
                        bot.moveTo({
                            from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                            to: { locX: fleeX, locY: fleeY, locZ: bot.fetchLocZ() }
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
        } else {
            // PK BOTS: Hunt players/bots, ignore mobs, flee if threatened
            let threatCount = 0;
            let highestThreat = null;

            World.user.sessions.forEach((user) => {
                const other = user.actor;
                if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() === 0) {
                    const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                    if (dist < 1500) {
                        if (other.fetchDestId() === bot.fetchId() || dist < 700) {
                            threatCount++;
                            if (other.fetchLevel() > bot.fetchLevel()) {
                                highestThreat = other;
                            }
                        }
                    }
                }
            });

            // Flee check for PK
            if (threatCount >= 2 || highestThreat) {
                if (session.plan !== 'pk_fleeing') {
                    session.plan = 'pk_fleeing';
                    session.currentTargetId = undefined;

                    const panicPhrases = [
                        `Whoa! Too many of them! Fall back!`,
                        `You win this time, white names! Running!`,
                        `Ah, you guys are too strong! Fallback!`,
                        `I will be back for your blood! Fleeing!`
                    ];
                    this.say(session, panicPhrases[Math.floor(Math.random() * panicPhrases.length)]);

                    const escapeFrom = highestThreat || bot; // flee from threat
                    const dx = bot.fetchLocX() - escapeFrom.fetchLocX();
                    const dy = bot.fetchLocY() - escapeFrom.fetchLocY();
                    const length = Math.sqrt(dx*dx + dy*dy) || 1;
                    const fleeX = Math.round(bot.fetchLocX() + (dx / length) * 900);
                    const fleeY = Math.round(bot.fetchLocY() + (dy / length) * 900);

                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: fleeX, locY: fleeY, locZ: bot.fetchLocZ() }
                    });

                    setTimeout(() => {
                        if (session.plan === 'pk_fleeing') {
                            session.plan = 'pk_hunting';
                        }
                    }, 6000);
                }
                return; // Skip rest of AI tick while fleeing!
            }

            // Normal PK Hunt Targeting
            if (session.currentTargetId) {
                // Keep attacking existing target
                const World = invoke('GameServer/World/World');
                World.fetchUser(session.currentTargetId).then((targetActor) => {
                    if (targetActor && targetActor.fetchIsOnline() && !targetActor.state.fetchDead()) {
                        this.executePvPCombat(session, bot, targetActor, Generics);
                    } else {
                        session.currentTargetId = undefined;
                    }
                }).catch(() => {
                    session.currentTargetId = undefined;
                });
                return;
            } else {
                // Scan for closest white player/bot
                let closestWhite = null;
                let closestDist = 99999;

                World.user.sessions.forEach((user) => {
                    const other = user.actor;
                    if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() === 0) {
                        const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                        if (dist < 2500 && dist < closestDist) {
                            closestDist = dist;
                            closestWhite = other;
                        }
                    }
                });

                if (closestWhite) {
                    session.currentTargetId = closestWhite.fetchId();
                    bot.select({ id: closestWhite.fetchId() });
                    
                    if (Math.random() < 0.20) {
                        this.say(session, `Found you, ${closestWhite.fetchName()}! Fresh meat!`);
                    }
                    this.executePvPCombat(session, bot, closestWhite, Generics);
                } else {
                    // Wandering around high density coordinates to find players
                    if (Math.random() < 0.20) {
                        // Tiny chance to relocate to a new farming sector if completely alone
                        if (Math.random() < 0.05) {
                            try {
                                const BotManager = invoke('GameServer/Bot/BotManager');
                                const densityCoord = BotManager.findHighDensityCoord();
                                Generics.teleportTo(session, bot, densityCoord);
                                return;
                            } catch (err) {}
                        }

                        const randomX = bot.fetchLocX() + utils.oneFromSpan(-150, 150);
                        const randomY = bot.fetchLocY() + utils.oneFromSpan(-150, 150);
                        bot.moveTo({
                            from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                            to: { locX: randomX, locY: randomY, locZ: bot.fetchLocZ() }
                        });
                    }
                }
                return; // PKs do not execute monster hunting!
            }
        }

        // 3. Resting / Mana recovery logic
        if (session.plan === 'hunting') {
            const hpRatio = bot.fetchHp() / bot.fetchMaxHp();
            const mpRatio = bot.fetchMp() / bot.fetchMaxMp();
            if (hpRatio < 0.35 || mpRatio < 0.20) {
                session.plan = 'resting';
                bot.state.setSeated(true);
                session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
                this.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
                return;
            }
        }

        if (session.plan === 'resting') {
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
                session.plan = 'hunting';
                this.say(session, "Fully rested! Ready to hunt again.");
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
            return; // Stay seated and do nothing else
        }

        // 4. Shopping logic
        if (session.plan === 'hunting' && Math.random() < 0.005) { // ~0.5% chance per tick (~10 minutes)
            session.plan = 'shopping';
            session.shopTimer = Date.now();
            this.say(session, "My bags are full of keltir skins! Walking back to Town to sell and restock.");
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: -84318, locY: 244579, locZ: -3730 } // Village center
            });
            return;
        }

        if (session.plan === 'shopping') {
            const distToTown = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
                .distance(new SpeckMath.Point3D(-84318, 244579, -3730));
            
            if (distToTown > 300) {
                // Keep moving to Town center if got diverted
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: -84318, locY: 244579, locZ: -3730 }
                });
                return;
            }

            // In town! Wait and pretend to shop
            if (!session.shoppingDoneAnnounced) {
                session.shoppingDoneAnnounced = true;

                // 1. Actually Sell their junk loot using our new sell-junk bypass!
                const NpcTalkResponse = invoke(path.world + 'NpcTalkResponse');
                NpcTalkResponse(session, { link: 'sell-junk' });

                // 2. Schedule actual Soulshot purchase after 4 seconds (giving time for the sell payout to register)
                const Database = invoke('Database');
                setTimeout(() => {
                    const backpack = bot.backpack;
                    const adena = backpack.fetchTotalAdena();
                    
                    if (adena >= 7000) {
                        // Deduct 7000 Adena
                        backpack.stackableExists(57).then((adenaItem) => {
                            const total = adenaItem.fetchAmount() - 7000;
                            Database.updateItemAmount(bot.fetchId(), adenaItem.fetchId(), total).then(() => {
                                adenaItem.setAmount(total);
                            });
                        });

                        // Give 1000 No Grade Soulshots (1835)
                        backpack.stackableExists(1835).then((shotItem) => {
                            const total = shotItem.fetchAmount() + 1000;
                            Database.updateItemAmount(bot.fetchId(), shotItem.fetchId(), total).then(() => {
                                shotItem.setAmount(total);
                            });
                        }).catch(() => {
                            Database.setItem(bot.fetchId(), {
                                selfId: 1835,
                                name: "Soulshot: No Grade",
                                amount: 1000,
                                equipped: false,
                                slot: 0
                            }).then((packet) => {
                                backpack.insertItem(Number(packet.insertId), 1835, { amount: 1000 });
                            });
                        });

                        this.say(session, "Bought 1000x Soulshot: No Grade (-7000 Adena)!");
                        // Play a fun casting effect to simulate purchasing / soulshots
                        session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);
                    } else {
                        this.say(session, `Not enough Adena to buy Soulshots (Have ${adena}/7000 Adena). Skipping restocking.`);
                    }
                }, 4000);

                setTimeout(() => {
                    this.say(session, "All stocked up! Returning to the keltir fields.");
                    session.plan = 'hunting';
                    session.shoppingDoneAnnounced = false;
                    // Teleport close to newbie field to start hunting again
                    Generics.teleportTo(session, bot, { locX: -81174, locY: 246037, locZ: -3719 });
                }, 9000);
            }
            return;
        }

        // 5. Following logic (Companion Mode)
        if (session.plan === 'following') {
            const playerSession = session.followPlayerSession;
            if (!playerSession || !playerSession.actor || !playerSession.actor.fetchIsOnline()) {
                session.plan = 'hunting';
                this.say(session, "My companion has disconnected. Heading back to hunt.");
                return;
            }

            const player = playerSession.actor;
            const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
                .distance(new SpeckMath.Point3D(player.fetchLocX(), player.fetchLocY(), player.fetchLocZ()));

            if (distance > 3500) {
                session.plan = 'hunting';
                this.say(session, "You ran too far away! I'm going back to hunt on my own.");
                return;
            }

            // Check if player has targeted a valid attackable target
            const playerTargetId = player.fetchDestId();
            if (playerTargetId) {
                // If player is in combat, assist them!
                World.fetchNpc(playerTargetId).then((npc) => {
                    if (npc.fetchAttackable() && !npc.isDead()) {
                        if (session.currentTargetId !== playerTargetId) {
                            session.currentTargetId = playerTargetId;
                            bot.select({ id: playerTargetId });
                            if (Math.random() < 0.20) {
                                this.say(session, "Assisting you! Smashing that " + npc.fetchName() + "!");
                            }
                        }
                    }
                }).catch(() => {});
            }

            // Move closer to player if not in combat and far
            if (!session.currentTargetId && distance > 250) {
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: player.fetchLocX() + utils.oneFromSpan(-60, 60), locY: player.fetchLocY() + utils.oneFromSpan(-60, 60), locZ: player.fetchLocZ() }
                });
                return;
            }
        }

        // 6. Normal Combat Attack target (HUNTING or ASSISTING)
        if (session.currentTargetId) {
            World.fetchNpc(session.currentTargetId).then((npc) => {
                if (npc.isDead()) {
                    if (Math.random() < 0.20) {
                        this.say(session, getRandomPhrase('victory'));
                    }
                    session.currentTargetId = undefined;
                    bot.unselect();
                } else {
                    if (bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts()) {
                        return;
                    }
                    this.executeCombat(session, bot, npc, Generics);
                }
            }).catch(() => {
                session.currentTargetId = undefined;
                bot.unselect();
            });
        } else if (session.plan === 'hunting') {
            // Find closest monster within 2500 units
            let closestMonster = null;
            let closestDistance = 2500;

            const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 2500);
            nearbyNpcs.forEach((npc) => {
                if (npc.fetchAttackable() && !npc.isDead()) {
                    const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
                        .distance(new SpeckMath.Point3D(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()));
                    
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closestMonster = npc;
                    }
                }
            });

            if (closestMonster) {
                session.currentTargetId = closestMonster.fetchId();
                bot.select({ id: closestMonster.fetchId() });

                if (Math.random() < 0.15) {
                    this.say(session, getRandomPhrase('foundTarget', closestMonster.fetchName()));
                }
                this.executeCombat(session, bot, closestMonster, Generics);
            } else {
                // Wandering to search for monsters in starting zones if none nearby
                if (Math.random() < 0.50) {
                    const spawns = newbieSpawnCoords(bot.fetchClassId());
                    const baseCoord = spawns[Math.floor(Math.random() * spawns.length)];
                    
                    // Wander up to 2500 units away from their newbie spawn base coordinate to hunt!
                    const wanderX = baseCoord.locX + utils.oneFromSpan(-2500, 2500);
                    const wanderY = baseCoord.locY + utils.oneFromSpan(-2500, 2500);
                    
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: wanderX, locY: wanderY, locZ: bot.fetchLocZ() }
                    });
                }
            }
        }
    },

    executePvPCombat(session, bot, victim, Generics) {
        this.executeCombat(session, bot, victim, Generics);
    },

    executeCombat(session, bot, npc, Generics) {
        const botName = bot.fetchName();
        if (botName === 'Bot_Gandalf') {
            const SkillModel = invoke('GameServer/Model/Skill');
            let skill = bot.skillset.fetchSkill(1177);
            if (!skill) {
                skill = new SkillModel({
                    selfId: 1177,
                    name: "Wind Strike",
                    level: 1,
                    hp: 0,
                    mp: 8,
                    hitTime: 1500,
                    reuse: 1000,
                    power: 12,
                    distance: 600,
                    passive: false
                });
                bot.skillset.skills.push(skill);
            }
            if (bot.fetchMp() >= skill.fetchConsumedMp()) {
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 1177 });
                return;
            }
        }
        else if (botName === 'Bot_Legolas') {
            const SkillModel = invoke('GameServer/Model/Skill');
            let skill = bot.skillset.fetchSkill(56);
            if (!skill) {
                skill = new SkillModel({
                    selfId: 56,
                    name: "Power Shot",
                    level: 1,
                    hp: 0,
                    mp: 5,
                    hitTime: 1200,
                    reuse: 1500,
                    power: 15,
                    distance: 600,
                    passive: false
                });
                bot.skillset.skills.push(skill);
            }
            if (bot.fetchMp() >= skill.fetchConsumedMp()) {
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 56 });
                return;
            }
        }

        Generics.attackExec(session, bot, { id: npc.fetchId() });
    },

    say(session, text) {
        if (!session.actor) return;
        session.dataSendToOthers(
            ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
            session.actor
        );
    }
};

function newbieSpawnCoords(classId) {
    const DataCache = invoke('GameServer/DataCache');
    return DataCache.newbieSpawns.find(ob => ob.classId === classId)?.spawns ?? [{ locX: -84318, locY: 244579, locZ: -3730 }];
}

module.exports = BotAI;

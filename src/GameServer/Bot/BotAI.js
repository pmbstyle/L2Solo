const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const BotStatus      = invoke('GameServer/Bot/AI/BotStatus');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

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

function newbieSpawnCoords(classId) {
    const DataCache = invoke('GameServer/DataCache');
    return DataCache.newbieSpawns.find(ob => ob.classId === classId)?.spawns ?? [{ locX: -84318, locY: 244579, locZ: -3730 }];
}

const States = {
    fleeing: invoke('GameServer/Bot/AI/States/FleeingState'),
    pk_fleeing: invoke('GameServer/Bot/AI/States/PkFleeingState'),
    getting_buffed: invoke('GameServer/Bot/AI/States/GettingBuffedState'),
    resting: invoke('GameServer/Bot/AI/States/RestingState'),
    shopping: invoke('GameServer/Bot/AI/States/ShoppingState'),
    following: invoke('GameServer/Bot/AI/States/FollowingState'),
    hunting: invoke('GameServer/Bot/AI/States/HuntingState'),
    pk_hunting: invoke('GameServer/Bot/AI/States/PkHuntingState'),
    merchant: invoke('GameServer/Bot/AI/States/MerchantState')
};

const BotAI = {
    init(session) {
        const runAiTick = () => {
            if (!session.actor || !session.aiActive) return;

            try {
                this.tick(session);
            } catch (err) {
                console.error("Bot AI Tick Error:", err);
            }

            const nextTickDelay = this.calculateNextTickDelay(session);
            session.aiTimeout = setTimeout(runAiTick, nextTickDelay);
        };

        session.aiActive = true;
        session.aiTimeout = setTimeout(runAiTick, 1000 + Math.random() * 2000);
    },

    stop(session) {
        session.aiActive = false;
        if (session.aiTimeout) {
            clearTimeout(session.aiTimeout);
            session.aiTimeout = null;
        }
    },

    wakeup(session) {
        if (!session.actor || !session.aiActive) return;
        if (session.aiTimeout) {
            clearTimeout(session.aiTimeout);
            session.aiTimeout = null;
        }

        const runAiTick = () => {
            if (!session.actor || !session.aiActive) return;

            try {
                this.tick(session);
            } catch (err) {
                console.error("Bot AI Tick Error:", err);
            }

            const nextTickDelay = this.calculateNextTickDelay(session);
            session.aiTimeout = setTimeout(runAiTick, nextTickDelay);
        };

        runAiTick();
    },

    calculateNextTickDelay(session) {
        const bot = session.actor;
        if (!bot) return 3000;

        const isCompanion = !!session.followPlayerSession && session.partyCompanion === true;
        if (session.plan === 'shopping') {
            return 1500;
        }

        const World = invoke('GameServer/World/World');
        const onlinePlayers = World.user.sessions.filter(s => 
            s.actor && 
            s.actor.fetchIsOnline() && 
            s.accountId && 
            !s.accountId.startsWith('bot_')
        );

        if (onlinePlayers.length === 0) {
            return 30000;
        }

        const botX = bot.fetchLocX();
        const botY = bot.fetchLocY();

        let minDist = Infinity;
        onlinePlayers.forEach(pSession => {
            const player = pSession.actor;
            const dx = player.fetchLocX() - botX;
            const dy = player.fetchLocY() - botY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
            }
        });

        if (isCompanion || minDist <= 1200) {
            return 1000 + Math.random() * 200;
        } else if (minDist <= 3000) {
            return 3000;
        } else if (minDist <= 6000) {
            return 5000;
        } else {
            return 30000;
        }
    },

    getClosestTown(locX, locY) {
        const towns = [
            { name: "Talking Island", x: -84318, y: 244579, z: -3730 },
            { name: "Elven Village", x: 45475, y: 48359, z: -3060 },
            { name: "Dark Elven Village", x: 12111, y: 16686, z: -4582 },
            { name: "Dwarven Village", x: 115632, y: -177996, z: -905 },
            { name: "Orc Village", x: -45032, y: -113598, z: -192 },
            { name: "Gludio", x: -12672, y: 122776, z: -3730 },
            { name: "Dion", x: 15664, y: 142979, z: -3730 },
            { name: "Giran", x: 83400, y: 147943, z: -3730 },
            { name: "Oren", x: 82960, y: 53177, z: -3730 }
        ];
        let closest = towns[0];
        let minDist = Infinity;
        towns.forEach(town => {
            const dx = town.x - locX;
            const dy = town.y - locY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                closest = town;
            }
        });
        return closest;
    },

    getClosestTownName(locX, locY) {
        return this.getClosestTown(locX, locY).name;
    },

    getClosestNewbieGuide(locX, locY) {
        const guides = [
            { name: "Talking Island", locX: -84081, locY: 243227, locZ: -3723 },
            { name: "Elven Village", locX: 45475, locY: 48359, locZ: -3060 },
            { name: "Dark Elven Village", locX: 12111, locY: 16686, locZ: -4582 },
            { name: "Dwarven Village", locX: 115632, locY: -177996, locZ: -905 },
            { name: "Orc Village", locX: -45032, locY: -113598, locZ: -192 }
        ];
        let closest = guides[0];
        let minDist = Infinity;
        guides.forEach(g => {
            const dx = g.locX - locX;
            const dy = g.locY - locY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                closest = g;
            }
        });
        return closest;
    },

    triggerFarAwayChatEvent(session, bot) {
        try {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const townName = this.getClosestTownName(bot.fetchLocX(), bot.fetchLocY());

            const pkSession = BotManager.sessions.find(s => s.actor && s.actor.fetchKarma() > 0);
            const pkLoc = pkSession?.actor ? this.getClosestTownName(pkSession.actor.fetchLocX(), pkSession.actor.fetchLocY()) : "Dion";
            const pkName = pkSession?.actor ? pkSession.actor.fetchName() : "a red name";

            const pkPhrases = [
                `Help! PK spotted near ${pkLoc}!`,
                `Watch out, ${pkName} is PKing near ${pkLoc}!`,
                `Someone deal with the red name at ${pkLoc}!`,
                `${pkName} is hunting people near ${pkLoc}! Flee!`
            ];

            const normalPhrases = [
                `WTB wood/leather near ${townName}! PM me!`,
                `Farming is so peaceful near ${townName}.`,
                `LFP for Goblins near ${townName}!`,
                `Selling fresh drops near ${townName} center!`,
                `Wow, the mobs near ${townName} are spawning fast today.`
            ];

            const pkSelfPhrases = [
                `No one is safe near ${townName}! I'm coming for you!`,
                `Dion and ${townName} are my hunting grounds! Prepare to die!`,
                `Haha, another soul claimed near ${townName}!`,
                `You can run, but you can't hide from me near ${townName}!`
            ];

            let text = "";
            if (bot.fetchKarma() > 0) {
                text = pkSelfPhrases[Math.floor(Math.random() * pkSelfPhrases.length)];
            } else if (Math.random() < 0.25 && pkSession && pkSession.actor && !pkSession.actor.state.fetchDead()) {
                text = pkPhrases[Math.floor(Math.random() * pkPhrases.length)];
            } else {
                text = normalPhrases[Math.floor(Math.random() * normalPhrases.length)];
            }

            BotManager.botShout(session, text);
        } catch (err) {
            console.error("Far away chat event error:", err);
        }
    },

    tick(session) {
        const bot = session.actor;
        if (!bot) return;

        PopulationService.recordHotTick(session);
        session.botStatus = BotStatus.getStatus(session);

        const isCompanion = !!session.followPlayerSession && session.partyCompanion === true;
        const World = invoke('GameServer/World/World');
        const onlinePlayers = World.user.sessions.filter(s => 
            s.actor && 
            s.actor.fetchIsOnline() && 
            s.accountId && 
            !s.accountId.startsWith('bot_')
        );

        let minDist = Infinity;
        if (onlinePlayers.length > 0) {
            const botX = bot.fetchLocX();
            const botY = bot.fetchLocY();
            onlinePlayers.forEach(pSession => {
                const player = pSession.actor;
                const dx = player.fetchLocX() - botX;
                const dy = player.fetchLocY() - botY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < minDist) {
                    minDist = dist;
                }
            });
        }

        if (onlinePlayers.length > 0 && minDist > 1500 && !isCompanion && session.plan !== 'shopping') {
            // Far-away bot: light background event processing, skip everything else
            if (Math.random() < 0.05) {
                this.triggerFarAwayChatEvent(session, bot);
            }
            return;
        }

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
        if (session.followPlayerSession && session.partyCompanion === true) {
            const playerSession = session.followPlayerSession;
            if (playerSession && playerSession.actor && playerSession.actor.fetchIsOnline()) {
                playerSession.dataSendToMe(
                    ServerResponse.partySmallWindowUpdate(bot)
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

            // Revive after 12 seconds of death
            if (Date.now() - session.deathTimerStart > 12000) {
                Generics.revive(session, bot);
                bot.fillupVitals(); // Restore full HP/MP
                session.deathTimerStart = undefined;
                session.currentTargetId = undefined;
                
                let spawnTarget;
                if (bot.fetchKarma() > 0) {
                    session.plan = 'pk_hunting';
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    spawnTarget = BotManager.findHighDensityCoord();
                    spawnTarget.locX += (Math.random() - 0.5) * 800;
                    spawnTarget.locY += (Math.random() - 0.5) * 800;
                    spawnTarget.locZ = GeodataEngine.getHeight(spawnTarget.locX, spawnTarget.locY, spawnTarget.locZ);
                } else {
                    if (session.plan === 'merchant' || (bot.fetchPrivateStore && bot.fetchPrivateStore())) {
                        session.plan = 'merchant';
                        bot.state.setSeated(true);
                        spawnTarget = {
                            locX: session.initialSpawnCoord.locX,
                            locY: session.initialSpawnCoord.locY,
                            locZ: session.initialSpawnCoord.locZ
                        };
                    } else {
                        session.plan = 'hunting'; // Reset plan
                        
                        // Teleport back to spawn coordinate to prevent getting stuck in deep water
                        if (!session.initialSpawnCoord) {
                            session.initialSpawnCoord = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                        }
                        
                        spawnTarget = {
                            locX: session.initialSpawnCoord.locX + (Math.random() - 0.5) * 1000,
                            locY: session.initialSpawnCoord.locY + (Math.random() - 0.5) * 1000,
                            locZ: session.initialSpawnCoord.locZ
                        };
                        spawnTarget.locZ = GeodataEngine.getHeight(spawnTarget.locX, spawnTarget.locY, spawnTarget.locZ);
                    }
                }
                
                Generics.teleportTo(session, bot, spawnTarget);
                
                this.say(session, getRandomPhrase('revived'));
            }
            return;
        }

        // 2. Initialize default plan if not set
        if (!session.plan) {
            session.plan = 'hunting';
        }

        // 3. Dynamic State Machine Routing
        const state = States[session.plan];
        if (state) {
            try {
                state.tick(session, bot, Generics, BotAI);
                session.botStatus = BotStatus.getStatus(session);
            } catch (err) {
                console.error(`Error in Bot AI State (${session.plan}) tick:`, err);
            }
        } else {
            utils.infoWarn('GameServer', 'Unhandled Bot plan: %s', session.plan);
        }
    },

    executePvPCombat(session, bot, victim, Generics) {
        this.executeCombat(session, bot, victim, Generics);
    },

    executeCombat(session, bot, npc, Generics) {
        const role = BotRoles.inferRole(bot);
        const MAGE_ATTACK_RANGE = 600;
        const ARCHER_ATTACK_RANGE = 700;

        if (role === 'mage' || role === 'healer' || role === 'buffer') {
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
                    distance: MAGE_ATTACK_RANGE,
                    passive: false
                });
                bot.skillset.skills.push(skill);
            }
            if (bot.fetchMp() >= skill.fetchConsumedMp()) {
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 1177, ctrl: true });
                return;
            }
        }
        else if (role === 'archer') {
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
                    distance: ARCHER_ATTACK_RANGE,
                    passive: false
                });
                bot.skillset.skills.push(skill);
            }
            if (bot.fetchMp() >= skill.fetchConsumedMp()) {
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 56, ctrl: true });
                return;
            }
            Generics.attackExec(session, bot, { id: npc.fetchId(), ctrl: true, range: ARCHER_ATTACK_RANGE });
            return;
        }
        else {
            // Melee Fighter: Cast Power Strike with 40% probability if MP allows
            if (Math.random() < 0.40) {
                const SkillModel = invoke('GameServer/Model/Skill');
                let skill = bot.skillset.fetchSkill(3);
                if (!skill) {
                    skill = new SkillModel({
                        selfId: 3,
                        name: "Power Strike",
                        level: 1,
                        hp: 0,
                        mp: 4,
                        hitTime: 1000,
                        reuse: 2000,
                        power: 10,
                        distance: 80,
                        passive: false
                    });
                    bot.skillset.skills.push(skill);
                }
                if (bot.fetchMp() >= skill.fetchConsumedMp()) {
                    Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 3, ctrl: true });
                    return;
                }
            }
        }

        Generics.attackExec(session, bot, { id: npc.fetchId(), ctrl: true });
    },

    say(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        session.dataSendToOthers(
            ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
            session.actor
        );
    },

    tell(session, targetSession, text) {
        if (!session.actor || !targetSession || !targetSession.dataSendToMe) return;
        const clean = String(text || '').trim().slice(0, 120);
        if (!clean) return;

        const ServerResponse = invoke('GameServer/Network/Response');
        targetSession.dataSendToMe(
            ServerResponse.speak(session.actor, { kind: 2, text: clean })
        );
    },

    trade(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        const World = invoke('GameServer/World/World');
        const packet = ServerResponse.speak(session.actor, { kind: 8, text: text });

        World.user.sessions.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function' && user.accountId.indexOf('bot_') !== 0) {
                user.dataSendToMe(packet);
            }
        });
    },

    getStatus(session) {
        const status = BotStatus.getStatus(session);
        session.botStatus = status;
        return status;
    },

    summarizeStatus(session) {
        return BotStatus.summarize(this.getStatus(session));
    }
};

BotAI.CHAT_PHRASES = CHAT_PHRASES;
BotAI.getRandomPhrase = getRandomPhrase;
BotAI.newbieSpawnCoords = newbieSpawnCoords;

module.exports = BotAI;

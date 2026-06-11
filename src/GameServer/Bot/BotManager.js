const Database    = invoke('Database');
const Shared      = invoke('GameServer/Network/Shared');
const DataCache   = invoke('GameServer/DataCache');
const World       = invoke('GameServer/World/World');
const BotSession  = invoke('GameServer/Bot/BotSession');
const BotAI       = invoke('GameServer/Bot/BotAI');
const BotBrain    = invoke('GameServer/Bot/AI/BotBrain');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const MerchantConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const TradeService = invoke('GameServer/Bot/TradeService');

const BOTS_TO_SPAWN = [
    { name: "Bot_Gimli",   race: 4, sex: 0, classId: 53, face: 0, hair: 0, hairColor: 0 }, // Dwarf
    { name: "Bot_Legolas", race: 1, sex: 0, classId: 18, face: 0, hair: 4, hairColor: 0 }, // Elf
    { name: "Bot_Gandalf", race: 0, sex: 0, classId: 10, face: 0, hair: 2, hairColor: 0 }  // Human Mage
];

const MERCHANT_BOTS = Object.keys(MerchantConfigs).map(name => {
    const cfg = MerchantConfigs[name];
    return { name: name, race: 4, sex: 0, classId: 53, face: 0, hair: 0, hairColor: 0, locX: cfg.locX, locY: cfg.locY, locZ: cfg.locZ };
});

const isMerchantName = name => !!MerchantConfigs[name];

const EXTRA_BOTS_COUNT = 10; // Configurable: Set to 20, 50, or more to scale up the bot count!

const FANTASY_NAMES = [
    "Aragorn", "Boromir", "Galadriel", "Arwen", "Elrond", "Eowyn", "Faramir", "Theoden", 
    "Conan", "Xena", "Arthur", "Merlin", "Robin", "Marian", "Frodo", "Samwise", 
    "Merry", "Pippin", "Bilbo", "Geralt", "Yennefer", "Triss", "Ciri", "Dandelion"
];

const BOT_COMBINATIONS = [
    { race: 0, sex: 0, classId: 10 }, // Human Mage
    { race: 0, sex: 0, classId: 0 },  // Human Fighter
    { race: 1, sex: 0, classId: 18 }, // Elf Knight
    { race: 4, sex: 0, classId: 53 }  // Dwarf Scavenger
];

const BotManager = {
    sessions: [],

    findSessionByName(name) {
        const lookup = String(name || '').toLowerCase();
        return this.sessions.find((session) => session.actor && session.actor.fetchName().toLowerCase() === lookup);
    },

    findSessionById(id) {
        return this.sessions.find((session) => session.actor && session.actor.fetchId() === id);
    },

    getBotStatus(sessionOrName) {
        const session = typeof sessionOrName === 'string' ? this.findSessionByName(sessionOrName) : sessionOrName;
        if (!session) return null;
        return BotAI.getStatus(session);
    },

    getAllBotStatuses() {
        return this.sessions
            .filter((session) => session.actor)
            .map((session) => BotAI.getStatus(session));
    },

    renderBotStatusPanel(playerSession, botSession = null) {
        if (!playerSession.actor) return;

        const ServerResponse = invoke('GameServer/Network/Response');
        const pct = (value) => `${Math.round((value || 0) * 100)}%`;
        const row = (label, value) => `<tr><td width=80><font color="LEVEL">${label}</font></td><td width=190>${value}</td></tr>`;

        if (!botSession) {
            const statuses = this.getAllBotStatuses().slice(0, 14);
            let html = `<html><body><title>Bot Status</title><font color="LEVEL">Bot Runtime Status</font><br><br>`;
            statuses.forEach((status) => {
                const blockers = status.blockers.length > 0 ? ` / ${status.blockers.join(',')}` : '';
                html += `<a action="bypass -h bot-status ${status.name}">${status.name}</a>: ${status.mode}, ${status.intent}, HP ${pct(status.vitals.hpPct)}, MP ${pct(status.vitals.mpPct)}${blockers}<br>`;
            });
            html += `</body></html>`;
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
            return;
        }

        const status = this.getBotStatus(botSession);
        if (!status || !status.available) {
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), `<html><body><title>Bot Status</title>Bot status unavailable.</body></html>`));
            return;
        }

        const spot = status.spot ? `${status.spot.name} / Lv ${status.spot.minLevel}-${status.spot.maxLevel} / density ${status.spot.density}` : 'none';
        const target = status.target ? `${status.target.type}:${status.target.name || status.target.id}` : 'none';
        const party = status.party ? `${status.party.role}, ${status.party.stance}, leader ${status.party.leader?.name || 'unknown'}` : 'none';
        const blockers = status.blockers.length > 0 ? status.blockers.join(', ') : 'none';
        const decision = botSession.lastDecision ? `${botSession.lastDecision.action} / ${botSession.lastDecision.reason}${botSession.lastDecision.spotName ? ` / ${botSession.lastDecision.spotName}` : ''}` : 'none';
        const trade = status.trade?.last ? status.trade.last :
            status.trade?.shoppingTarget ? `going to ${status.trade.shoppingTarget.name}` :
            status.trade?.store ? `${status.trade.store.type} / ${status.trade.store.title}` : 'none';

        let html = `<html><body><title>Bot Status</title><font color="LEVEL">${status.name}</font><br><br>`;
        html += `<table width=270>`;
        html += row('Mode', status.mode);
        html += row('Intent', status.intent);
        html += row('Role', status.role);
        html += row('Vitals', `HP ${pct(status.vitals.hpPct)} / MP ${pct(status.vitals.mpPct)}`);
        html += row('Target', target);
        html += row('Party', party);
        html += row('Spot', spot);
        html += row('Nearby', `players ${status.nearby.realPlayers}, bots ${status.nearby.friendlyBots}, mobs ${status.nearby.attackableNpcs}`);
        html += row('Move', status.movement.moving ? `moving (${status.movement.towards})` : 'idle');
        html += row('Blockers', blockers);
        html += row('Decision', decision);
        html += row('Trade', trade);
        html += `</table><br>`;
        html += `<a action="bypass -h bot-status ${status.name}">Refresh</a>`;
        html += `</body></html>`;

        playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
    },

    init() {
        console.info("BotManager :: Initializing automated SimPlayers...");
        
        const bots = [...BOTS_TO_SPAWN, ...MERCHANT_BOTS];

        // Dynamically generate extra bots
        for (let i = 0; i < EXTRA_BOTS_COUNT; i++) {
            const name = FANTASY_NAMES[i % FANTASY_NAMES.length] + (Math.floor(i / FANTASY_NAMES.length) || "");
            const combo = BOT_COMBINATIONS[i % BOT_COMBINATIONS.length];
            bots.push({
                name: name,
                race: combo.race,
                sex: combo.sex,
                classId: combo.classId,
                face: 0,
                hair: 0,
                hairColor: 0
            });
        }
        
        // Wait 5 seconds after startup to let world finish loading
        setTimeout(() => {
            bots.forEach((botData, idx) => {
                this.provisionAndSpawn(botData, idx);
            });
            this.startDynamicScalingMonitor();
            this.startStatusLogMonitor();
        }, 5000);
    },

    provisionAndSpawn(botData, idx) {
        const username = ("bot_" + botData.name.toLowerCase()).slice(0, 16);
        
        // 1. Ensure Bot Account exists
        Database.fetchUserPassword(username).then((rows) => {
            if (!rows[0]) {
                Database.createAccount(username, "botpass").then(() => {
                    this.provisionCharacter(username, botData, idx);
                });
            } else {
                this.provisionCharacter(username, botData, idx);
            }
        });
    },

    provisionCharacter(username, botData, idx) {
        // 2. Ensure Bot Character exists
        Database.fetchCharacterName(botData.name).then((rows) => {
            if (!rows[0]) {
                Shared.fetchClassInformation(botData.classId).then((classInfo) => {
                    let coords;
                    if (botData.locX !== undefined) {
                        coords = {
                            locX: botData.locX,
                            locY: botData.locY,
                            locZ: botData.locZ
                        };
                    } else {
                        const spawns = BotAI.newbieSpawnCoords(botData.classId);
                        const spawn = spawns[Math.floor(Math.random() * spawns.length)];
                        coords = {
                            locX: spawn.locX + (idx % 5) * 20, // small offset to avoid direct overlapping
                            locY: spawn.locY + (idx % 5) * 20,
                            locZ: spawn.locZ
                        };
                    }

                    const charData = {
                        name: botData.name,
                        race: botData.race,
                        sex: botData.sex,
                        classId: botData.classId,
                        hair: botData.hair ?? 0,
                        hairColor: botData.hairColor ?? 0,
                        face: botData.face ?? 0,
                        ...classInfo.vitals,
                        ...coords
                    };

                    Database.createCharacter(username, charData).then((packet) => {
                        const charId = Number(packet.insertId);
                        this.awardBaseGear(charId, botData.classId);
                        this.awardBaseSkills(charId, botData.classId);
                        this.loadAndSpawnBot(username);
                    });
                });
            } else {
                this.loadAndSpawnBot(username);
            }
        });
    },

    loadAndSpawnBot(username) {
        const session = new BotSession(username);
        
        Shared.fetchCharacters(username).then((characters) => {
            const character = characters[0];
            if (!character) return;

            Shared.fetchClassInformation(character.classId).then((classInfo) => {
                // Reset merchant bots back to their exact designated coordinates on load
                if (isMerchantName(character.name)) {
                    const config = MERCHANT_BOTS.find(b => b.name === character.name);
                    if (config) {
                        character.locX = config.locX;
                        character.locY = config.locY;
                        character.locZ = config.locZ;
                    }
                }

                // Randomize initial location slightly to scatter them across the starting area
                if (character.name !== "Bot_Gimli" && character.name !== "Bot_Legolas" && character.name !== "Bot_Gandalf" && character.name !== "Aragorn" && !isMerchantName(character.name)) {
                    character.locX += (Math.random() - 0.5) * 1600;
                    character.locY += (Math.random() - 0.5) * 1600;
                }

                character.locZ = GeodataEngine.getHeight(character.locX, character.locY, character.locZ);

                session.setActor({
                    ...character, ...utils.crushOb(classInfo)
                });
                
                session.initialSpawnCoord = {
                    locX: character.locX,
                    locY: character.locY,
                    locZ: character.locZ
                };

                // Designate some extra bots as permanent town gossips, and Aragorn as PK!
                if (character.name !== "Bot_Gimli" && character.name !== "Bot_Legolas" && character.name !== "Bot_Gandalf") {
                    if (character.name === "Aragorn") {
                        session.plan = 'pk_hunting';
                        session.actor.setPk(5);
                        session.actor.setKarma(9999);
                        
                        // Teleport Aragorn to the highest player density coordinate after spawning
                        setTimeout(() => {
                            const densityCoord = this.findHighDensityCoord();
                            session.actor.setLocXYZ(densityCoord);
                            
                            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
                            if (TeleportTo && typeof TeleportTo === 'function') {
                                TeleportTo(session, session.actor, densityCoord);
                            }
                            utils.infoSuccess("BotManager", "PK Bot %s (Level %d) is hunting at %d, %d", character.name, character.level, densityCoord.locX, densityCoord.locY);
                        }, 8000);
                    } else if (isMerchantName(character.name)) {
                        session.plan = 'merchant';
                        session.actor.state.setSeated(true);

                        const storeCfg = MerchantConfigs[character.name];
                        if (storeCfg) {
                            session.actor.setTitle(storeCfg.title);
                            session.actor.setPrivateStoreType(storeCfg.storeType);

                            const storeItems = TradeService.normalizeStoreItems(storeCfg);

                            session.actor.setPrivateStore({
                                storeType: storeCfg.storeType,
                                title: storeCfg.title,
                                town: storeCfg.town,
                                items: storeItems
                            });
                        }
                    } else if (Math.random() < 0.40) {
                        session.plan = 'resting';
                        session.townGossip = true;
                        session.actor.state.setSeated(true);
                    } else {
                        session.plan = 'hunting';
                    }
                } else {
                    session.plan = 'hunting';
                }

                // Spawn the bot actor in the World
                World.insertUser(session);
                session.actor.enterWorld();

                // Explicitly send the bot's CharInfo to other players in the world
                const ServerResponse = invoke('GameServer/Network/Response');
                session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
                session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);

                // Start AI loop
                BotAI.init(session);
                
                this.sessions.push(session);
                let modeText = "[Hunting Mode]";
                if (session.townGossip) modeText = "[Gossip Mode]";
                if (session.plan === 'pk_hunting') modeText = "[PK Mode]";
                if (session.plan === 'merchant') modeText = "[Merchant Mode]";
                utils.infoSuccess("BotManager", "%s (Level %d) is active in World %s", character.name, character.level, modeText);
            });
        });
    },

    awardBaseGear(id, classId) {
        const items = DataCache.newbieItems.find(ob => ob.classId === classId)?.items ?? [];
        items.forEach((item) => {
            item.slot = DataCache.items.find(ob => ob.selfId === item.selfId)?.etc?.slot ?? 0;
            // Equip weapons/armors automatically for bots
            item.equipped = true;
            Database.setItem(id, item);
        });
    },

    awardBaseSkills(id, classId) {
        DataCache.fetchSkillTreeFromClassId(classId, (skillTree) => {
            const skills = skillTree.skills ?? [];
            const level1 = skills.filter((ob) => ob.levels.find((ob) => ob.pLevel === 1));

            level1.forEach((skill) => {
                skill.levels = skill.levels.filter((ob) => ob.pLevel === 1);
                DataCache.fetchSkillFromSelfId(skill.selfId, (skillDetails) => {
                    skill = { ...utils.crushOb(skill), passive: skillDetails.template?.passive ?? false };
                    Database.setSkill(skill, id);
                });
            });
        });
    },

    handlePlayerSpeak(playerSession, data) {
        const rawText = data.text.trim();
        const text = rawText.toLowerCase();
        const player = playerSession.actor;
        if (!player || rawText.length === 0) return;

        const SpeckMath = invoke('GameServer/SpeckMath');
        const playerPt = new SpeckMath.Point3D(player.fetchLocX(), player.fetchLocY(), player.fetchLocZ());
        let brainGroupResponderPicked = false;

        this.sessions.forEach((session) => {
            const bot = session.actor;
            if (!bot) return;

            const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ()).distance(playerPt);
            if (distance > 1500) return; // Too far to hear

            let handledByRule = false;

            if (text.includes("hi") || text.includes("hello") || text.includes("привет") || text.includes("ку")) {
                handledByRule = true;
                setTimeout(() => {
                    const currentPlan = session.plan || 'hunting';
                    const phrases = [
                        `Hey ${player.fetchName()}! I'm currently ${currentPlan}.`,
                        `Hello there! Ready to kill some keltirs?`,
                        `Hi! Beautiful day to hunt, isn't it?`
                    ];
                    this.botSay(session, phrases[Math.floor(Math.random() * phrases.length)]);
                }, 1000 + Math.random() * 1000);
            }

            else if (text.includes("follow") || text.includes("за мной") || text.includes("помоги")) {
                handledByRule = true;
                setTimeout(() => {
                    if (session.partyCompanion === true && session.followPlayerSession === playerSession) {
                        this.botSay(session, `Sure! I will follow you and assist in combat.`);
                        session.plan = 'following';
                    } else {
                        this.botTell(session, playerSession, `I can come closer, but invite me if you want party follow.`);
                        bot.moveTo({
                            from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                            to: {
                                locX: player.fetchLocX() + utils.oneFromSpan(-80, 80),
                                locY: player.fetchLocY() + utils.oneFromSpan(-80, 80),
                                locZ: player.fetchLocZ()
                            }
                        });
                    }
                }, 800 + Math.random() * 800);
            }

            else if (text.includes("stop") || text.includes("стой") || text.includes("wait")) {
                handledByRule = true;
                setTimeout(() => {
                    this.botSay(session, `Staying here! Let me know if you need help.`);
                    session.plan = 'resting';
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() }
                    });
                }, 800 + Math.random() * 800);
            }

            else if (text.includes("hunt") || text.includes("иди качайся") || text.includes("кач")) {
                handledByRule = true;
                setTimeout(() => {
                    this.botSay(session, `Alright, returning to hunt keltirs!`);
                    session.plan = 'hunting';
                    session.followPlayerSession = null;
                    session.partyCompanion = false;
                }, 800 + Math.random() * 800);
            }

            else if (text.includes("heal") || text.includes("хил") || text.includes("buff") || text.includes("бафф")) {
                handledByRule = true;
                if (bot.fetchName() === 'Bot_Gandalf') {
                    setTimeout(() => {
                        this.botSay(session, `Casting divine healing on you, ${player.fetchName()}!`);
                        
                        const ServerResponse = invoke('GameServer/Network/Response');
                        playerSession.dataSendToMe(
                            ServerResponse.skillStarted(bot, player.fetchId(), {
                                fetchSelfId: () => 1011,
                                fetchCalculatedHitTime: () => 1000,
                                fetchReuseTime: () => 1000
                            })
                        );

                        setTimeout(() => {
                            player.setHp(player.fetchMaxHp());
                            player.setMp(player.fetchMaxMp());
                            player.statusUpdateVitals(player);
                            this.botSay(session, `There! You are fully healed.`);
                        }, 1000);

                    }, 1000);
                } else {
                    setTimeout(() => {
                        this.botSay(session, `I'm not a mage! Ask Bot_Gandalf for healing.`);
                    }, 1000 + Math.random() * 500);
                }
            }

            if (!handledByRule) {
                const botName = bot.fetchName().toLowerCase();
                const shortBotName = botName.replace(/^bot_/, '');
                const addressedToBot = text.includes(botName) || text.includes(shortBotName);
                const selectedBot = typeof player.fetchDestId === 'function' && player.fetchDestId() === bot.fetchId();
                const companionBot = session.followPlayerSession === playerSession && session.partyCompanion === true;
                const groupAddress = /\b(bot|bots|guys|party|team|help)\b/.test(text) || /(бот|боты|ребят|народ|пати|команда|кто-нибудь)/.test(text);

                if (addressedToBot || selectedBot || companionBot || (groupAddress && !brainGroupResponderPicked)) {
                    if (groupAddress && !addressedToBot && !selectedBot && !companionBot) {
                        brainGroupResponderPicked = true;
                    }
                    BotBrain.maybeThink(session, 'player_chat', BotAI.getStatus(session), rawText);
                }
            }
        });
    },

    botSay(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        
        if (session.plan === 'following' && session.followPlayerSession && session.partyCompanion === true) {
            const packet = ServerResponse.speak(session.actor, { kind: 3, text: text });
            if (session.followPlayerSession.dataSendToMe) {
                session.followPlayerSession.dataSendToMe(packet);
            }
        } else {
            session.dataSendToOthers(
                ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
                session.actor
            );
        }
    },

    botTell(session, targetSession, text) {
        if (!session.actor || !targetSession || !targetSession.dataSendToMe) return;
        const clean = String(text || '').trim().slice(0, 120);
        if (!clean) return;

        const ServerResponse = invoke('GameServer/Network/Response');
        targetSession.dataSendToMe(ServerResponse.speak(session.actor, { kind: 2, text: clean }));
    },

    botShout(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        const World = invoke('GameServer/World/World');
        
        const packet = ServerResponse.speak(session.actor, { kind: 1, text: text });
        
        World.user.sessions.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function' && user.accountId.indexOf('bot_') !== 0) {
                user.dataSendToMe(packet);
            }
        });
    },

    checkAndStartConversation(botSession) {
        if (botSession.inConversation) return;
        const bot = botSession.actor;
        if (!bot) return;

        const SpeckMath = invoke('GameServer/SpeckMath');
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

        // Find a nearby bot session
        const targetSession = this.sessions.find((session) => {
            if (session === botSession || session.inConversation) return false;
            const target = session.actor;
            if (!target) return false;

            // Target must also be resting in town
            if (session.plan !== 'resting') return false;

            const dist = new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()).distance(botPt);
            return dist < 800; // nearby range
        });

        if (targetSession) {
            this.triggerConversation(botSession, targetSession);
        }
    },

    triggerConversation(botSession, targetSession) {
        botSession.inConversation = true;
        targetSession.inConversation = true;

        const topic = CONVERSATION_TOPICS[Math.floor(Math.random() * CONVERSATION_TOPICS.length)];
        const reply = topic.replies[Math.floor(Math.random() * topic.replies.length)];

        // Stage 1: First bot speaks
        this.botSay(botSession, topic.prompt);

        // Stage 2: Second bot reactively replies after 2.5s
        setTimeout(() => {
            if (targetSession.actor) {
                this.botSay(targetSession, reply);
            }
            // Clear conversation state after another 2 seconds
            setTimeout(() => {
                botSession.inConversation = false;
                targetSession.inConversation = false;
            }, 2000);
        }, 2500);
    },

    handleBotGlobalShout(botSession) {
        const text = GLOBAL_SHOUTS[Math.floor(Math.random() * GLOBAL_SHOUTS.length)];
        this.botShout(botSession, text);
    },

    findHighDensityCoord() {
        const coords = { locX: -83000, locY: 243000, locZ: -3700 }; // default Keltir spot
        const sectors = {};
        const World = invoke('GameServer/World/World');

        let maxCount = 0;
        let bestSector = null;

        World.user.sessions.forEach((session) => {
            const actor = session.actor;
            if (actor && actor.fetchIsOnline() && actor.fetchKarma() === 0 && actor.fetchName() !== 'Bot_Gimli' && actor.fetchName() !== 'Bot_Legolas' && actor.fetchName() !== 'Bot_Gandalf' && !utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY())) {
                const sx = Math.floor(actor.fetchLocX() / 4000);
                const sy = Math.floor(actor.fetchLocY() / 4000);
                const key = `${sx},${sy}`;
                if (!sectors[key]) {
                    sectors[key] = { count: 0, sumX: 0, sumY: 0, sumZ: 0 };
                }
                sectors[key].count++;
                sectors[key].sumX += actor.fetchLocX();
                sectors[key].sumY += actor.fetchLocY();
                sectors[key].sumZ += actor.fetchLocZ();

                if (sectors[key].count > maxCount) {
                    maxCount = sectors[key].count;
                    bestSector = sectors[key];
                }
            }
        });

        if (bestSector) {
            coords.locX = Math.floor(bestSector.sumX / bestSector.count);
            coords.locY = Math.floor(bestSector.sumY / bestSector.count);
            coords.locZ = GeodataEngine.getHeight(coords.locX, coords.locY, Math.floor(bestSector.sumZ / bestSector.count));
        }
        return coords;
    },

    startDynamicScalingMonitor() {
        setInterval(() => {
            try {
                this.monitorAndScaleBots();
            } catch (err) {
                console.error("Dynamic Scaling Monitor Error:", err);
            }
        }, 5000); // Check and scale bots every 5 seconds
    },

    startStatusLogMonitor() {
        if (process.env.BOT_STATUS_LOGS === '0') return;

        setInterval(() => {
            try {
                const summaries = this.sessions
                    .filter((session) => session.actor && session.plan !== 'merchant')
                    .slice(0, 10)
                    .map((session) => {
                        const summary = BotAI.summarizeStatus(session);
                        if (!session.lastDecision) return summary;
                        return `${summary} decision=${session.lastDecision.action}/${session.lastDecision.reason}`;
                    });

                if (summaries.length > 0) {
                    console.info("BotStatus :: %s", summaries.join(" | "));
                }
            } catch (err) {
                console.error("Bot Status Monitor Error:", err);
            }
        }, 30000);
    },

    monitorAndScaleBots() {
        const World = invoke('GameServer/World/World');
        
        // 1. Get all online real players
        const onlinePlayers = World.user.sessions.filter(s => 
            s.actor && 
            s.actor.fetchIsOnline() && 
            s.accountId && 
            !s.accountId.startsWith('bot_')
        );

        if (onlinePlayers.length === 0) return;

        // Target bots we want to maintain around each player
        const TARGET_BOTS_COUNT = 8;

        onlinePlayers.forEach(playerSession => {
            const player = playerSession.actor;
            const px = player.fetchLocX();
            const py = player.fetchLocY();
            const pz = player.fetchLocZ();
            const playerLevel = player.fetchLevel();

            // 2. Filter bots that are already close to this player (within 2500 radius)
            const nearbyBots = this.sessions.filter(botSession => {
                const bot = botSession.actor;
                if (!bot || !bot.fetchIsOnline()) return false;
                if (botSession.plan === 'merchant') return false;

                const dx = bot.fetchLocX() - px;
                const dy = bot.fetchLocY() - py;
                const dist = Math.sqrt(dx * dx + dy * dy);
                return dist <= 2500;
            });

            // 3. If nearby bots count is less than target, teleport far/idle bots to this player
            if (nearbyBots.length < TARGET_BOTS_COUNT) {
                const countToTeleport = TARGET_BOTS_COUNT - nearbyBots.length;

                // Find bots that are currently far (> 2500) from this player, and not close to any other player
                const farBots = this.sessions.filter(botSession => {
                    if (botSession.followPlayerSession && botSession.partyCompanion === true) return false; // Do not dynamically scale/teleport active companion bots!
                    if (botSession.plan === 'merchant') return false;
                    const bot = botSession.actor;
                    if (!bot || !bot.fetchIsOnline()) return false;

                    const dx = bot.fetchLocX() - px;
                    const dy = bot.fetchLocY() - py;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist <= 2500) return false; // Eliminate the dead zone between 2500 and 3000

                    // Make sure it's not near any other online player either
                    const isNearOtherPlayer = onlinePlayers.some(otherPlayerSession => {
                        if (otherPlayerSession === playerSession) return false;
                        const op = otherPlayerSession.actor;
                        const odx = bot.fetchLocX() - op.fetchLocX();
                        const ody = bot.fetchLocY() - op.fetchLocY();
                        const odist = Math.sqrt(odx * odx + ody * ody);
                        return odist <= 2500;
                    });

                    return !isNearOtherPlayer;
                });

                // Teleport the bots and scale their levels
                for (let i = 0; i < Math.min(countToTeleport, farBots.length); i++) {
                    const botSession = farBots[i];
                    const bot = botSession.actor;

                    // Randomized position around player (between 1500 and 2500 units)
                    const angle = Math.random() * 2 * Math.PI;
                    const rad = 1500 + Math.random() * 1000;
                    const tx = Math.floor(px + Math.cos(angle) * rad);
                    const ty = Math.floor(py + Math.sin(angle) * rad);
                    const tz = GeodataEngine.getHeight(tx, ty, pz);

                    // Dynamic Level Scaling (playerLevel ± 1)
                    const levelVariance = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
                    const targetLevel = Math.max(1, playerLevel + levelVariance);
                    bot.setLevel(targetLevel);

                    const getBaseClassId = (race, isSpellcaster) => {
                        if (race === 0) return isSpellcaster ? 10 : 0;
                        if (race === 1) return isSpellcaster ? 25 : 18;
                        if (race === 2) return isSpellcaster ? 38 : 31;
                        if (race === 3) return isSpellcaster ? 49 : 44;
                        if (race === 4) return 53;
                        return 0;
                    };

                    const getRandomClassForLevel = (baseClassId, level) => {
                        if (level < 20) return baseClassId;
                        
                        const firstProfMap = {
                            0: [1, 4, 7],
                            10: [11, 15],
                            18: [19, 22],
                            25: [26, 29],
                            31: [32, 35],
                            38: [39, 42],
                            44: [45, 47],
                            49: [50],
                            53: [54, 56]
                        };

                        const secondProfMap = {
                            1: [2, 3],
                            4: [5, 6],
                            7: [8, 9],
                            11: [12, 13, 14],
                            15: [16, 17],
                            19: [20, 21],
                            22: [23, 24],
                            26: [27, 28],
                            29: [30],
                            32: [33, 34],
                            35: [36, 37],
                            39: [40, 41],
                            42: [43],
                            45: [46],
                            47: [48],
                            50: [51, 52],
                            54: [55],
                            56: [57]
                        };

                        const firstProfs = firstProfMap[baseClassId] || [baseClassId];
                        const randomFirst = firstProfs[Math.floor(Math.random() * firstProfs.length)];

                        if (level < 40) return randomFirst;

                        const secondProfs = secondProfMap[randomFirst] || [randomFirst];
                        return secondProfs[Math.floor(Math.random() * secondProfs.length)];
                    };

                    const baseClass = getBaseClassId(bot.fetchRace(), bot.isSpellcaster());
                    const targetClassId = getRandomClassForLevel(baseClass, targetLevel);
                    bot.setClassId(targetClassId);

                    bot.skillset.awardSkills(bot.fetchId(), targetClassId, targetLevel).then(() => {
                        this.equipScaledBot(botSession, bot, targetLevel, targetClassId).then(() => {
                            // Recalculate stats & replenish HP/MP
                            const CalculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
                            if (typeof CalculateStats === 'function') {
                                CalculateStats(botSession, bot);
                            }
                            bot.fillupVitals();
                        });
                    });

                    // Update bot session plans & centers
                    botSession.initialSpawnCoord = { locX: tx, locY: ty, locZ: tz };
                    if (bot.fetchKarma() > 0 || bot.fetchName() === "Aragorn") {
                        botSession.plan = 'pk_hunting';
                        bot.setPk(5);
                        bot.setKarma(9999);
                    } else {
                        // Reset gossip/hunt plans dynamically
                        botSession.plan = (botSession.townGossip) ? 'resting' : 'hunting';
                        if (botSession.plan === 'resting') {
                            bot.state.setSeated(true);
                        } else {
                            bot.state.setSeated(false);
                        }
                    }

                    // Perform smooth teleportation and sync
                    const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
                    if (TeleportTo && typeof TeleportTo === 'function') {
                        TeleportTo(botSession, bot, { locX: tx, locY: ty, locZ: tz });
                    }

                    console.info("BotManager :: Dynamically scaled & teleported bot %s (Level %d) to player %s (Level %d) at %d, %d", 
                        bot.fetchName(), bot.fetchLevel(), player.fetchName(), player.fetchLevel(), tx, ty);
                }
            }
        });
    },

    getClassArchetype(classId) {
        const mages = [10, 11, 12, 13, 14, 15, 16, 17, 25, 26, 27, 28, 29, 30, 38, 39, 40, 41, 42, 43, 49, 50, 51, 52];
        const archers = [9, 24, 37];
        const daggers = [7, 8, 23, 35, 36, 47, 48];
        if (mages.includes(classId)) return 'MAGE';
        if (archers.includes(classId)) return 'ARCHER';
        if (daggers.includes(classId)) return 'DAGGER';
        return 'HEAVY';
    },

    mapLevelToRank(level) {
        if (level < 20) return "none";
        if (level < 40) return "d";
        if (level < 52) return "c";
        if (level < 61) return "b";
        if (level < 76) return "a";
        return "s";
    },

    selectItemForBot(archetype, slot, rank) {
        let candidates = DataCache.items.filter(item => {
            if (slot === 10) {
                return item.etc?.slot === 10 || item.etc?.slot === 15;
            }
            return item.etc?.slot === slot;
        });

        let rankCandidates = candidates.filter(item => item.etc?.rank === rank);
        
        if (rankCandidates.length === 0) {
            const ranks = ["none", "d", "c", "b", "a", "s"];
            let idx = ranks.indexOf(rank);
            while (idx > 0 && rankCandidates.length === 0) {
                idx--;
                rankCandidates = candidates.filter(item => item.etc?.rank === ranks[idx]);
            }
        }
        if (rankCandidates.length === 0) {
            rankCandidates = candidates;
        }

        let finalCandidates = [];
        if (slot === 10 || slot === 11) {
            const isRobe = archetype === 'MAGE';
            const isLight = archetype === 'LIGHT' || archetype === 'ARCHER' || archetype === 'DAGGER';
            
            if (isRobe) {
                finalCandidates = rankCandidates.filter(item => item.template?.kind === 'Armor.Fabric');
            } else if (isLight) {
                finalCandidates = rankCandidates.filter(item => item.template?.kind === 'Armor.Leather');
            } else {
                finalCandidates = rankCandidates.filter(item => item.template?.kind === 'Armor.Chain');
            }
        } else if (slot === 7 || slot === 14) {
            if (archetype === 'MAGE') {
                finalCandidates = rankCandidates.filter(item => 
                    item.template?.kind === 'Weapon.Blunt' || 
                    item.template?.kind === 'Weapon.Sword'
                );
            } else if (archetype === 'ARCHER') {
                finalCandidates = rankCandidates.filter(item => item.template?.kind === 'Weapon.Bow');
            } else if (archetype === 'DAGGER') {
                finalCandidates = rankCandidates.filter(item => item.template?.kind === 'Weapon.Knife');
            } else {
                finalCandidates = rankCandidates.filter(item => 
                    item.template?.kind === 'Weapon.Sword' || 
                    item.template?.kind === 'Weapon.Blunt' || 
                    item.template?.kind === 'Weapon.Pole'
                );
            }
        } else {
            finalCandidates = rankCandidates;
        }

        if (finalCandidates.length === 0) {
            finalCandidates = rankCandidates;
        }

        if (finalCandidates.length === 0) {
            return null;
        }

        if (slot === 7 || slot === 14) {
            if (archetype === 'MAGE') {
                finalCandidates.sort((a, b) => (b.stats?.mAtk ?? 0) - (a.stats?.mAtk ?? 0));
            } else {
                finalCandidates.sort((a, b) => (b.stats?.pAtk ?? 0) - (a.stats?.pAtk ?? 0));
            }
        } else if (slot === 10 || slot === 11 || slot === 6 || slot === 9 || slot === 12 || slot === 8) {
            finalCandidates.sort((a, b) => (b.stats?.pDef ?? 0) - (a.stats?.pDef ?? 0));
        } else if (slot === 1 || slot === 3 || slot === 4) {
            finalCandidates.sort((a, b) => (b.stats?.mDef ?? 0) - (a.stats?.mDef ?? 0));
        }

        return finalCandidates[0];
    },

    selectGearForBot(classId, level) {
        const archetype = this.getClassArchetype(classId);
        const rank = this.mapLevelToRank(level);
        const gearList = [];

        const weaponSlot = (archetype === 'ARCHER' || archetype === 'MAGE') ? 14 : 7;
        let weapon = this.selectItemForBot(archetype, weaponSlot, rank);
        
        if (!weapon) {
            const alternateSlot = weaponSlot === 7 ? 14 : 7;
            weapon = this.selectItemForBot(archetype, alternateSlot, rank);
        }

        if (weapon) {
            gearList.push({ selfId: weapon.selfId, slot: weapon.etc?.slot ?? weaponSlot });
        }

        const isOneHanded = weapon && (weapon.etc?.slot === 7);
        const needsShield = isOneHanded && (archetype === 'HEAVY' || (archetype === 'MAGE' && [15, 16, 17, 29, 30, 42, 43].includes(classId)));
        if (needsShield) {
            const shield = this.selectItemForBot(archetype, 8, rank);
            if (shield) {
                gearList.push({ selfId: shield.selfId, slot: 8 });
            }
        }

        const chest = this.selectItemForBot(archetype, 10, rank);
        let isFullBody = false;
        if (chest) {
            const slot = chest.etc?.slot ?? 10;
            isFullBody = (slot === 15);
            gearList.push({ selfId: chest.selfId, slot: slot });
        }

        if (!isFullBody) {
            const pants = this.selectItemForBot(archetype, 11, rank);
            if (pants) {
                gearList.push({ selfId: pants.selfId, slot: 11 });
            }
        }

        const helmet = this.selectItemForBot(archetype, 6, rank);
        if (helmet) {
            gearList.push({ selfId: helmet.selfId, slot: 6 });
        }

        const gloves = this.selectItemForBot(archetype, 9, rank);
        if (gloves) {
            gearList.push({ selfId: gloves.selfId, slot: 9 });
        }

        const boots = this.selectItemForBot(archetype, 12, rank);
        if (boots) {
            gearList.push({ selfId: boots.selfId, slot: 12 });
        }

        const neck = this.selectItemForBot(archetype, 3, rank);
        if (neck) {
            gearList.push({ selfId: neck.selfId, slot: 3 });
        }

        const earring = this.selectItemForBot(archetype, 1, rank);
        if (earring) {
            gearList.push({ selfId: earring.selfId, slot: 1 });
            gearList.push({ selfId: earring.selfId, slot: 2 });
        }

        const ring = this.selectItemForBot(archetype, 4, rank);
        if (ring) {
            gearList.push({ selfId: ring.selfId, slot: 4 });
            gearList.push({ selfId: ring.selfId, slot: 5 });
        }

        return gearList;
    },

    equipScaledBot(botSession, bot, targetLevel, targetClassId) {
        const charId = bot.fetchId();
        const gearList = this.selectGearForBot(targetClassId, targetLevel);

        return Database.deleteGearItems(charId).then(() => {
            const promises = gearList.map(gear => {
                const itemDetails = DataCache.items.find(ob => ob.selfId === gear.selfId);
                const item = {
                    selfId: gear.selfId,
                    name: itemDetails?.template?.name ?? '',
                    amount: 1,
                    equipped: true,
                    slot: gear.slot
                };
                return Database.setItem(charId, item);
            });

            return Promise.all(promises).then(() => {
                return this.rebuildBotInventory(bot);
            });
        });
    },

    rebuildBotInventory(bot) {
        return new Promise((resolve) => {
            Database.fetchItems(bot.fetchId()).then((dbItems) => {
                bot.backpack.items = [];
                bot.backpack.paperdoll = utils.tupleAlloc(15 + 1, {});

                const promises = dbItems.map((dbItem) => {
                    return new Promise((done) => {
                        bot.backpack.insertItem(dbItem.id, dbItem.selfId, dbItem);

                        if (dbItem.equipped === 1 || dbItem.equipped === true) {
                            const slot = dbItem.slot;
                            if (slot === 15) {
                                bot.backpack.paperdoll[10] = { id: dbItem.id, selfId: dbItem.selfId };
                                bot.backpack.paperdoll[11] = { id: dbItem.id, selfId: dbItem.selfId };
                            }
                            bot.backpack.paperdoll[slot] = { id: dbItem.id, selfId: dbItem.selfId };
                        }
                        done();
                    });
                });

                Promise.all(promises).then(() => {
                    const ServerResponse = invoke('GameServer/Network/Response');
                    if (bot.session && typeof bot.session.dataSendToOthers === 'function') {
                        bot.session.dataSendToOthers(ServerResponse.charInfo(bot), bot);
                        bot.session.dataSendToOthers(ServerResponse.relationChanged(bot), bot);
                    }
                    resolve();
                });
            });
        });
    }
};

const CONVERSATION_TOPICS = [
    {
        prompt: "Man, these Keltirs near the village are getting annoying.",
        replies: [
            "Tell me about it! I've killed like a hundred today.",
            "At least they drop some adena. Slow and steady!",
            "I'm moving to Orcs soon. Goblins are much better exp."
        ]
    },
    {
        prompt: "Anyone want to form a party later for Goblins?",
        replies: [
            "Sure! I'm a Knight, can tank them easily.",
            "I'm in if Gandalf joins. We need a healer!",
            "Count me in, I need to level my Scavenger skills."
        ]
    },
    {
        prompt: "Did you see that player running around? Crazy gear!",
        replies: [
            "Yeah, must have spent hours farming those Goblins.",
            "I heard they got a weapon drop from an Orc!",
            "Nice, one day we will get C-grade gear too!"
        ]
    },
    {
        prompt: "I'm so tired. Talking Island Town is cozy though.",
        replies: [
            "True. Sitting by the square feels great after a long hunt.",
            "Agreed. Let's rest up and get back out there.",
            "Yeah, recovery is fast when you just sit back."
        ]
    },
    {
        prompt: "Do you think the server admin is watching us right now?",
        replies: [
            "Shh! Don't say that, they might spawn a giant boss on us!",
            "Haha, probably coding some cool new feature for us bots.",
            "As long as my pathfinding works, I'm happy!"
        ]
    }
];

const GLOBAL_SHOUTS = [
    "WTB starter mats near Talking Island. Check Nika or Tarin.",
    "Mira has cheap mats and soulshots around Talking Island.",
    "Need D-grade parts? Maren is buying near Gludio.",
    "Rina has C-grade craft stock in Dion, cheaper than shop.",
    "Wow, this server is so smooth! Loving the solo gameplay.",
    "LFP / Party invite me! Aragorn level 5 ready to hunt!",
    "Legolas is looking for Gandalf, where you at?",
    "Pavel and Tessa are buying Giran drops.",
    "Who is up for Orc Archer hunting? Level 8 Knight WTT help.",
    "Iris has B/A mats near Oren, prices below regular shops."
];

module.exports = BotManager;

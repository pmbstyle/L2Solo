const Database    = invoke('Database');
const Shared      = invoke('GameServer/Network/Shared');
const DataCache   = invoke('GameServer/DataCache');
const World       = invoke('GameServer/World/World');
const BotSession  = invoke('GameServer/Bot/BotSession');
const BotAI       = invoke('GameServer/Bot/BotAI');

const BOTS_TO_SPAWN = [
    { name: "Bot_Gimli",   race: 4, sex: 0, classId: 53, face: 0, hair: 0, hairColor: 0 }, // Dwarf
    { name: "Bot_Legolas", race: 1, sex: 0, classId: 18, face: 0, hair: 4, hairColor: 0 }, // Elf
    { name: "Bot_Gandalf", race: 0, sex: 0, classId: 10, face: 0, hair: 2, hairColor: 0 }  // Human Mage
];

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

    init() {
        console.info("BotManager :: Initializing automated SimPlayers...");
        
        const bots = [...BOTS_TO_SPAWN];

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
        }, 5000);
    },

    provisionAndSpawn(botData, idx) {
        const username = "bot_" + botData.name.toLowerCase();
        
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
                    // Spawn near Town Center of Talking Island with slight offsets
                    const coords = {
                        locX: -84318 + (idx * 60),
                        locY: 244579 + (idx * 60),
                        locZ: -3730
                    };

                    const charData = {
                        name: botData.name,
                        race: botData.race,
                        sex: botData.sex,
                        classId: botData.classId,
                        hair: botData.hair,
                        hairColor: botData.hairColor,
                        face: botData.face,
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
                session.setActor({
                    ...character, ...utils.crushOb(classInfo)
                });

                // Spawn the bot actor in the World
                World.insertUser(session);
                session.actor.enterWorld();
                
                // Designate some extra bots as permanent town gossips
                if (character.name !== "Bot_Gimli" && character.name !== "Bot_Legolas" && character.name !== "Bot_Gandalf" && Math.random() < 0.40) {
                    session.plan = 'resting';
                    session.townGossip = true;
                    session.actor.state.setSeated(true);
                } else {
                    session.plan = 'hunting';
                }

                // Start AI loop
                BotAI.init(session);
                
                this.sessions.push(session);
                utils.infoSuccess("BotManager", "%s (Level %d) is active in World %s", character.name, character.level, session.townGossip ? "[Gossip Mode]" : "[Hunting Mode]");
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
        const text = data.text.trim().toLowerCase();
        const player = playerSession.actor;
        if (!player) return;

        const SpeckMath = invoke('GameServer/SpeckMath');
        const playerPt = new SpeckMath.Point3D(player.fetchLocX(), player.fetchLocY(), player.fetchLocZ());

        this.sessions.forEach((session) => {
            const bot = session.actor;
            if (!bot) return;

            const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ()).distance(playerPt);
            if (distance > 1500) return; // Too far to hear

            if (text.includes("hi") || text.includes("hello") || text.includes("привет") || text.includes("ку")) {
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
                setTimeout(() => {
                    this.botSay(session, `Sure! I will follow you and assist in combat.`);
                    session.plan = 'following';
                    session.followPlayerSession = playerSession;
                }, 800 + Math.random() * 800);
            }

            else if (text.includes("stop") || text.includes("стой") || text.includes("wait")) {
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
                setTimeout(() => {
                    this.botSay(session, `Alright, returning to hunt keltirs!`);
                    session.plan = 'hunting';
                    session.followPlayerSession = null;
                }, 800 + Math.random() * 800);
            }

            else if (text.includes("heal") || text.includes("хил") || text.includes("buff") || text.includes("бафф")) {
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
        });
    },

    botSay(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        const World = invoke('GameServer/World/World');
        
        session.dataSendToOthers(
            ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
            session.actor
        );
        
        World.user.sessions.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function') {
                const header = Buffer.alloc(2);
                const data = ServerResponse.speak(session.actor, { kind: 0x00, text: text });
                header.writeInt16LE(utils.size(data) + 2);
                user.socket.write(Buffer.concat([header, data]));
            }
        });
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
    "WTB Keltir Claws 20a each! PM me!",
    "LFG for Orc farming, level 6 Elf here!",
    "Anyone got a spare wooden shield? WTB cheap!",
    "Gimli here, selling dwarven scrap metal near the town square!",
    "Wow, this server is so smooth! Loving the solo gameplay.",
    "LFP / Party invite me! Aragorn level 5 ready to hunt!",
    "Legolas is looking for Gandalf, where you at?",
    "Selling Keltir meat, fresh and delicious! PM me!",
    "Who is up for some Orc Archer hunting? Level 8 Knight WTT help.",
    "This Talking Island is so cozy, perfect classic vibes!"
];

module.exports = BotManager;

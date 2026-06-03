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
    merchant: { tick() {} }
};

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

            // Revive after 12 seconds of death
            if (Date.now() - session.deathTimerStart > 12000) {
                Generics.revive(session, bot);
                bot.fillupVitals(); // Restore full HP/MP
                session.deathTimerStart = undefined;
                session.currentTargetId = undefined;
                
                let spawnTarget;
                if (bot.fetchKarma() > 0 || bot.fetchName() === "Aragorn") {
                    session.plan = 'pk_hunting';
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    spawnTarget = BotManager.findHighDensityCoord();
                    spawnTarget.locX += (Math.random() - 0.5) * 800;
                    spawnTarget.locY += (Math.random() - 0.5) * 800;
                } else {
                    if (bot.fetchName().startsWith("Merchant_")) {
                        session.plan = 'merchant';
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
        const botName = bot.fetchName();
        const classId = bot.fetchClassId();

        const MAGE_CLASSES = [10, 11, 12, 13, 14, 15, 16, 17, 25, 26, 27, 28, 29, 30, 38, 39, 40, 41, 42, 43];
        const ARCHER_CLASSES = [8, 9, 22, 23, 35, 36];

        if (botName === 'Bot_Gandalf' || MAGE_CLASSES.includes(classId)) {
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
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 1177, ctrl: true });
                return;
            }
        }
        else if (botName === 'Bot_Legolas' || ARCHER_CLASSES.includes(classId)) {
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
                Generics.skillExec(session, bot, { id: npc.fetchId(), selfId: 56, ctrl: true });
                return;
            }
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
        session.dataSendToOthers(
            ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
            session.actor
        );
    }
};

BotAI.CHAT_PHRASES = CHAT_PHRASES;
BotAI.getRandomPhrase = getRandomPhrase;
BotAI.newbieSpawnCoords = newbieSpawnCoords;

module.exports = BotAI;

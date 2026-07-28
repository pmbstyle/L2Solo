const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const BotStatus      = invoke('GameServer/Bot/AI/BotStatus');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PartyRevivalService = invoke('GameServer/Bot/AI/PartyRevivalService');
const TownRespawn = invoke('GameServer/World/TownRespawn');

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
// Visibility refreshes and damage can request an immediate AI pass from
// several nearby actors at once.  Without a small gate each request cancels
// and recreates the companion's normal timer, which can turn a group move
// into a tight synchronous AI loop.
const WAKEUP_THROTTLE_MS = 250;
const REAL_PLAYER_CACHE_MS = 250;
let realPlayerCache = { world: null, revision: -1, checkedAt: 0, sessions: [] };

function getRandomPhrase(category, ...args) {
    const list = CHAT_PHRASES[category];
    const phrase = list[Math.floor(Math.random() * list.length)];
    return require('util').format(phrase, ...args);
}

function newbieSpawnCoords(classId) {
    const DataCache = invoke('GameServer/DataCache');
    return DataCache.newbieSpawns.find(ob => ob.classId === classId)?.spawns ?? [{ locX: -84318, locY: 244579, locZ: -3730 }];
}

function townRespawnCoords(bot) {
    return TownRespawn.getRespawnCoords(bot.fetchLocX(), bot.fetchLocY());
}

function isRealPlayerSession(session) {
    return !!(
        session &&
        session.actor &&
        session.actor.fetchIsOnline() &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    );
}

function realPlayerSessions(World) {
    const sessions = World?.user?.sessions;
    if (!Array.isArray(sessions)) return null;
    const timestamp = Date.now();
    const revision = Number(World.user.revision || 0);
    if (realPlayerCache.world === World && realPlayerCache.revision === revision && timestamp - realPlayerCache.checkedAt < REAL_PLAYER_CACHE_MS) {
        return realPlayerCache.sessions;
    }
    realPlayerCache = {
        world: World,
        revision,
        checkedAt: timestamp,
        sessions: sessions.filter(isRealPlayerSession)
    };
    return realPlayerCache.sessions;
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

function clearTacticalState(session) {
    session.currentTargetId = undefined;
    session.targetTrackId = undefined;
    session.targetAcquiredAt = undefined;
    session.targetLastDistance = undefined;
    session.targetStallTicks = 0;
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    session.roleDecision = undefined;
    session.lastDecision = undefined;
    session.lastTargetEvaluation = undefined;
    session.lastCombatDecision = undefined;
    session.lastPvpDecision = undefined;
}

const BotAI = {
    clearTacticalState,

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

    wakeup(session, { urgent = false } = {}) {
        if (!session.actor || !session.aiActive) return;

        const now = Date.now();
        if (!urgent && now - Number(session.lastAiWakeAt || 0) < WAKEUP_THROTTLE_MS) return;
        session.lastAiWakeAt = now;

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
        const onlinePlayers = realPlayerSessions(World) || [];

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
        const town = TownRespawn.getClosestTown(locX, locY);
        return { name: town.name, x: town.locX, y: town.locY, z: town.locZ };
    },

    getDeathRespawnTarget(session, bot, wasCompanion = false) {
        if (session?.pkProfile?.anchor) {
            return { ...session.pkProfile.anchor };
        }
        if (bot.fetchKarma?.() > 0) {
            return TownRespawn.getChaoticRespawnCoords(bot.fetchLocX(), bot.fetchLocY());
        }

        if (session.plan === 'merchant' || (bot.fetchPrivateStore && bot.fetchPrivateStore())) {
            return {
                locX: session.initialSpawnCoord.locX,
                locY: session.initialSpawnCoord.locY,
                locZ: session.initialSpawnCoord.locZ
            };
        }

        const leader = session.followPlayerSession?.actor;
        if (wasCompanion && leader?.fetchIsOnline?.()) {
            return session.botStay && session.stayLocation ? {
                locX: session.stayLocation.locX,
                locY: session.stayLocation.locY,
                locZ: session.stayLocation.locZ
            } : {
                locX: leader.fetchLocX() + utils.oneFromSpan(-80, 80),
                locY: leader.fetchLocY() + utils.oneFromSpan(-80, 80),
                locZ: leader.fetchLocZ()
            };
        }

        return townRespawnCoords(bot);
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
        const botDead = bot.isDead();
        if (botDead) clearTacticalState(session);
        session.botStatus = BotStatus.getStatus(session);

        const isCompanion = !!session.followPlayerSession && session.partyCompanion === true;
        const World = invoke('GameServer/World/World');
        const onlinePlayers = realPlayerSessions(World) || [];
        const visibleRealPlayers = this.visibleRealPlayers(session, bot, World);

        if (!botDead && onlinePlayers.length > 0 && visibleRealPlayers.length === 0 && !isCompanion && session.plan !== 'shopping' && session.plan !== 'pk_hunting') {
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
            PartyCompanionService.updateMember(session);
        }

        const Generics = invoke(path.actor);

        // 1. Handle Death State
        if (botDead) {
            const wasCompanion = session.partyCompanion === true && !!session.followPlayerSession;
            if (!session.deathTimerStart) {
                session.deathTimerStart = Date.now();
                if (wasCompanion) {
                    invoke('GameServer/Bot/AI/BotPartyChat').announce(session, {
                        priority: 'critical',
                        key: `party-death:${bot.fetchId()}`,
                        templates: [
                            `${bot.fetchName()} is down — waiting for resurrection.`,
                            `Down at the camp. Waiting for a resurrection.`
                        ]
                    });
                } else {
                    this.say(session, 'Oops... I died! Resurrecting shortly.');
                }
                if (wasCompanion && session.followPlayerSession?.actor?.isDead?.()) {
                    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
                    BotSocialMemory.recordEvent(session.followPlayerSession, session, 'party_wiped', 'bot_and_leader_dead');
                }
            }

            const partyRescuePending = wasCompanion && !PartyRevivalService.shouldTownRespawn(
                session.followPlayerSession,
                session
            );
            // Companions wait for the party's resurrection attempt.  The
            // normal town restart remains the escape hatch for a wipe, an
            // unsupported solo leader, or an unanswered corpse.
            if (!partyRescuePending && Date.now() - session.deathTimerStart > 12000) {
                // TeleportTo rejects actors that are still marked dead, so bot
                // respawns must complete before applying the new town location.
                Generics.revive(session, bot, { delayMs: 0, restoreFullVitals: true });
                session.deathTimerStart = undefined;
                session.currentTargetId = undefined;
                session.incomingThreatId = undefined;
                session.incomingThreatAt = undefined;
                
                let spawnTarget;
                if (bot.fetchKarma() > 0) {
                    session.plan = 'pk_hunting';
                    spawnTarget = this.getDeathRespawnTarget(session, bot);
                } else {
                    if (wasCompanion) {
                        PartyCompanionService.clearCompanion(session, {
                            plan: 'hunting',
                            refreshPanel: false
                        });
                        // A corpse that timed out of party resurrection has
                        // just been sent to town. Keep the now-solo bot hot
                        // long enough to complete that visible transition;
                        // otherwise population policy can remove it in the
                        // same scheduler pass before the client sees town.
                        session.populationHotAt = Date.now();
                        session.plan = 'hunting';
                        session.currentSpot = null;
                        session.noTargetTicks = 0;
                        spawnTarget = this.getDeathRespawnTarget(session, bot, false);
                    } else if (session.plan === 'merchant' || (bot.fetchPrivateStore && bot.fetchPrivateStore())) {
                        session.plan = 'merchant';
                        bot.state.setSeated(true);
                        spawnTarget = {
                            locX: session.initialSpawnCoord.locX,
                            locY: session.initialSpawnCoord.locY,
                            locZ: session.initialSpawnCoord.locZ
                        };
                    } else {
                        if (wasCompanion && session.followPlayerSession?.actor?.fetchIsOnline?.()) {
                            session.plan = 'following';
                            spawnTarget = this.getDeathRespawnTarget(session, bot, wasCompanion);
                        } else {
                            if (wasCompanion) {
                                PartyCompanionService.clearCompanion(session, {
                                    plan: 'hunting',
                                    refreshPanel: false
                                });
                            }
                            session.plan = 'hunting'; // Reset plan
                            session.currentSpot = null;
                            session.noTargetTicks = 0;
                            spawnTarget = this.getDeathRespawnTarget(session, bot, wasCompanion);
                        }
                    }
                }
                
                Generics.teleportTo(session, bot, spawnTarget);
                
                this.say(session, getRandomPhrase('revived'));
            }
            return;
        }

        if (bot.state?.fetchDead?.()) {
            return;
        }

        // 2. Initialize default plan if not set
        if (!session.plan) {
            session.plan = 'hunting';
        }

        BotEquipmentUpgrade.applyBestUpgrades(session);

        // Ground drops belong to the party, not to a particular movement
        // plan. Reconcile them before routing follow/hold/rest/pull states so
        // idle companions can collect available loot in every party stance.
        // PartyCompanionService itself blocks real combat and incoming adds.
        if (isCompanion) {
            PartyCompanionService.reconcileGroundLoot(session);
            if (PartyCompanionService.startQueuedGroundPickup(session)) {
                session.botStatus = BotStatus.getStatus(session);
                return;
            }
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

    executePvPCombat(session, bot, victim, Generics, options = {}) {
        this.executeCombat(session, bot, victim, Generics, options);
    },

    executeCombat(session, bot, npc, Generics, options = {}) {
        const role = BotRoles.inferRole(bot);
        const ARCHER_ATTACK_RANGE = 700;
        // Healers and buffers may assist the party with their weapon, but
        // their role controller must be able to keep their MP for support.
        // Do not make that policy depend on the generic combat selector.
        const decision = options.basicAttackOnly ? null : BotCombatUtility.select(bot, npc, role);
        if (decision) {
            session.lastCombatDecision = {
                action: 'cast_skill',
                role,
                skillId: decision.skill.fetchSelfId(),
                skillName: decision.skill.fetchName?.() || null,
                score: decision.score,
                reasons: decision.reasons,
                at: Date.now()
            };
            Generics.skillExec(session, bot, {
                id: npc.fetchId(),
                selfId: decision.skill.fetchSelfId(),
                ctrl: true
            });
            return;
        }

        session.lastCombatDecision = {
            action: 'basic_attack',
            role,
            reason: 'no_usable_offensive_skill',
            at: Date.now()
        };
        Generics.attackExec(session, bot, {
            id: npc.fetchId(),
            ctrl: true,
            ...(role === 'archer' ? { range: ARCHER_ATTACK_RANGE } : {})
        });
    },

    say(session, text) {
        invoke('GameServer/Bot/BotManager').botSay(session, text);
    },

    tell(session, targetSession, text) {
        invoke('GameServer/Bot/BotManager').botTell(session, targetSession, text);
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

    visibleRealPlayers(session, bot, World = invoke('GameServer/World/World')) {
        if (!session || !bot || !World) return [];
        const players = realPlayerSessions(World);
        if (players && typeof bot.fetchLocX === 'function' && typeof bot.fetchLocY === 'function') {
            const x = bot.fetchLocX();
            const y = bot.fetchLocY();
            return players.filter((candidate) => {
                if (candidate === session || !candidate.actor || typeof candidate.actor.fetchLocX !== 'function' || typeof candidate.actor.fetchLocY !== 'function') return false;
                const dx = candidate.actor.fetchLocX() - x;
                const dy = candidate.actor.fetchLocY() - y;
                return dx * dx + dy * dy <= 6000 * 6000;
            });
        }
        if (typeof World.fetchVisibleUsers !== 'function') return [];
        return World.fetchVisibleUsers(session, bot).filter(isRealPlayerSession);
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

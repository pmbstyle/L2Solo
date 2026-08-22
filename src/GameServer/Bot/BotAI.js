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
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const HotActorLodPolicy = invoke('GameServer/Bot/AI/HotActorLodPolicy');
const HotAiDispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const SummonerTactics = invoke('GameServer/Bot/AI/SummonerTactics');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

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
    return TownRespawn.getRespawnCoords(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
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

    cancelScheduledTick(session) {
        if (!session) return false;
        session.aiScheduleGeneration = Number(session.aiScheduleGeneration || 0) + 1;
        if (session.aiTimeout) clearTimeout(session.aiTimeout);
        session.aiTimeout = null;
        return HotAiDispatcher.cancel(session);
    },

    scheduleTick(session, delayMs, { urgent = false } = {}) {
        if (!session?.actor || !session.aiActive) return false;
        this.cancelScheduledTick(session);
        const generation = Number(session.aiScheduleGeneration || 0);
        const runAiTick = () => {
            session.aiTimeout = null;
            if (!session.actor || !session.aiActive || Number(session.aiScheduleGeneration || 0) !== generation) return;
            HotAiDispatcher.enqueue(session, () => {
                if (!session.actor || !session.aiActive || Number(session.aiScheduleGeneration || 0) !== generation) return;
                try {
                    this.tick(session);
                } catch (err) {
                    console.error("Bot AI Tick Error:", err);
                }
                // A wakeup requested from inside the tick owns the next pass.
                if (!session.actor || !session.aiActive || Number(session.aiScheduleGeneration || 0) !== generation) return;
                this.scheduleTick(session, this.calculateNextTickDelay(session));
            }, {
                urgent,
                onError: (err) => console.error("Bot AI Dispatch Error:", err)
            });
        };
        session.aiTimeout = setTimeout(runAiTick, Math.max(0, Number(delayMs) || 0));
        return true;
    },

    init(session) {
        this.cancelScheduledTick(session);
        session.aiActive = true;
        this.scheduleTick(session, 1000 + Math.random() * 2000);
    },

    stop(session) {
        session.aiActive = false;
        session.pendingBrainTurns = [];
        session.pendingBrainTurn = null;
        HotBotPolicyOverlay.clearForCold(session);
        ChatArrivalState.clear(session, 'ai_stop');
        try { invoke('GameServer/Bot/AI/BotAmbientDirector').cleanup(session, 'ai_stop'); } catch (_) { /* optional ambient module */ }
        try { invoke('GameServer/Bot/AI/BotInferenceBudget').reset(session); } catch (_) { /* optional budget module */ }
        this.cancelScheduledTick(session);
    },

    wakeup(session, { urgent = false } = {}) {
        if (!session.actor || !session.aiActive) return;

        const now = Date.now();
        if (!urgent && now - Number(session.lastAiWakeAt || 0) < WAKEUP_THROTTLE_MS) return;
        session.lastAiWakeAt = now;

        // Even urgent damage/player-interaction reactions must leave the
        // network callback before AI work starts. The dispatcher prioritizes
        // them, coalesces duplicate wakes, and runs one actor per turn.
        this.scheduleTick(session, 0, { urgent });
    },

    calculateNextTickDelay(session) {
        const bot = session.actor;
        if (!bot) return 3000;
        const World = invoke('GameServer/World/World');
        const onlinePlayers = realPlayerSessions(World) || [];
        const context = HotActorLodPolicy.evaluate(session, onlinePlayers);
        const lodDelay = HotActorLodPolicy.nextTickDelay(session, context);
        return session.plan === 'shopping' && context.tier === 'full'
            ? Math.min(1500, lodDelay)
            : lodDelay;
    },

    promoteForPlayerInteraction(session, reason = 'player_interaction', sourceSession = null) {
        if (!session?.actor || !session.aiActive) return false;
        if (sourceSession && !HotActorLodPolicy.isRealPlayerSession(sourceSession)) return false;
        HotActorLodPolicy.promote(session, reason);
        this.wakeup(session, { urgent: true });
        return true;
    },

    getClosestTown(locX, locY, locZ) {
        const town = TownRespawn.getClosestTown(locX, locY, locZ);
        return { name: town.name, x: town.locX, y: town.locY, z: town.locZ };
    },

    getDeathRespawnTarget(session, bot, wasCompanion = false) {
        if (session?.pkProfile?.anchor) {
            return { ...session.pkProfile.anchor };
        }
        if (bot.fetchKarma?.() > 0) {
            return TownRespawn.getChaoticRespawnCoords(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
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

    beginPartyTownRecovery(session, bot, now = Date.now()) {
        const leaderSession = session.followPlayerSession;
        const role = BotRoles.inferRole(bot);
        const spawnTarget = this.getDeathRespawnTarget(session, bot, false);

        // Keep native party membership and the C4 party window intact. The
        // bot first restarts in town, refreshes Newbie Guide buffs when it is
        // eligible, then uses the same bounded catch-up teleport as a remotely
        // summoned const-party companion.
        session.preBuffLocation = { ...spawnTarget };
        session.preBuffPlan = 'following';
        session.resumeAfterBuff = {
            plan: 'following',
            followPlayerSession: leaderSession,
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role,
            readyAt: now + 1500,
            conditionalNewbieBuff: true,
            waitForSafePartyReturn: true,
            returnMode: 'teleport',
            reason: 'party_town_respawn'
        };
        session.plan = 'getting_buffed';
        session.botStay = false;
        session.stayLocation = null;
        session.currentTargetId = undefined;
        session.roleDecision = {
            role,
            action: 'return_to_party',
            reason: 'town_respawn',
            at: now
        };
        return spawnTarget;
    },

    getClosestTownName(locX, locY, locZ) {
        return this.getClosestTown(locX, locY, locZ).name;
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
            const townName = this.getClosestTownName(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

            const pkSession = BotManager.sessions.find(s => s.actor && s.actor.fetchKarma() > 0);
            const pkLoc = pkSession?.actor
                ? this.getClosestTownName(pkSession.actor.fetchLocX(), pkSession.actor.fetchLocY(), pkSession.actor.fetchLocZ())
                : "Dion";
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
        const tickStartedAt = Date.now();
        let lodContext = { tier: 'preload' };

        try {

        // Supply errands are parked as a cold workflow while away from the
        // leader. No autonomous state, ambient event, or LLM pass may run
        // until the destination callback resumes the shopping phase.
        if (session.supplyErrandPhase === 'cold' || session.supplyErrandPhase === 'returning') return;

        const World = invoke('GameServer/World/World');
        const onlinePlayers = realPlayerSessions(World) || [];
        lodContext = HotActorLodPolicy.evaluate(session, onlinePlayers, tickStartedAt);
        PopulationService.recordHotTick(session);
        const botDead = bot.isDead();
        if (botDead) {
            clearTacticalState(session);
            HotBotPolicyOverlay.clearForDeath(session);
            BotTradeService.cleanup(session, 'death');
            try { invoke('GameServer/Bot/AI/BotAmbientDirector').cleanup(session, 'death'); } catch (_) { /* optional ambient module */ }
        } else {
            // TTL expiry is intentionally lazy and bounded to hot ticks; no
            // background timer is needed for a session-local preference.
            HotBotPolicyOverlay.get(session);
        }
        if (lodContext.tier === 'preload' && !botDead) {
            if (Math.random() < 0.05) this.triggerFarAwayChatEvent(session, bot);
            return;
        }

        if (HotActorLodPolicy.shouldRefreshStatus(session, lodContext, tickStartedAt)) {
            const statusStartedAt = Date.now();
            session.botStatus = BotStatus.getStatus(session);
            HotActorLodPolicy.recordStatusRefresh(session, Date.now() - statusStartedAt);
        }
        if (HotActorLodPolicy.budgetExceeded(lodContext, tickStartedAt)) {
            HotActorLodPolicy.recordDeferral();
            return;
        }
        // Autonomous state changes remain owned by the deterministic brain.
        // LLM inference is reserved for explicit player communication.

        // A cold bot explicitly asked to come is temporarily held near the
        // player. Keep this deterministic and independent from the LLM so the
        // normal hunting state cannot immediately overwrite the arrival.
        if (!botDead && ChatArrivalState.tick(session, bot)) {
            return;
        }

        const isCompanion = !!session.followPlayerSession && session.partyCompanion === true;
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
                    const deathReaction = PartyRevivalService.noteCompanionDeath(
                        session.followPlayerSession,
                        session,
                        session.deathTimerStart
                    );
                    invoke('GameServer/Bot/AI/BotPartyChat').announce(session, {
                        priority: 'critical',
                        key: `party-death:${bot.fetchId()}`,
                        templates: deathReaction.warning
                            ? [
                                `Down again. I'll wait for a safe resurrection, or restart and return if needed.`
                            ]
                            : [
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
                const deathStartedAt = session.deathTimerStart;
                // TeleportTo rejects actors that are still marked dead, so bot
                // respawns must complete before applying the new town location.
                Generics.revive(session, bot, { delayMs: 0, restoreFullVitals: true });
                session.deathTimerStart = undefined;
                session.currentTargetId = undefined;
                session.incomingThreatId = undefined;
                session.incomingThreatAt = undefined;
                
                let spawnTarget;
                if (wasCompanion) {
                    invoke('GameServer/Bot/AI/BotPartyChat').announce(session, {
                        priority: 'critical',
                        key: `party-respawn-timeout:${bot.fetchId()}:${deathStartedAt}`,
                        templates: [
                            `No resurrection came. Restarting in town, rebuffing if needed, then teleporting back.`
                        ]
                    });
                    // Keep the party relationship authoritative through the
                    // town restart. Population policy must also keep this
                    // visible recovery hot until the bot is back.
                    session.populationHotAt = Date.now();
                    session.noTargetTicks = 0;
                    spawnTarget = this.beginPartyTownRecovery(session, bot);
                } else if (bot.fetchKarma() > 0) {
                    session.plan = 'pk_hunting';
                    spawnTarget = this.getDeathRespawnTarget(session, bot);
                } else if (session.plan === 'merchant' || (bot.fetchPrivateStore && bot.fetchPrivateStore())) {
                    session.plan = 'merchant';
                    bot.state.setSeated(true);
                    spawnTarget = {
                        locX: session.initialSpawnCoord.locX,
                        locY: session.initialSpawnCoord.locY,
                        locZ: session.initialSpawnCoord.locZ
                    };
                } else {
                    session.plan = 'hunting'; // Reset plan
                    session.currentSpot = null;
                    session.noTargetTicks = 0;
                    spawnTarget = this.getDeathRespawnTarget(session, bot, false);
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
                return;
            }
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
        } finally {
            HotActorLodPolicy.recordTick(lodContext.tier, Date.now() - tickStartedAt);
        }
    },

    executePvPCombat(session, bot, victim, Generics, options = {}) {
        return this.executeCombat(session, bot, victim, Generics, options);
    },

    executeCombat(session, bot, npc, Generics, options = {}) {
        const allowedPlayerPartyRaid = BotRaidSafety.isProtectedRaidEntity(npc) &&
            BotRaidSafety.canEngagePlayerPartyRaid(session, npc, options.playerPartyRaidLeaderSession);
        if (BotRaidSafety.isProtectedRaidEntity(npc) && !allowedPlayerPartyRaid) {
            BotRaidSafety.clearTarget(session, bot, npc);
            if (session) {
                session.lastCombatDecision = {
                    action: 'blocked',
                    reason: 'raid_entity_protected',
                    targetId: Number(npc?.fetchId?.() || 0) || null,
                    at: Date.now()
                };
            }
            return false;
        }
        const role = BotRoles.inferRole(bot);
        const BOW_ATTACK_RANGE = 700;
        const hasBow = bot?.backpack?.fetchTotalWeaponKind?.() === 'Weapon.Bow';
        // Healers and buffers may assist the party with their weapon, but
        // their role controller must be able to keep their MP for support.
        // Do not make that policy depend on the generic combat selector.
        const combatPolicy = {
            ...HotBotPolicyOverlay.combatPolicy(session),
            avoidAreaDamage: options.avoidAreaDamage === true || (
                allowedPlayerPartyRaid && BotRaidSafety.hasControlledRaidMinion(npc)
            )
        };
        // Bot casts use the internal SkillExec path and therefore do not pass
        // through the packet-level SkillRequest control-effect gate.
        const canCast = EffectRestrictions.canCast(bot);
        const summonAction = options.basicAttackOnly || !canCast
            ? null
            : SummonerTactics.combatAction(session, bot, npc, Generics);
        if (summonAction?.handled) {
            session.lastCombatDecision = {
                action: summonAction.reason,
                role,
                skillId: summonAction.skill?.fetchSelfId?.() || null,
                targetId: summonAction.target?.fetchId?.() || npc?.fetchId?.() || null,
                at: Date.now()
            };
            return true;
        }
        const chargeSkill = options.basicAttackOnly || !canCast ? null : BotCombatUtility.selectChargeSkill(bot, role);
        if (chargeSkill) {
            session.lastCombatDecision = {
                action: 'charge_skill',
                role,
                skillId: chargeSkill.fetchSelfId(),
                skillName: chargeSkill.fetchName?.() || null,
                charges: Number(bot.fetchCharges?.() ?? bot.charges ?? 0) || 0,
                at: Date.now()
            };
            Generics.skillExec(session, bot, {
                id: bot.fetchId(),
                selfId: chargeSkill.fetchSelfId(),
                ctrl: true
            });
            return true;
        }
        const decision = options.basicAttackOnly || !canCast
            ? null
            : BotCombatUtility.select(bot, npc, role, combatPolicy);
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
            return true;
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
            ...(hasBow ? { range: BOW_ATTACK_RANGE } : {})
        });
        return true;
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
        const fetchVisiblePlayers = typeof World.fetchVisibleRealPlayers === 'function'
            ? World.fetchVisibleRealPlayers.bind(World)
            : World.fetchVisibleUsers?.bind(World);
        if (!fetchVisiblePlayers) return [];
        return fetchVisiblePlayers(session, bot).filter(isRealPlayerSession);
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

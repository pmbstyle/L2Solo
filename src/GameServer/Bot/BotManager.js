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
const BotPopulation = invoke('GameServer/Bot/BotPopulation');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const BOTS_TO_SPAWN = BotPopulation.buildStarterBots();
const DIRECT_SUPPORT_RANGE = 900;
const DIRECT_HEAL_MP_COST = 15;
const DIRECT_BUFF_MP_COST = 20;

const MERCHANT_BOTS = Object.keys(MerchantConfigs).map(name => {
    const cfg = MerchantConfigs[name];
    return { name: name, merchantConfigName: name, race: 4, sex: 0, classId: 53, face: 0, hair: 0, hairColor: 0, locX: cfg.locX, locY: cfg.locY, locZ: cfg.locZ };
});

const merchantConfigFor = (botData, characterName) => MerchantConfigs[botData.merchantConfigName || characterName];

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
        const Html = invoke('GameServer/World/Generics/HtmlKit');
        const pct = (value) => `${Math.round((value || 0) * 100)}%`;
        const safe = (value) => Html.esc(value);

        if (!botSession) {
            const statuses = this.getAllBotStatuses().slice(0, 14);
            let body = `${Html.font('Bot Runtime Status', Html.COLOR.title)}<br>`;
            statuses.forEach((status) => {
                const blockers = status.blockers.length > 0 ? ` / ${status.blockers.join(',')}` : '';
                body += Html.botCard({
                    name: status.name,
                    badge: Html.font(pct(status.vitals.hpPct), Html.COLOR.ok),
                    subtitle: `${status.mode}, ${status.intent}, HP ${pct(status.vitals.hpPct)}, MP ${pct(status.vitals.mpPct)}${blockers}`,
                    actions: [
                        { label: 'Open', command: `bot-status ${status.name}` }
                    ]
                });
                body += Html.spacer(3);
            });
            const html = Html.page(body, { title: 'Bot Status' });
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
            return;
        }

        const status = this.getBotStatus(botSession);
        if (!status || !status.available) {
            const html = Html.page(Html.emptyState('Bot Status', 'Bot status unavailable.'), { title: 'Bot Status' });
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
            return;
        }

        const spot = status.spot ? `${status.spot.name} / Lv ${status.spot.minLevel}-${status.spot.maxLevel} / density ${status.spot.density}` : 'none';
        const target = status.target ? `${status.target.type}:${status.target.name || status.target.id}` : 'none';
        const party = status.party ? `${status.party.role}, ${status.party.stance}/${status.party.roleStance}, leader ${status.party.leader?.name || 'unknown'}` : 'none';
        const home = status.home?.region ? `${status.home.region}${status.home.visitor ? ' visitor' : ''}` : 'unknown';
        const blockers = status.blockers.length > 0 ? status.blockers.join(', ') : 'none';
        const roleDecision = status.roleDecision ? `${status.roleDecision.action} / ${status.roleDecision.reason}` : null;
        const huntDecision = botSession.lastDecision ? `${botSession.lastDecision.action} / ${botSession.lastDecision.reason}${botSession.lastDecision.spotName ? ` / ${botSession.lastDecision.spotName}` : ''}` : null;
        const decision = roleDecision || huntDecision || 'none';
        const pathInfo = status.movement.pathfinding
            ? `${status.movement.pathSummary} / geodata ${status.movement.pathfinding.pathLength}`
            : 'none';
        const buffs = status.buffs?.eligible
            ? `WW ${status.buffs.windWalk}s / Shield ${status.buffs.shield}s / Haste ${status.buffs.haste}s / Might ${status.buffs.might}s${status.buffs.needsRefresh ? ' / refresh' : ''}`
            : `Might ${status.buffs?.might ?? 0}s`;
        const trade = status.trade?.last ? status.trade.last :
            status.trade?.shoppingTarget ? `going to ${status.trade.shoppingTarget.name}` :
            status.trade?.store ? `${status.trade.store.type} / ${status.trade.store.title}` : 'none';
        const availability = BotAvailability.evaluate(playerSession, botSession);
        const social = availability.memory ? `${availability.relationship}, trust ${availability.memory.trust}, familiarity ${availability.memory.familiarity}` : 'none';
        const invite = availability.available ? 'available' : availability.reasonText;

        let body = `${Html.font(status.name, Html.COLOR.title)}<br>`;
        body += Html.statusTable([
            ['Mode', safe(status.mode)],
            ['Intent', safe(status.intent)],
            ['Role', safe(status.role)],
            ['Home', safe(home)],
            ['Vitals', safe(`HP ${pct(status.vitals.hpPct)} / MP ${pct(status.vitals.mpPct)}`)],
            ['Target', safe(target)],
            ['Party', safe(party)],
            ['Spot', safe(spot)],
            ['Nearby', safe(`players ${status.nearby.realPlayers}, bots ${status.nearby.friendlyBots}, mobs ${status.nearby.attackableNpcs}`)],
            ['Move', safe(status.movement.moving ? `moving (${status.movement.towards})` : 'idle')],
            ['Path', safe(pathInfo)],
            ['Blockers', safe(blockers)],
            ['Decision', safe(decision)],
            ['Buffs', safe(buffs)],
            ['Trade', safe(trade)],
            ['Social', safe(social)],
            ['Invite', safe(invite)]
        ]);
        body += '<br>' + Html.actionFooter([
            { label: 'Refresh', command: `bot-status ${status.name}` }
        ]);
        const html = Html.page(body, { title: 'Bot Status' });

        playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
    },

    renderBotPathPanel(playerSession, botSession = null) {
        if (!playerSession.actor) return;

        const ServerResponse = invoke('GameServer/Network/Response');
        const Html = invoke('GameServer/World/Generics/HtmlKit');
        const safe = (value) => Html.esc(value);
        const locText = (loc) => loc ? `${loc.locX},${loc.locY},${loc.locZ}` : 'none';

        if (!botSession) {
            const statuses = this.getAllBotStatuses().slice(0, 14);
            let body = `${Html.font('Bot Path Diagnostics', Html.COLOR.title)}<br>`;
            statuses.forEach((status) => {
                const path = status.movement.pathfinding;
                const subtitle = path
                    ? `${status.movement.pathSummary} / geodata ${path.pathLength}`
                    : 'no movement recorded';
                body += Html.botCard({
                    name: status.name,
                    badge: status.movement.moving ? Html.font('moving', Html.COLOR.ok) : Html.font('idle', Html.COLOR.muted),
                    subtitle,
                    actions: [
                        { label: 'Open', command: `bot-path ${status.name}` },
                        { label: 'Status', command: `bot-status ${status.name}` }
                    ]
                });
                body += Html.spacer(3);
            });
            const html = Html.page(body, { title: 'Bot Paths' });
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
            return;
        }

        const status = this.getBotStatus(botSession);
        if (!status || !status.available) {
            const html = Html.page(Html.emptyState('Bot Paths', 'Bot path diagnostics unavailable.'), { title: 'Bot Paths' });
            playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
            return;
        }

        const path = status.movement.pathfinding;
        const route = path?.townRoute || null;
        const body = `${Html.font(status.name, Html.COLOR.title)}<br>` + Html.statusTable([
            ['Moving', safe(status.movement.moving ? `yes (${status.movement.towards})` : 'no')],
            ['Stuck', safe(String(status.movement.stuckTicks))],
            ['Follow Target', safe(locText(status.movement.followTarget))],
            ['Requested', safe(locText(path?.requestedTo))],
            ['Routed', safe(locText(path?.routedTo))],
            ['Town Route', safe(status.movement.pathSummary)],
            ['Geodata Path', safe(path ? String(path.pathLength) : 'none')],
            ['LOD Warp', safe(path?.lowLodWarp ? 'yes' : 'no')],
            ['From/To Town', safe(route ? `${route.fromTown || 'field'} -> ${route.toTown || 'field'}` : 'none')]
        ]) + '<br>' + Html.actionFooter([
            { label: 'Refresh', command: `bot-path ${status.name}` },
            { label: 'Status', command: `bot-status ${status.name}` }
        ]);
        const html = Html.page(body, { title: 'Bot Paths' });
        playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), html));
    },

    init() {
        console.info("BotManager :: Initializing automated SimPlayers...");
        BotSocialMemory.init();
        PopulationService.init();
        
        const bots = [...BOTS_TO_SPAWN, ...MERCHANT_BOTS];
        console.info("BotManager :: Starter population: %s", BotPopulation.summarize(BOTS_TO_SPAWN));
        
        // Wait 5 seconds after startup to let world finish loading
        setTimeout(() => {
            bots.forEach((botData, idx) => {
                this.provisionAndSpawn(botData, idx);
            });
            this.startDynamicScalingMonitor();
            this.startStatusLogMonitor();
            PopulationService.start();
        }, 5000);
    },

    provisionAndSpawn(botData, idx) {
        const username = (botData.username || ("bot_" + botData.name.toLowerCase())).slice(0, 16);
        
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

    resolveCharacterName(baseName, attempt = 0) {
        const suffix = attempt === 0 ? '' : String(attempt);
        const candidate = `${String(baseName).slice(0, 16 - suffix.length)}${suffix}`;

        return Database.fetchCharacterName(candidate).then((rows) => {
            if (!rows[0]) return candidate;
            return this.resolveCharacterName(baseName, attempt + 1);
        });
    },

    provisionCharacter(username, botData, idx) {
        Database.fetchCharacters(username).then((characters) => {
            if (characters[0]) {
                this.loadAndSpawnBot(username, botData);
                return;
            }

            this.resolveCharacterName(botData.name).then((characterName) => {
                const effectiveBotData = { ...botData, name: characterName };
                if (characterName !== botData.name) {
                    utils.infoWarn('BotManager', 'bot name %s is taken; using %s for %s', botData.name, characterName, username);
                }

                Shared.fetchClassInformation(effectiveBotData.classId).then((classInfo) => {
                    let coords;
                    if (effectiveBotData.locX !== undefined) {
                        coords = {
                            locX: effectiveBotData.locX,
                            locY: effectiveBotData.locY,
                            locZ: effectiveBotData.locZ
                        };
                    } else {
                        const spawns = BotAI.newbieSpawnCoords(effectiveBotData.spawnClassId || effectiveBotData.classId);
                        const spawn = spawns[Math.floor(Math.random() * spawns.length)];
                        coords = {
                            locX: spawn.locX + utils.oneFromSpan(-180, 180),
                            locY: spawn.locY + utils.oneFromSpan(-180, 180),
                            locZ: spawn.locZ
                        };
                    }

                    const charData = {
                        name: effectiveBotData.name,
                        race: effectiveBotData.race,
                        sex: effectiveBotData.sex,
                        classId: effectiveBotData.classId,
                        hair: effectiveBotData.hair ?? 0,
                        hairColor: effectiveBotData.hairColor ?? 0,
                        face: effectiveBotData.face ?? 0,
                        ...classInfo.vitals,
                        ...coords
                    };

                    Database.createCharacter(username, charData).then((packet) => {
                        const charId = Number(packet.insertId);
                        this.awardBaseGear(charId, effectiveBotData.classId);
                        this.awardBaseSkills(charId, effectiveBotData.classId);
                        this.loadAndSpawnBot(username, effectiveBotData);
                    });
                });
            });
        });
    },

    prepareBotForSpawn(session, botData = {}) {
        if (!session || !session.actor) return null;

        const Generics = invoke(path.actor);
        const actor = session.actor;

        actor.state.setDead(false);
        if (botData.fullNewbieBlessing !== false && BotBuffs.isNewbieEligible(actor)) {
            return BotBuffs.applyFullNewbieBlessing(session, actor, Generics);
        }

        actor.fillupVitals();
        actor.statusUpdateVitals(actor);
        return { buffs: [], expiresAt: null };
    },

    loadAndSpawnBot(username, botData = {}) {
        const session = new BotSession(username);
        
        Shared.fetchCharacters(username).then((characters) => {
            const firstCharacter = characters[0];
            if (!firstCharacter) return;

            const firstStoreCfg = merchantConfigFor(botData, firstCharacter.name);
            const gearReady = (firstStoreCfg
                ? Promise.resolve()
                : BotGear.ensureCharacterGear(firstCharacter, botData))
                .then(() => ShotStock.ensureCharacterStock(firstCharacter.id, {
                    classId: firstCharacter.classId,
                    targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
                }))
                .then(() => Shared.fetchCharacters(username));

            gearReady.then((readyCharacters) => {
                const character = readyCharacters[0];
                if (!character) return;
                const storeCfg = merchantConfigFor(botData, character.name);

                Shared.fetchClassInformation(character.classId).then((classInfo) => {
                    if (botData.locX !== undefined) {
                        character.locX = botData.locX;
                        character.locY = botData.locY;
                        character.locZ = botData.locZ;
                    }

                    character.locZ = GeodataEngine.getHeight(character.locX, character.locY, character.locZ);

                    session.setActor({
                        ...character, ...utils.crushOb(classInfo)
                    });

                    session.homeRegion = botData.homeRegion || null;
                    session.visitor = !!botData.visitor;
                    session.newbieAnchor = !!botData.newbieAnchor;
                
                    session.initialSpawnCoord = {
                        locX: character.locX,
                        locY: character.locY,
                        locZ: character.locZ
                    };

                    if (storeCfg) {
                        session.plan = 'merchant';
                        session.actor.state.setSeated(true);

                        session.actor.setTitle(storeCfg.title);
                        session.actor.setPrivateStoreType(storeCfg.storeType);

                        const storeItems = TradeService.normalizeStoreItems(storeCfg);

                        session.actor.setPrivateStore({
                            storeType: storeCfg.storeType,
                            title: storeCfg.title,
                            town: storeCfg.town,
                            items: storeItems
                        });
                    } else {
                        session.plan = botData.plan || 'hunting';
                        session.backgroundActivity = botData.backgroundActivity || session.plan;
                        session.currentSpot = botData.currentSpot || null;
                        if (botData.spawnReady !== false) {
                            this.prepareBotForSpawn(session, botData);
                        }
                        session.actor.state.setSeated(session.plan === 'resting');
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
                    session.populationHotAt = Date.now();
                    PopulationService.markHot(session, 'spawn');
                    let modeText = "[Hunting Mode]";
                    if (session.townGossip) modeText = "[Gossip Mode]";
                    if (session.plan === 'pk_hunting') modeText = "[PK Mode]";
                    if (session.plan === 'merchant') modeText = "[Merchant Mode]";
                    utils.infoSuccess("BotManager", "%s (Level %d) is active in World %s", character.name, character.level, modeText);
                });
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
            const botName = bot.fetchName().toLowerCase();
            const shortBotName = botName.replace(/^bot_/, '');
            const addressedToBot = text.includes(botName) || text.includes(shortBotName);
            const selectedBot = typeof player.fetchDestId === 'function' && player.fetchDestId() === bot.fetchId();
            const companionBot = session.followPlayerSession === playerSession && session.partyCompanion === true;
            const directCommandTarget = addressedToBot || selectedBot || companionBot;
            const groupAddress = /\b(bot|bots|guys|party|team|help)\b/.test(text) || /(бот|боты|ребят|народ|пати|команда|кто-нибудь)/.test(text);

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

            else if (directCommandTarget && (text.includes("follow") || text.includes("за мной") || text.includes("помоги"))) {
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

            else if (directCommandTarget && (text.includes("stop") || text.includes("стой") || text.includes("wait"))) {
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

            else if (directCommandTarget && (text.includes("hunt") || text.includes("иди качайся") || text.includes("кач"))) {
                handledByRule = true;
                setTimeout(() => {
                    this.botSay(session, `Alright, returning to hunt keltirs!`);
                    if (session.followPlayerSession === playerSession && session.partyCompanion === true) {
                        BotSocialMemory.recordEvent(playerSession, session, 'party_dismissed', 'chat_hunt');
                    }
                    session.plan = 'hunting';
                    session.followPlayerSession = null;
                    session.partyCompanion = false;
                }, 800 + Math.random() * 800);
            }

            else if (directCommandTarget && (text.includes("heal") || text.includes("хил") || text.includes("buff") || text.includes("бафф"))) {
                handledByRule = true;
                setTimeout(() => {
                    this.handleDirectSupportRequest(session, playerSession, distance, {
                        heal: text.includes("heal") || text.includes("хил"),
                        buff: text.includes("buff") || text.includes("бафф")
                    });
                }, 1000);
            }

            if (!handledByRule) {
                if (addressedToBot || selectedBot || companionBot || (groupAddress && !brainGroupResponderPicked)) {
                    if (groupAddress && !addressedToBot && !selectedBot && !companionBot) {
                        brainGroupResponderPicked = true;
                    }
                    BotBrain.maybeThink(session, 'player_chat', BotAI.getStatus(session), rawText);
                }
            }
        });
    },

    handleDirectSupportRequest(botSession, playerSession, distance, request = {}) {
        const bot = botSession?.actor;
        const player = playerSession?.actor;
        if (!bot || !player) return false;

        if (distance > DIRECT_SUPPORT_RANGE) {
            this.botTell(botSession, playerSession, `You're too far for me to cast safely.`);
            return false;
        }

        if (request.heal) {
            if (!BotRoles.isHealer(bot)) {
                this.botTell(botSession, playerSession, `I don't have proper healing magic.`);
                return false;
            }
            if (bot.fetchMp() < DIRECT_HEAL_MP_COST) {
                this.botTell(botSession, playerSession, `I need to recover MP before healing.`);
                return false;
            }

            const ServerResponse = invoke('GameServer/Network/Response');
            playerSession.dataSendToMe(
                ServerResponse.skillStarted(bot, player.fetchId(), {
                    fetchSelfId: () => 1011,
                    fetchCalculatedHitTime: () => 1000,
                    fetchReuseTime: () => 1000
                })
            );

            setTimeout(() => {
                if (player.isDead && player.isDead()) return;
                player.setHp(player.fetchMaxHp());
                bot.setMp(Math.max(0, bot.fetchMp() - DIRECT_HEAL_MP_COST));
                player.statusUpdateVitals(player);
                bot.statusUpdateVitals(bot);
                this.botTell(botSession, playerSession, `Healing done. Watch your HP.`);
            }, 1000);
            return true;
        }

        if (request.buff) {
            if (!BotRoles.canBuff(bot)) {
                this.botTell(botSession, playerSession, `I don't have useful support buffs.`);
                return false;
            }
            if (bot.fetchMp() < DIRECT_BUFF_MP_COST) {
                this.botTell(botSession, playerSession, `I need more MP before buffing.`);
                return false;
            }

            const buffType = BotBuffs.nextSupportBuff(player) || 'might';
            const result = BotBuffs.applySupportBuff(playerSession, player, buffType, invoke(path.actor), {
                casterSession: botSession,
                caster: bot
            });
            if (!result) {
                this.botTell(botSession, playerSession, `That buff did not land.`);
                return false;
            }

            bot.setMp(Math.max(0, bot.fetchMp() - DIRECT_BUFF_MP_COST));
            bot.statusUpdateVitals(bot);
            this.botTell(botSession, playerSession, `${result.name} is up.`);
            return true;
        }

        return false;
    },

    botSay(session, text) {
        if (!session.actor) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        session.dataSendToOthers(
            ServerResponse.speak(session.actor, { kind: 0x00, text: text }),
            session.actor
        );
    },

    botTell(session, targetSession, text) {
        if (!session.actor || !targetSession || !targetSession.dataSendToMe) return;
        const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
        const lines = BotChatText.splitForTell(text);
        if (!lines.length) return;

        const ServerResponse = invoke('GameServer/Network/Response');
        lines.forEach((line) => {
            targetSession.dataSendToMe(ServerResponse.speak(session.actor, { kind: 2, text: line }));
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
    },

    findHighDensityCoord() {
        const coords = { locX: -83000, locY: 243000, locZ: -3700 }; // default Keltir spot
        const sectors = {};
        const World = invoke('GameServer/World/World');

        let maxCount = 0;
        let bestSector = null;

        World.user.sessions.forEach((session) => {
            const actor = session.actor;
            if (actor && actor.fetchIsOnline() && actor.fetchKarma() === 0 && !session.accountId?.startsWith('bot_') && !utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY())) {
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
        console.info("BotManager :: Dynamic bot teleport/level scaling removed; using persistent starter populations.");
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
                        if (session.roleDecision) return `${summary} roleDecision=${session.roleDecision.action}/${session.roleDecision.reason}`;
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
    }
};

const CONVERSATION_TOPICS = [
    {
        prompt: "Man, these Keltirs near the village are getting annoying.",
        replies: [
            "Tell me about it! I've killed like a hundred today.",
            "At least they drop some adena. Slow and steady!",
            "I'm moving to the ruins soon. Better exp there."
        ]
    },
    {
        prompt: "Anyone want to form a party later for Goblins?",
        replies: [
            "Sure! I'm a Knight, can tank them easily.",
            "I'm in if we find someone who can heal.",
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
        prompt: "Have you seen the market near town today?",
        replies: [
            "Adena is tight, but the material prices are fair.",
            "I should sell this junk before I go back out.",
            "If I find enough leather, I might upgrade my gloves."
        ]
    }
];

const GLOBAL_SHOUTS = [
    "WTB starter mats near Talking Island. Check Nika or Tarin.",
    "Mira has cheap mats and soulshots around Talking Island.",
    "Need D-grade parts? Maren is buying near Gludio.",
    "Rina has C-grade craft stock in Dion, cheaper than shop.",
    "The roads near Gludio feel busy today.",
    "LFP near the ruins. Need a tank or healer.",
    "Anyone seen a good hunting group near Gludio?",
    "Pavel and Tessa are buying Giran drops.",
    "Who is up for Orc Archer hunting? Level 8 Knight WTT help.",
    "Iris has B/A mats near Oren, prices below regular shops."
];

module.exports = BotManager;

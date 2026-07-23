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
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SimulationKernel = invoke('GameServer/Bot/Simulation/SimulationKernel');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const BotConversation = invoke('GameServer/Bot/AI/BotConversation');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');

const BOTS_TO_SPAWN = BotPopulation.buildStarterBots();
const DIRECT_SUPPORT_RANGE = 900;
const INSULT_PATTERN = /\b(noob|idiot|stupid|trash|useless|suck|sucks)\b|(?:дурак|дура|тупой|тупая|лох|нуб|мусор|бесполезн)/i;

const MERCHANT_BOTS = Object.keys(MerchantConfigs).map(name => {
    const cfg = MerchantConfigs[name];
    return { name: name, merchantConfigName: name, race: 4, sex: 0, classId: 53, face: 0, hair: 0, hairColor: 0, locX: cfg.locX, locY: cfg.locY, locZ: cfg.locZ };
});

const merchantConfigFor = (botData, characterName) => MerchantConfigs[botData.merchantConfigName || characterName];

function isOnGiranMarketPlaza(loc = {}) {
    return Number(loc.locX) >= 80911 && Number(loc.locX) <= 83750
        && Number(loc.locY) >= 147662 && Number(loc.locY) <= 149550;
}

function stableSpawnLocation(botData = {}) {
    const spawns = BotAI.newbieSpawnCoords(botData.spawnClassId || botData.classId);
    const seed = [...String(botData.username || botData.name || '')]
        .reduce((sum, character) => sum + character.charCodeAt(0), 0);
    const spawn = spawns[seed % spawns.length] || spawns[0];
    const offsetX = ((seed * 37) % 301) - 150;
    const offsetY = ((seed * 71) % 301) - 150;
    return {
        locX: Number(spawn.locX) + offsetX,
        locY: Number(spawn.locY) + offsetY,
        locZ: Number(spawn.locZ)
    };
}

function recoverStarterSpawn(botData = {}, character = {}) {
    // Static starters are reloaded directly by BotManager, outside the cold
    // population activation path.  A historical Giran location therefore
    // used to respawn every starter on top of the craft station after restart.
    if (botData.merchantConfigName || !botData.homeRegion || !isOnGiranMarketPlaza(character)) return botData;
    return { ...botData, ...stableSpawnLocation(botData) };
}

const BotManager = {
    sessions: [],
    pkEncounterTimer: null,
    pkEncounterPending: new Set(),
    pkEncounterBots: [],
    recoverStarterSpawn,

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
        const roleDecision = status.decisions?.role ? BotStatus.decisionSummary(status.decisions.role, 'role') : null;
        const huntDecision = status.decisions?.hunt ? BotStatus.decisionSummary(status.decisions.hunt, 'hunt') : null;
        const decision = roleDecision || huntDecision || 'none';
        const targetDecision = BotStatus.decisionSummary(status.decisions?.target, 'target');
        const combatDecision = BotStatus.decisionSummary(status.decisions?.combat, 'combat');
        const pvpDecision = BotStatus.decisionSummary(status.decisions?.pvp, 'pvp');
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
            ['Target AI', safe(targetDecision)],
            ['Combat AI', safe(combatDecision)],
            ['PvP AI', safe(pvpDecision)],
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

    renderColdBotStatusPanel(playerSession, state) {
        if (!playerSession.actor || !state) return;
        const ServerResponse = invoke('GameServer/Network/Response');
        const Html = invoke('GameServer/World/Generics/HtmlKit');
        const safe = (value) => Html.esc(value);
        const goal = invoke('GameServer/Bot/Goals/GoalState').snapshot(state.characterId)?.current;
        const travel = state.stats?.travel;
        const lead = state.stats?.marketLead;
        const wanted = state.stats?.marketWanted;
        const history = Object.values(state.stats?.partyHistory || {});
        const body = `${Html.font(state.name, Html.COLOR.title)}<br>` + Html.statusTable([
            ['Phase', 'cold'], ['Activity', safe(state.activity)], ['Level', safe(String(state.level))],
            ['Role', safe(state.party?.role || state.stats?.role || 'dps')], ['Region / Spot', safe(`${state.currentRegion || 'unknown'} / ${state.spotId || 'none'}`)],
            ['Party', safe(state.party?.partyId || 'none')], ['Goal', safe(goal ? `${goal.type}: ${goal.plan?.expectedBenefit || 'active'}` : 'none')],
            ['Travel', safe(travel ? `${travel.reason} -> ${travel.townName || 'field'}` : 'none')],
            ['Market Lead', safe(lead ? `${lead.itemName} in ${lead.town} for ${lead.price}` : 'none')],
            ['WTB', safe(wanted ? wanted.itemName || `Item ${wanted.itemId}` : 'none')],
            ['Party Bonds', safe(`${history.length} remembered partners`)]
        ]) + '<br>' + Html.actionFooter([{ label: 'Refresh', command: `bot-status ${state.name}` }]);
        playerSession.dataSendToMe(ServerResponse.npcHtml(playerSession.actor.fetchId(), Html.page(body, { title: 'Cold Bot Status' })));
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
        console.info("BotManager :: Initializing automated bots...");
        BotSocialMemory.init();
        PopulationService.init();
        GoalService.init();
        SimulationKernel.init({ population: PopulationService });
        SimulationKernel.register({
            id: 'population',
            register: (registry) => registry.statusProvider(() => PopulationService.summary?.() || null)
        });
        SimulationKernel.register({
            id: 'goals',
            requires: ['population'],
            register: (registry) => registry.statusProvider(() => ({ initialized: GoalService.initialized }))
        });
        
        const bots = [...BOTS_TO_SPAWN.filter((bot) => bot.plan !== 'pk_hunting'), ...MERCHANT_BOTS];
        console.info("BotManager :: Starter population: %s", BotPopulation.summarize(BOTS_TO_SPAWN));
        
        // Wait 5 seconds after startup to let world finish loading
        setTimeout(() => {
            bots.forEach((botData, idx) => {
                this.provisionAndSpawn(botData, idx);
            });
            this.pkEncounterBots = BotPopulation.pkEncounters();
            this.hydratePkEncounterAnchors().finally(() => {
                this.startPkEncounterMonitor();
                this.startDynamicScalingMonitor();
                this.startStatusLogMonitor();
                PopulationService.start();
                SimulationKernel.start();
            });
        }, 5000);
    },

    bindPkAnchorToCharacter(botData, character) {
        if (!botData?.dynamicStarter || !botData.pkProfile?.anchor || !character) return botData;
        const anchor = {
            locX: Number(character.locX),
            locY: Number(character.locY),
            locZ: Number(character.locZ)
        };
        if (!Number.isFinite(anchor.locX) || !Number.isFinite(anchor.locY) || !Number.isFinite(anchor.locZ)) return botData;
        botData.pkProfile = { ...botData.pkProfile, anchor };
        botData.locX = anchor.locX;
        botData.locY = anchor.locY;
        botData.locZ = anchor.locZ;
        return botData;
    },

    hydratePkEncounterAnchors() {
        return Promise.all(this.pkEncounterBots.map((botData) => (
            botData.dynamicStarter
                ? Shared.fetchCharacters(botData.username)
                    .then((characters) => this.bindPkAnchorToCharacter(botData, characters[0]))
                    .catch(() => botData)
                : Promise.resolve(botData)
        )));
    },

    activePopulationForPk(profile) {
        if (!profile) return [];
        return World.user.sessions.filter((session) => {
            const actor = session?.actor;
            if (!actor || !actor.fetchIsOnline?.() || session.plan === 'merchant') return false;
            if (actor.state?.fetchDead?.() || utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY())) return false;
            if (Number(actor.fetchKarma?.() || 0) !== 0) return false;
            // The encounter stays alive for any local white actor. The level
            // bracket is enforced by PkHuntingState when it selects victims;
            // an out-of-band player is still a threat the PK must react to.
            const dx = actor.fetchLocX() - profile.anchor.locX;
            const dy = actor.fetchLocY() - profile.anchor.locY;
            return Math.sqrt(dx * dx + dy * dy) <= profile.activationRadius;
        });
    },

    reconcilePkEncounters() {
        const encounters = this.pkEncounterBots;
        return encounters.reduce((chain, botData, index) => chain.then(() => {
            const active = this.sessions.find((session) => session.accountId === botData.username && session.actor);
            const hasPopulation = this.activePopulationForPk(botData.pkProfile).length > 0;
            if (hasPopulation && !active && !this.pkEncounterPending.has(botData.username)) {
                this.pkEncounterPending.add(botData.username);
                this.provisionAndSpawn(botData, 1000 + index);
                setTimeout(() => this.pkEncounterPending.delete(botData.username), 12000);
                return null;
            }
            if (!hasPopulation && active) {
                return PopulationService.cooldownSession(active, 'pk_no_eligible_player', {
                    allowPk: true,
                    ignoreVisibility: true
                });
            }
            return null;
        }), Promise.resolve());
    },

    startPkEncounterMonitor() {
        if (this.pkEncounterTimer) return;
        if (this.pkEncounterBots.length === 0) this.pkEncounterBots = BotPopulation.pkEncounters();
        this.reconcilePkEncounters();
        this.pkEncounterTimer = setInterval(() => this.reconcilePkEncounters(), 15000);
        if (typeof this.pkEncounterTimer.unref === 'function') this.pkEncounterTimer.unref();
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
                const existing = characters[0];
                const recoveredBotData = recoverStarterSpawn(botData, existing);
                const recoveredLoc = recoveredBotData.locX === undefined
                    ? Promise.resolve()
                    : Database.updateCharacterLocation(existing.id, recoveredBotData);
                recoveredLoc
                    .then(() => this.applyProfileLevel(existing, recoveredBotData))
                    .then(() => this.awardProfileSkills(existing.id, recoveredBotData, existing.classId))
                    .then(() => this.loadAndSpawnBot(username, recoveredBotData));
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
                        this.applyProfileLevel({ id: charId }, effectiveBotData)
                            .then(() => this.awardProfileSkills(charId, effectiveBotData))
                            .then(() => {
                                this.awardBaseGear(charId, effectiveBotData.classId);
                                if (Number(effectiveBotData.level || 1) <= 1) {
                                    this.awardBaseSkills(charId, effectiveBotData.classId);
                                }
                                this.loadAndSpawnBot(username, effectiveBotData);
                            });
                    });
                });
            });
        });
    },

    applyProfileLevel(character, botData = {}) {
        const level = Number(botData.level || 0);
        if (!character?.id || level <= 1) return Promise.resolve(false);
        const exp = Number(DataCache.experience?.[level - 1] || 0);
        const sp = Math.round(level * level * 3);
        return Database.updateCharacterExperience(character.id, level, exp, sp)
            .then(() => true);
    },

    awardProfileSkills(characterId, botData = {}, currentClassId = botData.classId) {
        const level = Number(botData.level || 1);
        if (level <= 1) return Promise.resolve();
        return BotClassProgression.reconcile({
            characterId,
            classId: currentClassId,
            level,
            seed: botData.name || characterId
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
            // Cold-generated characters may have been created before their
            // profile skills were persisted. Reconcile them before loading the
            // runtime actor so active companions never keep a level-one kit.
            const skillsReady = this.awardProfileSkills(firstCharacter.id, {
                classId: firstCharacter.classId,
                level: firstCharacter.level
            }, firstCharacter.classId);
            const spawnReady = skillsReady.then(() => Shared.fetchCharacters(username))
                .then((reconciledCharacters) => {
                    const reconciledCharacter = reconciledCharacters[0];
                    if (!reconciledCharacter) return null;
                    return ShotStock.ensureCharacterStock(reconciledCharacter.id, {
                    classId: reconciledCharacter.classId,
                    targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT
                })
                        .then(() => Shared.fetchCharacters(username));
                });

            spawnReady.then((readyCharacters) => {
                const character = readyCharacters[0];
                if (!character) return;
                const storeCfg = merchantConfigFor(botData, character.name);
                const runtimeStore = botData.privateStore || null;
                const manufactureShop = botData.manufactureShop || null;

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

                    // PK seeds must remain red across restarts. Existing bot
                    // records predate the seed list, so update both runtime
                    // and persistence on first load.
                    if (Number(botData.karma) > 0 && session.actor.fetchKarma() <= 0) {
                        session.actor.setKarma(Number(botData.karma));
                        session.actor.setPk(Math.max(Number(botData.pk) || 0, Number(session.actor.fetchPk()) || 0));
                        Database.updateCharacterPvpPkKarma(
                            session.actor.fetchId(),
                            session.actor.fetchPvp(),
                            session.actor.fetchPk(),
                            session.actor.fetchKarma()
                        );
                    }

                    session.homeRegion = botData.homeRegion || null;
                    session.visitor = !!botData.visitor;
                    session.newbieAnchor = !!botData.newbieAnchor;
                    session.pkProfile = botData.pkProfile || null;
                
                    session.initialSpawnCoord = {
                        locX: character.locX,
                        locY: character.locY,
                        locZ: character.locZ
                    };

                    let privateStore = null;
                    if (storeCfg || runtimeStore) {
                        privateStore = runtimeStore || storeCfg;
                        session.plan = 'merchant';
                        session.coldMarketState = botData.coldMarketState || null;
                        session.actor.state.setSeated(true);

                        // A C4 shop title is carried by PrivateStoreMsg, not
                        // CharInfo.title. Keeping it out of the character
                        // title prevents an extra coloured nameplate line.
                        session.actor.setTitle('');
                        session.actor.setPrivateStoreType(privateStore.storeType);

                        const storeItems = TradeService.normalizeStoreItems(privateStore);

                        session.actor.setPrivateStore({
                            storeType: privateStore.storeType,
                            title: privateStore.title,
                            town: privateStore.town,
                            items: storeItems
                        });
                    } else if (manufactureShop) {
                        session.plan = 'merchant';
                        session.coldCraftState = botData.coldCraftState || null;
                        session.actor.state.setSeated(true);
                        session.actor.setTitle('');
                        session.actor.setPrivateStoreType(5);
                        const manufactureStore = session.actor.model || session.actor;
                        manufactureStore.manufactureShop = {
                            type: manufactureShop.type === 'common' ? 'common' : 'dwarven',
                            title: String(manufactureShop.title || '').slice(0, 52),
                            entries: (manufactureShop.entries || []).map((entry) => ({
                                recipeId: Number(entry.recipeId),
                                price: Number(entry.price)
                            }))
                        };
                    } else {
                        session.plan = botData.plan || 'hunting';
                        session.backgroundActivity = botData.backgroundActivity || session.plan;
                        session.currentSpot = botData.currentSpot || null;
                        session.coldLifeState = botData.coldLifeState || null;
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
                    if (privateStore?.storeType === 1) {
                        session.dataSendToOthers(ServerResponse.privateStoreMsg(session.actor, privateStore.title), session.actor);
                    } else if (privateStore?.storeType === 3) {
                        session.dataSendToOthers(ServerResponse.privateStoreBuyMsg(session.actor, privateStore.title), session.actor);
                    } else if (manufactureShop) {
                        session.dataSendToOthers(ServerResponse.recipeShopMsg(session.actor), session.actor);
                    }

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

    awardBaseSkills(id, classId, level = 1) {
        DataCache.fetchSkillTreeFromClassId(classId, (skillTree) => {
            const skills = skillTree.skills ?? [];
            const eligibleSkills = skills.filter((ob) => ob.levels.find((ob) => ob.pLevel <= level));

            eligibleSkills.forEach((skill) => {
                skill.levels = skill.levels.filter((ob) => ob.pLevel <= level).slice(-1);
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

            if (directCommandTarget && INSULT_PATTERN.test(rawText)) {
                handledByRule = true;
                BotSocialMemory.recordEvent(playerSession, session, 'insulted', 'chat');
                setTimeout(() => {
                    this.botTell(session, playerSession, `That was uncalled for.`);
                }, 500 + Math.random() * 500);
            }

            else if (text.includes("hi") || text.includes("hello") || text.includes("привет") || text.includes("ку")) {
                handledByRule = true;
                setTimeout(() => {
                    const currentPlan = session.plan || 'hunting';
                    const phrases = [
                        `Hey ${player.fetchName()}! I'm currently ${currentPlan}.`,
                        `Hello there! Ready to kill some keltirs?`,
                        `Hi! Beautiful day to hunt, isn't it?`
                    ];
                    this.botSay(session, phrases[Math.floor(Math.random() * phrases.length)], playerSession);
                }, 1000 + Math.random() * 1000);
            }

            else if (directCommandTarget && session.plan === 'pk_hunting' && (
                text.includes('follow') || text.includes('come here') || text.includes('за мной') || text.includes('иди сюда') ||
                text.includes('помоги') || text.includes('stop') || text.includes('стой') || text.includes('wait') ||
                text.includes('hunt') || text.includes('иди качайся') || text.includes('кач') ||
                text.includes('heal') || text.includes('хил') || text.includes('buff') || text.includes('бафф')
            )) {
                handledByRule = true;
                setTimeout(() => {
                    this.botSay(session, `I take no orders, ${player.fetchName()}.`, playerSession);
                }, 500 + Math.random() * 500);
            }

            else if (directCommandTarget && (text.includes("follow") || text.includes("за мной") || text.includes("помоги"))) {
                handledByRule = true;
                setTimeout(() => {
                    if (session.partyCompanion === true && session.followPlayerSession === playerSession) {
                        this.botSay(session, `Sure! I will follow you and assist in combat.`, playerSession);
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
                    this.botSay(session, `Staying here! Let me know if you need help.`, playerSession);
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
                    this.botSay(session, `Alright, returning to hunt keltirs!`, playerSession);
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
            const skill = BotSkillCapabilities.healSkill(bot);
            if (!skill) {
                this.botTell(botSession, playerSession, `I haven't learned a suitable healing spell.`);
                return false;
            }
            if (bot.fetchMp() < skill.fetchConsumedMp()) {
                this.botTell(botSession, playerSession, `I need to recover MP before healing.`);
                return false;
            }

            invoke(path.actor).skillExec(botSession, bot, {
                id: player.fetchId(),
                selfId: skill.fetchSelfId(),
                ctrl: false
            });
            this.botTell(botSession, playerSession, `Casting ${skill.fetchName()} on you.`);
            return true;
        }

        if (request.buff) {
            // A direct "buff" request is not a general conversation prompt.
            // Classes without a learned friendly/party support skill (for
            // example tanks) should simply ignore it instead of advertising a
            // missing buff service.
            if (BotSupportPlanner.supportSkills(bot).length === 0) return false;

            const providers = this.sessions
                .filter((session) => session?.actor && (
                    session === botSession ||
                    (session.partyCompanion === true && session.followPlayerSession === playerSession)
                ))
                .map((session) => session.actor);
            if (!providers.includes(bot)) providers.push(bot);

            const supportAction = BotSupportPlanner.nextAction(bot, [{ actor: player, leader: true }], providers);
            const skill = supportAction?.skill;
            if (!skill) {
                const otherProviderCanCast = providers.some((provider) => {
                    if (provider === bot) return false;
                    return BotSupportPlanner.supportSkills(provider).some((candidate) => (
                        Number(provider.fetchMp?.() || 0) >= Number(candidate.fetchConsumedMp?.() || 0)
                    ));
                });
                if (otherProviderCanCast) return false;

                const known = BotSupportPlanner.supportSkills(bot);
                const names = known.map((candidate) => candidate.fetchName()).join(', ');
                const requiredMp = known.length > 0
                    ? Math.min(...known.map((candidate) => Number(candidate.fetchConsumedMp?.() || 0)))
                    : 0;
                if (known.length > 0 && bot.fetchMp() < requiredMp) {
                    this.botTell(botSession, playerSession, `I know ${names}, but I need at least ${requiredMp} MP before buffing.`);
                } else if (known.length > 0) {
                    this.botTell(botSession, playerSession, `You already have the party buffs I can improve: ${names}.`);
                } else {
                    this.botTell(botSession, playerSession, `I haven't learned any friendly support buffs.`);
                }
                return false;
            }
            if (bot.fetchMp() < skill.fetchConsumedMp()) {
                this.botTell(botSession, playerSession, `I need more MP before buffing.`);
                return false;
            }

            BotSupportPlanner.reserve(supportAction);
            invoke(path.actor).skillExec(botSession, bot, {
                id: player.fetchId(),
                selfId: skill.fetchSelfId(),
                ctrl: false
            });
            this.botTell(botSession, playerSession, `Casting ${skill.fetchName()} on you.`);
            return true;
        }

        return false;
    },

    partyChatRecipients(session, targetSession = null) {
        const leaderSession = session?.partyCompanion === true ? session.followPlayerSession : null;
        if (!leaderSession?.actor) return [];

        const companions = this.sessions.filter((candidate) => (
            candidate?.partyCompanion === true &&
            candidate.followPlayerSession === leaderSession &&
            candidate.actor
        ));
        if (targetSession && targetSession !== leaderSession && !companions.includes(targetSession)) return [];

        return [leaderSession, ...companions].filter((candidate) => typeof candidate.dataSendToMe === 'function');
    },

    botPartySay(session, text, targetSession = null) {
        if (!session?.actor) return false;
        const recipients = this.partyChatRecipients(session, targetSession);
        if (recipients.length === 0) return false;

        const ServerResponse = invoke('GameServer/Network/Response');
        const packet = ServerResponse.speak(session.actor, { kind: 3, text: text });
        recipients.forEach((recipient) => recipient.dataSendToMe(packet));
        return true;
    },

    botSay(session, text, targetSession = null) {
        if (!session.actor) return;
        if (targetSession && this.partyChatRecipients(session, targetSession).length === 0) {
            this.botTell(session, targetSession, text);
            return;
        }
        if (this.botPartySay(session, text, targetSession)) return;
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

        if (this.partyChatRecipients(session, targetSession).length > 0) {
            lines.forEach((line) => this.botPartySay(session, line, targetSession));
            return;
        }

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
        if (botSession.inConversation || botSession.partyCompanion) return;
        const bot = botSession.actor;
        if (!bot) return;

        const SpeckMath = invoke('GameServer/SpeckMath');
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());

        // Find a nearby bot session
        const targetSession = this.sessions.find((session) => {
            if (session === botSession || session.inConversation || session.partyCompanion) return false;
            const target = session.actor;
            if (!target) return false;

            // Target must also be resting in town
            if (session.plan !== 'resting') return false;

            const dist = new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ()).distance(botPt);
            return dist < BotConversation.CONVERSATION_RANGE;
        });

        if (targetSession && BotConversation.canStart(botSession, targetSession)) {
            this.triggerConversation(botSession, targetSession);
        }
    },

    triggerConversation(botSession, targetSession) {
        const conversation = BotConversation.start(botSession, targetSession);
        if (!conversation) return false;

        const deliver = (index) => {
            const line = conversation.lines[index];
            if (!line?.speaker?.actor) return;
            this.botSay(line.speaker, line.text);
        };

        deliver(0);
        setTimeout(() => deliver(1), 2200);
        setTimeout(() => deliver(2), 4300);
        setTimeout(() => BotConversation.finish(conversation), 6500);
        return true;
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
                    .map((session) => BotAI.summarizeStatus(session));

                if (summaries.length > 0) {
                    console.info("BotStatus :: %s", summaries.join(" | "));
                }
            } catch (err) {
                console.error("Bot Status Monitor Error:", err);
            }
        }, 30000);
    }
};

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

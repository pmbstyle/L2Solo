const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');

const World = {
    init() {
        this.user  = { sessions : [] };
        this.npc   = { spawns   : [], grid: {}, nextId: 1000000 };
        this.items = { spawns   : [], nextId: 5000000 };

        World.spawnNpcs();
        this.indexSpawnsInGrid();
    },

    insertUser(session) {
        const exists = this.user.sessions.find((ob) => session.fetchAccountId() === ob.fetchAccountId());
        if (exists) {
            if (exists.socket && typeof exists.socket.destroy === 'function') {
                exists.socket.destroy();
            } else if (exists.socket && typeof exists.socket.resetAndDestroy === 'function') {
                exists.socket.resetAndDestroy();
            }
            this.user.sessions = this.user.sessions.filter((ob) => session.fetchAccountId() !== ob.fetchAccountId());
            this.user.sessions.push(session);
        }
        else {
            this.user.sessions.push(session);
        }
    },

    removeUser(session) {
        this.user.sessions = this.user.sessions.filter((ob) => ob !== session);
    },

    fetchUser(id) {
        return new Promise((success, fail) => {
            let user = this.user.sessions.find((ob) => id === ob.actor?.fetchId());
            return user.actor ? success(user.actor) : fail();
        });
    },

    fetchVisibleUsers(session, creature) {
        const actorArea = new SpeckMath.Circle(creature.fetchLocX(), creature.fetchLocY(), 6000);
        return this.user.sessions.filter((ob) => session !== ob && ob.actor?.fetchIsOnline() === true && actorArea.contains(new SpeckMath.Point(ob.actor?.fetchLocX() ?? 0, ob.actor?.fetchLocY() ?? 0))) ?? [];
    },

    askForTeamUp(session, actor, data) {
        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        this.fetchUser(data.id).then((user) => {
            const targetSession = user.session;
            const targetIsBot = targetSession && (targetSession.constructor.name === 'BotSession' || (targetSession.accountId && targetSession.accountId.startsWith('bot_')));

            if (targetIsBot) {
                this.inviteBotCompanion(session, actor, targetSession, data.distribution, 'invite');
            } else {
                user.session.dataSendToMe(ServerResponse.askForTeamUp(actor.fetchId(), data.distribution));
            }
        });
    },

    inviteBotCompanion(session, actor, targetSession, distribution = 1, source = 'invite') {
        const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const availability = BotAvailability.evaluate(session, targetSession);
        const bot = targetSession.actor;

        BotSocialMemory.recordEvent(session, targetSession, 'invite_attempt', source);

        if (!availability.available) {
            BotSocialMemory.recordEvent(session, targetSession, 'party_refused', availability.reason);
            session.dataSendToMe(ServerResponse.actionFailed());
            BotManager.botTell(targetSession, session, `I can't join right now: ${availability.reasonText}.`);
            console.info(
                'BotParty :: %s refused %s: %s distance=%s',
                bot?.fetchName() || 'unknown',
                actor?.fetchName() || 'unknown',
                availability.reason,
                availability.distance === null ? '?' : Math.round(availability.distance)
            );
            return false;
        }

        session.dataSendToMe(ServerResponse.joinParty(distribution || 1));
        session.dataSendToMe(ServerResponse.partySmallWindowDeleteAll());

        const wasResting = targetSession.plan === 'resting';
        targetSession.plan = wasResting ? 'resting' : 'following';
        targetSession.followPlayerSession = session;
        targetSession.partyCompanion = true;
        targetSession.botStay = false;
        targetSession.stayLocation = null;

        session.dataSendToMe(ServerResponse.partySmallWindowAll(actor.fetchId(), 0, [bot]));

        const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
        CompanionControl.render(session);

        BotSocialMemory.recordEvent(session, targetSession, 'party_formed', source);
        setTimeout(() => {
            BotManager.botTell(
                targetSession,
                session,
                wasResting ? `I'll join you, just need a moment to recover.` : `I'm with you. Lead the way.`
            );
        }, 1000);
        return true;
    },

    answerForTeamUp(session, actor, data) {
        console.info(data);
    },

    oustPartyMember(session, actor, data) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        let botFound = false;
        BotManager.sessions.forEach((targetSession) => {
            if (targetSession.actor && targetSession.actor.fetchName().toLowerCase() === data.name.toLowerCase() && targetSession.followPlayerSession === session && targetSession.partyCompanion === true) {
                botFound = true;
                session.dataSendToMe(ServerResponse.partySmallWindowDelete(targetSession.actor.fetchId(), targetSession.actor.fetchName()));
                
                setTimeout(() => {
                    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
                    BotSocialMemory.recordEvent(session, targetSession, 'party_kicked', 'oust');
                    BotManager.botSay(targetSession, `I have been kicked from the party. Returning to hunt on my own!`);
                    targetSession.plan = 'hunting';
                    targetSession.followPlayerSession = null;
                    targetSession.partyCompanion = false;
                }, 1000);
            }
        });
        if (!botFound) {
            session.dataSendToMe(ServerResponse.actionFailed());
        }
    },

    dismissParty(session, actor) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        let botsDisbanded = 0;
        BotManager.sessions.forEach((targetSession) => {
            if (targetSession.followPlayerSession === session && targetSession.partyCompanion === true) {
                botsDisbanded++;
                session.dataSendToMe(ServerResponse.partySmallWindowDelete(targetSession.actor.fetchId(), targetSession.actor.fetchName()));

                setTimeout(() => {
                    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
                    BotSocialMemory.recordEvent(session, targetSession, 'party_dismissed', 'dismiss');
                    BotManager.botSay(targetSession, `Party dismissed! Returning to my farming fields.`);
                    targetSession.plan = 'hunting';
                    targetSession.followPlayerSession = null;
                    targetSession.partyCompanion = false;
                }, 1000);
            }
        });
        if (botsDisbanded === 0) {
            session.dataSendToMe(ServerResponse.actionFailed());
        }
    },

    indexSpawnsInGrid() {
        const GRID_SIZE = 6000;
        this.npc.grid = {};
        this.npc.spawns.forEach((npc) => {
            const gx = Math.floor(npc.fetchLocX() / GRID_SIZE);
            const gy = Math.floor(npc.fetchLocY() / GRID_SIZE);
            const key = `${gx}_${gy}`;
            if (!this.npc.grid[key]) {
                this.npc.grid[key] = [];
            }
            this.npc.grid[key].push(npc);
        });
        utils.infoSuccess('SpawnsGrid', 'Indexed %d npcs in 2D spatial grid', this.npc.spawns.length);
    },

    fetchNpcsInRadius(locX, locY, radius) {
        const GRID_SIZE = 6000;
        const bgx = Math.floor(locX / GRID_SIZE);
        const bgy = Math.floor(locY / GRID_SIZE);
        const npcs = [];
        
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${bgx + dx}_${bgy + dy}`;
                const sector = this.npc.grid[key];
                if (sector) {
                    npcs.push(...sector);
                }
            }
        }
        
        const SpeckMath = invoke('GameServer/SpeckMath');
        const pt = new SpeckMath.Point(locX, locY);
        return npcs.filter(npc => {
            return new SpeckMath.Point(npc.fetchLocX(), npc.fetchLocY()).distance(pt) <= radius;
        });
    },

    fetchNpc        : invoke(path.world + 'FetchNpc'),
    spawnNpcs       : invoke(path.world + 'SpawnNpcs'),
    removeNpc       : invoke(path.world + 'RemoveNpc'),
    npcRewards      : invoke(path.world + 'NpcRewards'),
    npcTalk         : invoke(path.world + 'NpcTalk'),
    npcTalkResponse : invoke(path.world + 'NpcTalkResponse'),

    fetchItem       : invoke(path.world + 'fetchItem'),
    spawnItem       : invoke(path.world + 'SpawnItem'),
    pickupItem      : invoke(path.world + 'PickupItem'),
    purchaseItem    : invoke(path.world + 'PurchaseItem'),
    purchaseItems   : invoke(path.world + 'PurchaseItems')
};

module.exports = World;

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
        const actorArea = new SpeckMath.Circle(creature.fetchLocX(), creature.fetchLocY(), 5000);
        return this.user.sessions.filter((ob) => session !== ob && ob.actor?.fetchIsOnline() === true && actorArea.contains(new SpeckMath.Point(ob.actor?.fetchLocX() ?? 0, ob.actor?.fetchLocY() ?? 0))) ?? [];
    },

    askForTeamUp(session, actor, data) {
        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        this.fetchUser(data.id).then((user) => {
            const targetSession = user.session;
            const targetIsBot = targetSession && (targetSession.constructor.name === 'BotSession' || (targetSession.accountId && targetSession.accountId.startsWith('bot_')));

            if (targetIsBot) {
                const BotManager = invoke('GameServer/Bot/BotManager');

                // 1. Distance check & automated teleportation if far away (> 500 units)
                const pLoc = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
                const bLoc = { locX: user.fetchLocX(), locY: user.fetchLocY(), locZ: user.fetchLocZ() };
                const distance = new SpeckMath.Point3D(bLoc.locX, bLoc.locY, bLoc.locZ)
                    .distance(new SpeckMath.Point3D(pLoc.locX, pLoc.locY, pLoc.locZ));

                if (distance > 500) {
                    const Generics = invoke('GameServer/Actor/Generics');
                    Generics.teleportTo(targetSession, user, {
                        locX: pLoc.locX + 60,
                        locY: pLoc.locY + 60,
                        locZ: pLoc.locZ
                    });
                }

                // Send JoinParty (0x3a) to client to initialize party UI structure and prevent crash
                session.dataSendToMe(ServerResponse.joinParty(1));

                // Clear any existing party window elements to prevent client crash
                session.dataSendToMe(ServerResponse.partySmallWindowDeleteAll());

                // Set companion state immediately so renderCompanionPanel works on the first invite
                targetSession.plan = 'following';
                targetSession.followPlayerSession = session;

                // 2. Add companion to party HUD sidebar
                session.dataSendToMe(ServerResponse.partySmallWindowAll(actor.fetchId(), 0, [user]));

                // 3. Open the Companion Control Panel
                const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
                CompanionControl.render(session);

                setTimeout(() => {
                    BotManager.botSay(targetSession, `Party system is a bit complex for my brain, but I've joined you as a companion! (Follow mode active)`);
                }, 1000);
            } else {
                user.session.dataSendToMe(ServerResponse.askForTeamUp(actor.fetchId(), data.distribution));
            }
        });
    },

    answerForTeamUp(session, actor, data) {
        console.info(data);
    },

    oustPartyMember(session, actor, data) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        let botFound = false;
        BotManager.sessions.forEach((targetSession) => {
            if (targetSession.actor && targetSession.actor.fetchName().toLowerCase() === data.name.toLowerCase() && targetSession.followPlayerSession === session) {
                botFound = true;
                session.dataSendToMe(ServerResponse.partySmallWindowDelete(targetSession.actor.fetchId(), targetSession.actor.fetchName()));
                
                setTimeout(() => {
                    BotManager.botSay(targetSession, `I have been kicked from the party. Returning to hunt on my own!`);
                    targetSession.plan = 'hunting';
                    targetSession.followPlayerSession = null;
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
            if (targetSession.followPlayerSession === session) {
                botsDisbanded++;
                session.dataSendToMe(ServerResponse.partySmallWindowDelete(targetSession.actor.fetchId(), targetSession.actor.fetchName()));

                setTimeout(() => {
                    BotManager.botSay(targetSession, `Party dismissed! Returning to my farming fields.`);
                    targetSession.plan = 'hunting';
                    targetSession.followPlayerSession = null;
                }, 1000);
            }
        });
        if (botsDisbanded === 0) {
            session.dataSendToMe(ServerResponse.actionFailed());
        }
    },

    indexSpawnsInGrid() {
        const GRID_SIZE = 5000;
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
        const GRID_SIZE = 5000;
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

const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');

function actorLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function coldActor(state) {
    return {
        fetchId: () => Number(state.characterId || 0),
        fetchName: () => state.name || 'Bot'
    };
}

function coldBotTell(playerSession, state, text) {
    const clean = String(text || '').trim().slice(0, 120);
    if (!clean || !state || !playerSession?.dataSendToMe) return;

    playerSession.dataSendToMe(
        ServerResponse.speak(coldActor(state), { kind: 2, text: clean })
    );
}

function waitForBotSession(BotManager, name, attempts = 40) {
    const target = String(name || '').toLowerCase();
    return new Promise((resolve) => {
        const check = (left) => {
            const session = BotManager.findSessionByName(target);
            if (session) {
                resolve(session);
                return;
            }

            if (left <= 0) {
                resolve(null);
                return;
            }

            setTimeout(() => check(left - 1), 100);
        };

        check(attempts);
    });
}

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
            return user?.actor ? success(user.actor) : fail(new Error('user_not_found'));
        });
    },

    fetchUserByName(name) {
        const lookup = String(name || '').trim().toLowerCase();
        return new Promise((success, fail) => {
            if (!lookup) {
                fail(new Error('user_not_found'));
                return;
            }

            let user = this.user.sessions.find((ob) => ob.actor?.fetchName?.().toLowerCase() === lookup);
            return user?.actor ? success(user.actor) : fail(new Error('user_not_found'));
        });
    },

    fetchVisibleUsers(session, creature) {
        const actorArea = new SpeckMath.Circle(creature.fetchLocX(), creature.fetchLocY(), 6000);
        return this.user.sessions.filter((ob) => session !== ob && ob.actor?.fetchIsOnline() === true && actorArea.contains(new SpeckMath.Point(ob.actor?.fetchLocX() ?? 0, ob.actor?.fetchLocY() ?? 0))) ?? [];
    },

    askForTeamUp(session, actor, data) {
        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        const request = data.name
            ? this.fetchUserByName(data.name)
            : this.fetchUser(data.id);

        request.then((user) => {
            const targetSession = user.session;
            const targetIsBot = targetSession && (targetSession.constructor.name === 'BotSession' || (targetSession.accountId && targetSession.accountId.startsWith('bot_')));

            if (targetIsBot) {
                this.inviteBotCompanion(session, actor, targetSession, data.distribution, 'invite');
            } else {
                user.session.dataSendToMe(ServerResponse.askForTeamUp(actor.fetchName(), data.distribution));
            }
        }).catch(() => {
            if (data.name) {
                return this.inviteBotByName(session, actor, data.name, data.distribution, 'invite');
            }

            session.dataSendToMe(ServerResponse.actionFailed());
        });
    },

    inviteBotCompanion(session, actor, targetSession, distribution, source = 'invite') {
        const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
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

        const attachOptions = {};
        if (distribution !== undefined && distribution !== null) {
            attachOptions.distribution = distribution;
        }

        const wasResting = targetSession.plan === 'resting';
        PartyCompanionService.attach(session, targetSession, attachOptions);

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

    inviteBotByName(session, actor, name, distribution, source = 'named_invite') {
        const lookup = String(name || '').trim();
        if (!lookup) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return Promise.resolve(false);
        }

        const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

        const hotSession = BotManager.findSessionByName(lookup);
        if (hotSession) {
            return Promise.resolve(this.inviteBotCompanion(session, actor, hotSession, distribution, source));
        }

        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        return LifeState.findByName(lookup).then((state) => {
            if (!state) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return false;
            }

            const availability = BotAvailability.evaluateState(session, state);
            if (!availability.available) {
                BotSocialMemory.recordEvent(session, state, 'invite_attempt', source);
                BotSocialMemory.recordEvent(session, state, 'party_refused', availability.reason);
                session.dataSendToMe(ServerResponse.actionFailed());
                coldBotTell(session, state, `I can't join right now: ${availability.reasonText}.`);
                console.info(
                    'BotParty :: %s refused remote invite from %s: %s',
                    state.name || lookup,
                    actor?.fetchName() || 'unknown',
                    availability.reason
                );
                return false;
            }

            return PopulationService.requestActivation(state, 'remote_invite', {
                playerLoc: actorLoc(actor),
                forceNearPlayer: true
            }).then((result) => {
                if (!result.ok) {
                    BotSocialMemory.recordEvent(session, state, 'invite_attempt', source);
                    BotSocialMemory.recordEvent(session, state, 'party_refused', result.reason || 'activation_failed');
                    session.dataSendToMe(ServerResponse.actionFailed());
                    coldBotTell(session, state, `I can't get to you right now.`);
                    return false;
                }

                return waitForBotSession(BotManager, state.name || lookup).then((targetSession) => {
                    if (!targetSession) {
                        session.dataSendToMe(ServerResponse.actionFailed());
                        coldBotTell(session, state, `I tried to come over, but something went wrong.`);
                        return false;
                    }

                    return this.inviteBotCompanion(session, actor, targetSession, distribution, source);
                });
            });
        }).catch((err) => {
            utils.infoWarn('BotParty', 'remote invite failed for %s: %s', lookup, err.message);
            session.dataSendToMe(ServerResponse.actionFailed());
            return false;
        });
    },

    messageBotByName(session, actor, name, text, source = 'remote_chat') {
        const lookup = String(name || '').trim();
        const message = String(text || '').trim();
        if (!lookup || !message) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return Promise.resolve(false);
        }

        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');

        const hotSession = BotManager.findSessionByName(lookup);
        if (hotSession) {
            BotSocialMemory.recordEvent(session, hotSession, 'chat', source);
            const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
            const BotAI = invoke('GameServer/Bot/BotAI');
            const started = BotBrain.maybeThink(hotSession, 'player_chat', BotAI.getStatus(hotSession), message);
            if (!started) {
                const plan = hotSession.plan || 'hunting';
                BotManager.botTell(hotSession, session, `I hear you. I'm ${plan} right now.`);
            }
            return Promise.resolve(true);
        }

        return LifeState.findByName(lookup).then((state) => {
            if (!state) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return false;
            }

            return BotRemoteChat.replyForState(session, state, message).then((result) => {
                if (!result?.ok || !result.reply) {
                    session.dataSendToMe(ServerResponse.actionFailed());
                    return false;
                }

                coldBotTell(session, state, result.reply);
                console.info(
                    'BotRemoteChat :: %s replied to %s reason=%s',
                    state.name || lookup,
                    actor?.fetchName() || 'unknown',
                    result.reason || 'unknown'
                );
                return true;
            });
        }).catch((err) => {
            utils.infoWarn('BotRemoteChat', 'remote message failed for %s: %s', lookup, err.message);
            session.dataSendToMe(ServerResponse.actionFailed());
            return false;
        });
    },

    answerForTeamUp(session, actor, data) {
        console.info(data);
    },

    oustPartyMember(session, actor, data) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        let botFound = false;
        BotManager.sessions.forEach((targetSession) => {
            if (targetSession.actor && targetSession.actor.fetchName().toLowerCase() === data.name.toLowerCase() && targetSession.followPlayerSession === session && targetSession.partyCompanion === true) {
                botFound = true;
                PartyCompanionService.detach(session, targetSession, {
                    event: 'party_kicked',
                    source: 'oust',
                    message: 'I have been kicked from the party. Returning to hunt on my own!'
                });
            }
        });
        if (!botFound) {
            session.dataSendToMe(ServerResponse.actionFailed());
        }
    },

    dismissParty(session, actor) {
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        const botsDisbanded = PartyCompanionService.detachAll(session, {
            event: 'party_dismissed',
            source: 'dismiss',
            message: 'Party dismissed! Returning to my farming fields.'
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

    fetchItem       : invoke(path.world + 'FetchItem'),
    spawnItem       : invoke(path.world + 'SpawnItem'),
    pickupItem      : invoke(path.world + 'PickupItem'),
    purchaseItem    : invoke(path.world + 'PurchaseItem'),
    purchaseItems   : invoke(path.world + 'PurchaseItems')
};

module.exports = World;

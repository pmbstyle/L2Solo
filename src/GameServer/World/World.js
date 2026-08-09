const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');
const NpcDecay       = invoke('GameServer/World/Generics/NpcDecay');
const GameTime       = invoke('GameServer/World/GameTime');
const DayNightSpawnManager = invoke('GameServer/World/DayNightSpawnManager');

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
    if (!state || !playerSession?.dataSendToMe) return;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const lines = BotChatText.splitForTell(text);
    if (!lines.length) return;

    lines.forEach((line) => {
        playerSession.dataSendToMe(
            ServerResponse.speak(coldActor(state), { kind: 2, text: line })
        );
    });
}

function nameDistance(left, right) {
    const a = String(left || '').toLowerCase();
    const b = String(right || '').toLowerCase();
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= b.length; column += 1) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
            );
        }
        for (let column = 0; column <= b.length; column += 1) previous[column] = current[column];
    }
    return previous[b.length];
}

function nearestBotName(lookup, BotManager, LifeState) {
    const hotNames = (BotManager.sessions || [])
        .map((session) => session?.actor?.fetchName?.())
        .filter(Boolean);
    const coldNames = typeof LifeState.allStates === 'function'
        ? LifeState.allStates(2000).map((state) => state?.name).filter(Boolean)
        : [];
    const names = [...new Set([...hotNames, ...coldNames].map((name) => String(name)))];
    const ranked = names
        .map((name) => ({ name, distance: nameDistance(lookup, name) }))
        .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));
    const best = ranked[0];
    if (!best) return null;
    const maxDistance = Math.max(2, Math.floor(Math.max(String(lookup).length, best.name.length) * 0.3));
    return best.distance <= maxDistance ? best.name : null;
}

function unknownBotReply(session, lookup, BotManager, LifeState) {
    const suggestion = nearestBotName(lookup, BotManager, LifeState);
    const text = suggestion
        ? `I couldn't find a bot named "${lookup}". Did you mean "${suggestion}"?`
        : `I couldn't find a bot named "${lookup}".`;
    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text }));
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
    waitForBotSession,

    init() {
        NpcDecay.stop(this);
        DayNightSpawnManager.stop(this);
        this.user  = { sessions : [], revision: 0 };
        this.gameTime = GameTime;
        this.npc   = {
            spawns: [], grid: {}, nextId: 1000000,
            periodMode: GameTime.mode(), periodRevision: 0, periodDefinitions: []
        };
        this.items = { spawns   : [], nextId: 5000000 };

        World.spawnNpcs();
        this.indexSpawnsInGrid();
        NpcDecay.start(this);
        DayNightSpawnManager.start(this);
        invoke('GameServer/Npc/NpcAggro').startAggroTicker(this);
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
        this.user.revision += 1;
    },

    removeUser(session) {
        this.user.sessions = this.user.sessions.filter((ob) => ob !== session);
        this.user.revision += 1;
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
                // Keep the native C4 request/answer lifecycle even though a
                // SimPlayer has no client from which to send AnswerJoinParty.
                // The server-side availability decision is the bot's answer.
                targetSession.pendingPartyInvite = {
                    requestorSession: session,
                    requestorActor: actor,
                    distribution: data.distribution,
                    source: 'invite'
                };
                this.answerForTeamUp(targetSession, user, { id: 1 });
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

    inviteBotCompanion(session, actor, targetSession, distribution, source = 'invite', options = {}) {
        const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const PersonaPartyDecisionPolicy = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        const availability = BotAvailability.evaluate(session, targetSession, options);
        const bot = targetSession.actor;
        const capacityReservation = options.capacityReservation || targetSession;

        BotSocialMemory.recordEvent(session, targetSession, 'invite_attempt', source);

        if (!availability.available) {
            PartyCompanionService.releaseCapacity(session, capacityReservation);
            BotSocialMemory.recordEvent(session, targetSession, 'party_refused', availability.reason);
            session.dataSendToMe(ServerResponse.joinParty(0));
            BotManager.botTell(targetSession, session, availability.partyDecision
                ? PersonaPartyDecisionPolicy.reply(availability.partyDecision)
                : `I can't join right now: ${availability.reasonText}.`);
            console.info(
                'BotParty :: %s refused %s: %s distance=%s',
                bot?.fetchName() || 'unknown',
                actor?.fetchName() || 'unknown',
                availability.reason,
                availability.distance === null ? '?' : Math.round(availability.distance)
            );
            return false;
        }

        if (!PartyCompanionService.reserveCapacity(session, capacityReservation)) {
            BotSocialMemory.recordEvent(session, targetSession, 'party_refused', 'party_full');
            session.dataSendToMe(ServerResponse.joinParty(0));
            BotManager.botTell(targetSession, session, "Your party is full. Ask me again after making room.");
            return false;
        }

        const attachCompanion = (withdrawal = null) => {
            const attachOptions = {};
            if (distribution !== undefined && distribution !== null) {
                attachOptions.distribution = distribution;
            }
            attachOptions.capacityReservation = capacityReservation;

            if (!PartyCompanionService.attach(session, targetSession, attachOptions)) {
                PartyCompanionService.releaseCapacity(session, capacityReservation);
                BotSocialMemory.recordEvent(session, targetSession, 'party_refused', 'party_full');
                session.dataSendToMe(ServerResponse.joinParty(0));
                BotManager.botTell(targetSession, session, "Your party is full. Ask me again after making room.");
                if (withdrawal?.withdrawn) {
                    const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
                    return BotMerchantStoreService.restoreAfterPartyFailure(targetSession, withdrawal).then(() => false);
                }
                return false;
            }

            BotSocialMemory.recordEvent(session, targetSession, 'party_formed', source);
            setTimeout(() => {
                BotManager.botTell(
                    targetSession,
                    session,
                    availability.partyDecision
                        ? PersonaPartyDecisionPolicy.reply(availability.partyDecision)
                        : `I'm with you. Lead the way.`
                );
            }, 1000);
            return true;
        };

        const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
        if (!BotMerchantStoreService.needsPartyWithdrawal(targetSession)) return attachCompanion();
        let completedWithdrawal = null;
        return BotMerchantStoreService.withdrawForParty(targetSession).then((withdrawal) => {
            completedWithdrawal = withdrawal;
            if (withdrawal.ok) return attachCompanion(withdrawal);
            PartyCompanionService.releaseCapacity(session, capacityReservation);
            BotSocialMemory.recordEvent(session, targetSession, 'party_refused', withdrawal.reason || 'store_withdrawal_failed');
            session.dataSendToMe(ServerResponse.joinParty(0));
            BotManager.botTell(targetSession, session, "Give me a moment to finish this trade, then ask me again.");
            return false;
        }).catch(async (error) => {
            PartyCompanionService.releaseCapacity(session, capacityReservation);
            if (completedWithdrawal?.withdrawn) {
                try {
                    await BotMerchantStoreService.restoreAfterPartyFailure(targetSession, completedWithdrawal);
                } catch (rollbackError) {
                    utils.infoWarn('BotParty', 'merchant rollback failed for %s: %s', bot?.fetchName?.() || 'unknown', rollbackError.message || rollbackError);
                }
            }
            utils.infoWarn('BotParty', 'merchant withdrawal failed for %s: %s', bot?.fetchName?.() || 'unknown', error.message || error);
            session.dataSendToMe(ServerResponse.joinParty(0));
            return false;
        });
    },

    inviteBotByName(session, actor, name, distribution, source = 'named_invite', options = {}) {
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
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        let capacityReservation = null;

        const hotSession = BotManager.findSessionByName(lookup);
        if (hotSession) {
            return Promise.resolve(this.inviteBotCompanion(session, actor, hotSession, distribution, source, options));
        }

        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        return LifeState.findByName(lookup).then((state) => {
            if (!state) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return false;
            }

            const availability = BotAvailability.evaluateState(session, state, options);
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

            capacityReservation = state;
            if (!PartyCompanionService.reserveCapacity(session, capacityReservation)) {
                BotSocialMemory.recordEvent(session, state, 'party_refused', 'party_full');
                session.dataSendToMe(ServerResponse.actionFailed());
                coldBotTell(session, state, `Your party is full. Ask me again after making room.`);
                return false;
            }

            return PopulationService.requestActivation(state, 'remote_invite', {
                playerLoc: actorLoc(actor),
                forceNearPlayer: true
            }).then((result) => {
                if (!result.ok) {
                    PartyCompanionService.releaseCapacity(session, capacityReservation);
                    BotSocialMemory.recordEvent(session, state, 'invite_attempt', source);
                    BotSocialMemory.recordEvent(session, state, 'party_refused', result.reason || 'activation_failed');
                    session.dataSendToMe(ServerResponse.actionFailed());
                    coldBotTell(session, state, `I can't get to you right now.`);
                    return false;
                }

                return waitForBotSession(BotManager, state.name || lookup).then((targetSession) => {
                    if (!targetSession) {
                        PartyCompanionService.releaseCapacity(session, capacityReservation);
                        session.dataSendToMe(ServerResponse.actionFailed());
                        coldBotTell(session, state, `I tried to come over, but something went wrong.`);
                        return false;
                    }

                    return this.inviteBotCompanion(session, actor, targetSession, distribution, source, {
                        ...options,
                        capacityReservation
                    });
                });
            });
        }).catch((err) => {
            PartyCompanionService.releaseCapacity(session, capacityReservation);
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
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
        const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');

        const hotSession = BotManager.findSessionByName(lookup);
        if (hotSession) {
            return BotDialogueArbiter.route({
                playerSession: session,
                botSession: hotSession,
                text: message,
                channel: source,
                source,
                allowFallback: true
            }).then((result) => result?.ok !== false);
        }

        return LifeState.findByName(lookup).then((state) => {
            if (!state) {
                unknownBotReply(session, lookup, BotManager, LifeState);
                return false;
            }

            return BotRemoteChat.replyForState(session, state, message, source).then((result) => {
                if (!result?.ok || !result.reply || result.delivered !== true) {
                    session.dataSendToMe(ServerResponse.actionFailed());
                    return false;
                }

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
        const pending = session.pendingPartyInvite;
        session.pendingPartyInvite = null;

        if (!pending?.requestorSession || !pending?.requestorActor) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return false;
        }

        if (Number(data?.id) !== 1) {
            pending.requestorSession.dataSendToMe(ServerResponse.joinParty(0));
            return false;
        }

        return this.inviteBotCompanion(
            pending.requestorSession,
            pending.requestorActor,
            session,
            pending.distribution,
            pending.source || 'invite'
        );
    },

    inviteFriendByName(session, actor, name, distribution, source = 'friend_invite') {
        const BotFriendship = invoke('GameServer/Bot/AI/BotFriendship');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        if (!PartyCompanionService.hasCapacity(session)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return Promise.resolve(false);
        }
        return LifeState.findByName(name).then((state) => {
            if (!state) return false;
            return BotFriendship.isFriend(session, state.characterId).then((friend) => {
                if (!friend) return false;
                const hotSession = BotManager.findSessionByName(name);
                const previousLeader = hotSession?.partyCompanion === true ? hotSession.followPlayerSession : null;
                const leaveActiveParty = previousLeader && previousLeader !== session
                    ? Promise.resolve(PartyCompanionService.detach(previousLeader, hotSession, { source: 'friend_priority' }))
                    : Promise.resolve(true);
                const leaveBackgroundParty = state.party?.partyId
                    ? LifeState.leaveParty(state, 'friend_priority')
                    : Promise.resolve(state);
                return Promise.all([leaveActiveParty, leaveBackgroundParty])
                    .then(() => this.inviteBotByName(session, actor, name, distribution, source, {
                        forceFriend: true
                    }));
            });
        });
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
    spawnNpc        : invoke(path.world + 'SpawnNpcs').spawnNpc,
    spawnQuestNpc(options) {
        return invoke(path.world + 'SpawnNpcs').spawnQuestNpc(this, options);
    },
    despawnQuestNpc(npc, sourceSession = null) {
        return invoke(path.world + 'SpawnNpcs').despawnQuestNpc(this, npc, sourceSession);
    },
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

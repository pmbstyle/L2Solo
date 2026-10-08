const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const NpcDecay       = invoke('GameServer/World/Generics/NpcDecay');
const GameTime       = invoke('GameServer/World/GameTime');
const DayNightSpawnManager = invoke('GameServer/World/DayNightSpawnManager');
const RaidBossState = invoke('GameServer/World/RaidBossState');
const RaidBossMinionManager = invoke('GameServer/World/RaidBossMinionManager');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const NpcObjectIndex = require('./NpcObjectIndex');
const CharacterLocationRuntime = require('./CharacterLocationRuntime');
const PvpPartyMembershipKeys = require('./PvpPartyMembershipKeys');
const PlayerActivitySignal = require('../Bot/Population/PlayerActivitySignal');
const userLocationIndexes = new WeakMap();
const userChangeListeners = new Set();
const actorPublicationListeners = new Set();
let currentActorPublication = Object.freeze({ binding: null });
let currentUser;

function notifyUserChange(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    for (const listener of userChangeListeners) {
        try { listener(id); }
        catch (error) { utils.infoWarn('World', 'user change listener failed: %s', error.message); }
    }
}

function currentActorPublicationRuntime(runtime) {
    return !!runtime && runtime.binding === currentActorPublication.binding
        && CharacterLocationRuntime.isCurrentWorld(currentUser, runtime.binding);
}

function notifyActorPublication(runtime, kind, record, cause) {
    // Dirty evidence retains the native record; listener failures cannot mask
    // a pending native error, including when publication runs from finally.
    try {
        const publication = currentActorPublication;
        const envelope = Object.freeze(record
            ? { kind, binding: publication.binding, record, cause }
            : { kind, binding: publication.binding, cause });
        const listeners = [...actorPublicationListeners];
        for (const listener of listeners) {
            if (!actorPublicationListeners.has(listener)) continue;
            try {
                if (publication !== currentActorPublication) break;
                if (kind !== 'reset') {
                    if (!currentActorPublicationRuntime(runtime)) break;
                    if (kind === 'upsert' && !currentActorRecord(runtime, record)) break;
                    if (kind === 'remove' && runtime.index.getSource(record.id, 'actor') === record) break;
                }
                listener(envelope);
            } catch (error) {
                try { utils.infoWarn('World', 'actor publication listener failed: %s', error?.message); }
                catch { /* Diagnostics are observational, including in finally. */ }
            }
        }
    } catch { /* Publication must preserve the native return or original error. */ }
}

function createUserLocationIndex(user) {
    const runtime = { index: CharacterLocationRuntime.index, binding: CharacterLocationRuntime.bindWorld(user), sessions: new Map(),
        nextOrder: 0, retiredActors: new WeakSet() };
    userLocationIndexes.set(user, runtime);
    return runtime;
}

function currentUserLocationIndex(user) {
    const runtime = user && userLocationIndexes.get(user);
    return CharacterLocationRuntime.isCurrentWorld(user, runtime?.binding) ? runtime : null;
}

function registeredActor(runtime, session, actor, id, membership) {
    return Object.freeze({ id, session, actor, source: actor, phase: 'hot', order: membership.order,
        token: Symbol('user-registration'), loc: () => projectedActorLoc(actor),
        get spotId() { return membership.spotId ?? null; },
        get realPlayer() { return membership.realPlayer === true; },
        get retired() { return runtime.retiredActors.has(actor); } });
}

function currentActorRecord(runtime, record) {
    return !!record && runtime.sessions.get(record.session)?.registered === record
        && record.session.actor === record.actor && runtime.index.getSource(record.id, 'actor') === record;
}

function rawCoordinate(value) {
    if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function rawActorLoc(actor) {
    if (typeof actor.fetchLocX !== 'function' || typeof actor.fetchLocY !== 'function') return null;
    const rawX = actor.fetchLocX(), rawY = actor.fetchLocY();
    const locX = rawCoordinate(rawX), locY = rawCoordinate(rawY);
    return locX !== null && locY !== null ? { locX, locY } : null;
}

function refreshActorPresence(runtime, record) {
    if (!currentActorRecord(runtime, record)) return false;
    const targetId = Number(record.actor.fetchDestId?.() || 0);
    return runtime.index.updateActorPresence(record.id, record, {
        online: record.actor.fetchIsOnline?.() === true,
        realPlayer: !!record.session.accountId && !String(record.session.accountId).startsWith('bot_'),
        targetId: Number.isFinite(targetId) && targetId > 0 ? targetId : 0
    });
}

function partyMembershipPacket(runtime, record) {
    if (!currentActorRecord(runtime, record)) return null;
    return { record, keys: [...new Set(PvpPartyMembershipKeys(record.session))] };
}

function publishPartyMembership(runtime, packet) {
    if (!packet || !currentActorRecord(runtime, packet.record)) return false;
    const { record, keys } = packet;
    return runtime.index.updateGroups(record.id, 'actor', record, 'pvp_party', keys, record.order);
}

function attachRegisteredActor(runtime, session, membership, explicit = false) {
    const actor = session.actor;
    const id = Number(actor?.fetchId?.());
    if (!currentActorPublicationRuntime(runtime) || runtime.sessions.get(session) !== membership
        || session.actor !== actor) return null;
    const previous = membership.registered;
    if (previous && previous.actor === actor && previous.id === id) {
        if (currentActorRecord(runtime, previous)) return previous;
        if (!explicit) return null;
    }
    const removed = [];
    let accepted = null;
    try {
        if (previous && runtime.index.getSource(previous.id, 'actor') === previous) {
            runtime.index.removeSource(previous.id, 'actor', previous.source);
            removed.push(previous);
            if (previous.actor !== actor) runtime.retiredActors.add(previous.actor);
        }
        membership.registered = null;
        if (previous) notifyUserChange(previous.id);
        if (!currentActorPublicationRuntime(runtime) || runtime.sessions.get(session) !== membership
            || session.actor !== actor) return null;
        if (!actor || !Number.isSafeInteger(id) || id <= 0) return null;
        const displaced = runtime.index.getSource(id, 'actor');
        if (displaced && displaced.actor !== actor) {
            runtime.retiredActors.add(displaced.actor);
        }
        const record = registeredActor(runtime, session, actor, id, membership);
        runtime.index.setSource(id, 'actor', record, { indexed: false });
        accepted = record;
        if (displaced && displaced !== record) removed.push(displaced);
        membership.registered = record;
        membership.cellX = membership.cellY = undefined;
        membership.actor = null;
        refreshActorPresence(runtime, record);
        publishPartyMembership(runtime, partyMembershipPacket(runtime, record));
        notifyUserChange(id);
        return record;
    } finally {
        for (const record of removed) notifyActorPublication(runtime, 'remove', record, 'replace');
        if (accepted) notifyActorPublication(runtime, 'upsert', accepted, 'attach');
    }
}

function removeIndexedSession(runtime, session) {
    const membership = runtime?.sessions.get(session);
    if (!membership) return;
    const registered = membership.registered;
    let removed = false;
    try {
        if (registered && runtime.index.getSource(registered.id, 'actor') === registered) {
            removed = runtime.index.removeSource(registered.id, 'actor', registered.source);
            runtime.retiredActors.add(registered.actor);
        }
        runtime.sessions.delete(session);
        if (registered) notifyUserChange(registered.id);
    } finally {
        if (removed) notifyActorPublication(runtime, 'remove', registered, 'remove');
    }
}

function actorLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function indexedActorLoc(actor) {
    return {
        locX: Number(actor.fetchLocX?.()),
        locY: Number(actor.fetchLocY?.()),
        locZ: Number(actor.fetchLocZ?.())
    };
}

function usableActorLoc(loc) {
    return Number.isFinite(loc.locX) && Number.isFinite(loc.locY) && Number.isFinite(loc.locZ);
}

function projectedActorLoc(actor) {
    return { locX: Number(actor.fetchLocX?.() ?? 0), locY: Number(actor.fetchLocY?.() ?? 0), locZ: 0 };
}

function usableProjection(actor) {
    if (typeof actor.fetchLocX !== 'function' || typeof actor.fetchLocY !== 'function') return false;
    const loc = projectedActorLoc(actor);
    return Number.isFinite(loc.locX) && Number.isFinite(loc.locY);
}

function actorIdForTarget(target) {
    return Number(target?.actor?.fetchId?.() || target?.characterId || target?.coldLifeState?.characterId || 0);
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

const { CLIENT_VISIBILITY_RADIUS, NPC_GRID_SIZE } = invoke('GameServer/World/WorldConstants');
const CLIENT_VISIBILITY_RADIUS_SQUARED = CLIENT_VISIBILITY_RADIUS * CLIENT_VISIBILITY_RADIUS;

function isBotSession(session) {
    return !!session && (
        session.botSession === true ||
        session.constructor?.name === 'BotSession' ||
        String(session.accountId || '').startsWith('bot_')
    );
}

function isVisibleFrom(creature, candidate) {
    const dx = Number(candidate.actor.fetchLocX() ?? 0) - Number(creature.fetchLocX());
    const dy = Number(candidate.actor.fetchLocY() ?? 0) - Number(creature.fetchLocY());
    return (dx * dx) + (dy * dy) < CLIENT_VISIBILITY_RADIUS_SQUARED;
}

function visibleUserSessions(user, session, creature, realOnly) {
    const runtime = currentUserLocationIndex(user);
    if (!runtime) return [];
    const loc = { locX: Number(creature?.fetchLocX?.()), locY: Number(creature?.fetchLocY?.()), locZ: 0 };
    if (!Number.isFinite(loc.locX) || !Number.isFinite(loc.locY)) return [];
    return runtime.index.nearSources(loc, CLIENT_VISIBILITY_RADIUS, { view: 'actor', kind: 'all',
        accept: (record) => !record.retired
            && record.session !== session && (!realOnly || !isBotSession(record.session))
            && record.actor.fetchIsOnline?.() === true })
        .sort((left, right) => left.order - right.order)
        .filter((record) => isVisibleFrom(creature, record.session))
        .map((record) => record.session);
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
    actorSpatialIndex: true,
    get user() { return currentUser; },
    set user(user) {
        const binding = CharacterLocationRuntime.bindWorld(user);
        currentUser = user;
        if (binding !== currentActorPublication.binding) {
            currentActorPublication = Object.freeze({ binding });
            notifyActorPublication(null, 'reset', null, 'reset');
        }
    },
    get actorPublicationBinding() { return currentActorPublication.binding; },
    waitForBotSession,
    isBotSession,

    async init() {
        NpcDecay.stop(this);
        RaidBossMinionManager.stop(this);
        DayNightSpawnManager.stop(this);
        this.user  = { sessions : [], revision: 0 };
        createUserLocationIndex(this.user);
        this.gameTime = GameTime;
        this.npc   = {
            spawns: [], grid: {}, nextId: 1000000,
            threatRevision: 0,
            gridKeys: new WeakMap(),
            periodMode: GameTime.mode(), periodRevision: 0, periodDefinitions: [],
            raidBossRespawnTimers: new Map(), raidBossState: new Map()
        };
        RaidEntityIndex.reset(this);
        this.npc.raidBossState = await RaidBossState.load();
        this.items = { spawns   : [], nextId: 5000000 };

        World.spawnNpcs();
        RaidBossMinionManager.start(this);
        this.indexSpawnsInGrid();
        NpcDecay.start(this);
        DayNightSpawnManager.start(this);
        invoke('GameServer/Npc/NpcAggro').startAggroTicker(this);
        return this;
    },

    insertUser(session) {
        const runtime = currentUserLocationIndex(this.user) ?? createUserLocationIndex(this.user);
        const exists = this.user.sessions.find((ob) => session.fetchAccountId() === ob.fetchAccountId());
        if (exists && exists !== session) {
            // Retire before destroying the socket: synchronous/late cleanup
            // from the previous session cannot alter its replacement.
            removeIndexedSession(runtime, exists);
            if (exists.socket && typeof exists.socket.destroy === 'function') {
                exists.socket.destroy();
            } else if (exists.socket && typeof exists.socket.resetAndDestroy === 'function') {
                exists.socket.resetAndDestroy();
            }
            this.user.sessions = this.user.sessions.filter((ob) => session.fetchAccountId() !== ob.fetchAccountId());
            this.user.sessions.push(session);
        }
        else if (!exists) {
            this.user.sessions.push(session);
        }
        // Explicit registration is authoritative, including reconnecting the
        // same session/actor. Delayed setters alone cannot undo retirement.
        const restored = session.actor && runtime.retiredActors.delete(session.actor);
        if (!runtime.sessions.has(session)) runtime.sessions.set(session, { actor: null, id: null, order: ++runtime.nextOrder });
        attachRegisteredActor(runtime, session, runtime.sessions.get(session), true);
        this.updateUserLocation(session);
        if (restored) notifyUserChange(Number(session.actor.fetchId?.()));
        this.user.revision += 1;
        invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
    },

    removeUser(session) {
        removeIndexedSession(currentUserLocationIndex(this.user), session);
        const wasPresent = this.user.sessions.includes(session);
        this.user.sessions = this.user.sessions.filter((ob) => ob !== session);
        this.user.revision += 1;
        invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
        // Build the packet after removal so its online object ID becomes zero.
        if (wasPresent) invoke('GameServer/Clan/ClanService').broadcastMemberPresence(session.actor);
    },

    updateUserLocation(session, actor = session?.actor) {
        const runtime = userLocationIndexes.get(this.user);
        const membership = runtime?.sessions.get(session);
        if (!membership || !actor || session.actor !== actor) return false;
        // A session owns one actor registration. Ordinary moves need no token
        // receipt and no allocation; cells retain a pointer to the live actor.
        const record = membership.actor === actor ? membership.registered
            : attachRegisteredActor(runtime, session, membership);
        if (!record || record.retired || runtime.index.getSource(record.id, 'actor') !== record) return false;
        const online = actor.fetchIsOnline?.() !== false;
        const rawX = actor.fetchLocX?.(), rawY = actor.fetchLocY?.(), z = Number(actor.fetchLocZ?.());
        const usable = Number.isFinite(Number(rawX)) && Number.isFinite(Number(rawY)) && Number.isFinite(z);
        // Client visibility retains nullish XY as zero; real-player proximity
        // above still requires the actor's actual finite XYZ coordinates.
        const x = Number(rawX ?? 0), y = Number(rawY ?? 0);
        const indexed = online && typeof actor.fetchLocX === 'function' && typeof actor.fetchLocY === 'function'
            && Number.isFinite(x) && Number.isFinite(y);
        const cellX = Math.floor(x / runtime.index.cellSize), cellY = Math.floor(y / runtime.index.cellSize);
        const spotId = session.currentSpot?.id ?? null;
        if (membership.cellX === cellX && membership.cellY === cellY && membership.spotId === spotId
            && membership.online === online && membership.usable === usable && membership.indexed === indexed) return online && usable;
        const changed = membership.online !== online || membership.usable !== usable;
        membership.online = online; membership.usable = usable; membership.indexed = indexed;
        membership.spotId = spotId;
        membership.realPlayer = online && usable && PlayerActivitySignal.isRealPlayerSession(session);
        runtime.index.updateSource(record.id, 'actor', actor, { indexed });
        refreshActorPresence(runtime, record);
        membership.actor = actor; membership.id = record.id;
        membership.cellX = cellX; membership.cellY = cellY;
        if (changed) notifyUserChange(record.id);
        // ARCH-NOTE: actor location publications had only the cold stream as a
        // reader. It has no worker consumer, so moves publish nothing. Attach,
        // retirement and removal continue to publish their ownership changes.
        return online && usable;
    },

    retireUserActor(session, actor) {
        const runtime = currentUserLocationIndex(this.user);
        const membership = runtime?.sessions.get(session);
        if (!membership || !actor) return false;
        const previous = membership.registered;
        if (previous?.actor !== actor || !currentActorRecord(runtime, previous)) return false;
        runtime.retiredActors.add(actor);
        membership.realPlayer = false;
        // Renew the common raw record even for the same actor so an in-flight
        // registration token cannot survive terminal retirement/restoration.
        const retired = registeredActor(runtime, session, actor, previous.id, membership);
        let accepted = false;
        try {
            runtime.index.setSource(previous.id, 'actor', retired, { indexed: false });
            accepted = true;
            membership.registered = retired;
            refreshActorPresence(runtime, retired);
            publishPartyMembership(runtime, partyMembershipPacket(runtime, retired));
            notifyUserChange(previous.id);
            membership.actor = null;
            membership.id = null;
            membership.cellX = membership.cellY = undefined;
            return true;
        } finally {
            if (accepted) notifyActorPublication(runtime, 'upsert', retired, 'retire');
        }
    },

    registeredActorById(id) {
        const runtime = currentUserLocationIndex(this.user);
        const record = runtime?.index.getSource(Number(id), 'actor');
        return runtime && currentActorRecord(runtime, record) ? record : null;
    },

    actorSessionsNear(loc, radius, accept = null) {
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return [];
        return runtime.index.nearSources({ ...loc, locZ: loc.locZ ?? 0 }, radius, { view: 'actor', kind: 'all',
            accept: record => !record.retired && (!accept || accept(record.session)) })
            .sort((a, b) => a.order - b.order).map(record => record.session);
    },

    actorPresenceSessions(kind = 'onlineHuman', targetId = null) {
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return [];
        return runtime.index.presenceSources({ kind, targetId }).filter(record => currentActorRecord(runtime, record))
            .map(record => record.session);
    },

    actorPresenceCount() {
        return currentUserLocationIndex(this.user)?.index.presenceSize() ?? 0;
    },

    nearestRealPlayer(loc) {
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return { record: null, session: null, distance: Infinity, count: 0 };
        let record = null, distanceSquared = Infinity;
        const x = Number(loc?.locX), y = Number(loc?.locY);
        for (const candidate of runtime.index.presenceSources({ kind: 'onlineHuman' })) {
            if (candidate.retired || candidate.actor.fetchIsOnline?.() !== true) continue;
            const dx = Number(candidate.actor.fetchLocX?.()) - x, dy = Number(candidate.actor.fetchLocY?.()) - y;
            const d = dx * dx + dy * dy;
            if (d < distanceSquared || (d === distanceSquared && candidate.order < record?.order)) {
                record = candidate; distanceSquared = d;
            }
        }
        return { record, session: record?.session ?? null, distance: Math.sqrt(distanceSquared), count: runtime.index.presenceSize() };
    },

    botRealPlayerIndex: true,

    botVisibleRealPlayers(session, bot) {
        if (!session || !bot) return [];
        const point = rawActorLoc(bot);
        if (!point) return [];
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return [];
        const records = runtime.index.nearSources({ ...point, locZ: 0 }, CLIENT_VISIBILITY_RADIUS, {
            view: 'actor', kind: 'all',
            accept: record => {
                if (record.retired || record.session === session) return false;
                const candidate = record.session, actor = record.actor;
                return !!actor.fetchIsOnline?.() && !!candidate.accountId
                    && !String(candidate.accountId).startsWith('bot_')
                    && !!rawActorLoc(actor);
            }
        });
        records.sort((left, right) => left.order - right.order);
        return records.map(record => record.session);
    },

    pvpPartyMembershipIndex: true,
    pvpPartyMembershipKeys: PvpPartyMembershipKeys,

    pvpPartySessionsForKey(key) {
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return [];
        const sessions = [];
        for (const record of runtime.index.groupSources(key)) {
            if (currentActorRecord(runtime, record)) sessions.push(record.session);
        }
        return sessions;
    },

    refreshPartyMemberships(changedSessions) {
        if (!Array.isArray(changedSessions) && !(changedSessions instanceof Set)) {
            throw new TypeError('invalid_party_membership_sources');
        }
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) return 0;
        const packets = [];
        for (const session of new Set(changedSessions)) {
            const record = runtime.sessions.get(session)?.registered;
            const packet = partyMembershipPacket(runtime, record);
            if (packet) packets.push(packet);
        }
        let updated = 0;
        for (const packet of packets) if (publishPartyMembership(runtime, packet)) updated += 1;
        return updated;
    },

    notifyUserStateChanged(session, actor = session?.actor) {
        const runtime = currentUserLocationIndex(this.user);
        const record = runtime?.sessions.get(session)?.registered;
        if (!record || record.retired || record.actor !== actor || session.actor !== actor
            || !currentActorRecord(runtime, record)) return false;
        notifyUserChange(record.id);
        return true;
    },

    updateUserPresence(session, actor = session?.actor) {
        const runtime = userLocationIndexes.get(this.user);
        const record = runtime?.sessions.get(session)?.registered;
        if (!record || record.actor !== actor || session.actor !== actor || record.retired) return false;
        return refreshActorPresence(runtime, record);
    },

    subscribeUserChanges(listener) {
        if (typeof listener !== 'function') return () => {};
        userChangeListeners.add(listener);
        return () => userChangeListeners.delete(listener);
    },

    subscribeActorPublications(listener) {
        if (typeof listener !== 'function') throw new TypeError('invalid_actor_publication_listener');
        actorPublicationListeners.add(listener);
        return () => actorPublicationListeners.delete(listener);
    },

    realPlayerSessionsNear(loc, radius) {
        const runtime = currentUserLocationIndex(this.user);
        if (!runtime) throw new Error('character_location_index_uninitialized');
        return runtime.index.nearSources(loc, radius, { view: 'actor', kind: 'player',
            accept: (record) => !record.retired
                && usableActorLoc(indexedActorLoc(record.actor))
                && PlayerActivitySignal.isRealPlayerSession(record.session) })
            .map((record) => record.session);
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
        return visibleUserSessions(this.user, session, creature, false);
    },

    fetchVisibleRealPlayers(session, creature) {
        return visibleUserSessions(this.user, session, creature, true);
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
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
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
            // A delayed invite must not overwrite a newer client setting.
            if (!session.clientPartyLootDistributionKnown && distribution !== undefined && distribution !== null) {
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
        return LifeState.findByName(lookup).then(async (state) => {
            if (!state) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return false;
            }

            await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany([Number(state.characterId)]);
            const availability = BotAvailability.evaluateState(session, state, options);
            if (!availability.available) {
                BotSocialMemory.recordEvent(session, state, 'invite_attempt', source);
                BotSocialMemory.recordEvent(session, state, 'party_refused', availability.reason);
                session.dataSendToMe(ServerResponse.actionFailed());
                coldBotTell(session, state, `I can't join right now: ${availability.reasonText}.`);
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
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
                forceNearPlayer: true,
                interruptBackgroundActivity: availability.clanmate || options.forceFriend === true
            }).then((result) => {
                if (!result.ok) {
                    PartyCompanionService.releaseCapacity(session, capacityReservation);
                    BotSocialMemory.recordEvent(session, state, 'invite_attempt', source);
                    BotSocialMemory.recordEvent(session, state, 'party_refused', result.reason || 'activation_failed');
                    session.dataSendToMe(ServerResponse.actionFailed());
                    utils.infoWarn('BotParty', 'remote activation failed for %s: reason=%s activity=%s clanmate=%s',
                        state.name || lookup, result.reason || 'activation_failed', state.activity || 'unknown', availability.clanmate);
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
            const marketState = LifeState.snapshot(hotSession.actor?.fetchId?.());
            const marketChat = invoke('GameServer/Bot/Economy/BotAfkTradeChat');
            if (marketState && marketChat.parse(marketState, message, session)) {
                return BotRemoteChat.replyForState(session, marketState, message, source)
                    .then((result) => result?.ok === true && result.delivered === true);
            }
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

                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
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

    requestJoinBotPartyByName(session, actor, name, source = 'join_party_command') {
        const lookup = String(name || '').trim();
        if (!session?.actor) {
            session?.dataSendToMe?.(ServerResponse.actionFailed());
            return Promise.resolve(false);
        }
        const BotManager = invoke('GameServer/Bot/BotManager');
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Takeover = invoke('GameServer/Bot/AI/PlayerPartyTakeover');
        let hotSession = lookup ? BotManager.findSessionByName(lookup) : null;
        if (!lookup) {
            const selectedId = Number(actor?.fetchDestId?.() || 0);
            const candidates = (BotManager.sessions || []).filter((candidate) => (
                candidate?.actor && candidate.hotBackgroundPartyId &&
                candidate.actor.fetchIsOnline?.() !== false && !candidate.actor.isDead?.()
            )).map((candidate) => {
                const dx = Number(candidate.actor.fetchLocX?.() || 0) - Number(actor.fetchLocX?.() || 0);
                const dy = Number(candidate.actor.fetchLocY?.() || 0) - Number(actor.fetchLocY?.() || 0);
                const dz = Number(candidate.actor.fetchLocZ?.() || 0) - Number(actor.fetchLocZ?.() || 0);
                return { session: candidate, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) };
            }).filter((candidate) => candidate.distance <= 1500)
                .sort((left, right) => left.distance - right.distance);
            hotSession = candidates.find((candidate) => Number(candidate.session.actor.fetchId?.()) === selectedId)?.session
                || candidates[0]?.session || null;
        }
        const resolveTarget = hotSession
            ? Promise.resolve(hotSession)
            : lookup ? LifeState.findByName(lookup) : Promise.resolve(null);

        ConsoleText.transmit(session, ConsoleText.caption.waitForResponse);
        return resolveTarget.then((target) => {
            if (!target) {
                if (lookup) unknownBotReply(session, lookup, BotManager, LifeState);
                else session.dataSendToMe(ServerResponse.actionFailed());
                utils.infoWarn('BotParty', 'join request has no target player=%s lookup=%s',
                    actor.fetchName?.() || 'unknown', lookup || 'nearest');
                return false;
            }
            const requestedPartyId = Takeover.partyIdFor(target);
            return Takeover.request({ playerSession: session, target, source }).then((result) => {
                const speaker = BotManager.findSessionById(actorIdForTarget(target));
                if (speaker?.actor) {
                    BotManager.botTell(speaker, session, result.reply);
                } else {
                    coldBotTell(session, target.coldLifeState || target, result.reply);
                }
                if (!result.ok) session.dataSendToMe(ServerResponse.actionFailed());
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
                    'BotParty :: command join request player=%s target=%s party=%s result=%s applied=%s',
                    actor.fetchName?.() || 'unknown',
                    speaker?.actor?.fetchName?.() || target.name || lookup || 'unknown',
                    requestedPartyId || result.partyId || 'none',
                    result.reason || 'unknown',
                    result.applied === true
                );
                return result.ok === true;
            });
        }).catch((error) => {
            utils.infoWarn('BotParty', 'join-party request failed for %s: %s', lookup, error.message || error);
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

    dismissParty(session) {
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

    npcGridKey(npc) {
        const gx = Math.floor(npc.fetchLocX() / NPC_GRID_SIZE);
        const gy = Math.floor(npc.fetchLocY() / NPC_GRID_SIZE);
        return `${gx}_${gy}`;
    },

    addNpcToGrid(npc) {
        if (!npc) return false;
        NpcObjectIndex.add(this, npc);
        const raidIndexed = RaidEntityIndex.add(this, npc);
        if (!npc.fetchLocX || !npc.fetchLocY) return raidIndexed;
        if (!(this.npc.gridKeys instanceof WeakMap)) this.npc.gridKeys = new WeakMap();
        const key = this.npcGridKey(npc);
        const previousKey = this.npc.gridKeys.get(npc);
        if (previousKey && previousKey !== key) {
            const previousSector = this.npc.grid[previousKey];
            const previousIndex = previousSector?.indexOf(npc) ?? -1;
            if (previousIndex >= 0) previousSector.splice(previousIndex, 1);
            if (previousSector?.length === 0) delete this.npc.grid[previousKey];
        }
        const sector = this.npc.grid[key] || (this.npc.grid[key] = []);
        if (!sector.includes(npc)) sector.push(npc);
        this.npc.gridKeys.set(npc, key);
        return true;
    },

    removeNpcFromGrid(npc) {
        if (!npc) return false;
        NpcObjectIndex.remove(this, npc);
        const raidRemoved = RaidEntityIndex.remove(this, npc);
        if (!npc.fetchLocX || !npc.fetchLocY) return raidRemoved;
        if (!(this.npc.gridKeys instanceof WeakMap)) this.npc.gridKeys = new WeakMap();
        // NPCs move after insertion. Remove from the sector where the object
        // was actually indexed rather than deriving a potentially newer key.
        const key = this.npc.gridKeys.get(npc) || this.npcGridKey(npc);
        const sector = this.npc.grid[key];
        if (!sector) {
            this.npc.gridKeys.delete(npc);
            return false;
        }
        const index = sector.indexOf(npc);
        if (index < 0) {
            this.npc.gridKeys.delete(npc);
            return false;
        }
        sector.splice(index, 1);
        if (sector.length === 0) delete this.npc.grid[key];
        this.npc.gridKeys.delete(npc);
        return true;
    },

    indexSpawnsInGrid() {
        this.npc.grid = {};
        this.npc.gridKeys = new WeakMap();
        NpcObjectIndex.reset(this);
        RaidEntityIndex.reset(this);
        this.npc.spawns.forEach((npc) => {
            this.addNpcToGrid(npc);
        });
        utils.infoSuccess('SpawnsGrid', 'Indexed %d npcs in 2D spatial grid', this.npc.spawns.length);
    },

    fetchNpcsInRadius(locX, locY, radius) {
        const bgx = Math.floor(locX / NPC_GRID_SIZE);
        const bgy = Math.floor(locY / NPC_GRID_SIZE);
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

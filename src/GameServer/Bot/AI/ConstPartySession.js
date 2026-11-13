const refreshMemberships = require('../../World/PartyMembershipPublication');
const pending = new Map();
const preparations = new Map();
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const database = () => invoke('Database');
const manager = () => invoke('GameServer/Bot/BotManager');
const ai = () => invoke('GameServer/Bot/BotAI');
const marker = session => (life().cachedState(Number(session?.actor?.fetchId?.()))
    || session?.coldLifeState)?.stats?.constPartySession;

function serialize(id, work, queue = pending) {
    const previous = queue.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    queue.set(id, run);
    return run.finally(() => { if (queue.get(id) === run) queue.delete(id); });
}

function stop(session) {
    if (!session?.actor) return;
    session.constActivityPaused = true;
    ai().stop(session);
    invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, session.actor);
    invoke('GameServer/Bot/AI/BotPvpDefense').clear(session, { dead: true });
    session.pvpRevenge = null;
    session.pendingPvpProvocation = null;
    session.actor.attack?.abortCast?.(session, session.actor);
    session.actor.attack?.clearTimers?.();
    session.actor.automation?.abortAll?.(session.actor);
    session.actor.automation?.stopReplenish?.();
    session.actor.unselect?.();
}

function accept(result) {
    const states = (result.rows || []).map(row => life().acceptLifecycleRow(row));
    if (result.party) invoke('GameServer/Bot/Population/BackgroundPartyState').acceptRow(result.party);
    const changed = [];
    for (const state of states) {
        const session = manager().findSessionById(state.characterId);
        if (!session) continue;
        session.coldLifeState = state;
        session.hotBackgroundPartyId = null;
        session.hotCompetitionCommit = null;
        session.pvpEncounter = null;
        session.supplyErrandPhase = undefined;
        session.companionShopping = null;
        session.clanAllianceQuest = null;
        session.coldMarketState = null;
        session.coldCraftState = null;
        changed.push(session);
    }
    refreshMemberships(changed, invoke);
    return states;
}

function retire(session) {
    if (!session?.actor || session.partyCompanion || session.followPlayerSession) return;
    stop(session);
    invoke('GameServer/Bot/Population/Cooldown').removeFromClientWorld(session);
    session.actor.destructor?.();
    invoke('GameServer/World/World').removeUser(session);
    manager().sessions = manager().sessions.filter(candidate => candidate !== session);
    session.actor = null;
}

async function release(characterId, playerId, session = null) {
    const current = manager().findSessionById(characterId) || session;
    if (current?.partyCompanion || current?.followPlayerSession) return false;
    stop(current);
    if (current?.actor && !await life().markHot(current, 'const_party_departure')) throw Error('activity_checkpoint_failed');
    await life().settleWrites([characterId]);
    const result = await database().releaseConstPartyActivity({ characterId, playerId });
    if (!result.ok) return false;
    const states = accept(result);
    for (const state of states) retire(manager().findSessionById(state.characterId));
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    for (const state of states) coordinator.notifyState(state, { critical: true, reason: 'const_party_resumed' });
    return true;
}

async function prepareActivity(state, playerId) {
    state = life().cachedState(state.characterId) || state;
    const takeover = state.stats?.playerPartyTakeover;
    const partyId = state.party?.partyId || (Number(takeover?.playerId) === playerId ? takeover.partyId : null);
    if (partyId && invoke('GameServer/Bot/Population/HotPartyLifecycle').pending.has(partyId)) {
        throw Error('party_transition_pending');
    }
    const rows = partyId ? await database().execute(['SELECT memberIdsJson FROM bot_background_parties WHERE partyId=?', [partyId]]) : [];
    const ids = rows[0] ? JSON.parse(rows[0].memberIdsJson) : [state.characterId];
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    try {
        for (const id of ids) {
            const session = manager().findSessionById(id);
            if (session) stop(session);
            invoke('GameServer/Bot/BotTradeService').cleanup(session, 'const_party_invite');
            if (!await invoke('GameServer/AfkTrade/TradeMeetingService').prepareForPlayerParty(id)) throw Error('trade_cancellation_failed');
            if (session?.actor && !marker(session) && !await life().markHot(session, 'const_party_pause')) throw Error('activity_checkpoint_failed');
            const fence = await coordinator.fenceBot(id);
            if (!fence.ok && fence.reason !== 'worker_not_ready') throw Error('const_party_fence_failed');
        }
        await life().settleWrites(ids);
        const parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
        const party = partyId && parties.find(partyId);
        if (party?.status === 'hot') {
            const snapshot = invoke('GameServer/Bot/Population/HotPartyLifecycle')
                .snapshotForConstPause(party, manager().findSessionById(state.characterId));
            if (!await parties.createOrUpdate(snapshot)) throw Error('party_pause_snapshot_failed');
        }
        const selected = manager().findSessionById(state.characterId);
        const result = await database().pauseConstPartyActivity({ characterId: state.characterId, playerId,
            activity: selected?.plan === 'merchant' ? 'merchant' : undefined });
        if (!result.ok) throw Error(result.reason);
        const pausedStates = accept(result);
        for (const paused of pausedStates) {
            if (!paused.stats?.constPartySession?.active) {
                const session = manager().findSessionById(paused.characterId);
                if (session?.partyCompanion && session.followPlayerSession) {
                    invoke('GameServer/Bot/AI/PartyCompanionService').detach(session.followPlayerSession, session,
                        { source: 'const_party_pause', preserveConstActivity: true });
                }
                retire(session);
            }
            coordinator.notifyState(paused, { critical: true, reason: 'const_party_paused' });
        }
    } catch (error) {
        for (const id of ids) {
            const session = manager().findSessionById(id);
            if (session && !marker(session)) {
                session.constActivityPaused = false;
                session.actor?.automation?.replenishVitals?.(session.actor);
                ai().init(session);
            }
            const current = life().cachedState(id);
            if (current) coordinator.notifyState(current, { critical: true, reason: 'const_party_pause_failed' });
        }
        throw error;
    }
}

function prepare(state, playerId) {
    const key = state.party?.partyId || state.stats?.constPartySession?.groupId
        || state.stats?.playerPartyTakeover?.partyId || `bot:${state.characterId}`;
    return serialize(key, () => prepareActivity(state, playerId), preparations);
}

async function invite(player, actor, state, distribution) {
    const id = Number(state.characterId), playerId = Number(actor.fetchId());
    const companion = invoke('GameServer/Bot/AI/PartyCompanionService');
    const existing = manager().findSessionById(id);
    const alreadyJoined = companion.isActiveCompanion(existing, player);
    if (alreadyJoined && marker(existing)) {
        existing.constActivityPaused = false; existing.aiActive = true;
        ai().wakeup(existing, { urgent: true });
        return true;
    }
    const reservation = { constBotId: id };
    if (player.actor !== actor || (!alreadyJoined && !companion.reserveCapacity(player, reservation))) return false;
    let joined = false;
    try {
        // Moving a friend between player sessions keeps its first autonomous
        // checkpoint. The old leader must not resume it during this transfer.
        if (existing?.partyCompanion && existing.followPlayerSession && existing.followPlayerSession !== player) {
            companion.detach(existing.followPlayerSession, existing, { source: 'const_party_transfer', preserveConstActivity: true });
        }
        await prepare(state, playerId);
        if (player.actor !== actor) return false;
        const hot = manager().findSessionById(id);
        if (hot) { hot.constActivityPaused = false; hot.aiActive = true; }
        if (alreadyJoined) { joined = true; ai().wakeup(hot, { urgent: true }); return true; }
        joined = await invoke('GameServer/World/World').inviteBotByName(player, actor, state.name,
            distribution, 'friend_const', { constParty: true, capacityReservation: reservation });
        return joined;
    } finally {
        companion.releaseCapacity(player, reservation);
        if (!joined) {
            const checkpoint = life().cachedState(id)?.stats?.constPartySession;
            if (checkpoint) await release(id, checkpoint.playerId);
        }
    }
}

module.exports = {
    has: session => !!marker(session),
    isCurrent(player, subject) {
        const id = Number(subject?.actor?.fetchId?.() || subject?.characterId);
        const state = life().cachedState(id) || subject?.coldLifeState || subject;
        const checkpoint = state?.stats?.constPartySession;
        return checkpoint?.active === true && Number(checkpoint.playerId) === Number(player?.actor?.fetchId?.());
    },
    async prepareFormation(player, actor, bots, isCurrent = () => true) {
        if (player.actor !== actor || !bots.length) return;
        const ids = new Set(bots.map(bot => Number(bot.characterId || bot.botId)));
        const current = () => player.actor === actor && isCurrent();
        const playerId = Number(actor.fetchId()), prepared = new Set();
        const companion = invoke('GameServer/Bot/AI/PartyCompanionService');
        const rollback = async () => {
            for (const id of prepared) {
                const checkpoint = life().cachedState(id)?.stats?.constPartySession;
                if (!checkpoint || Number(checkpoint.playerId) !== playerId) continue;
                const session = manager().findSessionById(id);
                if (current() && companion.isActiveCompanion(session, player) && !session.constActivityPaused) continue;
                if (session?.followPlayerSession === player && session.partyCompanion) {
                    companion.detach(player, session, { source: 'const_formation_cancelled', preserveConstActivity: true,
                        rebuildWindow: false, refreshPanel: false });
                }
                await serialize(id, () => release(id, playerId));
            }
        };
        let complete = false;
        try {
            // Preserve an inherited autonomous roster before individually removing
            // companions outside the chosen const: individual detach releases its
            // old takeover ownership and would otherwise destroy that checkpoint.
            for (const id of ids) {
                const state = life().cachedState(id);
                if (Number(state?.stats?.playerPartyTakeover?.playerId) === playerId) {
                    if (!current()) return;
                    prepared.add(id);
                    await prepare(state, playerId);
                    if (!current()) return;
                }
            }
            if (!current()) return;
            const removed = companion.membersForLeader(player).filter(member => !ids.has(Number(member.actor?.fetchId?.())));
            for (const member of removed) companion.detach(player, member, { source: 'const_party_formation' });
            await Promise.all(removed.map(member => member.constPartyResumePromise).filter(Boolean));
            if (!current()) return;
            complete = true;
            return { rollback };
        } finally { if (!complete) await rollback(); }
    },
    resume(session) {
        if (session?.constPartyResumePromise) return session.constPartyResumePromise;
        const saved = marker(session), id = Number(session?.actor?.fetchId?.());
        if (!saved || !id) return null;
        const promise = serialize(id, () => release(id, saved.playerId, session)).catch(error => {
            utils.infoWarn('ConstParty', 'resume failed for %s: %s', id, error.message);
            return false;
        }).finally(() => { if (session.constPartyResumePromise === promise) session.constPartyResumePromise = null; });
        session.constPartyResumePromise = promise;
        return promise;
    },
    invite(player, actor, state, distribution) {
        return serialize(Number(state.characterId), () => invite(player, actor, state, distribution));
    }
};

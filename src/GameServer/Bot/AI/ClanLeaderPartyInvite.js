const pending = new Map();
const Life = () => invoke('GameServer/Bot/Population/BotLifeState');
const Manager = () => invoke('GameServer/Bot/BotManager');

function isLeaderFor(playerSession, subject) {
    const player = playerSession?.actor, clanId = Number(player?.fetchClanId?.() || 0);
    if (!clanId) return false;
    const clan = invoke('GameServer/Clan/ClanService').findById(clanId);
    if (Number(clan?.leaderId) !== Number(player.fetchId())) return false;
    const bot = subject?.actor || (subject?.fetchId ? subject : null);
    return bot ? Number(bot.fetchClanId?.()) === clanId
        : !!clan.members?.some(member => Number(member.id) === Number(subject?.characterId));
}

function stop(session) {
    if (!session?.actor) return;
    invoke('GameServer/Bot/BotAI').stop(session);
    invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, session.actor);
    session.actor.attack?.abortCast?.(session, session.actor);
    session.actor.attack?.clearTimers?.();
    session.actor.automation?.abortAll?.(session.actor);
    session.actor.automation?.stopReplenish?.();
    invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, session.actor);
}

async function invite(player, actor, subject, distribution, source, id) {
    const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
    const current = () => player.actor === actor && isLeaderFor(player, Manager().findSessionById(id) || Life().cachedState(id) || subject);
    let session = Manager().findSessionById(id);
    if (!current()) return false;
    const alreadyJoined = Companion.isActiveCompanion(session, player);
    const reservation = { clanBotId: id };
    if (!alreadyJoined && !Companion.reserveCapacity(player, reservation)) {
        player.dataSendToMe(invoke('GameServer/Network/Response').joinParty(0));
        if (subject?.actor) Manager().botTell(subject, player, 'Your party is full. Make room, then call me again.');
        return false;
    }
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const HotParty = invoke('GameServer/Bot/Population/HotPartyLifecycle');
    const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
    const Pvp = invoke('GameServer/Bot/Population/PvpEncounterRuntime');
    let lockedParty = null, lockedEncounter = null, releaseActivations = null, joined = false, claimedActivity = false;
    const stopped = new Set(), fenced = new Set();
    try {
        const Const = invoke('GameServer/Bot/AI/ConstPartySession');
        let state = Life().cachedState(id) || await Life().findByName(subject?.actor?.fetchName?.() || subject.name);
        if (!current() || !state) return false;
        const deadline = Date.now() + 15000;
        let party, ids;
        // Let an already-running handoff finish, then take its freshly
        // published actor/roster. Hold all its lifecycle owners before yielding.
        while (true) {
            if (!current()) return false;
            state = Life().cachedState(id) || state;
            const partyId = state.party?.partyId || state.stats?.constPartySession?.groupId || state.stats?.playerPartyTakeover?.partyId;
            party = partyId && Parties.find(partyId);
            ids = party?.memberIds || [id];
            const encounter = Pvp.snapshot(state);
            const activationIds = [...new Set([...ids, ...(encounter ? Pvp.ids(encounter) : [])])];
            const busy = partyId && HotParty.pending.has(partyId) || encounter && Pvp.pending.has(encounter.key);
            if (!busy) releaseActivations = HotActivation.holdForPlayerInvite(activationIds);
            if (releaseActivations) {
                if (partyId) { HotParty.pending.add(partyId); lockedParty = partyId; }
                if (encounter) { Pvp.pending.add(encounter.key); lockedEncounter = encounter.key; }
                session = Manager().findSessionById(id);
                break;
            }
            if (Date.now() >= deadline) throw Error('party_transition_pending');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        for (const memberId of ids) {
            const member = Manager().findSessionById(memberId);
            if (member) { stop(member); stopped.add(member); }
        }
        invoke('GameServer/Bot/BotTradeService').cleanup(session, 'clan_leader_invite');
        if (!await invoke('GameServer/AfkTrade/TradeMeetingService').prepareForPlayerParty(id)) throw Error('trade_cancellation_failed');
        for (const memberId of ids) {
            const member = Manager().findSessionById(memberId);
            if (member?.actor && !Const.has(member) && !await Life().markHot(member, 'clan_leader_invite')) throw Error('activity_checkpoint_failed');
            fenced.add(memberId);
            const fence = await Coordinator.fenceBot(memberId);
            if (!fence.ok && fence.reason !== 'worker_not_ready') throw Error(fence.reason);
        }
        await Life().settleWrites(ids);
        if (!current()) return false;
        if (party?.status === 'hot') HotParty.pauseForPlayerInvite(party, session);
        const claimed = await invoke('Database').claimBotForClanLeader({ characterId: id, playerId: Number(actor.fetchId()),
            expectedMembers: ids, expectedRevision: Number(Life().cachedState(id)?.simulation?.revision || 0),
            expectedPartyId: party?.partyId || null, expectedPartyRevision: party?.revision ?? null, expectedPartyStatus: party?.status || null,
            partyMinSize: invoke('GameServer/Bot/Population/PopulationConfig').partyMinSize, isCurrent: current });
        if (!claimed.ok) throw Error(claimed.reason);
        claimedActivity = true;
        if (claimed.party) Parties.acceptRow(claimed.party);
        for (const inventory of claimed.inventories) invoke('GameServer/AfkTrade/AfkTradeService').syncOnlineInventory(inventory.characterId, inventory.items);
        for (const row of claimed.rows) {
            const saved = Life().acceptLifecycleRow(row), member = Manager().findSessionById(saved.characterId);
            if (!member) continue;
            member.coldLifeState = saved;
            member.hotBackgroundPartyId = saved.party?.partyId || null;
            if (saved.characterId === id || !member.hotBackgroundPartyId) {
                member.hotCompetitionCommit = null;
                member.backgroundHuntTarget = null;
                member.backgroundSearchDestination = null;
                member.currentTargetId = undefined;
                member.incomingThreatId = undefined;
                member.actor?.unselect?.();
                if (!saved.spotId) member.currentSpot = null;
            }
        }
        session = Manager().findSessionById(id);
        if (session) {
            if (session.followPlayerSession && session.followPlayerSession !== player) Companion.detach(session.followPlayerSession, session,
                { source: 'clan_leader_invite', preserveTakeover: true, preserveConstActivity: true });
            const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
            TownTravel.clearCombatTrip(session);
            TownTravel.revealSupplyErrand(session, session.actor, { clearErrand: true });
            for (const key of ['supplyErrandPhase', 'companionShopping', 'clanAllianceQuest', 'coldMarketState', 'coldCraftState',
                'spotRelocation', 'townTravel', 'resumeAfterBuff', 'preBuffPlan', 'preBuffLocation', 'shoppingTarget',
                'resumeAfterShopping', 'preShopLocation', 'pvpEncounter', 'pvpRevenge', 'pendingPvpProvocation']) session[key] = null;
            session.constActivityPaused = false;
            session.aiActive = true;
        }
        require('../../World/PartyMembershipPublication')([...stopped], invoke);
        joined = await invoke('GameServer/World/World').inviteBotByName(player, actor,
            state.name, distribution, source, { clanLeaderPrepared: true, capacityReservation: reservation });
        return joined;
    } catch (error) {
        utils.infoWarn('BotParty', 'clan leader invite failed for %s: %s', id, error.message);
        if (player.actor === actor) player.dataSendToMe(invoke('GameServer/Network/Response').actionFailed());
        return false;
    } finally {
        try {
            if (claimedActivity && !joined && !Manager().findSessionById(id)) {
                const state = Life().cachedState(id);
                if (state?.phase === 'hot') await Life().upsertState({ ...state, phase: 'cold',
                    timing: { ...state.timing, nextResolveAt: Date.now() + 1000 } }, 'clan_invite_cancelled', { releaseHot: true });
            }
        } finally {
            if (lockedParty) HotParty.pending.delete(lockedParty);
            if (lockedEncounter) Pvp.pending.delete(lockedEncounter);
            releaseActivations?.();
            Companion.releaseCapacity(player, reservation);
            for (const memberId of fenced) Coordinator.releaseFence(memberId);
            for (const member of stopped) {
                if (!member.actor || member.constActivityPaused) continue;
                member.aiActive = true;
                member.actor.refreshVitalsRegeneration?.();
                invoke('GameServer/Bot/BotAI').wakeup(member, { urgent: true });
            }
        }
    }
}

module.exports = {
    isLeaderFor,
    request(player, actor, subject, distribution, source) {
        const state = subject?.coldLifeState || subject;
        const id = Number(subject?.actor?.fetchId?.() || state.characterId);
        const key = subject?.hotBackgroundPartyId || state.party?.partyId || state.stats?.constPartySession?.groupId
            || state.stats?.playerPartyTakeover?.partyId || `bot:${subject?.actor?.fetchId?.() || state.characterId}`;
        const keys = [...new Set([key, `bot:${subject?.actor?.fetchId?.() || state.characterId}`])];
        const run = Promise.all(keys.map(key => (pending.get(key) || Promise.resolve()).catch(() => {})))
            .then(() => invite(player, actor, subject, distribution, source, id));
        keys.forEach(key => pending.set(key, run));
        return run.finally(() => { for (const key of keys) if (pending.get(key) === run) pending.delete(key); });
    }
};

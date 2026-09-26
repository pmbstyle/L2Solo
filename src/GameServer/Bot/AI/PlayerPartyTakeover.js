const PartyRewardMath = invoke('GameServer/Actor/PartyRewardMath');

const pending = new Map();
const RECENT_ABANDON_MS = 5 * 60 * 1000;

function isJoinRequest(text) {
    return /\b(?:can|could|may)\s+i\s+join(?:\s+(?:you\s+guys|you|(?:your|the|this)\s+(?:party|group|team)))?\b|\b(?:let|add|take|invite)\s+me\s+(?:join|into|to)\s+(?:your|the|this)\s+(?:party|group|team)\b|\bcan\s+i\s+party\s+with\s+you\b/i.test(String(text || ''));
}

function actorId(subject) {
    return Number(subject?.actor?.fetchId?.() || subject?.characterId || subject?.id || 0);
}

function playerLocation(playerSession) {
    const actor = playerSession?.actor;
    if (!actor) return null;
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function partyIdFor(target) {
    return String(target?.hotBackgroundPartyId || target?.party?.partyId
        || target?.coldLifeState?.party?.partyId || '');
}

function rejection(reason, extra = {}) {
    const replies = {
        player_unavailable: 'I cannot add you while you are dead or offline.',
        player_party_not_empty: 'You already have a bot party. Make room before taking over our group.',
        target_not_in_autonomous_party: 'I am not in an autonomous party you can join.',
        party_not_available: 'Our party is not available anymore.',
        invalid_party_roster: 'Our roster is not in a safe state to hand over.',
        party_roster_changed: 'Our roster changed while we were deciding. Ask again.',
        party_member_unavailable: 'One of us is unavailable, so we cannot hand over the party safely.',
        party_member_already_attached: 'One of us already joined another leader.',
        party_special_operation: 'We are committed to a special operation and cannot change leaders now.',
        party_busy: 'We are in the middle of a special operation. Ask again later.',
        level_mismatch: 'The level spread is too wide for everyone to share experience, so we will pass.',
        relationship_hostile: 'Someone in the party does not trust you enough to accept.',
        recently_abandoned: 'Someone in the party remembers being abandoned. Not this time.',
        activation_failed: 'We agreed, but the whole party could not reach you safely.',
        party_changed: 'The party changed while we were deciding. Ask again.',
        member_changed: 'One of us changed state while we were deciding. Ask again.',
        party_membership_changed: 'Our roster changed while we were deciding. Ask again.',
        persistence_failed: 'We could not transfer party ownership safely. Ask again in a moment.'
    };
    return {
        ok: false,
        applied: false,
        reason,
        reply: replies[reason] || 'We cannot accept you into this party right now.',
        ...extra
    };
}

function sameClanParty(playerSession, memberIds) {
    const clanId = Number(playerSession?.actor?.fetchClanId?.() || 0);
    if (!clanId) return false;
    const clan = invoke('GameServer/Clan/ClanService').findById(clanId);
    const clanMembers = new Set((clan?.members || []).map((member) => Number(member.id)));
    return memberIds.every((id) => clanMembers.has(Number(id)));
}

function activeCompetition(stats, timestamp = Date.now()) {
    const wait = stats?.coldCompetition?.wait;
    if (!wait) return false;
    const until = Number(wait.until || 0);
    return until <= 0 || until > timestamp;
}

function specialOperation(party, states) {
    const stats = party?.stats || {};
    const objective = stats.objective || {};
    if (stats.travel || stats.pvpEncounter || activeCompetition(stats) || stats.raidEncounter
        || stats.clanOperation || objective.sourceKind === 'raid' || objective.raidBossTemplateId
        || objective.kind === 'raid' || objective.kind === 'pvp') return true;
    return states.some((state) => {
        const member = state?.stats || {};
        return member.travel || member.pvpEncounter || activeCompetition(member) || member.supplyErrand
            || member.warehouseWorkflow || member.marketStore || member.craftShop
            || ['dead', 'merchant', 'crafting', 'shopping', 'traveling', 'pk_hunting'].includes(state?.activity);
    });
}

async function evaluate(playerSession, party, states) {
    const actor = playerSession?.actor;
    if (!actor || actor.fetchIsOnline?.() === false || actor.isDead?.()) {
        return rejection('player_unavailable');
    }
    const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
    if (Companion.membersForLeader(playerSession).length > 0) {
        return rejection('player_party_not_empty');
    }
    const ids = (party?.memberIds || []).map(Number);
    if (!['active', 'hot'].includes(party?.status)) return rejection('party_not_available');
    if (ids.length < 2 || ids.length > Companion.MAX_COMPANIONS || new Set(ids).size !== ids.length) {
        return rejection('invalid_party_roster');
    }
    if (states.length !== ids.length || states.some((state) => !state || !ids.includes(Number(state.characterId))
        || state.party?.partyId !== party.partyId || Number(state.vitals?.hp || 0) <= 0)) {
        return rejection('party_roster_changed');
    }
    if (specialOperation(party, states)) return rejection('party_busy');

    const clanmate = sameClanParty(playerSession, ids);
    if (!clanmate) {
        const playerLevel = Number(actor.fetchLevel?.() || 1);
        const levels = [...states.map((state) => Number(state.level || 1)), playerLevel];
        if (PartyRewardMath.validMemberIndexes(levels).length !== levels.length) {
            return rejection('level_mismatch', { levels });
        }

        const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
        await InteractionMemory.ensureMany(ids);
        await Promise.all(states.map((state) => BotSocialMemory.load(playerSession, state)));
        for (const state of states) {
            const hotSession = invoke('GameServer/Bot/BotManager').findSessionById(Number(state.characterId));
            const availability = hotSession?.actor
                ? BotAvailability.evaluate(playerSession, hotSession, { loadMemory: false })
                : BotAvailability.evaluateState(playerSession, state, { loadMemory: false });
            if (availability.relationshipReason === 'relationship_hostile' || Number(availability.memory?.trust || 0) <= -6) {
                return rejection('relationship_hostile', { refusingMemberId: state.characterId });
            }
            if (availability.memory?.recentlyAbandonedAt
                && Date.now() - Number(availability.memory.recentlyAbandonedAt) < RECENT_ABANDON_MS) {
                return rejection('recently_abandoned', { refusingMemberId: state.characterId });
            }
        }
    }
    return { ok: true, reason: clanmate ? 'same_clan' : 'party_accepts', clanmate };
}

function sessionsForParty(party) {
    const Manager = invoke('GameServer/Bot/BotManager');
    return party.memberIds.map((memberId) => Manager.findSessionById(Number(memberId)));
}

async function loadStates(party) {
    if (!party?.memberIds?.length) return [];
    return invoke('GameServer/Bot/Population/BotLifeState').statesByIds(party.memberIds);
}

async function perform(playerSession, target, source) {
    const partyId = partyIdFor(target);
    if (!partyId) return rejection('target_not_in_autonomous_party');
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Companion = invoke('GameServer/Bot/AI/PartyCompanionService');
    let party = Parties.find(partyId);
    let states = await loadStates(party);
    let policy = await evaluate(playerSession, party, states);
    if (!policy.ok) return policy;

    if (party.status === 'active') {
        const activation = await invoke('GameServer/Bot/Population/HotPartyLifecycle').activate(
            partyId,
            'player_party_takeover',
            { playerLoc: playerLocation(playerSession), forceNearPlayer: true, raidFanout: false }
        );
        if (!activation?.ok) return rejection('activation_failed', { detail: activation?.reason || null });
    }

    await Life.settleWrites(party.memberIds);
    party = Parties.find(partyId);
    states = await loadStates(party);
    policy = await evaluate(playerSession, party, states);
    if (!policy.ok) return policy;
    if (party.status !== 'hot') return rejection('party_changed');

    const sessions = sessionsForParty(party);
    const runtimeValidation = Companion.canAttachRoster(playerSession, sessions, {
        expectedBackgroundPartyId: partyId
    });
    if (!runtimeValidation.ok) return rejection(runtimeValidation.reason);

    const persisted = await invoke('Database').takeOverBackgroundParty({
        partyId,
        expectedUpdatedAt: party.updatedAt,
        playerId: actorId(playerSession),
        source,
        members: states.map((state) => ({
            characterId: state.characterId,
            expectedRevision: Number(state.simulation?.revision || 0),
            expectedUpdatedAt: state.updatedAt
        }))
    });
    if (!persisted?.ok) return rejection(persisted?.reason || 'persistence_failed');

    const acceptedParty = Parties.acceptRow(persisted.party);
    const acceptedStates = persisted.rows.map((row) => Life.acceptLifecycleRow(row));
    const attached = Companion.attachRoster(playerSession, sessions, {
        expectedBackgroundPartyId: partyId,
        lifeStates: acceptedStates,
        distribution: 1
    });
    if (!attached.ok) {
        utils.infoWarn('BotParty', 'persisted party takeover could not attach runtime roster party=%s reason=%s', partyId, attached.reason);
        return rejection('persistence_failed');
    }

    const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
    sessions.forEach((session) => Social.recordEvent(playerSession, session, 'party_formed', source));
    console.info('BotParty :: player %s took over party %s members=%d source=%s',
        playerSession.actor.fetchName?.() || actorId(playerSession), partyId, sessions.length, source);
    return {
        ok: true,
        applied: true,
        reason: policy.clanmate ? 'same_clan_party_taken_over' : 'party_taken_over',
        reply: policy.clanmate
            ? 'Of course. Clan comes first—you are leading now.'
            : 'All right. You are leading now; let us keep moving.',
        partyId: acceptedParty.partyId,
        count: sessions.length,
        clanmate: policy.clanmate
    };
}

function request({ playerSession, target, source = 'player_request' } = {}) {
    const partyId = partyIdFor(target);
    if (!partyId) return Promise.resolve(rejection('target_not_in_autonomous_party'));
    const current = pending.get(partyId) || Promise.resolve();
    const run = current.catch(() => {}).then(() => perform(playerSession, target, source))
        .catch((error) => {
            utils.infoWarn('BotParty', 'party takeover failed party=%s: %s', partyId, error.message || error);
            return rejection('persistence_failed');
        });
    pending.set(partyId, run);
    return run.finally(() => {
        if (pending.get(partyId) === run) pending.delete(partyId);
    });
}

function restorationTarget(playerSession, companionSessions = []) {
    const playerId = actorId(playerSession);
    if (!playerId || companionSessions.length < 2) return null;
    const records = companionSessions.map((session) => session?.coldLifeState?.stats?.playerPartyTakeover);
    const partyId = String(records[0]?.partyId || '');
    if (!partyId || records.some((record) => (
        String(record?.partyId || '') !== partyId || Number(record?.playerId || 0) !== playerId
    ))) return null;
    return { partyId, playerId };
}

async function restoreAutonomousParty({ partyId, playerId, companionSessions = [], source = 'player_party_released' } = {}) {
    const ids = companionSessions.map((session) => actorId(session)).filter(Boolean);
    if (ids.length) await invoke('GameServer/Bot/Population/BotLifeState').settleWrites(ids);
    const restored = await invoke('Database').restoreTakenOverBackgroundParty({ partyId, playerId, source });
    if (!restored?.ok) return restored || { ok: false, reason: 'party_restore_failed' };

    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const party = Parties.acceptRow(restored.party);
    const states = restored.rows.map((row) => Life.acceptLifecycleRow(row));
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    states.filter((state) => state.phase === 'cold').forEach((state) => {
        Coordinator.markDirty?.(state, { reason: 'player_party_restored', critical: true });
    });
    const statesById = new Map(states.map((state) => [Number(state.characterId), state]));
    companionSessions.forEach((session) => {
        const id = actorId(session);
        const state = statesById.get(id);
        if (!state) return;
        session.coldLifeState = state;
        session.hotBackgroundPartyId = state.phase === 'hot' ? party.partyId : null;
        session.plan = state.phase === 'hot' ? 'hunting' : session.plan;
        if (state.phase === 'hot' && session.actor) {
            invoke('GameServer/Bot/BotAI').wakeup(session, { urgent: true });
        }
    });
    console.info('BotParty :: restored autonomous party %s members=%d source=%s',
        party.partyId, party.memberIds.length, source);
    return { ok: true, reason: 'autonomous_party_restored', party, states };
}

module.exports = {
    request,
    evaluate,
    isJoinRequest,
    partyIdFor,
    activeCompetition,
    restorationTarget,
    restoreAutonomousParty,
    pending
};

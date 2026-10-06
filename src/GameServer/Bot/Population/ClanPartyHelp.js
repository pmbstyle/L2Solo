const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ClanService = invoke('GameServer/Clan/ClanService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');

const TTL_MS = 10 * 60000;
const RETRY_MS = 30000;
const pending = new Map();
const pendingListeners = new Set();

function listeners(clanId) {
    return (invoke('GameServer/World/World').user?.sessions || []).some(session =>
        session.accountId && !String(session.accountId).startsWith('bot_')
        && session.socket && typeof session.socket.write === 'function'
        && session.actor?.fetchIsOnline?.() !== false
        && Number(session.actor?.fetchClanId?.()) === Number(clanId));
}

function request(characterId, clanId, now = Date.now()) {
    if (!listeners(clanId) || Config.clanChatEnabled === false) return false;
    if (pending.has(characterId)) return false;
    if (pending.size >= 64) return false;
    pending.set(characterId, { characterId, clanId, expiresAt: now + TTL_MS, nextAt: now });
    for (const listener of pendingListeners) {
        try { listener(); } catch (error) { utils.infoWarn('BotParty', 'help event failed: %s', error?.message || error); }
    }
    return true;
}

function available(state, grouped = false, requestingHelp = false) {
    return state?.phase === 'cold' && !Identity.isStaticService(state)
        && String(state.simulation?.ownerId || 'legacy_main') === 'legacy_main'
        && ['hunting', 'resting', 'party_wait', ...(grouped ? ['grouped'] : [])].includes(state.activity)
        && Number(state.vitals?.hp || 0) > 0
        && !state.stats?.coldCompetition?.wait && !state.stats?.pvpEncounter && !state.stats?.travel
        && (requestingHelp || state.stats?.equipmentPlan?.requiresParty !== true
            && state.stats?.equipmentPlan?.partyNeed !== 'required')
        && !state.stats?.clanPartyObjective?.clanGoalKey
        && !state.stats?.equipmentPlan?.clanGoal
        && !state.stats?.partyRequest?.clanGoalKey
        && (requestingHelp || state.stats?.partyRequest?.priority !== 'required')
        && (grouped || !state.party?.partyId && !state.partyId);
}

function safeSpot(members, spotId, now, party = null) {
    const spot = Spots.findById(spotId);
    if (!spot || party && require('./PartySpotRiskPolicy').backoff(party, spotId, now)) return false;
    return members.every(member => Number(spot.minLevel) <= Number(member.level)
        && Number(spot.maxLevel) >= Number(member.level) - 4);
}

// One request, one clan (at most 64 members), once per retry interval. Called
// under the population membership lock, never from the chat delivery stack.
async function processOne({ commit, create, release }, now = Date.now()) {
    for (const [id, entry] of pending) {
        if (entry.expiresAt <= now || !listeners(entry.clanId)) pending.delete(id);
    }
    if (Config.clanChatEnabled === false) { pending.clear(); return null; }
    const entry = [...pending.values()].find(value => value.nextAt <= now);
    if (!entry) return null;
    entry.nextAt = now + RETRY_MS;
    const clan = ClanService.findById(entry.clanId);
    const ids = new Set((clan?.members || []).map(member => Number(member.id)));
    if (!ids.has(entry.characterId)) { pending.delete(entry.characterId); return null; }
    const rows = await LifeState.statesByIds([entry.characterId, ...[...ids].filter(id => id !== entry.characterId)],
        { ownerId: 'legacy_main', excludeReserved: true });
    const requester = rows.find(state => Number(state.characterId) === entry.characterId);
    const duty = require('./ClanPartyDuty').objective(requester)
        || Parties.find(requester?.party?.partyId)?.stats?.objective;
    if (duty?.clanGoalKey && Number(duty.clanId) === Number(entry.clanId)) {
        const helped = await require('./ClanPartyRescue').rescue({ requester, objective: duty, rows, entry,
            commit, create, release, listeners, now });
        if (helped) pending.delete(entry.characterId);
        return helped;
    }
    if (!available(requester, false, true)) return null; // Recovery/hot ownership may finish before TTL.
    const stillValid = members => listeners(entry.clanId) && members.every(state =>
        ClanService.findById(entry.clanId)?.members?.some(member => Number(member.id) === Number(state.characterId)));
    const finish = (party, helper) => {
        if (!party?.memberIds?.map(Number).includes(entry.characterId)) return null;
        pending.delete(entry.characterId);
        invoke('GameServer/Bot/AI/BotClanChat').onPartyHelp(helper, requester, party, entry.clanId);
        return party;
    };
    const parties = Parties.active().filter(party => ids.has(Number(party.leaderId))
        && party.memberIds.length < Number(Config.partyMaxSize || 5)
        && party.memberIds.every(id => ids.has(Number(id)))
        && !party.stats?.objective?.clanGoalKey && !party.stats?.travel
        && !party.stats?.acquisitionGoal?.clanGoal).slice(0, 8);
    for (const party of parties) {
        const members = await LifeState.statesForParty(party.partyId);
        if (members.length !== party.memberIds.length || !members.every(member =>
            available(member, true) && member.party?.partyId === party.partyId
            && party.memberIds.map(Number).includes(Number(member.characterId)))) continue;
        if (!Composition.selectRecruits(members, [requester], { maxSize: Config.partyMaxSize }).length
            || !safeSpot([...members, requester], party.spotId, now, party)
            || !stillValid([...members, requester])) continue;
        const next = { ...party, memberIds: [...party.memberIds, requester.characterId],
            roleCoverage: Composition.roleCoverage([...members, requester]),
            stats: { ...party.stats, memberNames: [...members, requester].map(member => member.name),
                lastRecruitAt: now, clanHelp: { until: now + TTL_MS,
                    memberIds: [...members, requester].map(member => member.characterId) } } };
        const result = await commit(next, [...members, requester], {
            characterId: party.leaderId, eventType: 'party_recruit',
            summary: `Clan party helped ${requester.name}`,
            meta: { partyId: party.partyId, recruitIds: [requester.characterId], reason: 'clan_help' },
            weight: 2, createdAt: now
        });
        return result?.party && !result.failed?.length
            ? finish(result.party, members.find(member => Number(member.characterId) === Number(party.leaderId))) : null;
    }
    const helpers = rows.filter(state => state.characterId !== requester.characterId && available(state))
        .sort((a, b) => Math.abs(a.level - requester.level) - Math.abs(b.level - requester.level));
    for (const helper of helpers) {
        const members = [helper, requester];
        if (!Composition.selectRecruits([helper], [requester], { maxSize: 2 }).length) continue;
        // A new group evaluates the hunt afresh; personal backoffs describe
        // solo capability. Normal party travel does assembly.
        const spotId = [helper.spotId, requester.spotId].find(id => safeSpot(members, id, now));
        if (!spotId || !stillValid(members)) continue;
        const party = await create(members, { status: 'open', priority: 'preferred',
            reason: 'clan_help', objectiveKey: `clan_help:${entry.clanId}:${spotId}`,
            spotId, clanId: entry.clanId });
        return finish(party, helper);
    }
    return null;
}

module.exports = { request, processOne, hasPending: () => pending.size > 0,
    nextDeadline() {
        let next = Infinity;
        for (const request of pending.values()) next = Math.min(next, request.nextAt, request.expiresAt);
        return Number.isFinite(next) ? next : 0;
    },
    subscribePending(listener) { if (typeof listener !== 'function') throw new TypeError('invalid_party_help_listener'); pendingListeners.add(listener); return () => pendingListeners.delete(listener); },
    reset() { pending.clear(); }, TTL_MS, RETRY_MS };

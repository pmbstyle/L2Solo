const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ClanService = invoke('GameServer/Clan/ClanService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');

// A plea is answered as a C4 clanmate answers the clan chat: tried when it is
// heard, and again only when the answer can change: a clan member turns free
// (its published row or its help party's, observe) while the requester is ready,
// or the requester's own readiness moves to ready. The TTL is the plea's deadline
// (dropped when next looked at), never a retry clock; MAX_TRIES bounds the tries
// a plea's members can wake (a pair that never fits one spot), counted when hit.
const TTL_MS = 10 * 60000;
const MAX_TRIES = 16;
const pending = new Map();
const pendingListeners = new Set();
const clanOf = state => Number(state?.stats?.clanId ?? state?.clanId ?? 0);

function notify() {
    for (const listener of pendingListeners) {
        try { listener(); } catch (error) { invoke('FailureLog').note('clan.help_listener', error); }
    }
}

function prune(now) {
    for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id);
}

function listeners(clanId) {
    return (invoke('GameServer/World/World').user?.sessions || []).some(session =>
        session.accountId && !String(session.accountId).startsWith('bot_')
        && session.socket && typeof session.socket.write === 'function'
        && session.actor?.fetchIsOnline?.() !== false
        && Number(session.actor?.fetchClanId?.()) === Number(clanId));
}

function request(characterId, clanId, now = Date.now()) {
    if (!listeners(clanId) || Config.clanChatEnabled === false) return false;
    prune(now);
    if (pending.has(characterId)) return false;
    if (pending.size >= 64) return false;
    // free: the members seen free (published rows, free()); ready: the requester's readiness.
    pending.set(characterId, { characterId, clanId, expiresAt: now + TTL_MS, due: true, tries: 0, duty: null, free: new Set(), ready: null });
    notify();
    return true;
}

function available(state, grouped = false, requestingHelp = false) {
    return state?.phase === 'cold' && !Identity.isStaticService(state)
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

function dutyOf(requester, clanId) {
    const duty = require('./ClanPartyDuty').objective(requester)
        || Parties.find(requester?.party?.partyId)?.stats?.objective;
    return duty?.clanGoalKey && Number(duty.clanId) === Number(clanId) ? duty : null;
}
// A clan help party that could take one more member (its members' clan is checked at the try).
function openHelpParty(party) {
    return party?.status === 'active' && party.memberIds.length < Number(Config.partyMaxSize || 5)
        && !party.stats?.objective?.clanGoalKey && !party.stats?.travel && !party.stats?.acquisitionGoal?.clanGoal;
}
// A member who could answer this plea now, read from its published row: a clan
// duty's rescue, or a plain helper alone or grouped in a help party that has room.
function free(state, entry) {
    if (!state) return false;
    if (entry.duty) return require('./ClanPartyRescue').eligible(state, entry.duty);
    return available(state) || available(state, true)
        && openHelpParty(Parties.find(state.party?.partyId || state.partyId));
}
function readiness(requester, entry) {
    const duty = dutyOf(requester, entry.clanId);
    const ready = duty ? require('./ClanPartyRescue').eligible(requester, duty) : available(requester, false, true);
    return `${duty?.clanGoalKey || ''}:${ready}`;
}

// A published row of a bot (LifeState publications; null: it left the cache): a
// clan member of a pending plea turning free while its requester is ready, or the
// requester's readiness moving to ready, makes the plea due; nothing else does. An
// expired plea is dropped here. Nothing pending: one size check per publication.
function observe(characterId, state, now = Date.now()) {
    if (!pending.size) return false;
    const id = Number(characterId), clanId = clanOf(state);
    let woke = false;
    for (const entry of pending.values()) {
        if (entry.expiresAt <= now) { pending.delete(entry.characterId); continue; }
        if (entry.characterId === id) {
            const ready = state ? readiness(state, entry) : null;
            if (ready !== entry.ready && ready?.endsWith(':true') && !entry.due) entry.due = woke = true;
            entry.ready = ready;
        } else if (entry.clanId !== clanId || !free(state, entry)) entry.free.delete(id);
        else if (!entry.free.has(id)) {
            entry.free.add(id);
            if (!entry.due && entry.ready?.endsWith(':true')) entry.due = woke = true;
        }
    }
    if (woke) notify();
    return woke;
}

// A published party (BackgroundPartyState): its arrival, a member leaving or its
// end changes whether its members can take the requester in; each member is
// judged again from its published row (observe).
function observeParty(party, now = Date.now()) {
    if (!pending.size || !party) return false;
    let woke = false;
    for (const memberId of party.memberIds || []) woke = observe(memberId, LifeState.cachedState(memberId), now) || woke;
    return woke;
}

// One request, one clan (at most 64 members), tried once per due (observe), at
// most MAX_TRIES times. Called under the population membership lock, never from
// the chat delivery stack.
async function processOne(writers, now = Date.now()) {
    prune(now);
    for (const [id, entry] of pending) if (!listeners(entry.clanId)) pending.delete(id);
    if (Config.clanChatEnabled === false) { pending.clear(); return null; }
    let entry = null;
    for (const value of pending.values()) if (value.due) { entry = value; break; }
    if (!entry) return null;
    entry.due = false;
    const helped = await tryPlea(entry, writers, now);
    if (!helped && pending.get(entry.characterId) === entry && ++entry.tries >= MAX_TRIES) {
        pending.delete(entry.characterId);
        invoke('FailureLog').note('clan.help_tries', new Error(`clan plea of ${entry.characterId} dropped after ${MAX_TRIES} tries`));
    }
    return helped;
}

async function tryPlea(entry, { commit, create, release }, now) {
    const clan = ClanService.findById(entry.clanId);
    const ids = new Set((clan?.members || []).map(member => Number(member.id)));
    if (!ids.has(entry.characterId)) { pending.delete(entry.characterId); return null; }
    const rows = await LifeState.statesByIds([entry.characterId, ...[...ids].filter(id => id !== entry.characterId)],
        { excludeReserved: true });
    const requester = rows.find(state => Number(state.characterId) === entry.characterId);
    const duty = dutyOf(requester, entry.clanId);
    // What this try saw, from the published rows observe reads: only a member
    // turning free since, or the requester's readiness moving, makes it due again.
    entry.duty = duty;
    entry.free = new Set();
    for (const id of ids) if (id !== entry.characterId && free(LifeState.cachedState(id), entry)) entry.free.add(id);
    entry.ready = requester ? readiness(requester, entry) : null;
    if (duty) {
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
    const parties = Parties.activeByLeaders(ids, 'clan_party_help').filter(party => openHelpParty(party)
        && party.memberIds.every(id => ids.has(Number(id)))).slice(0, 8);
    for (const party of parties) {
        const members = await LifeState.statesForParty(party.partyId);
        if (members.length !== party.memberIds.length || !members.every(member =>
            available(member, true) && member.party?.partyId === party.partyId
            && party.memberIds.map(Number).includes(Number(member.characterId)))) continue;
        if (!Composition.selectRecruits(members, [requester], { maxSize: Config.partyMaxSize }).length
            || !safeSpot([...members, requester], party.spotId, now, party)
            || !stillValid([...members, requester])) continue;
        const next = { ...party, memberIds: [...party.memberIds, requester.characterId],
            roleCoverage: Composition.roleCoverage([...members, requester]) };
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

function hasDue() {
    for (const entry of pending.values()) if (entry.due) return true;
    return false;
}

module.exports = { request, processOne, observe, observeParty, hasDue,
    subscribePending(listener) { if (typeof listener !== 'function') throw new TypeError('invalid_party_help_listener'); pendingListeners.add(listener); return () => pendingListeners.delete(listener); },
    reset() { pending.clear(); }, TTL_MS, MAX_TRIES };

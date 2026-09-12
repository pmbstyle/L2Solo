const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
const World = invoke('GameServer/World/World');
const pending = new Set();
const id = session => Number(session?.actor?.fetchId?.());

function ready(party, states) {
    return party?.status === 'active' && states && !party.stats?.travel
        && states.every(s => s.phase === 'cold' && s.accountName && ['grouped', 'hunting', 'resting'].includes(s.activity)
            && !(s.stats?.coldCompetition?.wait?.combat && s.stats.coldCompetition.wait.until > Date.now())
            && !s.stats?.travel && !s.stats?.supplyErrand && !s.stats?.warehouseWorkflow && s.vitals.hp > 0);
}

function members(party) {
    const ids = party?.memberIds || [];
    if (ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length || !ids.includes(party.leaderId)) return null;
    const states = ids.map(id => Life.cachedState(id));
    return states.every(s => s?.party?.partyId === party.partyId) ? states : null;
}

async function transition(party, states, next, phase, reason) {
    const at = Date.now();
    const nextResolveAt = phase === 'hot' ? null : at + 30000;
    const stats = { ...party.stats, hotLifecycle: phase === 'hot'
        ? { startedAt: party.stats?.hotLifecycle?.startedAt || at, reason }
        : null };
    // Hot time has already been played. It is never another cold reward window.
    const nextStates = next.map(s => ({ ...s, phase, activity: 'grouped',
        timing: { ...s.timing, nextResolveAt, lastResolvedAt: at }, updatedAt: at }));
    const result = await invoke('Database').transitionBackgroundParty({ partyId: party.partyId,
        expectedStatus: party.status, expectedUpdatedAt: party.updatedAt, expectedPhase: states[0].phase,
        phase, nextResolveAt, statsJson: JSON.stringify(stats),
        members: nextStates.map((s, index) => ({ characterId: s.characterId,
            expectedRevision: Number(states[index].simulation?.revision || 0),
            expectedUpdatedAt: states[index].updatedAt, patch: Owner.persistencePatch(s, at) })) });
    if (!result.ok) throw Error(result.reason);
    return { party: Parties.acceptRow(result.party), states: result.rows.map(row => Life.acceptLifecycleRow(row)) };
}

function discard(sessions) {
    const Manager = invoke('GameServer/Bot/BotManager');
    const AI = invoke('GameServer/Bot/BotAI');
    for (const session of sessions) {
        AI.stop(session);
        if (!session.populationStaging) invoke('GameServer/Bot/Population/Cooldown').removeFromClientWorld(session);
        session.populationStaging = true;
        session.actor?.destructor();
        World.removeUser(session);
        Manager.sessions = Manager.sessions.filter(s => s !== session);
        session.actor = null;
    }
}

function publish(sessions, states, party) {
    const Manager = invoke('GameServer/Bot/BotManager');
    const Response = invoke('GameServer/Network/Response');
    // No await here: no AI tick or observer can see a partially published roster.
    for (const session of sessions) {
        session.coldLifeState = states.find(s => s.characterId === id(session));
        session.hotBackgroundPartyId = party.partyId;
        session.populationHotAt = Date.now();
        session.populationStaging = false;
        World.insertUser(session);
        Manager.sessions.push(session);
    }
    for (const session of sessions) {
        session.actor.automation.replenishVitals(session.actor);
        session.dataSendToOthers(Response.charInfo(session.actor), session.actor);
        session.dataSendToOthers(Response.relationChanged(session.actor), session.actor);
        invoke('GameServer/Bot/BotAI').init(session);
    }
}

async function activate(partyId, reason = 'near_player', options = {}) {
    const encounter = members(Parties.find(partyId))?.map(s => s.stats?.pvpEncounter).find(Boolean);
    if (encounter) return invoke('GameServer/Bot/Population/PvpEncounterLifecycle').activate(encounter, reason, options);
    if (pending.has(partyId)) return { ok: false, reason: 'party_transition_pending' };
    pending.add(partyId);
    let party, states, reserved = false;
    const sessions = [];
    try {
        party = Parties.find(partyId);
        states = members(party);
        if (!ready(party, states)) {
            return { ok: false, reason: 'party_not_ready' };
        }
        const fences = await Promise.all(states.map(s => Coordinator.fenceBot(s.characterId)));
        if (fences.some(f => !f.ok)) throw Error('party_fence_failed');
        await Life.settleWrites(party.memberIds);
        party = Parties.find(partyId);
        states = members(party);
        if (!ready(party, states)) throw Error('party_changed');
        const floor = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
        if (options.playerLoc && floor.filterCandidates(states, { playerLoc: options.playerLoc, reason }).accepted.length !== states.length) {
            throw Error('party_floor_mismatch');
        }
        const leaderIndex = states.findIndex(s => s.characterId === party.leaderId);
        // Cold members can have historical positions across their shared spot.
        // Materialize around the leader, with a safe path to the same anchor.
        const placements = states.map(s => Placement.resolve({ ...s, loc: states[leaderIndex].loc }, options));
        const leaderLoc = placements[leaderIndex]?.loc;
        if (!leaderLoc || placements.some(p => !p || Math.hypot(p.loc.locX - leaderLoc.locX, p.loc.locY - leaderLoc.locY) > 1800
            || Math.abs(p.loc.locZ - leaderLoc.locZ) > 500)) throw Error('party_no_safe_placement');
        ({ party, states } = await transition(party, states, states, 'hot', reason));
        reserved = true;
        const Manager = invoke('GameServer/Bot/BotManager');
        for (let i = 0; i < states.length; i++) {
            const s = states[i], placement = placements[i];
            const session = await Manager.loadAndSpawnBot(s.accountName, { name: s.name, homeRegion: s.homeRegion,
                prepareOnly: true, spawnReady: true, readyOnActivation: true, plan: 'hunting', backgroundActivity: 'grouped',
                currentSpot: placement.spot, coldLifeState: s, populationLocationPolicy: 'physical', ...placement.loc });
            if (!session || id(session) !== s.characterId) throw Error('party_spawn_failed');
            sessions.push(session);
        }
        await Life.settleWrites(party.memberIds);
        states = members(Parties.find(partyId));
        const prepared = sessions.map(session => Life.partySessionSnapshot(session, states.find(s => s.characterId === id(session)), 'hot', reason));
        ({ party, states } = await transition(Parties.find(partyId), states, prepared, 'hot', reason));
        publish(sessions, states, party);
        for (const state of states) invoke('GameServer/Bot/Population/PopulationMetrics').recordActivation();
        console.info('BotPopulation :: activated party %s members=%d reason=%s', partyId, states.length, reason);
        return { ok: true, party, states, count: states.length, reason };
    } catch (error) {
        discard(sessions);
        if (reserved) {
            // Keep a failed reservation fenced until the full rollback commits.
            // A failed DB rollback leaves an explicit hot reservation for retry/restart.
            try {
                party = Parties.find(partyId);
                states = members(party);
                await transition(party, states, states, 'cold', 'party_activation_rollback');
            } catch (rollback) {
                utils.infoWarn('BotPopulation', 'party activation rollback failed %s: %s', partyId, rollback.message);
                return { ok: false, reason: 'party_rollback_failed' };
            }
        }
        for (const state of members(Parties.find(partyId)) || []) Coordinator.notifyState(state);
        return { ok: false, reason: error.message };
    } finally { pending.delete(partyId); }
}

async function cooldown(partyId, reason = 'policy', options = {}) {
    const encounter = members(Parties.find(partyId))?.map(s => s.stats?.pvpEncounter).find(Boolean);
    if (encounter) return invoke('GameServer/Bot/Population/PvpEncounterLifecycle').cooldown(encounter, reason, options);
    if (pending.has(partyId)) return { ok: false, reason: 'party_transition_pending' };
    pending.add(partyId);
    let sessions = [], stopped = false, committed = false;
    try {
        const party = Parties.find(partyId);
        const states = members(party);
        if (party?.status !== 'hot' || !states) return { ok: false, reason: 'not_hot_party' };
        const Manager = invoke('GameServer/Bot/BotManager');
        sessions = party.memberIds.map(memberId => Manager.sessions.find(s => id(s) === memberId));
        const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
        const eligible = () => {
            const players = invoke('GameServer/Bot/Population/PopulationService').realPlayerSessions();
            return !sessions.some(s => !s || s.populationStaging || !Cooldown.canCooldown(s, options).ok
            || s.actor.state.fetchHits?.() || s.actor.state.fetchCasts?.()
            || invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(s)
            || (!options.ignoreVisibility && (Date.now() - Number(s.populationHotAt || 0) < Config.cooldownGraceMs
                || players.some(p => Math.hypot(p.actor.fetchLocX() - s.actor.fetchLocX(), p.actor.fetchLocY() - s.actor.fetchLocY()) <= Math.max(Config.cooldownRadius, Config.activationRadius)))));
        };
        if (!eligible()) {
            return { ok: false, reason: 'party_member_busy_or_visible' };
        }
        for (const s of sessions) {
            invoke('GameServer/Bot/BotAI').stop(s);
            invoke('GameServer/Bot/AI/BotPvpTactics').stop(s, s.actor);
            s.actor.automation.stopReplenish();
        }
        stopped = true;
        await Life.settleWrites(party.memberIds);
        if (!eligible()) throw Error('party_member_busy_or_visible');
        const current = members(Parties.find(partyId));
        const next = sessions.map(s => Life.partySessionSnapshot(s, current.find(c => c.characterId === id(s)), 'cold', reason));
        const result = await transition(Parties.find(partyId), current, next, 'cold', reason);
        committed = true;
        discard(sessions);
        result.states.forEach(state => Coordinator.notifyState(state));
        for (const state of result.states) invoke('GameServer/Bot/Population/PopulationMetrics').recordCooldown();
        console.info('BotPopulation :: cooled party %s members=%d reason=%s', partyId, next.length, reason);
        return { ok: true, ...result, count: next.length };
    } catch (error) {
        if (stopped && !committed) sessions.filter(s => s?.actor).forEach(s => {
            s.actor.automation.replenishVitals(s.actor);
            invoke('GameServer/Bot/BotAI').init(s);
        });
        return { ok: false, reason: error.message };
    } finally { pending.delete(partyId); }
}

module.exports = { activate, cooldown, pending, members };

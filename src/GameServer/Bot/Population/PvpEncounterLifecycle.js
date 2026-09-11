const Runtime = require('./PvpEncounterRuntime');
const id = s => Number(s?.actor?.fetchId?.());
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const coordinator = () => invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const manager = () => invoke('GameServer/Bot/BotManager');
const statesFor = e => Runtime.ids(e).map(n => life().cachedState(n));

async function transition(e, states, next, phase, reason, validate) {
    const at = Date.now();
    const prepared = next.map(s => ({ ...s, phase,
        timing: { ...s.timing, lastResolvedAt: at, nextResolveAt: phase === 'hot' ? null : at + 1000 } }));
    const result = await invoke('Database').transitionPvpEncounter({ key: e.key, phase, expectedPhase: states[0].phase, reason, validate,
        members: prepared.map((s, i) => ({ characterId: s.characterId,
            expectedRevision: Number(states[i].simulation?.revision || 0), expectedUpdatedAt: states[i].updatedAt,
            patch: invoke('GameServer/Bot/Population/ColdSimulationOwner').persistencePatch(s, at) })) });
    if (!result.ok) throw Error(result.reason);
    result.parties.forEach(p => invoke('GameServer/Bot/Population/BackgroundPartyState').acceptRow(p));
    return result.rows.map(row => life().acceptLifecycleRow(row));
}
function discard(roster) {
    for (const session of roster) {
        invoke('GameServer/Bot/BotAI').stop(session);
        if (!session.populationStaging) invoke('GameServer/Bot/Population/Cooldown').removeFromClientWorld(session);
        session.populationStaging = true;
        session.actor?.destructor();
        invoke('GameServer/World/World').removeUser(session);
        manager().sessions = manager().sessions.filter(s => s !== session);
        session.actor = null;
    }
}
function publish(e, roster, states) {
    const World = invoke('GameServer/World/World'), Response = invoke('GameServer/Network/Response');
    Runtime.restoreTargets(e, roster);
    for (const s of roster) {
        s.coldLifeState = states.find(state => state.characterId === id(s));
        s.hotBackgroundPartyId = s.coldLifeState.party?.partyId || null;
        s.populationHotAt = Date.now();
        s.populationStaging = false;
        World.insertUser(s);
        manager().sessions.push(s);
    }
    for (const s of roster) {
        s.actor.automation.replenishVitals(s.actor);
        s.dataSendToOthers(Response.charInfo(s.actor), s.actor);
        s.dataSendToOthers(Response.relationChanged(s.actor), s.actor);
        invoke('GameServer/Bot/BotAI').init(s);
    }
}
function capture(session, state, phase, e) {
    const next = life().partySessionSnapshot(session, state, phase, 'pvp_encounter_handoff');
    next.activity = state.party?.partyId ? 'grouped' : 'hunting';
    next.stats.pvpEncounter = e;
    next.stats.coldCompetition = { ...state.stats.coldCompetition, wait: null };
    next.stats.coldCombat.effects = invoke('GameServer/Effects/EffectStore').list(session.actor).map(effect => ({ ...effect, stats: { ...effect.stats } }));
    next.stats.coldPvp.readyAt = Math.max(Date.now(), Number(session.pvpActionReadyAt || 0));
    return next;
}
async function activate(e, reason = 'near_player', options = {}) {
    if (Runtime.pending.has(e.key)) return { ok: false, reason: 'encounter_transition_pending' };
    Runtime.pending.add(e.key);
    let reserved = false, states = [], original = [];
    const roster = [];
    try {
        states = statesFor(e);
        const eligible = () => states.every(s => s?.phase === 'cold' && s.accountName && s.vitals.hp > 0
            && Runtime.active(s)?.key === e.key && !s.stats?.travel && !s.stats?.supplyErrand);
        if (!eligible()) throw Error('encounter_not_ready');
        const fences = await Promise.all(states.map(s => coordinator().fenceBot(s.characterId)));
        if (fences.some(f => !f.ok)) throw Error('encounter_fence_failed');
        await life().settleWrites(Runtime.ids(e));
        states = statesFor(e);
        if (!eligible()) throw Error('encounter_changed');
        e = states[0].stats.pvpEncounter;
        original = states;
        const floor = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
        if (options.playerLoc && floor.filterCandidates(states, { playerLoc: options.playerLoc, reason }).accepted.length !== states.length) {
            throw Error('encounter_floor_mismatch');
        }
        const anchor = states.find(s => s.characterId === e.sides[0].principalId).loc;
        const placements = states.map(s => invoke('GameServer/Bot/Population/ActivationPlacement').resolve({ ...s, loc: anchor }, options));
        const origin = placements[0]?.loc;
        if (!origin || placements.some(p => !p || Math.hypot(p.loc.locX - origin.locX, p.loc.locY - origin.locY) > 1500
            || Math.abs(p.loc.locZ - origin.locZ) > 500)) throw Error('encounter_no_safe_placement');
        states = await transition(e, states, states.map((s, i) => ({ ...s, loc: placements[i].loc })), 'hot', reason);
        reserved = true;
        for (let i = 0; i < states.length; i++) {
            const state = states[i];
            const session = await manager().loadAndSpawnBot(state.accountName, { name: state.name, homeRegion: state.homeRegion,
                prepareOnly: true, spawnReady: false, readyOnActivation: false, plan: 'hunting',
                backgroundActivity: state.party?.partyId ? 'grouped' : 'hunting', currentSpot: placements[i].spot,
                coldLifeState: state, populationLocationPolicy: 'physical', ...placements[i].loc });
            if (!session || id(session) !== state.characterId) throw Error('encounter_spawn_failed');
            roster.push(session);
        }
        if (e.expiresAt <= Date.now()) throw Error('encounter_expired_during_spawn');
        await life().settleWrites(Runtime.ids(e));
        states = statesFor(e);
        states = await transition(e, states, roster.map(s => capture(s, states.find(n => n.characterId === id(s)), 'hot', e)), 'hot', reason);
        publish(e, roster, states);
        Runtime.register(e);
        states.forEach(() => invoke('GameServer/Bot/Population/PopulationMetrics').recordActivation());
        return { ok: true, count: states.length, states, encounter: e, reason };
    } catch (error) {
        discard(roster);
        if (reserved) {
            try { await transition(e, statesFor(e), original, 'cold', 'encounter_activation_rollback'); }
            catch (rollback) { return { ok: false, reason: 'encounter_rollback_failed', error: rollback.message }; }
        }
        statesFor(e).filter(Boolean).forEach(s => coordinator().notifyState(s));
        return { ok: false, reason: error.message };
    } finally { Runtime.pending.delete(e.key); }
}
function cooldownEligible(e, roster, options) {
    const ids = Runtime.ids(e), Cooldown = invoke('GameServer/Bot/Population/Cooldown');
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const players = options.ignoreVisibility ? [] : invoke('GameServer/Bot/Population/PopulationService').realPlayerSessions();
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    return roster.every(s => s?.actor && !s.populationStaging && !s.partyCompanion && !s.followPlayerSession
        && Cooldown.canCooldown(s, { ...options, encounterKey: e.key }).ok
        && (options.drainActions || (!s.actor.state.fetchHits?.() && !s.actor.state.fetchCasts?.() && !s.actor.attack?.timers?.size))
        && players.every(p => Math.hypot(p.actor.fetchLocX() - s.actor.fetchLocX(), p.actor.fetchLocY() - s.actor.fetchLocY()) > Math.max(config.activationRadius, config.cooldownRadius))
        && !invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(s)
        && Threats.context(s).threats.every(t => ids.includes(Number(t.actor.fetchId()))));
}
async function cooldown(e, reason = 'policy', options = {}) {
    if (Runtime.pending.has(e.key)) return { ok: false, reason: 'encounter_transition_pending' };
    Runtime.pending.add(e.key);
    const roster = Runtime.sessions(e);
    let stopped = false, committed = false;
    try {
        if (!cooldownEligible(e, roster, { ...options, drainActions: true })) throw Error('encounter_busy_or_visible');
        for (const s of roster) {
            s.pvpHandoffPending = true;
            invoke('GameServer/Bot/BotAI').stop(s);
            s.actor.attack?.resetQueuedEvent?.();
            s.actor.automation.stopReplenish();
        }
        stopped = true;
        const drainDeadline = Date.now() + 8000;
        while (roster.some(s => s.actor.state.fetchHits?.() || s.actor.state.fetchCasts?.() || s.actor.attack?.timers?.size)) {
            if (Date.now() >= drainDeadline || !cooldownEligible(e, roster, { ...options, drainActions: true })) throw Error('encounter_action_drain_failed');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        for (const s of roster) invoke('GameServer/Bot/AI/BotPvpTactics').stop(s, s.actor);
        const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
        await memory.events.flush();
        if ([...memory.events.pending.keys()].some(k => k.startsWith(`${e.key}:`))) throw Error('encounter_memory_pending');
        await life().settleWrites(Runtime.ids(e));
        if (!cooldownEligible(e, roster, options)) throw Error('encounter_changed');
        const states = statesFor(e), at = Date.now();
        const resumed = e.expiresAt > at ? { ...e, stepAt: at, sequence: e.sequence + 1, materialized: true,
            seen: [...new Set(roster.flatMap(s => s.pvpEncounter?.seen || e.seen))] } : null;
        const next = roster.map(s => capture(s, states.find(n => n.characterId === id(s)), 'cold', resumed));
        const saved = await transition(e, states, next, 'cold', reason, () => cooldownEligible(e, roster, options)
            && roster.every((s, i) => Number(s.actor.fetchHp?.() ?? s.actor.hp) === next[i].vitals.hp
                && Number(s.actor.fetchMp?.() ?? s.actor.mp) === next[i].vitals.mp
                && Number(s.actor.fetchCp?.() ?? s.actor.cp) === next[i].stats.coldCombat.cp));
        committed = true;
        discard(roster);
        saved.forEach(s => coordinator().notifyState(s));
        // Expiry during handoff still needs the normal finalization path:
        // clear the persisted outcome and count completion exactly once.
        Runtime.register(resumed || e);
        saved.forEach(() => invoke('GameServer/Bot/Population/PopulationMetrics').recordCooldown());
        return { ok: true, count: saved.length, states: saved, encounter: resumed };
    } catch (error) {
        if (stopped && !committed) roster.filter(s => s?.actor).forEach(s => {
            delete s.pvpHandoffPending;
            s.actor.automation.replenishVitals(s.actor);
            invoke('GameServer/Bot/BotAI').init(s);
        });
        return { ok: false, reason: error.message };
    } finally { Runtime.pending.delete(e.key); }
}
module.exports = { activate, cooldown, transition, capture, cooldownEligible };

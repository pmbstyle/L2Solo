// Only active encounters are indexed. No per-tick scan of the population.
const encounters = new Map();
const pending = new Set();
let running = null;
function register(encounter) {
    if (encounter?.key) encounters.set(encounter.key, encounter);
}
function snapshot(state) { return state?.stats?.pvpEncounter || null; }
function active(state, now = Date.now()) { const e = snapshot(state); return e && e.expiresAt > now ? e : null; }
function ids(e) { return e.sides.flatMap(s => s.memberIds); }
function sessions(e) {
    const manager = invoke('GameServer/Bot/BotManager');
    return ids(e).map(id => manager.sessions.find(s => Number(s.actor?.fetchId?.()) === id));
}
function restoreTargets(e, roster) {
    const roles = new Map(e.roles);
    for (const session of roster) {
        const id = Number(session.actor.fetchId());
        session.pvpEncounter = e;
        const side = e.sides.find(s => s.memberIds.includes(id));
        const enemy = e.sides.find(s => s !== side);
        if (!['initiator', 'target', 'support'].includes(roles.get(id))) continue;
        const target = roster.find(s => Number(s.actor.fetchId()) === enemy.principalId)?.actor;
        if (target) session.pvpRevenge = { target, initiator: session, reason: 'continued_encounter',
            expiresAt: e.expiresAt, startedAt: e.startedAt, participation: null };
    }
}
async function finish(e, actions) {
    const result = await invoke('Database').endPvpEncounter(e.key, ids(e));
    for (const row of result.rows) {
        const state = actions.life.acceptLifecycleRow(row);
        actions.onState(state.characterId);
    }
    if (result.complete) {
        encounters.delete(e.key);
        for (const session of sessions(e).filter(Boolean)) {
            if (session.pvpEncounter?.key === e.key) delete session.pvpEncounter;
            if (session.pvpRevenge?.reason === 'continued_encounter') delete session.pvpRevenge;
            if (session.coldLifeState?.stats?.pvpEncounter?.key === e.key) {
                session.coldLifeState = actions.life.cachedState(Number(session.actor.fetchId()));
            }
        }
    }
}
function tick(actions) {
    if (running || actions.stopping || actions.running || !actions.canRun()) return running;
    running = (async () => {
        const life = actions.life;
        let budget = 4;
        for (const e of encounters.values()) {
            if (!budget || actions.stopping || !actions.canRun()) break;
            if (pending.has(e.key)) continue;
            const states = ids(e).map(id => life.cachedState(id));
            if (states.some(s => snapshot(s)?.key !== e.key || !(s.vitals?.hp > 0))) {
                budget--; await finish(e, actions); continue;
            }
            if (states.every(s => s.phase === 'hot')) {
                if (e.expiresAt <= Date.now()) { budget--; await finish(e, actions); }
                continue;
            }
            if (states.some(s => s.phase !== 'cold') || Date.now() - e.stepAt < 1000) continue;
            budget--;
            pending.add(e.key);
            try {
                const at = Date.now();
                const participant = side => {
                    const s = life.cachedState(side.principalId), p = side.partyId ? actions.parties.find(side.partyId) : null;
                    return { id: s.characterId, partyId: side.partyId, size: side.memberIds.length,
                        revision: Number(s.simulation?.revision || 0), memoryRevision: actions.memory.snapshot(s.characterId)?.revision,
                        partyUpdatedAt: p?.updatedAt };
                };
                const event = { key: e.key, at, pressure: 3, spotId: e.spotId, npcId: e.npcId,
                    actor: participant(e.sides[0]), peer: participant(e.sides[1]), action: e.reason === 'revenge' ? 'revenge' : 'contest', pvpIntent: true };
                const result = await require('./ColdPartyConflict').apply({ ...actions, event, resume: e,
                    incrementalPvp: true, onEncounter: register, waitMs: 15000, cooldownMs: 600000,
                    rng: require('./ColdCompetitionMonitor').seeded(`${e.key}:${e.sequence}`) });
                if (result.ok) {
                    actions.recordPvpStep(result);
                    if (!result.encounter) encounters.delete(e.key);
                } else {
                    actions.report && (actions.report.lastPvpStepFailure = { key: e.key, at, reason: result.reason });
                    if (result.reason === 'encounter_separated_or_protected' || e.expiresAt <= Date.now()) await finish(e, actions);
                }
            } finally { pending.delete(e.key); }
        }
    })().finally(() => { running = null; });
    return running;
}
async function stop() { if (running) await running; }
module.exports = { encounters, pending, register, snapshot, active, ids, sessions, restoreTargets, tick, stop };

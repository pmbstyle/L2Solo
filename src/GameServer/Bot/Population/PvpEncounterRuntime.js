const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const { seeded } = require('../AI/TendencyRoll');
const { STEP_MS, PASS_MS } = require('./PvpEncounterBudget');
const Database = invoke('Database');
const ColdPartyConflict = require('./ColdPartyConflict');
const PvpJournal = require('../../../PvpJournal');
// Only active encounters are indexed. No per-tick scan of the population.
const encounters = new Map();
const pending = new Set();
let running = null;
// The longest pass since the status line last read it (passPeak).
let peak = { steps: 0, ms: 0, left: 0 };
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
async function finish(e, actions, reason = 'pvp_interrupted') {
    const result = await Database.endPvpEncounter(e.key, ids(e), reason);
    for (const row of result.rows) {
        const state = actions.life.acceptLifecycleRow(row);
        actions.onState(state.characterId);
    }
    for (const row of result.parties || []) actions.parties?.acceptRow(row);
    encounters.delete(e.key);
    actions.recordPvpStep({ ok: true, key: e.key, encounter: null, outcome: reason });
    // The fight's journal row: it ends here without a losing side or a kill
    // (a kill ends it in a step), at its deadline or earlier.
    const at = Date.now();
    PvpJournal.coldConflict({ key: e.key, revenge: e.reason === 'revenge',
        reason: e.reason === 'clan_war' ? 'clan_war' : e.reason === 'revenge' ? 'revenge' : 'contest', spotId: e.spotId, npcId: e.npcId,
        partyIds: e.sides.map(s => s.partyId), sideSizes: e.sides.map(s => s.memberIds.length),
        outcome: reason, fought: true, principals: e.sides.map(s => actions.life.cachedState(s.principalId) || { characterId: s.principalId }),
        durationMs: Math.min(at, e.expiresAt) - e.startedAt, actions: e.actions, personaFor: actions.personaFor, at });
    const changedSessions = [];
    for (const session of sessions(e).filter(Boolean)) {
        if (session.pvpEncounter?.key === e.key) delete session.pvpEncounter;
        if (session.pvpRevenge?.reason === 'continued_encounter') delete session.pvpRevenge;
        if (session.coldLifeState?.stats?.pvpEncounter?.key === e.key) {
            session.coldLifeState = actions.life.cachedState(Number(session.actor.fetchId()));
            changedSessions.push(session);
        }
    }
    refreshPartyMemberships(changedSessions, invoke);
}
// The time a fight's row names for its next turn: the step after the last
// one, or its end.
const dueAt = e => Math.min(e.expiresAt, e.stepAt + STEP_MS);
// One pass per timer tick (STEP_MS) steps every fight whose turn has come,
// the longest-waiting first, while main has room (canRun) and the pass is
// within its wall budget (PASS_MS); what is left goes first next tick, as its
// turn is older. The pass runs cooperatively: after a slice of DB work it
// yields to the event loop, so timers, the player and other DB jobs run
// between steps and canRun sees them. A fight is due from half a step before
// its stamp: the tick nearest the stamp steps it, as the interval timer
// drifts by a few ms against the step times.
function tick(actions) {
    if (running || actions.stopping || actions.running || !actions.canRun()) return running;
    running = Database.cooperatively(() => pass(actions)).finally(() => { running = null; });
    return running;
}
async function pass(actions) {
    const life = actions.life, startedAt = Date.now();
    let steps = 0, left = 0;
    const order = [...encounters.values()].sort((a, b) => dueAt(a) - dueAt(b));
    for (const [i, e] of order.entries()) {
        if (actions.stopping || !actions.canRun() || Date.now() - startedAt >= PASS_MS) {
            const now = Date.now();
            left = order.slice(i).filter(o => now - o.stepAt >= STEP_MS / 2).length;
            break;
        }
        if (pending.has(e.key) || encounters.get(e.key) !== e) continue;
        if (e.expiresAt <= Date.now()) { steps++; await finish(e, actions, 'pvp_expired'); continue; }
        const states = ids(e).map(id => life.cachedState(id));
        if (states.some(s => snapshot(s)?.key !== e.key || !(s.vitals?.hp > 0))) {
            steps++; await finish(e, actions); continue;
        }
        if (states.every(s => s.phase === 'hot')) continue;
        if (states.some(s => s.phase !== 'cold') || Date.now() - e.stepAt < STEP_MS / 2) continue;
        steps++;
        pending.add(e.key);
        try {
            const at = Date.now();
            const participant = side => {
                const s = life.cachedState(side.principalId), p = side.partyId ? actions.parties.find(side.partyId) : null;
                return { id: s.characterId, partyId: side.partyId, size: side.memberIds.length,
                    revision: Number(s.simulation?.revision || 0), memoryRevision: actions.memory.revision(s.characterId),
                    partyRevision: p?.revision };
            };
            const event = { key: e.key, at, pressure: 3, spotId: e.spotId, npcId: e.npcId,
                actor: participant(e.sides[0]), peer: participant(e.sides[1]), action: e.reason === 'clan_war' ? 'clan_war' : e.reason === 'revenge' ? 'revenge' : 'contest', pvpIntent: true, willing: e.willing };
            const result = await ColdPartyConflict.apply({ ...actions, event, resume: e,
                incrementalPvp: true, onEncounter: register, waitMs: 15000, cooldownMs: 600000,
                rng: seeded(`${e.key}:${e.sequence}`) });
            if (result.ok) {
                actions.recordPvpStep(result);
                if (!result.encounter) encounters.delete(e.key);
            } else {
                actions.report && (actions.report.lastPvpStepFailure = { key: e.key, at, reason: result.reason });
                if (['encounter_separated_or_protected', 'revenge_no_longer_wanted', 'war_context_changed'].includes(result.reason)) await finish(e, actions, 'pvp_separated_or_protected');
                else if (e.expiresAt <= Date.now()) await finish(e, actions, 'pvp_expired');
            }
        } finally { pending.delete(e.key); }
    }
    const ms = Date.now() - startedAt;
    if (ms > peak.ms) peak = { steps, ms, left };
}
async function stop() { if (running) await running; }
// The status line's numbers: the fights running now, and the steps, wall ms
// and due fights it left for the next tick of the longest pass since the last read (its only caller is the periodic
// goal line, so a read starts the next window).
function passPeak() {
    const read = { live: encounters.size, ...peak };
    peak = { steps: 0, ms: 0, left: 0 };
    return read;
}
module.exports = { encounters, pending, register, snapshot, active, ids, sessions, restoreTargets, tick, stop, passPeak };

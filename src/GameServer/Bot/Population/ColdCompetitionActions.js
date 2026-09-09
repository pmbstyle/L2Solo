const TTL_MS = 10000;
const COOLDOWN_MS = 2 * 60000;
const WAIT_MS = 15000;
const CONFLICT_COOLDOWN_MS = 10 * 60000;

function eligible(state, event, participant, now) {
    const plan = state?.stats?.equipmentPlan;
    const partyId = state?.party?.partyId || state?.partyId || null;
    const recruiting = event.action === 'offer_party' && event.accepted && participant.partyId;
    return state?.phase === 'cold' && (recruiting ? ['grouped', 'hunting'].includes(state.activity) : state.activity === 'hunting') && state.vitals?.hp > 0
        && (recruiting ? partyId === participant.partyId : !partyId) && !state.stats?.travel
        && !state.stats?.supplyErrand && !state.stats?.warehouseWorkflow && !state.stats?.marketReturn
        && !state.stats?.coldCompetition?.wait
        && (state.simulation?.ownerId || 'legacy_main') === 'legacy_main'
        && Number(state.simulation?.revision || 0) === participant.revision
        && state.spotId === event.spotId
        && (recruiting || (plan?.status === 'active' && Number(plan.next?.npcId || plan.targetNpcId || 0) === event.npcId))
        && now - Number(state.stats?.coldCompetition?.at || 0) >= COOLDOWN_MS;
}

// Consumes forecasts, not combat events. The two participant versions fence
// duplicate deliveries, hot handoffs, target changes and concurrent worker work.
class ColdCompetitionActions {
    constructor({ life, owner, memory, parties, personaFor = () => ({ traits: {} }), formParty, onState = () => {}, canRun = () => true, participantAllowed = () => true,
        conflictsEnabled = () => false, contestContextAllowed = () => false, now = Date.now }) {
        Object.assign(this, { life, owner, memory, parties, personaFor, formParty, onState, canRun, participantAllowed, conflictsEnabled, contestContextAllowed, now });
        this.stopping = false;
        this.running = null;
        this.lastScanAt = 0;
        this.report = { mode: 'cooperation', applied: 0, rejected: 0, yields: 0, contests: 0, deescalated: 0, parties: 0, recruits: 0, queued: 0, budgetSkipped: 0, recent: [] };
    }
    submit(forecast) {
        if (this.stopping || this.running || !forecast || forecast.at <= this.lastScanAt || !this.canRun()) return;
        this.lastScanAt = forecast.at;
        const candidates = (forecast.recent || []).filter(e => e.at === forecast.at
            && (e.action === 'yield' || (e.action === 'contest' && this.conflictsEnabled()) || (e.action === 'offer_party' && e.accepted)))
            .sort((a, b) => ({ offer_party: 2, contest: 1, yield: 0 }[b.action] - { offer_party: 2, contest: 1, yield: 0 }[a.action]));
        this.report.budgetSkipped += Math.max(0, candidates.length - 2);
        const events = candidates.slice(0, 2);
        this.running = (async () => {
            for (const event of events) {
                if (this.stopping || !this.canRun()) break;
                let result;
                try { result = await this.apply(event); }
                catch (error) { result = { ok: false, reason: 'action_error', error: error.message }; }
                this.report[result.ok ? 'applied' : 'rejected']++;
                if (result.ok) this.report[result.deescalated ? 'deescalated' : result.queued ? 'queued' : event.action === 'contest' ? 'contests' : event.action === 'yield' ? 'yields' : result.recruited ? 'recruits' : 'parties']++;
                this.report.recent = [...this.report.recent, { key: event.key, at: this.now(), actorId: event.actor.id,
                    peerId: event.peer.id, action: event.action, ...result }].slice(-12);
            }
        })().finally(() => { this.running = null; });
    }
    async apply(event) {
        const now = this.now();
        if (!event.key || event.at > now || now - event.at > TTL_MS || event.actor.id === event.peer.id
            || !(event.pressure > 1)) return { ok: false, reason: 'invalid_or_expired' };
        const participants = [event.actor, event.peer];
        if (!participants.every(p => this.participantAllowed(p.id))) return { ok: false, reason: 'hot_handoff_fenced' };
        if (event.action === 'contest' && participants.some(p => p.partyId)) {
            if (!this.conflictsEnabled()) return { ok: false, reason: 'forecast_only' };
            return require('./ColdPartyConflict').apply({ ...this, event, waitMs: WAIT_MS, cooldownMs: CONFLICT_COOLDOWN_MS });
        }
        const states = participants.map(p => this.life.cachedState(p.id));
        if (!states.every((s, i) => eligible(s, event, participants[i], now))) return { ok: false, reason: 'state_changed_or_busy' };
        const contest = event.action === 'contest';
        if (contest) {
            if (!this.conflictsEnabled()) return { ok: false, reason: 'forecast_only' };
            if (!states.every(s => this.contestContextAllowed(s, event))) return { ok: false, reason: 'contest_context_changed' };
            if (states.some(s => Number(s.stats?.coldCompetition?.conflictUntil || 0) > now)) return { ok: false, reason: 'conflict_cooldown' };
        }
        if (!states.every((s, i) => {
            const view = this.memory.snapshot(s.characterId);
            return view && view.revision === participants[i].memoryRevision;
        })) return { ok: false, reason: 'memory_changed' };
        const next = states.map((s, i) => ({ ...s, stats: { ...s.stats, coldCompetition: {
            ...s.stats?.coldCompetition,
            key: event.key, at: now, action: event.action, peerId: participants[1 - i].id,
            ...(contest ? { conflictUntil: now + CONFLICT_COOLDOWN_MS, npcId: event.npcId } : {}),
            ...((event.action === 'yield' && i === 0) || (contest && i === 1)
                ? { wait: { start: now, until: now + WAIT_MS } } : {})
        } } }));
        let queued = false;
        if (event.action === 'offer_party' && event.accepted) {
            if (Math.abs(states[0].level - states[1].level) > 4) return { ok: false, reason: 'level_mismatch' };
            const party = await this.formParty(next, event, { participantAllowed: this.participantAllowed });
            if (party?.partyId) (party.memberIds || states.map(s => s.characterId)).forEach(id => this.onState(id));
            if (party?.partyId) return { ok: true, partyId: party.partyId, ...(party.recruited ? { recruited: party.recruited } : {}) };
            if (party?.rejected !== 'party_capacity' || states.some(s => s.party?.partyId || s.partyId)) {
                return { ok: false, reason: party?.rejected || 'party_commit_rejected' };
            }
            // A willing hunter can keep looking for a group while farming.
            // Use the ordinary request queue, not a reserved social pool or a
            // replay of this expired invitation. Later formation revalidates it.
            queued = true;
            next.forEach(s => {
                if (s.stats.partyRequest?.status === 'open' && s.stats.partyRequest.priority === 'required') return;
                const plan = s.stats.equipmentPlan;
                const objectiveKey = `${plan.strategy || 'acquisition'}:${event.spotId}:${event.npcId}`;
                const previous = s.stats.partyRequest;
                s.stats.partyRequest = { status: 'open', priority: 'preferred', reason: 'shared_target',
                    objectiveKey, spotId: event.spotId, npcId: event.npcId,
                    strategy: plan.strategy || 'acquisition', itemId: Number(plan.next?.itemId || plan.target?.selfId || 0) || null,
                    targetId: Number(plan.target?.selfId || 0) || null,
                    requestedAt: previous?.status === 'open' && previous.objectiveKey === objectiveKey ? previous.requestedAt || now : now,
                    attempts: 0 };
            });
        }
        if (event.action !== 'yield' && !contest && !queued) return { ok: false, reason: 'forecast_only' };
        const { grants } = await this.owner.claimBatch(states, { timestamp: now, allowLifecycle: true });
        try {
            if (grants.length !== 2) return { ok: false, reason: 'claim_rejected' };
            if (contest && (!participants.every(p => this.participantAllowed(p.id)
                && this.memory.snapshot(p.id)?.revision === p.memoryRevision)
                || !states.every(s => this.contestContextAllowed(s, event)))) return { ok: false, reason: 'contest_changed_during_claim' };
            const delayed = contest ? 1 : 0;
            if (!queued) next[delayed].timing = { ...states[delayed].timing,
                nextResolveAt: Math.max(now, Number(states[delayed].timing?.nextResolveAt || 0)) + WAIT_MS };
            const group = { id: event.key, memberIds: participants.map(p => p.id) };
            const results = await this.owner.commitAndReleaseBatch(next.map((state, i) => ({
                token: grants.find(g => g.characterId === state.characterId), nextState: state,
                atomicGroup: group, options: { allowLifecycle: true }, proposal: { baseState: states[i],
                    ...(contest && i === 1 ? { result: { memoryEvents: [{ key: `${event.key}:contested`,
                        sourceId: state.characterId, targetId: states[0].characterId, kind: 'character',
                        type: 'mob_contested', at: now }] } } : {}) }
            })), { timestamp: this.now() });
            states.forEach(s => this.onState(s.characterId));
            return results.length === 2 && results.every(r => r.ok)
                ? (queued ? { ok: true, queued: true } : { ok: true, waitUntil: now + WAIT_MS,
                    ...(contest ? { victimId: states[1].characterId, memoryEvent: 'mob_contested', pvp: false } : {}) }) : { ok: false, reason: 'commit_rejected' };
        } finally {
            // Successful atomic commits already released their leases; release
            // only tokens still owned after a rejected or interrupted operation.
            const owned = grants.filter(g => this.life.cachedState(g.characterId)?.simulation?.leaseId === g.leaseId);
            if (owned.length) await this.owner.releaseBatch(owned);
            states.forEach(s => this.onState(s.characterId));
        }
    }
    async stop() { this.stopping = true; if (this.running) await this.running; }
    snapshot() { return { ...this.report, mode: this.conflictsEnabled() ? 'resource_conflicts' : 'cooperation' }; }
}
module.exports = { ColdCompetitionActions, eligible, WAIT_MS, CONFLICT_COOLDOWN_MS };

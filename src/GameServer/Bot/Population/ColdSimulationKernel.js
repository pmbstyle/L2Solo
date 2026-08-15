const SIMPLE_ACTIVITIES = new Set(['hunting', 'resting', 'traveling', 'dead']);

class DueHeap {
    constructor() {
        this.values = [];
    }

    push(entry) {
        this.values.push(entry);
        let index = this.values.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.compare(this.values[parent], entry) <= 0) break;
            this.values[index] = this.values[parent];
            index = parent;
        }
        this.values[index] = entry;
    }

    pop() {
        if (!this.values.length) return null;
        const first = this.values[0];
        const last = this.values.pop();
        if (this.values.length && last) {
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                const right = left + 1;
                if (left >= this.values.length) break;
                let next = left;
                if (right < this.values.length && this.compare(this.values[right], this.values[left]) < 0) next = right;
                if (this.compare(last, this.values[next]) <= 0) break;
                this.values[index] = this.values[next];
                index = next;
            }
            this.values[index] = last;
        }
        return first;
    }

    peek() {
        return this.values[0] || null;
    }

    compare(a, b) {
        return Number(a.dueAt || 0) - Number(b.dueAt || 0)
            || Number(a.characterId || 0) - Number(b.characterId || 0);
    }

    get size() {
        return this.values.length;
    }
}

function deterministicRandom(state = {}) {
    const seedText = `${state.characterId || 0}:${state.timing?.lastResolvedAt || 0}:${state.timing?.nextResolveAt || 0}`;
    let seed = 2166136261;
    for (let index = 0; index < seedText.length; index++) {
        seed ^= seedText.charCodeAt(index);
        seed = Math.imul(seed, 16777619);
    }
    return () => {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function nextDueAt(state = {}, timestamp = Date.now()) {
    const due = Number(state.timing?.nextResolveAt || 0);
    return due > 0 ? due : Math.max(0, Number(state.updatedAt || timestamp));
}

function lifecycleKind(state = {}, context = {}) {
    if (state.phase !== 'cold' || state.activity === 'pk_hunting') return 'inactive';
    if (context.isPartyLeader) return 'party';
    if (state.partyId || state.party?.partyId) return 'party_member';
    if ((state.activity === 'merchant' && state.stats?.marketStore)
        || (state.activity === 'crafting' && state.stats?.craftShop)) return 'event_driven';
    const stats = state.stats || {};
    // Finite travel/rest/death transitions are completely represented by the
    // pure resolver result and the owner CAS proposal. Economy follow-up, if
    // any, is selected on the next state after the transition is durable.
    if (state.activity === 'traveling' || state.activity === 'dead'
        || (state.activity === 'resting' && Number(stats.restUntil || 0) > 0)) return 'resolver';
    if (!SIMPLE_ACTIVITIES.has(String(state.activity || ''))) return 'command';
    if (stats.warehouseWorkflow || stats.warehouseErrand || stats.marketStore || stats.marketReturn
        || stats.craftShop || stats.craftStationId || stats.craftReturn || stats.supplyErrand) return 'command';
    const plan = stats.equipmentPlan || {};
    if (String(plan.strategy || '') === 'market') {
        const price = Math.max(0, Number(plan.market?.price || 0));
        const reserve = Math.max(0, Number(plan.market?.reserve || 0));
        if (state.activity !== 'hunting' || (price > 0 && Number(state.adena || 0) >= price + reserve)) return 'command';
    }
    if (String(plan.strategy || '') === 'craft') {
        if (state.activity !== 'hunting' || ['component_ready', 'ready_to_craft'].includes(String(plan.status || ''))) return 'command';
    }
    if (state.activity === 'traveling' && stats.travel) {
        const reason = String(stats.travel.reason || '');
        const arrival = String(stats.travel.arrivalActivity || 'shopping');
        if (!SIMPLE_ACTIVITIES.has(arrival) || /(market|shop|sell|buy|craft)/i.test(reason)) return 'command';
    }
    return 'resolver';
}

function isSchedulableKind(kind) {
    return kind !== 'inactive' && kind !== 'event_driven' && kind !== 'party_member';
}

function priorityForResult(state, result) {
    const activity = String(result?.patch?.activity || state?.activity || '');
    if (activity === 'dead' || state?.activity === 'dead' || (result?.events || []).some((event) => (
        ['death', 'respawn', 'resurrection'].includes(String(event?.type || ''))
    ))) return 'P0';
    if ((result?.materialize?.items || []).some((item) => Number(item.selfId) !== 57 && Number(item.amount || 0) !== 0)) {
        return 'P1';
    }
    return 'P2';
}

class ColdSimulationKernel {
    constructor(options = {}) {
        if (typeof options.resolveSolo !== 'function') throw new Error('resolveSolo is required');
        this.resolveSolo = options.resolveSolo;
        this.resolveParty = typeof options.resolveParty === 'function' ? options.resolveParty : null;
        this.planLifecycle = typeof options.planLifecycle === 'function' ? options.planLifecycle : null;
        this.projectResolve = typeof options.projectResolve === 'function' ? options.projectResolve : null;
        this.now = options.now || Date.now;
        this.emit = options.emit || (() => {});
        this.maxBatch = Math.max(1, Math.min(64, Number(options.maxBatch) || 64));
        this.maxInFlight = Math.max(this.maxBatch, Math.min(128, Number(options.maxInFlight) || 128));
        this.claimAckTimeoutMs = Math.max(1000, Number(options.claimAckTimeoutMs) || 5000);
        this.flushTargetMs = Math.max(100, Number(options.flushTargetMs) || 2000);
        this.flushHardMs = Math.max(this.flushTargetMs, Number(options.flushHardMs) || 5000);
        this.states = new Map();
        this.versions = new Map();
        this.heap = new DueHeap();
        this.scheduleTokens = new Map();
        this.nextScheduleToken = 1;
        this.claiming = new Set();
        this.claimStartedAt = new Map();
        this.inFlight = new Map();
        this.partyRuns = new Map();
        this.dirty = new Map();
        this.commanding = new Set();
        this.commandStartedAt = new Map();
        this.lastOrphanSweepAt = 0;
        this.orphanSweepIntervalMs = Math.max(1000, Number(options.orphanSweepIntervalMs) || 30000);
        this.orphanRecoveryLimit = Math.max(1, Math.min(64, Number(options.orphanRecoveryLimit) || 64));
        this.paused = false;
        this.stopping = false;
        this.resolveChain = Promise.resolve();
        this.stats = {
            snapshots: 0,
            selected: 0,
            claimed: 0,
            resolved: 0,
            proposals: 0,
            commands: 0,
            errors: 0,
            stale: 0,
            claimRecoveries: 0,
            leaseRecoveries: 0,
            orphanRecoveries: 0,
            loopRuns: 0,
            lastLoopAt: 0,
            lastResolveMs: 0,
            maxResolveMs: 0
        };
    }

    upsert(entry = {}) {
        const state = entry.state || entry;
        const characterId = Number(state?.characterId || 0);
        if (!characterId) return false;
        const current = this.states.get(characterId);
        const incomingRevision = Math.max(0, Number(state.simulation?.revision || 0));
        const currentRevision = Math.max(0, Number(current?.state?.simulation?.revision || 0));
        if (current && incomingRevision < currentRevision) {
            // Periodic catalog pages are prepared on main while the worker can
            // still resolve and receive newer commit ACKs. Preserve monotonic
            // ownership state when an older page arrives out of order, while
            // still accepting refreshed routing/party context.
            if (entry.context) this.states.set(characterId, { ...current, context: entry.context });
            this.ensureScheduled(characterId);
            return false;
        }
        if (current && incomingRevision === currentRevision
            && nextDueAt(current.state, this.now()) === nextDueAt(state, this.now())
            && lifecycleKind(current.state, current.context) === lifecycleKind(state, entry.context || {})) {
            // A full catalog refresh normally changes only context. Keep the
            // existing heap version so ten-second refreshes do not accumulate
            // one invalid future node per bot until its next due time.
            this.states.set(characterId, {
                ...current,
                state,
                context: entry.context || {}
            });
            this.stats.snapshots += 1;
            this.ensureScheduled(characterId);
            return true;
        }
        const version = Number(this.versions.get(characterId) || 0) + 1;
        this.versions.set(characterId, version);
        this.states.set(characterId, { state, context: entry.context || {}, version });
        this.stats.snapshots += 1;
        this.ensureScheduled(characterId);
        return true;
    }

    upsertMany(entries = []) {
        entries.forEach((entry) => this.upsert(entry));
        return entries.length;
    }

    remove(characterId) {
        const id = Number(characterId);
        this.states.delete(id);
        this.versions.set(id, Number(this.versions.get(id) || 0) + 1);
        this.scheduleTokens.delete(id);
        this.claiming.delete(id);
        this.claimStartedAt.delete(id);
        this.commanding.delete(id);
        this.commandStartedAt.delete(id);
    }

    schedule(characterId, version, dueAt) {
        const id = Number(characterId);
        const token = this.nextScheduleToken++;
        this.scheduleTokens.set(id, { token, version: Number(version), dueAt: Number(dueAt || this.now()) });
        this.heap.push({ characterId: id, version: Number(version), dueAt: Number(dueAt || this.now()), scheduleToken: token });
    }

    busy(characterId) {
        const id = Number(characterId);
        return this.claiming.has(id) || this.inFlight.has(id) || this.commanding.has(id);
    }

    ensureScheduled(characterId, dueAt = null) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current || this.busy(id) || !isSchedulableKind(lifecycleKind(current.state, current.context))) return false;
        const scheduled = this.scheduleTokens.get(id);
        if (scheduled?.version === current.version) return false;
        this.schedule(id, current.version, dueAt ?? nextDueAt(current.state, this.now()));
        return true;
    }

    validHeapEntry(entry) {
        const current = this.states.get(Number(entry?.characterId));
        const scheduled = this.scheduleTokens.get(Number(entry?.characterId));
        return !!current && current.version === entry.version && scheduled?.token === entry.scheduleToken;
    }

    consumeHeapEntry(entry) {
        const id = Number(entry?.characterId);
        if (this.scheduleTokens.get(id)?.token === entry?.scheduleToken) this.scheduleTokens.delete(id);
    }

    dueCandidates(timestamp = this.now(), capacity = this.maxBatch) {
        const limit = Math.max(0, Math.min(this.maxBatch, Number(capacity) || 0));
        const candidates = [];
        while (candidates.length < limit && this.heap.size > 0) {
            const head = this.heap.peek();
            if (!this.validHeapEntry(head)) {
                this.heap.pop();
                continue;
            }
            if (Number(head.dueAt || 0) > timestamp) break;
            const entry = this.heap.pop();
            this.consumeHeapEntry(entry);
            const id = Number(entry.characterId);
            // A catalog page may race an ACK and carry a newer revision while
            // the previous revision is still busy. Never create a second
            // writer or depend on the invariant sweep to replace this token;
            // every claim/commit/command completion schedules explicitly.
            if (this.busy(id)) continue;
            const current = this.states.get(id);
            const kind = lifecycleKind(current.state, current.context);
            if (kind === 'resolver') {
                this.claiming.add(id);
                this.claimStartedAt.set(id, this.now());
                candidates.push({
                    characterId: id,
                    expectedRevision: Math.max(0, Number(current.state.simulation?.revision || 0)),
                    purpose: { kind: 'resolver' },
                    state: current.state,
                    context: current.context
                });
            } else if (kind === 'party') {
                const party = current.context.party;
                const contextMembers = current.context.partyMembers || [];
                const memberIds = [...new Set((party?.memberIds || contextMembers.map((member) => member.characterId)).map(Number).filter(Boolean))];
                // The leader context is a catalog snapshot and can lag behind
                // commit ACKs for individual members. Revision fencing must use
                // the kernel's authoritative per-bot state map or every party
                // refresh will issue a storm of correctly rejected stale CASes.
                const members = memberIds.map((memberId) => (
                    this.states.get(memberId)?.state
                    || contextMembers.find((member) => Number(member.characterId) === memberId)
                    || null
                )).filter(Boolean);
                if (!party || members.length !== memberIds.length || memberIds.length < 2
                    || memberIds.some((memberId) => this.claiming.has(memberId) || this.inFlight.has(memberId))) {
                    this.requeue(id, this.now() + 1000);
                    continue;
                }
                if (candidates.length + memberIds.length > limit) {
                    this.requeue(id, this.now() + 100);
                    break;
                }
                const purpose = { kind: 'party', partyId: party.partyId, leaderId: id, memberIds };
                this.partyRuns.set(String(party.partyId), {
                    purpose,
                    party,
                    members,
                    spot: current.context.spot,
                    pressure: current.context.pressure || {},
                    targetNpcId: Number(current.context.targetNpcId || 0),
                    grants: new Map(),
                    rejected: false
                });
                memberIds.forEach((memberId) => {
                    const member = members.find((entry) => Number(entry.characterId) === memberId);
                    this.claiming.add(memberId);
                    this.claimStartedAt.set(memberId, this.now());
                    candidates.push({
                        characterId: memberId,
                        expectedRevision: Math.max(0, Number(member?.simulation?.revision || 0)),
                        purpose
                    });
                });
            } else if (kind === 'command') {
                this.commanding.add(id);
                this.commandStartedAt.set(id, this.now());
                this.stats.commands += 1;
                this.resolveChain = this.resolveChain.then(() => this.resolveCommand(id));
            }
        }
        return candidates;
    }

    async resolveCommand(characterId) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current || this.stopping) return;
        const timestamp = this.now();
        try {
            const elapsedMs = current.state.timing?.lastResolvedAt
                ? Math.max(1000, timestamp - Number(current.state.timing.lastResolvedAt))
                : 60000;
            const lifecyclePlan = this.planLifecycle
                ? await this.planLifecycle({
                    state: current.state,
                    context: current.context,
                    timestamp
                })
                : null;
            const resolveState = lifecyclePlan?.plannedState || current.state;
            const result = await this.resolveSolo({
                state: resolveState,
                spot: current.context.spot || null,
                pressure: current.context.pressure || {},
                targetNpcId: Number(current.context.targetNpcId || 0),
                elapsedMs,
                rng: deterministicRandom(current.state),
                timestamp
            });
            this.stats.resolved += 1;
            this.emit('command_request', {
                requests: [{
                    characterId: id,
                    kind: 'lifecycle',
                    state: current.state,
                    context: current.context,
                    precomputedPlan: lifecyclePlan,
                    precomputedResult: result,
                    computedAt: timestamp
                }]
            });
        } catch (error) {
            this.stats.errors += 1;
            this.commanding.delete(id);
            this.commandStartedAt.delete(id);
            this.requeue(id, this.now() + 5000);
        }
    }

    recoverStalled(timestamp = this.now()) {
        const expiredClaims = [...this.claimStartedAt.entries()]
            .filter(([, startedAt]) => timestamp - Number(startedAt || timestamp) >= this.claimAckTimeoutMs)
            .map(([characterId]) => Number(characterId));
        const handledParties = new Set();
        for (const id of expiredClaims) {
            const partyRun = [...this.partyRuns.values()].find((run) => run.purpose.memberIds.includes(id));
            if (partyRun) {
                const partyId = String(partyRun.purpose.partyId);
                if (handledParties.has(partyId)) continue;
                handledParties.add(partyId);
                partyRun.purpose.memberIds.forEach((memberId) => {
                    this.claiming.delete(Number(memberId));
                    this.claimStartedAt.delete(Number(memberId));
                });
                this.partyRuns.delete(partyId);
                this.requeue(partyRun.purpose.leaderId, timestamp + 1000);
                this.stats.claimRecoveries += partyRun.purpose.memberIds.length;
            } else {
                this.claiming.delete(id);
                this.claimStartedAt.delete(id);
                this.requeue(id, timestamp + 1000);
                this.stats.claimRecoveries += 1;
            }
        }

        const expiredLeases = [...this.inFlight.entries()].filter(([, active]) => (
            Number(active?.grant?.leaseUntil || 0) > 0
            && Number(active.grant.leaseUntil) <= timestamp
        ));
        const expiredParties = new Set(expiredLeases.map(([, active]) => active.partyId).filter(Boolean).map(String));
        for (const partyId of expiredParties) {
            const members = [...this.inFlight.entries()].filter(([, active]) => String(active.partyId || '') === partyId);
            members.forEach(([id]) => {
                this.inFlight.delete(Number(id));
                this.dirty.delete(Number(id));
            });
            const leader = [...this.states.entries()].find(([, entry]) => (
                entry.context?.isPartyLeader && String(entry.context?.party?.partyId || '') === partyId
            ));
            if (leader) this.requeue(leader[0], timestamp + 1000);
            this.stats.leaseRecoveries += members.length;
        }
        expiredLeases.filter(([, active]) => !active.partyId).forEach(([id]) => {
            this.inFlight.delete(Number(id));
            this.dirty.delete(Number(id));
            this.requeue(Number(id), timestamp + 1000);
            this.stats.leaseRecoveries += 1;
        });
    }

    recoverOrphanedSchedules(timestamp = this.now()) {
        if (this.lastOrphanSweepAt && timestamp - this.lastOrphanSweepAt < this.orphanSweepIntervalMs) return 0;
        this.lastOrphanSweepAt = timestamp;
        let recovered = 0;
        for (const [id, entry] of this.states.entries()) {
            if (recovered >= this.orphanRecoveryLimit) break;
            if (!isSchedulableKind(lifecycleKind(entry.state, entry.context))
                || this.scheduleTokens.has(id)
                || this.busy(id)) continue;
            this.schedule(id, entry.version, nextDueAt(entry.state, timestamp));
            recovered += 1;
        }
        this.stats.orphanRecoveries += recovered;
        return recovered;
    }

    tick() {
        this.stats.loopRuns += 1;
        this.stats.lastLoopAt = this.now();
        this.recoverStalled(this.stats.lastLoopAt);
        this.recoverOrphanedSchedules(this.stats.lastLoopAt);
        if (this.paused || this.stopping) return;
        const capacity = this.maxInFlight - this.claiming.size - this.inFlight.size - this.commanding.size;
        if (capacity <= 0) return;
        const candidates = this.dueCandidates(this.now(), capacity);
        if (!candidates.length) return;
        this.stats.selected += candidates.length;
        this.emit('claim_request', { candidates: candidates.map(({ state, context, ...candidate }) => candidate) });
    }

    onClaimAck(payload = {}) {
        (payload.rejected || []).forEach((result) => {
            const id = Number(result.characterId);
            this.claiming.delete(id);
            this.claimStartedAt.delete(id);
            if (result.purpose?.kind === 'party') {
                const run = this.partyRuns.get(String(result.purpose.partyId));
                if (run) run.rejected = true;
                return;
            }
            if (result.state) this.upsert(result);
            else this.requeue(id, this.now() + 1000);
        });
        (payload.grants || []).forEach((grant) => {
            const id = Number(grant.characterId);
            this.claiming.delete(id);
            this.claimStartedAt.delete(id);
            if (grant.purpose?.kind === 'party') {
                const run = this.partyRuns.get(String(grant.purpose.partyId));
                if (run) run.grants.set(id, grant);
                return;
            }
            const entry = this.states.get(id);
            if (!entry) return;
            this.inFlight.set(id, { grant, state: entry.state, context: entry.context, startedAt: this.now() });
            this.stats.claimed += 1;
            this.resolveChain = this.resolveChain.then(() => this.resolveGrant(id));
        });
        const touchedParties = new Set([
            ...(payload.grants || []).map((entry) => entry.purpose?.partyId),
            ...(payload.rejected || []).map((entry) => entry.purpose?.partyId)
        ].filter(Boolean).map(String));
        touchedParties.forEach((partyId) => {
            const run = this.partyRuns.get(partyId);
            if (!run) return;
            const complete = run.rejected || run.grants.size === run.purpose.memberIds.length;
            if (!complete) return;
            if (run.rejected) {
                const releases = [...run.grants.values()].map((token) => ({ token, reason: 'party_claim_partial' }));
                if (releases.length) this.emit('release_request', { releases });
                run.purpose.memberIds.forEach((id) => {
                    this.claiming.delete(Number(id));
                    this.claimStartedAt.delete(Number(id));
                });
                this.partyRuns.delete(partyId);
                this.requeue(run.purpose.leaderId, this.now() + 1000);
                return;
            }
            run.purpose.memberIds.forEach((id) => {
                const state = run.members.find((member) => Number(member.characterId) === Number(id));
                this.inFlight.set(Number(id), {
                    grant: run.grants.get(Number(id)), state, context: {}, startedAt: this.now(), partyId
                });
            });
            this.stats.claimed += run.purpose.memberIds.length;
            this.resolveChain = this.resolveChain.then(() => this.resolvePartyGrant(partyId));
        });
    }

    async resolvePartyGrant(partyId) {
        const run = this.partyRuns.get(String(partyId));
        if (!run || this.stopping) return;
        const startedAt = this.now();
        try {
            if (!this.resolveParty) throw new Error('party_resolver_unavailable');
            const lastResolvedAt = Math.min(...run.members.map((member) => Number(member.timing?.lastResolvedAt || startedAt - 60000)));
            const resolution = await this.resolveParty({
                party: run.party,
                members: run.members,
                spot: run.spot,
                pressure: run.pressure,
                targetNpcId: run.targetNpcId,
                elapsedMs: Math.max(1000, startedAt - lastResolvedAt),
                rng: deterministicRandom(run.members[0] || {}),
                timestamp: startedAt
            });
            const proposals = [];
            for (const { state, result } of resolution.memberResults || []) {
                const id = Number(state.characterId);
                const projection = this.projectResolve
                    ? await this.projectResolve(state, result, startedAt)
                    : null;
                const projectedState = projection?.state || projection;
                const proposal = {
                    proposalId: `${run.grants.get(id)?.leaseId}:${run.grants.get(id)?.revision}`,
                    characterId: id,
                    priority: priorityForResult(state, result),
                    enqueuedAt: this.now(),
                    token: run.grants.get(id),
                    baseState: state,
                    nextState: projectedState,
                    durable: projection?.durable || null,
                    result: {
                        ...result,
                        events: [
                            ...(result.events || []),
                            ...(resolution.events || []).filter((event) => Number(event.characterId || run.party.leaderId) === id)
                        ]
                    },
                    options: { allowParty: true, allowLifecycle: true },
                    partyResolution: id === Number(run.party.leaderId) ? {
                        partyId: run.party.partyId,
                        party: {
                            ...run.party,
                            ...resolution.partyPatch,
                            stats: { ...(run.party.stats || {}), ...(resolution.partyPatch?.stats || {}) },
                            nextResolveAt: resolution.nextResolveAt
                        }
                    } : null
                };
                this.dirty.set(id, proposal);
                proposals.push(proposal);
            }
            this.stats.resolved += proposals.length;
            this.flush(null, true);
        } catch (error) {
            this.stats.errors += 1;
            this.emit('fault', { reason: error?.message || 'party_resolver_error', stage: 'party_project' });
            this.emit('release_request', {
                releases: [...run.grants.values()].map((token) => ({ token, reason: error?.message || 'party_resolver_error' }))
            });
        } finally {
            this.partyRuns.delete(String(partyId));
            const elapsed = this.now() - startedAt;
            this.stats.lastResolveMs = elapsed;
            this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed);
        }
    }

    async resolveGrant(characterId) {
        const active = this.inFlight.get(Number(characterId));
        if (!active || this.stopping) return;
        const startedAt = this.now();
        try {
            const timestamp = startedAt;
            const elapsedMs = active.state.timing?.lastResolvedAt
                ? Math.max(1000, timestamp - Number(active.state.timing.lastResolvedAt))
                : 60000;
            const lifecyclePlan = this.planLifecycle
                ? await this.planLifecycle({ state: active.state, context: active.context, timestamp })
                : null;
            const resolveState = lifecyclePlan?.plannedState || active.state;
            const result = await this.resolveSolo({
                state: resolveState,
                spot: active.context.spot || null,
                pressure: active.context.pressure || {},
                targetNpcId: Number(lifecyclePlan?.acquisitionPlan?.next?.npcId || active.context.targetNpcId || 0),
                elapsedMs,
                rng: deterministicRandom(active.state),
                timestamp
            });
            const projection = this.projectResolve
                ? await this.projectResolve(resolveState, result, timestamp)
                : null;
            const projectedState = projection?.state || projection;
            const priority = projection?.durable ? 'P1' : priorityForResult(active.state, result);
            const proposal = {
                proposalId: `${active.grant.leaseId}:${active.grant.revision}`,
                characterId: Number(characterId),
                priority,
                enqueuedAt: this.now(),
                token: active.grant,
                baseState: resolveState,
                nextState: projectedState,
                durable: projection?.durable || null,
                result,
                options: { allowLifecycle: true }
            };
            this.dirty.set(Number(characterId), proposal);
            this.stats.resolved += 1;
            if (priority !== 'P2' || this.dirty.size >= this.maxBatch) this.flush(priority);
        } catch (error) {
            this.stats.errors += 1;
            this.emit('fault', { reason: error?.message || 'resolver_error', stage: 'solo_project', characterId: Number(characterId) });
            this.inFlight.delete(Number(characterId));
            this.emit('release_request', {
                releases: [{ token: active.grant, reason: error?.message || 'resolver_error' }]
            });
        } finally {
            const elapsed = this.now() - startedAt;
            this.stats.lastResolveMs = elapsed;
            this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed);
        }
    }

    flush(priority = null, force = false) {
        const timestamp = this.now();
        const eligible = [...this.dirty.values()]
            .filter((proposal) => force || priority === null || proposal.priority === priority
                || timestamp - proposal.enqueuedAt >= this.flushHardMs)
            .sort((a, b) => {
                const rank = { P0: 0, P1: 1, P2: 2 };
                return rank[a.priority] - rank[b.priority] || a.enqueuedAt - b.enqueuedAt;
            })
            .slice(0, this.maxBatch);
        const proposals = [];
        for (const proposal of eligible) {
            const candidate = [...proposals, proposal];
            if (Buffer.byteLength(JSON.stringify({ proposals: candidate })) > 240 * 1024) break;
            proposals.push(proposal);
        }
        if (!proposals.length) return 0;
        proposals.forEach((proposal) => this.dirty.delete(proposal.characterId));
        this.stats.proposals += proposals.length;
        this.emit('proposal_batch', { proposals });
        return proposals.length;
    }

    flushDue() {
        const now = this.now();
        const oldest = Math.min(...[...this.dirty.values()].map((proposal) => Number(proposal.enqueuedAt || now)), now);
        if (this.dirty.size && (now - oldest >= this.flushTargetMs || this.dirty.size >= this.maxBatch)) {
            this.flush(null, now - oldest >= this.flushHardMs);
        }
    }

    onCommitAck(payload = {}) {
        (payload.results || []).forEach((result) => {
            const id = Number(result.characterId);
            this.inFlight.delete(id);
            if (result.ok && result.state) {
                this.upsert({ state: result.state, context: result.context || this.states.get(id)?.context || {} });
            } else {
                if (String(result.reason || '').includes('stale')) this.stats.stale += 1;
                if (result.state) this.upsert({
                    state: {
                        ...result.state,
                        timing: {
                            ...(result.state.timing || {}),
                            nextResolveAt: Math.max(this.now() + 1000, Number(result.state.timing?.nextResolveAt || 0))
                        }
                    },
                    context: result.context || {}
                });
                else this.requeue(id, this.now() + 1000);
            }
        });
    }

    onReleaseAck(payload = {}) {
        (payload.results || []).forEach((result) => {
            const id = Number(result.characterId);
            this.inFlight.delete(id);
            if (result.state) this.upsert(result);
            else this.requeue(id, this.now() + 1000);
        });
    }

    completeCommand(payload = {}) {
        const id = Number(payload.characterId);
        this.commanding.delete(id);
        this.commandStartedAt.delete(id);
        if (payload.state) this.upsert({ state: payload.state, context: payload.context || {} });
        else this.requeue(id, this.now() + Math.max(1000, Number(payload.retryAfterMs) || 5000));
    }

    requeue(characterId, dueAt) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current) return;
        this.schedule(id, current.version, Number(dueAt || this.now()));
    }

    fence(characterId) {
        const id = Number(characterId);
        this.claiming.delete(id);
        this.commanding.delete(id);
        const proposal = this.dirty.get(id) || null;
        if (proposal) this.dirty.delete(id);
        const active = this.inFlight.get(id) || null;
        this.inFlight.delete(id);
        this.remove(id);
        return { characterId: id, proposal, token: active?.grant || proposal?.token || null };
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    async shutdown() {
        this.stopping = true;
        await this.resolveChain.catch(() => null);
        this.flush(null, true);
        return this.snapshot();
    }

    snapshot() {
        const now = this.now();
        const due = [...this.states.values()].filter((entry) => (
            isSchedulableKind(lifecycleKind(entry.state, entry.context))
            && nextDueAt(entry.state, now) <= now
        ));
        const oldestDueAt = due.reduce((oldest, entry) => Math.min(oldest, nextDueAt(entry.state, now)), now);
        const oldestDirtyAt = [...this.dirty.values()].reduce((oldest, proposal) => (
            Math.min(oldest, Number(proposal.enqueuedAt || now))
        ), now);
        const oldestCommandAt = [...this.commandStartedAt.values()].reduce((oldest, startedAt) => (
            Math.min(oldest, Number(startedAt || now))
        ), now);
        const dueFences = due.reduce((counts, entry) => {
            const id = Number(entry.state.characterId);
            if (this.claiming.has(id)) counts.claiming += 1;
            else if (this.inFlight.has(id)) counts.inFlight += 1;
            else if (this.commanding.has(id)) counts.commanding += 1;
            else if (this.scheduleTokens.has(id)) counts.scheduled += 1;
            else counts.orphaned += 1;
            return counts;
        }, { scheduled: 0, claiming: 0, inFlight: 0, commanding: 0, orphaned: 0 });
        return {
            ...this.stats,
            states: this.states.size,
            heap: this.heap.size,
            due: due.length,
            dueAgeMs: due.length ? Math.max(0, now - oldestDueAt) : 0,
            dueFences,
            claiming: this.claiming.size,
            inFlight: this.inFlight.size,
            dirty: this.dirty.size,
            dirtyAgeMs: this.dirty.size ? Math.max(0, now - oldestDirtyAt) : 0,
            commanding: this.commanding.size,
            commandingAgeMs: this.commanding.size ? Math.max(0, now - oldestCommandAt) : 0,
            paused: this.paused,
            stopping: this.stopping
        };
    }
}

module.exports = {
    ColdSimulationKernel,
    DueHeap,
    deterministicRandom,
    lifecycleKind,
    priorityForResult,
    nextDueAt
};

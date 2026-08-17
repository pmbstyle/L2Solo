const assert = require('assert');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const {
    ColdSimulationKernel,
    beginRouteTravelState,
    deterministicRandom,
    finishPartyRouteTravelState,
    lifecycleKind
} = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

function state(characterId = 1, overrides = {}) {
    return {
        characterId,
        phase: 'cold',
        activity: 'hunting',
        level: 20,
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 },
        stats: {},
        simulation: { ownerId: 'legacy_main', revision: 3, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000,
        ...overrides
    };
}

(async () => {
    const valid = Protocol.validateEnvelope(Protocol.envelope('claim_request', 'epoch', { candidates: [] }), 'worker', { workerEpoch: 'epoch' });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(Protocol.validateEnvelope(null, 'worker').reason, 'invalid_envelope');
    assert.strictEqual(Protocol.validateEnvelope({
        version: 999, type: 'ready', msgId: 'x', workerEpoch: 'epoch', payload: {}
    }, 'worker').reason, 'protocol_version');
    assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('claim_request', 'epoch', {
        candidates: Array.from({ length: 65 }, (_, index) => ({ characterId: index + 1 }))
    }), 'worker').reason, 'batch_size');
    assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('command_request', 'epoch', {
        requests: Array.from({ length: 65 }, (_, index) => ({ characterId: index + 1 }))
    }), 'worker').reason, 'batch_size');

    const emitted = [];
    let now = 3000;
    const resolver = ({ state: current, rng, timestamp }) => ({
        patch: { activity: 'resting', stats: { roll: rng() } },
        materialize: { exp: Math.floor(rng() * 100), sp: 0, adena: 0, items: [] },
        events: [],
        nextResolveAt: timestamp + 30000,
        debug: { activity: current.activity }
    });
    const kernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: (type, payload) => emitted.push({ type, payload }),
        now: () => now,
        flushTargetMs: 2000,
        flushHardMs: 5000
    });
    kernel.upsert({ state: state(), context: { spot: { id: 'spot', rewards: {} } } });
    kernel.tick();
    const claimRequest = emitted.shift();
    assert.strictEqual(claimRequest.type, 'claim_request');
    assert.strictEqual(claimRequest.payload.candidates[0].expectedRevision, 3);
    kernel.onClaimAck({ grants: [{
        ok: true,
        characterId: 1,
        ownerId: 'cold_simulation_owner',
        revision: 4,
        leaseId: 'lease-1',
        leaseUntil: 33000
    }] });
    await kernel.resolveChain;
    assert.strictEqual(kernel.snapshot().resolved, 1);
    now += 2000;
    kernel.flushDue();
    const proposalMessage = emitted.find((entry) => entry.type === 'proposal_batch');
    assert(proposalMessage, 'ordinary dirty state must flush at the 2 second target');
    const proposal = proposalMessage.payload.proposals[0];
    assert.strictEqual(proposal.priority, 'P2');
    assert.strictEqual(proposal.token.revision, 4);

    const first = deterministicRandom(state());
    const second = deterministicRandom(state());
    assert.deepStrictEqual([first(), first(), first()], [second(), second(), second()], 'resolver RNG must replay deterministically');

    kernel.onCommitAck({ results: [{
        ok: true,
        characterId: 1,
        state: state(1, {
            activity: 'resting',
            timing: { lastResolvedAt: now, nextResolveAt: now + 30000 },
            simulation: { ownerId: 'legacy_main', revision: 5, leaseId: null, leaseUntil: 0 }
        })
    }] });
    assert.strictEqual(kernel.snapshot().inFlight, 0);
    assert.strictEqual(kernel.upsert({ state: state(1), context: { spot: { id: 'refreshed-context' } } }), false,
        'an out-of-order catalog snapshot must not replace a newer committed revision');
    assert.strictEqual(kernel.states.get(1).state.simulation.revision, 5,
        'worker ownership revisions must remain monotonic across catalog refreshes');
    assert.strictEqual(kernel.states.get(1).context.spot.id, 'refreshed-context',
        'a stale state page may still refresh non-authoritative routing context');
    const heapBeforeRefresh = kernel.heap.size;
    const currentState = kernel.states.get(1).state;
    assert.strictEqual(kernel.upsert({ state: { ...currentState }, context: { spot: { id: 'same-due-context' } } }), true);
    assert.strictEqual(kernel.heap.size, heapBeforeRefresh,
        'same-revision catalog refresh must coalesce without growing the due heap');

    const route = {
        needed: true,
        mode: 'solo',
        currentSpotId: 'starter-field',
        spotId: 'mid-level-field',
        regionName: 'Mid-level fields',
        travelMs: 25000,
        to: { locX: 125000, locY: -176000, locZ: -1000 }
    };
    const travelState = beginRouteTravelState(state(70, {
        level: 16,
        spotId: 'starter-field',
        loc: { locX: 115000, locY: -176000, locZ: -1000 },
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }
    }), route, 5000);
    assert.strictEqual(travelState.activity, 'traveling', 'an outleveled solo bot must enter a finite travel state');
    assert.strictEqual(travelState.spotId, 'starter-field', 'the old spot remains current until arrival');
    assert.strictEqual(travelState.stats.travel.spotId, 'mid-level-field');
    assert.strictEqual(travelState.stats.travel.arrivalAt, 30000);

    const arrivedPartyMember = finishPartyRouteTravelState({
        ...travelState,
        stats: {
            ...travelState.stats,
            travel: {
                ...travelState.stats.travel,
                reason: 'party_spot_replan',
                arrivalActivity: 'grouped'
            }
        }
    }, 30000);
    assert.strictEqual(arrivedPartyMember.activity, 'grouped', 'party travel must arrive as a grouped member');
    assert.strictEqual(arrivedPartyMember.spotId, 'mid-level-field');
    assert.deepStrictEqual(arrivedPartyMember.loc, route.to);
    assert.strictEqual(arrivedPartyMember.stats.travel, null);

    const routeStates = [];
    const routeKernel = new ColdSimulationKernel({
        resolveSolo: ({ state: current }) => {
            routeStates.push(current);
            return {
                patch: { activity: current.activity },
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                events: [],
                nextResolveAt: 30000,
                debug: { activity: current.activity }
            };
        },
        planLifecycle: ({ state: current, context, timestamp }) => ({
            plannedState: beginRouteTravelState(current, context.route, timestamp) || current
        }),
        emit: () => {},
        now: () => 5000
    });
    routeKernel.upsert({
        state: state(71, {
            level: 16,
            spotId: 'starter-field',
            loc: { locX: 115000, locY: -176000, locZ: -1000 },
            timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }
        }),
        context: { spot: { id: 'starter-field' }, route }
    });
    routeKernel.tick();
    routeKernel.onClaimAck({ grants: [{
        ok: true, characterId: 71, ownerId: 'cold_simulation_owner', revision: 4,
        leaseId: 'route-lease', leaseUntil: 35000
    }] });
    await routeKernel.resolveChain;
    assert.strictEqual(routeStates.length, 1);
    assert.strictEqual(routeStates[0].activity, 'traveling', 'worker resolve must execute the route transition before combat');
    assert.strictEqual(routeStates[0].stats.travel.spotId, 'mid-level-field');

    assert.strictEqual(lifecycleKind(state(2, { activity: 'crafting' })), 'command');
    assert.strictEqual(lifecycleKind(state(2, { stats: { equipmentPlan: { strategy: 'market' } } })), 'resolver');
    assert.strictEqual(lifecycleKind(state(2, {
        adena: 1000,
        stats: { equipmentPlan: { strategy: 'market', market: { price: 500, reserve: 100 } } }
    })), 'command');
    assert.strictEqual(lifecycleKind(state(2, { party: { partyId: 'party' } }), { isPartyLeader: true }), 'party');

    const commandMessages = [];
    let plannedOnWorker = 0;
    const commandKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        planLifecycle: ({ state: commandState }) => {
            plannedOnWorker += 1;
            return {
                previousPlan: null,
                acquisitionPlan: { strategy: 'direct_drop', status: 'active' },
                plannedState: { ...commandState, stats: { ...commandState.stats, workerPlanned: true } }
            };
        },
        emit: (type, payload) => commandMessages.push({ type, payload }),
        now: () => now
    });
    commandKernel.upsert({ state: state(3, { activity: 'shopping' }), context: {} });
    commandKernel.tick();
    await commandKernel.resolveChain;
    const commandRequest = commandMessages.find((entry) => entry.type === 'command_request');
    assert.strictEqual(plannedOnWorker, 1, 'lifecycle planning must execute in the cold kernel');
    assert.strictEqual(commandRequest.payload.requests[0].precomputedPlan.plannedState.stats.workerPlanned, true);
    assert(commandRequest.payload.requests[0].precomputedResult, 'main command gateway must receive worker-computed lifecycle output');
    assert.strictEqual(commandRequest.payload.requests[0].computedAt, now);
    assert.strictEqual(commandKernel.scheduleTokens.has(3), false,
        'a command request must consume its due token while the command is in flight');
    assert.strictEqual(commandKernel.snapshot().commandingAgeMs, 0,
        'command age starts at zero on the deterministic test clock');
    const commandState = commandKernel.states.get(3).state;
    commandKernel.upsert({ state: { ...commandState }, context: { refreshed: true } });
    assert.strictEqual(commandKernel.scheduleTokens.has(3), false,
        'a catalog refresh must not create a second writer while the command is in flight');
    commandKernel.completeCommand({ characterId: 3, state: { ...commandState }, context: { refreshed: true } });
    assert.strictEqual(commandKernel.scheduleTokens.has(3), true,
        'a same-revision command ACK must restore the consumed due token');
    assert.strictEqual(commandKernel.snapshot().commanding, 0);

    const transitionKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        planLifecycle: () => null,
        emit: () => {},
        now: () => now
    });
    transitionKernel.upsert({ state: state(5, { activity: 'shopping' }), context: {} });
    transitionKernel.tick();
    await transitionKernel.resolveChain;
    const transitioned = state(5, {
        activity: 'traveling',
        timing: { lastResolvedAt: now, nextResolveAt: now - 1 },
        updatedAt: now
    });
    transitionKernel.upsert({ state: transitioned, context: {} });
    transitionKernel.tick();
    assert.strictEqual(transitionKernel.scheduleTokens.has(5), false,
        'an interim durable refresh can be consumed while the lifecycle ACK is pending');
    transitionKernel.completeCommand({ characterId: 5, state: transitioned, context: {} });
    assert.strictEqual(transitionKernel.scheduleTokens.has(5), true,
        'the lifecycle ACK must restore a transition node consumed during the command');

    const memberOnlyKernel = new ColdSimulationKernel({ resolveSolo: resolver, emit: () => {}, now: () => now });
    memberOnlyKernel.upsert({ state: state(4, { party: { partyId: 'member-only' } }), context: {} });
    assert.strictEqual(memberOnlyKernel.heap.size, 0,
        'party members must be scheduled only through their leader');
    assert.strictEqual(memberOnlyKernel.snapshot().due, 0,
        'party members must not inflate independent worker due-age telemetry');

    let recoveryNow = now;
    const recoveryKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: () => {},
        now: () => recoveryNow,
        claimAckTimeoutMs: 5000
    });
    recoveryKernel.upsert({ state: state(6), context: { spot: { id: 'spot' } } });
    recoveryKernel.tick();
    assert.strictEqual(recoveryKernel.snapshot().claiming, 1);
    recoveryNow += 5001;
    recoveryKernel.tick();
    assert.strictEqual(recoveryKernel.snapshot().claiming, 0,
        'a lost claim ACK must not leave a bot permanently claiming');
    assert.strictEqual(recoveryKernel.snapshot().claimRecoveries, 1);
    assert.strictEqual(recoveryKernel.scheduleTokens.has(6), true);

    recoveryNow += 1000;
    recoveryKernel.tick();
    recoveryKernel.onClaimAck({ grants: [{
        ok: true, characterId: 6, ownerId: 'cold_simulation_owner', revision: 4,
        leaseId: 'lost-commit-ack', leaseUntil: recoveryNow + 1000
    }] });
    await recoveryKernel.resolveChain;
    assert.strictEqual(recoveryKernel.snapshot().inFlight, 1);
    recoveryNow += 1001;
    recoveryKernel.tick();
    assert.strictEqual(recoveryKernel.snapshot().inFlight, 0,
        'an expired lease after a lost commit ACK must release the worker busy fence');
    assert.strictEqual(recoveryKernel.snapshot().dirty, 0,
        'an expired proposal must never be retried outside its lease CAS boundary');
    assert.strictEqual(recoveryKernel.snapshot().leaseRecoveries, 1);
    assert.strictEqual(recoveryKernel.scheduleTokens.has(6), true);

    const orphanKernel = new ColdSimulationKernel({ resolveSolo: resolver, emit: () => {}, now: () => recoveryNow });
    orphanKernel.upsert({
        state: state(7, { timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow + 30000 } }),
        context: { spot: { id: 'spot' } }
    });
    const orphanedEntry = orphanKernel.heap.pop();
    orphanKernel.consumeHeapEntry(orphanedEntry);
    assert.strictEqual(orphanKernel.scheduleTokens.has(7), false);
    orphanKernel.tick();
    assert.strictEqual(orphanKernel.scheduleTokens.has(7), true,
        'the periodic invariant sweep must restore an orphaned schedulable state');
    assert.strictEqual(orphanKernel.snapshot().orphanRecoveries, 1);

    const ackRaceKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: () => {},
        now: () => recoveryNow,
        orphanSweepIntervalMs: 1000
    });
    ackRaceKernel.upsert({ state: state(8, {
        timing: { lastResolvedAt: recoveryNow - 1000, nextResolveAt: recoveryNow }
    }), context: { spot: { id: 'spot' } } });
    ackRaceKernel.tick();
    ackRaceKernel.onClaimAck({ grants: [{
        ok: true, characterId: 8, ownerId: 'cold_simulation_owner', revision: 4,
        leaseId: 'catalog-before-ack', leaseUntil: recoveryNow + 30000
    }] });
    await ackRaceKernel.resolveChain;
    ackRaceKernel.upsert({ state: state(8, {
        timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow },
        simulation: { ownerId: 'legacy_main', revision: 5, leaseId: null, leaseUntil: 0 }
    }), context: { spot: { id: 'newer-catalog' } } });
    assert.strictEqual(ackRaceKernel.scheduleTokens.has(8), false,
        'a newer catalog snapshot must not schedule a second writer while the prior revision is in flight');
    ackRaceKernel.onCommitAck({ results: [{
        ok: true,
        characterId: 8,
        state: state(8, {
            timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow },
            simulation: { ownerId: 'legacy_main', revision: 4, leaseId: null, leaseUntil: 0 }
        })
    }] });
    assert.strictEqual(ackRaceKernel.scheduleTokens.has(8), true,
        'a stale ACK must explicitly restore scheduling for the newer cached revision');
    recoveryNow += 1000;
    ackRaceKernel.tick();
    ackRaceKernel.tick();
    assert.strictEqual(ackRaceKernel.snapshot().orphanRecoveries, 0,
        'ordinary catalog/ACK races must not be counted as orphan recovery');

    const partyMessages = [];
    const members = [
        state(20, { party: { partyId: 'party-20' } }),
        state(21, { party: { partyId: 'party-20' } })
    ];
    const party = { partyId: 'party-20', leaderId: 20, memberIds: [20, 21], stats: {}, nextResolveAt: 2000 };
    const partyKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: ({ members: partyMembers, timestamp }) => ({
            memberResults: partyMembers.map((member) => ({ state: member, result: resolver({ state: member, rng: () => 0.5, timestamp }) })),
            events: [],
            partyPatch: { cohesion: 0.8, stats: { fightsResolved: 1 } },
            nextResolveAt: timestamp + 45000
        }),
        emit: (type, payload) => partyMessages.push({ type, payload }),
        now: () => now
    });
    partyKernel.upsert({ state: members[0], context: { isPartyLeader: true, party, partyMembers: members, spot: { id: 'party-spot' } } });
    partyKernel.upsert({ state: members[1], context: {} });
    partyKernel.upsert({
        state: {
            ...members[1],
            simulation: { ownerId: 'legacy_main', revision: 9, leaseId: null, leaseUntil: 0 }
        },
        context: {}
    });
    partyKernel.tick();
    const partyClaim = partyMessages.shift();
    assert.strictEqual(partyClaim.type, 'claim_request');
    assert.deepStrictEqual(partyClaim.payload.candidates.map((candidate) => candidate.characterId), [20, 21]);
    assert.deepStrictEqual(partyClaim.payload.candidates.map((candidate) => candidate.expectedRevision), [3, 9],
        'party claims must use current member revisions instead of the leader context snapshot');
    assert(partyClaim.payload.candidates.every((candidate) => candidate.purpose.kind === 'party'));
    partyKernel.onClaimAck({
        grants: partyClaim.payload.candidates.map((candidate) => ({
            ok: true,
            characterId: candidate.characterId,
            ownerId: 'cold_simulation_owner',
            revision: candidate.expectedRevision + 1,
            leaseId: `party-lease-${candidate.characterId}`,
            leaseUntil: now + 30000,
            purpose: candidate.purpose
        }))
    });
    await partyKernel.resolveChain;
    const partyProposal = partyMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(partyProposal.payload.proposals.length, 2, 'party compute must produce one CAS proposal per claimed member');
    assert(partyProposal.payload.proposals.every((proposalEntry) => proposalEntry.options.allowParty === true));
    assert(partyProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 20).partyResolution,
        'the leader proposal must carry the party durable update');
    assert(!partyMessages.some((entry) => entry.type === 'command_request'), 'party combat compute must never fall back to main');

    const expiredPartyMessages = [];
    const expiredPartyMembers = [
        state(22, {
            activity: 'grouped',
            party: { partyId: 'expired-party', leaderId: 22 },
            stats: { partyRequest: { status: 'open', priority: 'required' } }
        }),
        state(23, {
            activity: 'traveling',
            party: { partyId: 'expired-party', leaderId: 22 },
            stats: {
                partyRequest: { status: 'open', priority: 'required' },
                travel: { reason: 'party_spot_replan', spotId: 'old-party-spot' }
            }
        })
    ];
    const expiredParty = {
        partyId: 'expired-party',
        leaderId: 22,
        memberIds: [22, 23],
        spotId: 'old-party-spot',
        startedAt: now - 120000,
        stats: { sessionExpiresAt: now - 1 }
    };
    const expiredPartyKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('expired party must not enter combat'); },
        emit: (type, payload) => expiredPartyMessages.push({ type, payload }),
        now: () => now
    });
    expiredPartyKernel.upsert({
        state: expiredPartyMembers[0],
        context: { isPartyLeader: true, party: expiredParty, partyMembers: expiredPartyMembers, spot: { id: 'old-party-spot' } }
    });
    expiredPartyKernel.upsert({ state: expiredPartyMembers[1], context: {} });
    expiredPartyKernel.tick();
    const expiredClaim = expiredPartyMessages.shift();
    assert.strictEqual(expiredClaim.type, 'claim_request');
    expiredPartyKernel.onClaimAck({
        grants: expiredClaim.payload.candidates.map((candidate) => ({
            ok: true,
            characterId: candidate.characterId,
            ownerId: 'cold_simulation_owner',
            revision: candidate.expectedRevision + 1,
            leaseId: `expired-party-lease-${candidate.characterId}`,
            leaseUntil: now + 30000,
            purpose: candidate.purpose
        }))
    });
    await expiredPartyKernel.resolveChain;
    const expiryProposal = expiredPartyMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(expiryProposal.payload.proposals.length, 2, 'expired party release must include every member');
    assert(expiryProposal.payload.proposals.every((proposalEntry) => proposalEntry.atomicGroup?.memberIds.join(',') === '22,23'));
    assert(expiryProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.party.partyId === null));
    assert(expiryProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.stats.partyRequest === null));
    assert.strictEqual(expiryProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 22)
        .partyResolution.party.status, 'dissolved');
    assert.strictEqual(expiryProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 23)
        .nextState.activity, 'hunting', 'party travel must not re-enter grouped state after expiry');

    const expiryScheduleMessages = [];
    let expiryScheduleNow = now;
    const expiryScheduleMembers = [
        state(25, {
            timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: expiryScheduleNow + 60000 },
            party: { partyId: 'scheduled-expiry-party', leaderId: 25 }
        }),
        state(26, {
            timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: expiryScheduleNow + 60000 },
            party: { partyId: 'scheduled-expiry-party', leaderId: 25 }
        })
    ];
    const expiryScheduleParty = {
        partyId: 'scheduled-expiry-party',
        leaderId: 25,
        memberIds: [25, 26],
        nextResolveAt: expiryScheduleNow + 60000,
        stats: { sessionExpiresAt: expiryScheduleNow + 5000 }
    };
    const expiryScheduleKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: resolver,
        emit: (type, payload) => expiryScheduleMessages.push({ type, payload }),
        now: () => expiryScheduleNow
    });
    expiryScheduleKernel.upsert({
        state: expiryScheduleMembers[0],
        context: {
            isPartyLeader: true,
            party: expiryScheduleParty,
            partyMembers: expiryScheduleMembers,
            spot: { id: 'scheduled-expiry-spot' }
        }
    });
    expiryScheduleKernel.upsert({ state: expiryScheduleMembers[1], context: {} });
    expiryScheduleKernel.tick();
    assert.strictEqual(expiryScheduleMessages.length, 0,
        'a valid party must remain scheduled until its earliest resolve or expiry');
    expiryScheduleNow += 5001;
    expiryScheduleKernel.tick();
    assert.strictEqual(expiryScheduleMessages[0].type, 'claim_request',
        'a valid party must be claimed at session expiry even when nextResolveAt is later');

    const singletonMessages = [];
    let singletonNow = now;
    const singletonMember = state(24, {
        activity: 'grouped',
        timing: { lastResolvedAt: singletonNow - 1000, nextResolveAt: singletonNow + 60000 },
        party: { partyId: 'singleton-party', leaderId: 24 },
        stats: { sessionExpiresAt: singletonNow + 5000 }
    });
    const singletonParty = {
        partyId: 'singleton-party',
        leaderId: 24,
        memberIds: [24],
        nextResolveAt: singletonNow + 60000,
        stats: { sessionExpiresAt: singletonNow + 5000 }
    };
    const singletonKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('singleton party must be cleaned up before combat'); },
        emit: (type, payload) => singletonMessages.push({ type, payload }),
        now: () => singletonNow
    });
    singletonKernel.upsert({
        state: singletonMember,
        context: {
            isPartyLeader: true,
            party: singletonParty,
            partyMembers: [singletonMember],
            spot: { id: 'singleton-spot' }
        }
    });
    singletonKernel.tick();
    const singletonClaim = singletonMessages.shift();
    assert.strictEqual(singletonClaim.type, 'claim_request', 'invalid singleton must enter the cleanup path immediately');
    assert.deepStrictEqual(singletonClaim.payload.candidates.map((candidate) => candidate.characterId), [24]);
    assert.strictEqual(singletonClaim.payload.candidates[0].purpose.invalidReason, 'party_min_size');
    singletonKernel.onClaimAck({
        grants: singletonClaim.payload.candidates.map((candidate) => ({
            ok: true,
            characterId: candidate.characterId,
            ownerId: 'cold_simulation_owner',
            revision: candidate.expectedRevision + 1,
            leaseId: 'singleton-party-lease',
            leaseUntil: singletonNow + 30000,
            purpose: candidate.purpose
        }))
    });
    await singletonKernel.resolveChain;
    const singletonProposal = singletonMessages.find((entry) => entry.type === 'proposal_batch');
    assert(singletonProposal, 'invalid singleton must produce a durable release proposal');
    assert.strictEqual(singletonProposal.payload.proposals.length, 1);
    assert.strictEqual(singletonProposal.payload.proposals[0].nextState.party.partyId, null);
    assert.strictEqual(singletonProposal.payload.proposals[0].nextState.activity, 'hunting',
        'invalid party cleanup must return the member to solo hunting');
    assert.strictEqual(singletonProposal.payload.proposals[0].partyResolution.party.status, 'dissolved');
    assert.strictEqual(singletonProposal.payload.proposals[0].partyResolution.party.stats.partyBreakReason, 'party_min_size');

    const partyRouteMessages = [];
    const partyRouteMembers = [
        state(30, {
            level: 16,
            activity: 'grouped',
            party: { partyId: 'route-party' },
            spotId: 'starter-field',
            loc: { locX: 115000, locY: -176000, locZ: -1000 }
        }),
        state(31, {
            level: 16,
            activity: 'grouped',
            party: { partyId: 'route-party' },
            spotId: 'starter-field',
            loc: { locX: 115100, locY: -176100, locZ: -1000 }
        })
    ];
    const partyRouteParty = {
        partyId: 'route-party',
        leaderId: 30,
        memberIds: [30, 31],
        spotId: 'starter-field',
        stats: {},
        nextResolveAt: 2000
    };
    const partyRoute = {
        needed: true,
        mode: 'party',
        currentSpotId: 'starter-field',
        spotId: 'mid-level-field',
        regionName: 'Mid-level fields',
        travelMs: 25000,
        destinations: {
            30: { locX: 125000, locY: -176000, locZ: -1000 },
            31: { locX: 125100, locY: -176100, locZ: -1000 }
        }
    };
    const partyRouteKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('party combat must not run during route travel'); },
        emit: (type, payload) => partyRouteMessages.push({ type, payload }),
        now: () => now
    });
    partyRouteKernel.upsert({
        state: partyRouteMembers[0],
        context: {
            isPartyLeader: true,
            party: partyRouteParty,
            partyMembers: partyRouteMembers,
            spot: { id: 'starter-field' },
            route: partyRoute
        }
    });
    partyRouteKernel.upsert({ state: partyRouteMembers[1], context: {} });
    partyRouteKernel.tick();
    const partyRouteClaim = partyRouteMessages.shift();
    partyRouteKernel.onClaimAck({
        grants: partyRouteClaim.payload.candidates.map((candidate) => ({
            ok: true,
            characterId: candidate.characterId,
            ownerId: 'cold_simulation_owner',
            revision: candidate.expectedRevision + 1,
            leaseId: `route-party-lease-${candidate.characterId}`,
            leaseUntil: now + 30000,
            purpose: candidate.purpose
        }))
    });
    await partyRouteKernel.resolveChain;
    const partyRouteProposal = partyRouteMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(partyRouteProposal.payload.proposals.length, 2);
    assert(partyRouteProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.activity === 'traveling'),
        'a party route must move every member into the same finite travel state');
    assert(partyRouteProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.stats.travel.spotId === 'mid-level-field'));
    assert.strictEqual(partyRouteProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 30)
        .partyResolution.party.stats.travel.spotId, 'mid-level-field');

    const compactFallbackMessages = [];
    const compactFallbackKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('compact party fallback must wait for the authoritative member state'); },
        emit: (type, payload) => compactFallbackMessages.push({ type, payload }),
        now: () => now
    });
    const compactLeader = state(35, { party: { partyId: 'compact-party' } });
    const compactMember = {
        characterId: 36,
        phase: 'cold',
        activity: 'grouped',
        partyId: 'compact-party',
        party: { partyId: 'compact-party' },
        simulation: { ownerId: 'legacy_main', revision: 3 },
        compact: true
    };
    compactFallbackKernel.upsert({
        state: compactLeader,
        context: {
            isPartyLeader: true,
            party: { partyId: 'compact-party', leaderId: 35, memberIds: [35, 36] },
            partyMembers: [compactLeader, compactMember]
        }
    });
    compactFallbackKernel.tick();
    assert(!compactFallbackMessages.some((entry) => entry.type === 'claim_request'),
        'a compact party reference must wait until its full authoritative state is loaded');

    const capacityMessages = [];
    const capacityKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: now + 60000 }),
        emit: (type, payload) => capacityMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 64
    });
    const capacityMembers = Array.from({ length: 5 }, (_, index) => state(40 + index, { party: { partyId: 'capacity-party' } }));
    const capacityParty = { partyId: 'capacity-party', leaderId: 40, memberIds: capacityMembers.map((member) => member.characterId) };
    capacityMembers.forEach((member, index) => capacityKernel.upsert({
        state: member,
        context: index === 0 ? { isPartyLeader: true, party: capacityParty, partyMembers: capacityMembers, spot: { id: 'spot' } } : {}
    }));
    for (let id = 1000; id < 1062; id++) capacityKernel.claiming.add(id);
    capacityKernel.tick();
    assert(!capacityMessages.some((entry) => entry.type === 'claim_request'), 'a party must wait when remaining capacity cannot admit every member');
    assert(capacityMembers.every((member) => !capacityKernel.claiming.has(member.characterId)),
        'capacity deferral must not mark unsent party members as claiming');
    capacityKernel.claiming.clear();
    now += 100;
    capacityKernel.tick();
    assert.strictEqual(capacityMessages.find((entry) => entry.type === 'claim_request').payload.candidates.length, 5,
        'the next eligible tick must admit the entire party atomically');

    const fenceKernel = new ColdSimulationKernel({ resolveSolo: resolver, emit: () => {}, now: () => now });
    fenceKernel.upsert({ state: state(9), context: { spot: { id: 'spot' } } });
    fenceKernel.tick();
    fenceKernel.onClaimAck({ grants: [{
        ok: true, characterId: 9, ownerId: 'cold_simulation_owner', revision: 4, leaseId: 'fence-lease', leaseUntil: now + 30000
    }] });
    await fenceKernel.resolveChain;
    const fenced = fenceKernel.fence(9);
    assert.strictEqual(fenced.characterId, 9);
    assert(fenced.proposal, 'activation fence must return the latest uncommitted proposal');
    assert.strictEqual(fenceKernel.snapshot().inFlight, 0);

    const errorMessages = [];
    const errorKernel = new ColdSimulationKernel({
        resolveSolo: () => { throw new Error('synthetic_resolver_error'); },
        emit: (type, payload) => errorMessages.push({ type, payload }),
        now: () => now
    });
    errorKernel.upsert({ state: state(30), context: { spot: { id: 'spot' } } });
    errorKernel.tick();
    errorKernel.onClaimAck({ grants: [{
        ok: true, characterId: 30, ownerId: 'cold_simulation_owner', revision: 4,
        leaseId: 'error-lease', leaseUntil: now + 30000
    }] });
    await errorKernel.resolveChain;
    const release = errorMessages.find((entry) => entry.type === 'release_request');
    assert.strictEqual(release.payload.releases[0].token.leaseId, 'error-lease', 'resolver errors must release the exact lease');
    assert.strictEqual(errorKernel.snapshot().errors, 1);

    console.log('Cold worker protocol, deterministic kernel, scheduling, and fence checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

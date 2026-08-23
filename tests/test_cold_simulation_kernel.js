const assert = require('assert');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const {
    ColdSimulationKernel,
    beginRouteTravelState,
    deterministicRandom,
    finishPartyRouteTravelState,
    lifecycleKind,
    nextDueAt,
    partyTransitionProposals
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
    kernel.flushDue();
    assert(!emitted.some((entry) => entry.type === 'proposal_batch'),
        'an ordinary partial window must still wait for the flush target');
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

    const staleLeaderRun = {
        party: { partyId: 'bgp_stale_leader', leaderId: 99, memberIds: [99, 1, 2] },
        members: [state(1), state(2)],
        grants: new Map([
            [1, { leaseId: 'stale-1', revision: 4 }],
            [2, { leaseId: 'stale-2', revision: 4 }]
        ])
    };
    const staleLeaderProposals = partyTransitionProposals(
        staleLeaderRun,
        staleLeaderRun.members,
        { ...staleLeaderRun.party, status: 'dissolved' },
        5000,
        { type: 'party_invalid_size' },
        'party_invalid_size'
    );
    assert.strictEqual(staleLeaderProposals.filter((proposal) => proposal.partyResolution).length, 1,
        'an invalid party must still persist its resolution when the declared leader is no longer attached');
    assert.strictEqual(staleLeaderProposals[0].partyResolution.partyId, staleLeaderRun.party.partyId);
    assert.deepStrictEqual(staleLeaderProposals[0].result.events, [
        { type: 'party_invalid_size', characterId: 1 }
    ], 'the fallback attached member must receive the party lifecycle event');

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

    const stalePartyMessages = [];
    let stalePartyNow = now;
    const stalePartyMembers = [
        state(220, { party: { partyId: 'stale-party-220', leaderId: 220 } }),
        state(221, { party: { partyId: 'stale-party-220', leaderId: 220 } })
    ];
    const staleParty = {
        partyId: 'stale-party-220',
        leaderId: 220,
        memberIds: [220, 221],
        stats: {},
        nextResolveAt: stalePartyNow
    };
    const stalePartyKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('partial stale party claim must not resolve'); },
        emit: (type, payload) => stalePartyMessages.push({ type, payload }),
        now: () => stalePartyNow
    });
    stalePartyKernel.upsert({
        state: stalePartyMembers[0],
        context: { isPartyLeader: true, party: staleParty, partyMembers: stalePartyMembers, spot: { id: 'stale-party-spot' } }
    });
    stalePartyKernel.upsert({ state: stalePartyMembers[1], context: {} });
    stalePartyKernel.tick();
    const stalePartyClaim = stalePartyMessages.shift();
    const leaderCandidate = stalePartyClaim.payload.candidates.find((candidate) => candidate.characterId === 220);
    const memberCandidate = stalePartyClaim.payload.candidates.find((candidate) => candidate.characterId === 221);
    const refreshedMember = {
        ...stalePartyMembers[1],
        simulation: { ownerId: 'legacy_main', revision: 9, leaseId: null, leaseUntil: 0 }
    };
    stalePartyKernel.onClaimAck({
        grants: [{
            ok: true,
            characterId: 220,
            ownerId: 'cold_simulation_owner',
            revision: leaderCandidate.expectedRevision + 1,
            leaseId: 'stale-party-leader-lease',
            leaseUntil: stalePartyNow + 30000,
            purpose: leaderCandidate.purpose
        }],
        rejected: [{
            ok: false,
            characterId: 221,
            reason: 'stale_revision',
            expectedRevision: memberCandidate.expectedRevision,
            actualRevision: 9,
            actualOwner: 'legacy_main',
            state: refreshedMember,
            context: {},
            purpose: memberCandidate.purpose
        }]
    });
    assert.strictEqual(stalePartyKernel.states.get(221).state.simulation.revision, 9,
        'a stale party claim must refresh the member revision before retrying');
    const partialRelease = stalePartyMessages.find((entry) => entry.type === 'release_request');
    assert(partialRelease, 'a partial party claim must release grants accepted before the rejection');
    stalePartyKernel.onReleaseAck({ results: [{
        ok: true,
        characterId: 220,
        state: {
            ...stalePartyMembers[0],
            simulation: { ownerId: 'legacy_main', revision: 5, leaseId: null, leaseUntil: 0 }
        },
        context: { isPartyLeader: true, party: staleParty, partyMembers: stalePartyMembers, spot: { id: 'stale-party-spot' } }
    }] });
    stalePartyNow += 1000;
    stalePartyKernel.tick();
    const retriedPartyClaim = stalePartyMessages.find((entry) => entry.type === 'claim_request');
    assert.deepStrictEqual(
        retriedPartyClaim.payload.candidates.map((candidate) => candidate.expectedRevision),
        [5, 9],
        'the next party claim must use revisions returned by release and stale ACKs'
    );

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

    const partyDue = expiryScheduleNow + 3000;
    const partyDueLeader = state(27, {
        timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: null },
        party: { partyId: 'party-row-scheduled', leaderId: 27 }
    });
    const partyDueMember = state(28, {
        timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: null },
        party: { partyId: 'party-row-scheduled', leaderId: 27 }
    });
    const partyDueContext = {
        isPartyLeader: true,
        party: {
            partyId: 'party-row-scheduled',
            leaderId: 27,
            memberIds: [27, 28],
            nextResolveAt: partyDue,
            stats: { sessionExpiresAt: expiryScheduleNow + 60000 }
        },
        partyMembers: [partyDueLeader, partyDueMember]
    };
    assert.strictEqual(nextDueAt(partyDueLeader, expiryScheduleNow, partyDueContext), partyDue,
        'a newly assigned leader with no personal due time must use the durable party schedule');
    assert.strictEqual(nextDueAt({
        ...partyDueLeader,
        timing: { ...partyDueLeader.timing, nextResolveAt: expiryScheduleNow + 1000 }
    }, expiryScheduleNow, partyDueContext), partyDue,
        'a stale leader schedule must not outrun the authoritative party row');

    const priorityParty = {
        ...partyDueContext.party,
        nextResolveAt: expiryScheduleNow
    };
    const priorityContext = { ...partyDueContext, party: priorityParty };
    const partyCapacityKernel = new ColdSimulationKernel({ now: () => expiryScheduleNow, resolveSolo: resolver });
    partyCapacityKernel.upsert({ state: partyDueLeader, context: priorityContext });
    partyCapacityKernel.upsert({ state: partyDueMember, context: {} });
    assert.deepStrictEqual(partyCapacityKernel.dueCandidates(expiryScheduleNow, 1), [],
        'an atomic party claim must wait when the current capacity cannot fit every member');
    assert.strictEqual(partyCapacityKernel.dueCandidates(expiryScheduleNow, 2).length, 2,
        'a capacity-blocked party must retain priority instead of moving behind overdue solo work');

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

    const burstMessages = [];
    const burstKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: (type, payload) => burstMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 3
    });
    for (let id = 80; id < 85; id++) burstKernel.upsert({
        state: state(id, { timing: { lastResolvedAt: 1000, nextResolveAt: now - 1 } }),
        context: { spot: { id: 'spot' } }
    });
    burstKernel.tick();
    const burstClaim = burstMessages.find((entry) => entry.type === 'claim_request');
    assert.strictEqual(burstClaim.payload.candidates.length, 3,
        'a catch-up tick must honor the smaller in-flight burst even when the protocol batch is larger');

    const renewalKernel = new ColdSimulationKernel({ resolveSolo: resolver, now: () => now });
    const renewalGrant = {
        ok: true,
        characterId: 90,
        ownerId: 'cold_simulation_owner',
        revision: 4,
        leaseId: 'renewal-lease',
        leaseUntil: now + 1000
    };
    renewalKernel.inFlight.set(90, {
        grant: renewalGrant,
        state: state(90),
        context: {},
        startedAt: now
    });
    renewalKernel.onLeaseRenewal({ renewals: [{
        ...renewalGrant,
        leaseUntil: now + 10000
    }] });
    assert.strictEqual(renewalKernel.snapshot().leaseRenewals, 1,
        'worker must accept a matching lease renewal for an active claim');
    renewalKernel.recoverStalled(now + 2000);
    assert.strictEqual(renewalKernel.snapshot().leaseRecoveries, 0,
        'a renewed claim must not be recovered using its old deadline');
    assert.strictEqual(renewalKernel.inFlight.get(90).grant.leaseUntil, now + 10000);

    const oversizedInventory = Object.fromEntries(Array.from({ length: 1200 }, (_, index) => [
        String(index), {
            selfId: index + 1000,
            name: `Oversized item ${index} ${'x'.repeat(42)}`,
            amount: index + 1,
            kind: 'Other.Material'
        }
    ]));
    const oversizedState = state(91, {
        inventory: oversizedInventory,
        stats: { equipmentPlan: { status: 'active' } },
        simulation: { ownerId: 'cold_simulation_owner', revision: 5, leaseId: 'oversized-lease', leaseUntil: now + 30000 }
    });
    const oversizedEmitted = [];
    const oversizedKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: (type, payload) => oversizedEmitted.push({ type, payload }),
        now: () => now + 10000
    });
    const oversizedProposal = {
        proposalId: 'oversized-lease:5',
        characterId: 91,
        priority: 'P2',
        enqueuedAt: now,
        token: {
            ok: true,
            characterId: 91,
            ownerId: 'cold_simulation_owner',
            revision: 5,
            leaseId: 'oversized-lease',
            leaseUntil: now + 30000
        },
        baseState: oversizedState,
        nextState: oversizedState,
        durable: null,
        result: {
            patch: { inventory: oversizedInventory, stats: oversizedState.stats },
            events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: now + 30000,
            debug: { activity: 'hunting' }
        },
        options: { allowLifecycle: true }
    };
    oversizedKernel.inFlight.set(91, {
        grant: oversizedProposal.token,
        state: oversizedState,
        context: {},
        startedAt: now
    });
    oversizedKernel.dirty.set(91, oversizedProposal);
    oversizedKernel.flushDue();
    const compactedMessage = oversizedEmitted.find((entry) => entry.type === 'proposal_batch');
    assert(compactedMessage, 'an oversized first proposal must be compacted and emitted');
    assert(Protocol.validateEnvelope(
        Protocol.envelope('proposal_batch', 'epoch', compactedMessage.payload),
        'worker',
        { workerEpoch: 'epoch' }
    ).ok, 'compacted proposal batch must stay within the IPC envelope limit');
    assert.strictEqual(compactedMessage.payload.proposals[0].result.patch, undefined,
        'compacted proposals must remove duplicate result state when nextState is present');
    assert.strictEqual(oversizedKernel.snapshot().dirty, 0,
        'an oversized first proposal must not remain stuck in the dirty queue');
    assert.strictEqual(oversizedKernel.snapshot().proposalCompactions, 1);
    assert.strictEqual(oversizedKernel.snapshot().proposalOversize, 1);

    const capacityFlushMessages = [];
    const capacityFlushKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: (type, payload) => capacityFlushMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 8,
        flushTargetMs: 2000,
        flushHardMs: 5000
    });
    const capacityFlushStates = Array.from({ length: 8 }, (_, index) => state(200 + index));
    capacityFlushStates.forEach((entry) => capacityFlushKernel.upsert({
        state: entry,
        context: { spot: { id: 'spot', rewards: {} } }
    }));
    capacityFlushKernel.tick();
    const capacityFlushClaim = capacityFlushMessages.shift();
    assert.strictEqual(capacityFlushClaim.payload.candidates.length, 8);
    capacityFlushKernel.onClaimAck({
        grants: capacityFlushStates.map((entry) => ({
            ok: true,
            characterId: entry.characterId,
            ownerId: 'cold_simulation_owner',
            revision: 4,
            leaseId: `capacity-flush-${entry.characterId}`,
            leaseUntil: now + 30000
        }))
    });
    await capacityFlushKernel.resolveChain;
    assert.strictEqual(capacityFlushKernel.snapshot().dirty, 8);
    assert.strictEqual(capacityFlushKernel.flushDue(), 8,
        'a full ownership window must flush immediately instead of waiting two seconds');
    const capacityFlushBatch = capacityFlushMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(capacityFlushBatch.payload.proposals.length, 8);
    assert.strictEqual(capacityFlushKernel.snapshot().dirty, 0);
    assert.strictEqual(capacityFlushKernel.snapshot().flushReasons.capacity, 1);
    assert.strictEqual(capacityFlushKernel.snapshot().lastFlushRows, 8);

    const throttledPartyMessages = [];
    const throttledPartyKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: now + 60000 }),
        emit: (type, payload) => throttledPartyMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 4
    });
    const throttledPartyMembers = Array.from({ length: 5 }, (_, index) => state(40 + index, {
        party: { partyId: 'throttled-party' }
    }));
    const throttledParty = {
        partyId: 'throttled-party',
        leaderId: 40,
        memberIds: throttledPartyMembers.map((member) => member.characterId)
    };
    throttledPartyKernel.upsert({ state: state(39), context: { spot: { id: 'spot' } } });
    throttledPartyMembers.forEach((member, index) => throttledPartyKernel.upsert({
        state: member,
        context: index === 0 ? {
            isPartyLeader: true,
            party: throttledParty,
            partyMembers: throttledPartyMembers,
            spot: { id: 'spot' }
        } : {}
    }));
    throttledPartyKernel.upsert({ state: state(100), context: { spot: { id: 'spot' } } });
    throttledPartyKernel.tick();
    const throttledClaim = throttledPartyMessages.find((entry) => entry.type === 'claim_request');
    assert.deepStrictEqual(throttledClaim.payload.candidates.map((candidate) => candidate.characterId), [39, 100],
        'a busy ownership window must defer an oversized atomic party without blocking eligible solo work');
    assert.strictEqual(throttledPartyKernel.snapshot().partyCapacityDeferrals, 1);
    assert(throttledPartyMembers.every((member) => !throttledPartyKernel.claiming.has(member.characterId)),
        'a throttled atomic party must remain unclaimed until the ownership window recovers');

    const atomicBurstMessages = [];
    const atomicBurstKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        resolveParty: () => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: now + 60000 }),
        emit: (type, payload) => atomicBurstMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 2,
        maxAtomicPartySize: 5
    });
    throttledPartyMembers.forEach((member, index) => atomicBurstKernel.upsert({
        state: member,
        context: index === 0 ? {
            isPartyLeader: true,
            party: throttledParty,
            partyMembers: throttledPartyMembers,
            spot: { id: 'spot' }
        } : {}
    }));
    atomicBurstKernel.tick();
    const atomicBurstClaim = atomicBurstMessages.find((entry) => entry.type === 'claim_request');
    assert.deepStrictEqual(
        atomicBurstClaim.payload.candidates.map((candidate) => candidate.characterId),
        [40, 41, 42, 43, 44],
        'an empty throttled ownership window must admit one bounded atomic party'
    );
    assert.strictEqual(atomicBurstKernel.snapshot().partyCapacityBursts, 1);
    assert.strictEqual(atomicBurstKernel.snapshot().partyCapacityDeferrals, 0);

    const boundedBurstMessages = [];
    const boundedBurstKernel = new ColdSimulationKernel({
        resolveSolo: resolver,
        emit: (type, payload) => boundedBurstMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 2,
        maxAtomicPartySize: 5
    });
    const oversizedPartyMembers = Array.from({ length: 6 }, (_, index) => state(50 + index, {
        party: { partyId: 'oversized-party' }
    }));
    const oversizedParty = {
        partyId: 'oversized-party',
        leaderId: 50,
        memberIds: oversizedPartyMembers.map((member) => member.characterId)
    };
    oversizedPartyMembers.forEach((member, index) => boundedBurstKernel.upsert({
        state: member,
        context: index === 0 ? {
            isPartyLeader: true,
            party: oversizedParty,
            partyMembers: oversizedPartyMembers,
            spot: { id: 'spot' }
        } : {}
    }));
    boundedBurstKernel.upsert({ state: state(100), context: { spot: { id: 'spot' } } });
    boundedBurstKernel.tick();
    const boundedBurstClaim = boundedBurstMessages.find((entry) => entry.type === 'claim_request');
    assert.deepStrictEqual(boundedBurstClaim.payload.candidates.map((candidate) => candidate.characterId), [100],
        'a party above the configured atomic bound must defer without blocking solo work');
    assert.strictEqual(boundedBurstKernel.snapshot().partyCapacityBursts, 0);
    assert.strictEqual(boundedBurstKernel.snapshot().partyCapacityDeferrals, 1);

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

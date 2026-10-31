process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const {
    ColdSimulationKernel,
    deterministicRandom,
    finishPartyRouteTravelState,
    lifecycleKind,
    nextDueAt,
    partyTransitionProposals
} = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');

// The facts a kernel gives the free functions (its parties table, its
// states, the board's escrow) for a bot that leads `party`.
const leading = (party, members = []) => ({ leaderParty: () => party, partyMembers: () => members, buyOrderEscrow: () => 0,
    hallNeeded: () => false, playerWaiting: () => false });

function state(characterId = 1, overrides = {}) {
    return {
        characterId,
        phase: 'cold',
        activity: 'hunting',
        level: 20,
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 },
        stats: {},
        simulation: { revision: 3 },
        updatedAt: 1000,
        ...overrides
    };
}


// The steps each tick started (new inFlight entries, in start order): a step
// starts from the kernel's own copy at the tick, with no message to main.
const startedSteps = new WeakMap();
const sentProposals = new WeakMap();
const sentCommands = new WeakMap();
// The spot the worker finds a bot standing at (its spotOf), as the fixture states it.
const standing = new WeakMap();
function standOn(kernel, entry, spot) {
    standing.get(kernel).set(Number(entry.state.characterId), spot);
    return entry;
}
function recordingKernel(options) {
    let kernel;
    const steps = [];
    const proposals = new Map();
    const commands = new Map();
    const spots = new Map();
    kernel = new ColdSimulationKernel({ spotOf: value => spots.get(Number(value?.characterId)) || null,
        ...options, emit: (type, payload, msgId, ...rest) => {
        if (type === 'proposal_batch') for (const proposal of payload.proposals) proposals.set(proposal.characterId, proposal);
        if (type === 'command_request') for (const request of payload.requests) commands.set(request.characterId, request);
        return options.emit?.(type, payload, msgId, ...rest);
    } });
    const tick = kernel.tick.bind(kernel);
    kernel.tick = (...args) => {
        const before = new Set(kernel.inFlight.keys());
        const result = tick(...args);
        const started = [...kernel.inFlight.keys()].filter(id => !before.has(id));
        if (started.length) steps.push(started);
        return result;
    };
    startedSteps.set(kernel, steps);
    standing.set(kernel, spots);
    sentProposals.set(kernel, proposals);
    sentCommands.set(kernel, commands);
    return kernel;
}
function commandAck(kernel, payload) {
    const request = sentCommands.get(kernel).get(payload.characterId);
    assert(request, 'fixture command ACK echoes an actual sent input');
    return kernel.completeCommand({ ok: true, ...payload, commandId: request.commandId,
        commandCheckpoint: request.commandCheckpoint });
}
function commitAck(kernel, payload) {
    kernel.onCommitAck({ results: payload.results.map(result => {
        const proposal = sentProposals.get(kernel).get(result.characterId);
        assert(proposal, 'fixture commit ACK echoes an actual sent proposal');
        return { ...result, proposalId: proposal.proposalId };
    }) });
}
// The bots the last stepping tick started, and whether a bot ever stepped.
const lastSteps = kernel => startedSteps.get(kernel).at(-1) || [];
const everStepped = (kernel, id) => startedSteps.get(kernel).some(ids => ids.includes(id));

(async () => {
    {
        // Developer diagnostics: every scheduler tick is counted as stepped or
        // as empty with its reason; a not-yet-due head records its distance.
        const PopulationConfig = require('../src/GameServer/Bot/Population/PopulationConfig');
        const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
        const wasOn = PopulationConfig.developerDiagnostics;
        PopulationConfig.developerDiagnostics = true;
        const counts = () => Diagnostics.metrics().counts;
        const before = { ...counts() };
        const added = (key) => (counts()[key] || 0) - (before[key] || 0);
        let at = 1000;
        const probe = recordingKernel({ resolveSolo: () => null, now: () => at, maxInFlight: 1 });
        probe.tick();
        assert.strictEqual(added('worker_tick:empty:heap_empty'), 1);
        probe.upsert({ state: state(91, { timing: { lastResolvedAt: 1000, nextResolveAt: 1500 } }) });
        probe.tick();
        assert.strictEqual(added('worker_tick:empty:not_due'), 1);
        assert.strictEqual(added('worker_tick_gap:lt1s:unknown'), 1);
        at = 2000;
        probe.tick();
        assert.strictEqual(added('worker_tick:stepped:unknown'), 1);
        probe.tick();
        assert.strictEqual(added('worker_tick:empty:no_capacity'), 1);
        probe.paused = true;
        probe.tick();
        assert.strictEqual(added('worker_tick:empty:paused'), 1);
        // A due bot inside a PvP encounter is requeued past it: the tick took due
        // work but started no step, so it is not idle even though the head is not due.
        const encounter = recordingKernel({ resolveSolo: () => null, now: () => at, maxInFlight: 1 });
        encounter.upsert({ state: state(93, { stats: { pvpEncounter: { expiresAt: at + 5000 } },
            timing: { lastResolvedAt: 1000, nextResolveAt: 1500 } }) });
        encounter.tick();
        assert.strictEqual(added('worker_tick:empty:no_step'), 1);
        assert.strictEqual(added('worker_tick:empty:not_due'), 1, 'a requeued bot is not counted as an idle tick');
        const off = { ...counts() };
        PopulationConfig.developerDiagnostics = false;
        probe.paused = false;
        probe.tick();
        PopulationConfig.developerDiagnostics = true;
        assert.deepStrictEqual(counts(), off, 'no tick is counted with developer diagnostics off');
        PopulationConfig.developerDiagnostics = wasOn;
    }

    const valid = Protocol.validateEnvelope(Protocol.envelope('command_request', 'epoch', { requests: [] }), 'worker', { workerEpoch: 'epoch' });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(Protocol.validateEnvelope(null, 'worker').reason, 'invalid_envelope');
    assert.strictEqual(Protocol.validateEnvelope({
        version: 999, type: 'ready', msgId: 'x', workerEpoch: 'epoch', payload: {}
    }, 'worker').reason, 'protocol_version');
    assert.strictEqual(Protocol.validateEnvelope(Protocol.envelope('claim_request', 'epoch', {}), 'worker').reason,
        'message_type', 'no claim message exists: a step needs nothing from main to start');
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
    const kernel = recordingKernel({
        resolveSolo: resolver,
        emit: (type, payload) => emitted.push({ type, payload }),
        now: () => now,
        flushTargetMs: 2000,
        flushHardMs: 5000
    });
    kernel.upsert(standOn(kernel, { state: state() }, { id: 'spot', rewards: {} }));
    kernel.tick();
    assert.deepStrictEqual(emitted, [], 'a step goes out without a claim: the tick sends main nothing');
    assert.deepStrictEqual(lastSteps(kernel), [1]);
    await kernel.resolveChain;
    assert.strictEqual(kernel.snapshot().resolved, 1);
    kernel.flushDue();
    assert(!emitted.some((entry) => entry.type === 'proposal_batch'),
        'an ordinary partial window must still wait for the flush target');
    now += 2000;
    kernel.flushDue();
    const proposalMessage = emitted.find((entry) => entry.type === 'proposal_batch');
    assert(proposalMessage, 'ordinary dirty state must flush at the 2 second target');
    assert.strictEqual(proposalMessage.payload.capacityBlocked, false,
        'a partial ownership window must not request early commit admission');
    const proposal = proposalMessage.payload.proposals[0];
    assert.strictEqual(proposal.priority, 'P2');
    assert.strictEqual(proposal.revision, 3, 'the proposal carries the revision its step started from');
    assert.strictEqual(proposal.proposalId, '1:3000', 'the step is named by its bot and start');
    assert.strictEqual(proposal.token, undefined);

    const first = deterministicRandom(state());
    const second = deterministicRandom(state());
    assert.deepStrictEqual([first(), first(), first()], [second(), second(), second()], 'resolver RNG must replay deterministically');

    const staleLeaderRun = {
        party: { partyId: 'bgp_stale_leader', leaderId: 99, memberIds: [99, 1, 2] },
        members: [state(1), state(2)],
        startedAt: 4000
    };
    const staleLeaderProposals = partyTransitionProposals(
        staleLeaderRun,
        staleLeaderRun.members,
        { ...staleLeaderRun.party, status: 'dissolved' },
        5000,
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

    commitAck(kernel, { results: [{
        ok: true,
        characterId: 1,
        state: state(1, {
            activity: 'resting',
            timing: { lastResolvedAt: now, nextResolveAt: now + 30000 },
            simulation: { revision: 5 }
        })
    }] });
    assert.strictEqual(kernel.snapshot().inFlight, 0);
    assert.strictEqual(kernel.upsert({ state: state(1) }), false,
        'an out-of-order catalog snapshot must not replace a newer committed revision');
    assert.strictEqual(kernel.states.get(1).state.simulation.revision, 5,
        'worker ownership revisions must remain monotonic across catalog refreshes');
    const heapBeforeRefresh = kernel.heap.size;
    const currentState = kernel.states.get(1).state;
    assert.strictEqual(kernel.upsert({ state: { ...currentState } }), true);
    assert.strictEqual(kernel.heap.size, heapBeforeRefresh,
        'same-revision catalog refresh must coalesce without growing the due heap');
    // A near bot's fact post that crossed its cooldown: the cold row came
    // first at the same revision (hot -> cold keeps it), the hot post is stale.
    {
        const nearKernel = recordingKernel({ resolveSolo: () => null, now: () => 1000 });
        const cooled = state(95);
        assert.strictEqual(nearKernel.upsert({ state: cooled }), true);
        assert.strictEqual(nearKernel.upsert({ state: { ...cooled, phase: 'hot' } }), false,
            'a hot row at the cold row\'s revision must not replace the cold row');
        assert.strictEqual(nearKernel.states.get(95).state.phase, 'cold', 'the cooled bot stays a far bot that steps');
        const activated = { ...cooled, phase: 'hot', simulation: { ...cooled.simulation, revision: cooled.simulation.revision + 1 } };
        assert.strictEqual(nearKernel.upsert({ state: activated }), true,
            'a hot row at a higher revision (the handoff moved it) is accepted');
        assert.strictEqual(nearKernel.states.get(95).state.phase, 'hot');
    }

    const route = {
        needed: true,
        mode: 'solo',
        currentSpotId: 'starter-field',
        spotId: 'mid-level-field',
        regionName: 'Mid-level fields',
        travelMs: 25000,
        to: { locX: 125000, locY: -176000, locZ: -1000 }
    };
    const travelState = beginHuntingTrip(state(70, {
        level: 16,
        spotId: 'starter-field',
        loc: { locX: 115000, locY: -176000, locZ: -1000 },
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }
    }), route, 5000);
    assert.strictEqual(travelState.activity, 'traveling', 'an outleveled solo bot must enter a finite travel state');
    assert.strictEqual(travelState.spotId, 'starter-field', 'the old spot remains current until arrival');
    assert.strictEqual(travelState.stats.travel.spotId, 'mid-level-field');
    assert.strictEqual(travelState.stats.travel.arrivalAt, 30000);

    const deathPressureRoute = {
        ...route,
        reason: 'death_pressure_replan',
        cause: 'death_pressure',
        spotBackoff: {
            spotId: 'starter-field',
            reason: 'death_pressure',
            deaths: 2,
            fights: 5,
            deathRate: 0.4,
            startedAt: 5000,
            until: 3605000
        }
    };
    const backedOffTravelState = beginHuntingTrip(state(72, {
        spotId: 'starter-field',
        loc: { locX: 115000, locY: -176000, locZ: -1000 }
    }), deathPressureRoute, 5000);
    assert.strictEqual(backedOffTravelState.stats.travel.reason, 'death_pressure_replan');
    assert.strictEqual(backedOffTravelState.stats.travel.cause, 'death_pressure');
    assert.strictEqual(backedOffTravelState.stats.spotBackoffs[0].spotId, 'starter-field',
        'the travel transition must persist the cooldown before the spot baseline changes on arrival');

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
    const routeKernel = recordingKernel({
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
        // The worker's plan starts the bot's own route (BotRoute) in its step.
        planLifecycle: ({ state: current, timestamp }) => ({
            plannedState: beginHuntingTrip(current, route, timestamp) || current
        }),
        emit: () => {},
        now: () => 5000
    });
    routeKernel.upsert(standOn(routeKernel, {
        state: state(71, {
            level: 16,
            spotId: 'starter-field',
            loc: { locX: 115000, locY: -176000, locZ: -1000 },
            timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }
        })
    }, { id: 'starter-field' }));
    routeKernel.tick();
    await routeKernel.resolveChain;
    assert.strictEqual(routeStates.length, 1);
    assert.strictEqual(routeStates[0].activity, 'traveling', 'worker resolve must execute the route transition before combat');
    assert.strictEqual(routeStates[0].stats.travel.spotId, 'mid-level-field');

    for (const initialActivity of ['hunting', 'crafting']) {
        for (const activity of ['shopping', 'selling', 'crafting', 'improving']) {
            let combats = 0;
            const occupationPlan = { travel: 'stock:scrolls', sell: [], withdraw: [], buyAds: [] };
            const occupation = recordingKernel({ now: () => 5000,
                resolveSolo: input => { combats++; return resolver(input); },
                planLifecycle: ({ state: current }) => ({ plannedState: { ...current, activity: 'hunting' },
                    activityPick: { activity }, economyPlan: occupationPlan }),
                projectResolve: (current, result, at, plan) => ({ state: { ...current, updatedAt: at }, economyPlan: plan.economyPlan }),
                emit: () => {} });
            occupation.upsert(standOn(occupation, { state: state(90001, { activity: initialActivity,
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }) }, { id: 'occupation-field' }));
            occupation.tick(); await occupation.resolveChain; occupation.flush(null, true);
            assert.equal(combats, 0, `${initialActivity}: a selected ${activity} cannot run a farm fight first`);
            if (initialActivity === 'hunting') {
                const proposal = sentProposals.get(occupation).get(90001);
                assert.deepStrictEqual(proposal.economyPlan, occupationPlan);
                assert.equal(proposal.nextState.vitals.hp, 100, 'the purchase keeps its pre-fight HP');
            } else {
                const request = sentCommands.get(occupation).get(90001);
                assert.equal(request.precomputedResult.debug.reason, 'selected_occupation');
            }
        }
    }
    for (const expired of [false, true]) {
        let combats = 0;
        const pending = recordingKernel({ now: () => 5000,
            resolveSolo: input => { combats++; assert.equal(input.lastFight, true, 'the occupation waits for this fight only'); return resolver(input); },
            planLifecycle: ({ state: current }) => ({ plannedState: current, activityPick: { activity: 'shopping' } }),
            projectResolve: current => current, emit: () => {} });
        pending.upsert(standOn(pending, { state: state(90002, { stats: { pveEncounter: {
            version: 1, key: 'held', hp: 100, slices: expired ? 20 : 1, at: 4000 } } }) }, { id: 'pending-field' }));
        pending.tick(); await pending.resolveChain;
        assert.equal(combats, Number(!expired), 'an ongoing fight keeps ownership; an expired record cannot block the occupation');
    }

    assert.strictEqual(lifecycleKind(state(2, { activity: 'crafting' })), 'command');
    const clanDuty = { status: 'open', priority: 'required', clanGoalKey: 'clan:1:gear' };
    for (const activity of ['shopping', 'crafting', 'merchant']) {
        assert.strictEqual(lifecycleKind(state(2, { activity, stats: { clanPartyObjective: clanDuty } })), 'command',
            'a required clan objective must not bypass unfinished town services');
    }
    assert.strictEqual(lifecycleKind(state(2, { activity: 'hunting', stats: { clanPartyObjective: clanDuty } })), 'resolver',
        'a finished service must still preserve the clan assembly wait before solo hunting');
    assert.strictEqual(lifecycleKind(state(2, { activity: 'party_wait', stats: { clanPartyObjective: clanDuty } })), 'resolver',
        'actual clan assembly must remain in the pure worker wait path');
    assert.strictEqual(lifecycleKind(state(2, { activity: 'party_wait', adena: 1000, stats: {
        clanPartyObjective: clanDuty,
        equipmentPlan: { strategy: 'market', market: { price: 500, reserve: 100 } }
    } })), 'command', 'a funded weapon bridge must recover from a stale party-wait state');
    for (const plan of [{ status: 'complete' }, { status: 'deferred', strategy: 'none' },
        { status: 'active', strategy: 'craft' }]) {
        assert.strictEqual(lifecycleKind(state(2, { stats: {
            craftReturn: { loc: { locX: 1, locY: 2 } }, equipmentPlan: plan
        } })), 'resolver', 'a saved craft return point must not divert hunting into the command queue');
    }
    assert.strictEqual(lifecycleKind(state(2, { stats: { craftReturn: { loc: {} },
        equipmentPlan: { strategy: 'craft', status: 'ready_to_craft' } } })), 'command',
    'ready crafting still uses the main-thread crafting workflow');
    assert.strictEqual(lifecycleKind(state(2, { stats: { equipmentPlan: { strategy: 'market' } } })), 'resolver');
    assert.strictEqual(lifecycleKind(state(2, {
        adena: 1000,
        stats: { equipmentPlan: { strategy: 'market', market: { price: 500, reserve: 100 } } }
    })), 'command');
    assert.strictEqual(lifecycleKind(state(2, { party: { partyId: 'party' } }), leading({ partyId: 'party', leaderId: 2 })), 'party');

    // The worker's own hunting pick is the target for the native solo
    // resolver (the record carries no target).
    let pickedTarget = 0;
    const pickKernel = recordingKernel({ now: () => 5000,
        resolveSolo: input => { pickedTarget = input.targetNpcId; return resolver(input); },
        planLifecycle: ({ state }) => ({ plannedState: state, targetNpcId: 0,
            activityPick: { activity: 'hunting', npcId: 20101, spotId: 'worker-ground' } }) });
    pickKernel.upsert(standOn(pickKernel, { state: state(79) }, { id: 'worker-ground' }));
    pickKernel.tick();
    await pickKernel.resolveChain;
    assert.strictEqual(pickedTarget, 20101, 'native solo resolve uses the worker activityPick');

    const commandMessages = [];
    let plannedOnWorker = 0;
    const commandKernel = recordingKernel({
        resolveSolo: input => { assert.strictEqual(input.targetNpcId, 20101, 'command uses worker hunting pick'); return resolver(input); },
        planLifecycle: ({ state: commandState }) => {
            plannedOnWorker += 1;
            return {
                previousPlan: null,
                targetNpcId: 0, activityPick: { activity: 'hunting', npcId: 20101 },
                statsPacket: { money: [30000, .00001, 1000, 0], wishFocus: ['worker', 1], decisionSeq: 5, activityLeaf: 19, dormantWishes: [] },
                acquisitionPlan: { strategy: 'direct_drop', status: 'active' },
                // The trip the step started (BotRoute.record's shape).
                route: { needed: true, mode: 'solo', spotId: 'trip-ground', destinations: { 3: { locX: 1, locY: 2, locZ: 3 } } },
                plannedState: { ...commandState, stats: { ...commandState.stats, workerPlanned: true } }
            };
        },
        emit: (type, payload) => commandMessages.push({ type, payload }),
        now: () => now
    });
    commandKernel.upsert({ state: state(3, { activity: 'shopping' }) });
    commandKernel.tick();
    await commandKernel.resolveChain;
    const commandRequest = commandMessages.find((entry) => entry.type === 'command_request');
    assert.strictEqual(plannedOnWorker, 1, 'lifecycle planning must execute in the cold kernel');
    assert.strictEqual(commandRequest.payload.requests[0].precomputedPlan.plannedState.stats.workerPlanned, true);
    assert.strictEqual(commandRequest.payload.requests[0].precomputedPlan.statsPacket.activityLeaf, 19, 'kernel forwards whole packet');
    assert(commandRequest.payload.requests[0].precomputedResult, 'main command gateway must receive worker-computed lifecycle output');
    assert.strictEqual(commandRequest.payload.requests[0].computedAt, now);
    assert.deepStrictEqual(commandRequest.payload.requests[0].route, { needed: true, spotId: 'trip-ground' },
        'main\'s command reads the spot of the trip the worker\'s step started');
    assert.strictEqual(commandKernel.scheduleTokens.has(3), false,
        'a command request must consume its due token while the command is in flight');
    assert.strictEqual(commandKernel.snapshot().commandingAgeMs, 0,
        'command age starts at zero on the deterministic test clock');
    const commandState = commandKernel.states.get(3).state;
    commandKernel.upsert({ state: { ...commandState } });
    assert.strictEqual(commandKernel.scheduleTokens.has(3), false,
        'a catalog refresh must not create a second writer while the command is in flight');
    commandAck(commandKernel, { characterId: 3, state: { ...commandState } });
    assert.strictEqual(commandKernel.scheduleTokens.has(3), true,
        'a same-revision command ACK must restore the consumed due token');
    assert.strictEqual(commandKernel.snapshot().commanding, 0);

    const commandPressureMessages = [];
    const commandPressureKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
        maxInFlight: 2, maxAtomicPartySize: 9,
        emit: (type, payload) => commandPressureMessages.push({ type, payload }) });
    const blockedCommands = [710, 711, 712].map(id => state(id, { activity: 'shopping',
        timing: { nextResolveAt: now - 2000 } }));
    blockedCommands.forEach(s => commandPressureKernel.upsert({ state: s }));
    const waitingMembers = [720, 721, 722].map(id => state(id, { party: { partyId: 'after-commands' },
        timing: { nextResolveAt: now - 1000 } }));
    const waitingParty = { partyId: 'after-commands', leaderId: 720, memberIds: [720, 721, 722] };
    waitingMembers.forEach(s => commandPressureKernel.upsert({ state: s }));
    commandPressureKernel.partyPut(waitingParty.partyId, waitingParty);
    commandPressureKernel.tick();
    assert.strictEqual(commandPressureKernel.commanding.size, 2,
        'lifecycle commands must share the in-flight limit with combat steps');
    await commandPressureKernel.resolveChain;
    for (const s of blockedCommands.slice(0, 2)) {
        commandAck(commandPressureKernel, { characterId: s.characterId, ok: false,
            reason: 'missing_spot', retryAfterMs: 30000, state: s });
        commandPressureKernel.upsert({ state: s });
        assert.strictEqual(commandPressureKernel.scheduleTokens.get(s.characterId).dueAt, now + 30000,
            'a failed command with an unchanged state must respect retry delay after a catalog refresh');
    }
    commandPressureKernel.tick();
    await commandPressureKernel.resolveChain;
    commandAck(commandPressureKernel, { characterId: 712, ok: false, reason: 'missing_spot',
        retryAfterMs: 30000, state: blockedCommands[2] });
    commandPressureKernel.tick();
    assert.deepStrictEqual(lastSteps(commandPressureKernel), [720, 721, 722],
        'rejected commands must drain so an overdue atomic party can progress');

    const transitionKernel = recordingKernel({
        resolveSolo: resolver,
        planLifecycle: () => null,
        emit: () => {},
        now: () => now
    });
    transitionKernel.upsert({ state: state(5, { activity: 'shopping' }) });
    transitionKernel.tick();
    await transitionKernel.resolveChain;
    const transitioned = state(5, {
        activity: 'traveling',
        timing: { lastResolvedAt: now, nextResolveAt: now - 1 },
        updatedAt: now
    });
    transitionKernel.upsert({ state: transitioned });
    transitionKernel.tick();
    assert.strictEqual(transitionKernel.scheduleTokens.has(5), false,
        'an interim durable refresh can be consumed while the lifecycle ACK is pending');
    commandAck(transitionKernel, { characterId: 5, state: transitioned });
    assert.strictEqual(transitionKernel.scheduleTokens.has(5), true,
        'the lifecycle ACK must restore a transition node consumed during the command');

    const memberOnlyKernel = recordingKernel({ resolveSolo: resolver, emit: () => {}, now: () => now });
    memberOnlyKernel.upsert({ state: state(4, { party: { partyId: 'member-only' } }) });
    assert.strictEqual(memberOnlyKernel.heap.values.filter(entry => entry.kind !== 'alarm').length, 0,
        'party members must be scheduled only through their leader');
    assert.strictEqual([...memberOnlyKernel.alarms.values()].filter(entry => entry.alarmKind === 'worker_safety').length, 0);
    assert.strictEqual(memberOnlyKernel.snapshot().due, 0,
        'party members must not inflate independent worker due-age telemetry');

    // A step whose proposal never reached main (the send failed) is requeued
    // 30 s after its start; an ack arriving later misses it and is dropped.
    let recoveryNow = now;
    const unsent = type => type !== 'proposal_batch';
    const recoveryKernel = recordingKernel({ resolveSolo: resolver, emit: unsent, now: () => recoveryNow });
    recoveryKernel.upsert(standOn(recoveryKernel, { state: state(6) }, { id: 'spot' }));
    recoveryKernel.tick();
    const stalledAt = recoveryNow;
    await recoveryKernel.resolveChain;
    recoveryKernel.flush(null, true);
    assert.strictEqual(recoveryKernel.snapshot().inFlight, 1);
    assert.strictEqual(recoveryKernel.nextWakeAt(), stalledAt + 30000, 'the oldest step\'s stall is the next wake');
    recoveryNow = stalledAt + 29999;
    recoveryKernel.tick();
    assert.strictEqual(recoveryKernel.snapshot().inFlight, 1, 'a step within its 30 s waits for its commit ack');
    assert.strictEqual(recoveryKernel.snapshot().inFlightAgeMs, 29999);
    recoveryNow = stalledAt + 30000;
    recoveryKernel.tick();
    assert.strictEqual(recoveryKernel.snapshot().inFlight, 0,
        'a step with no commit ack 30 s after its start frees its slot');
    assert.strictEqual(recoveryKernel.snapshot().dirty, 0);
    assert.strictEqual(recoveryKernel.snapshot().stallRecoveries, 1);
    assert.strictEqual(recoveryKernel.scheduleTokens.get(6).dueAt, recoveryNow + 1000, 'the stalled bot is requeued');
    commitAck(recoveryKernel, { results: [{ ok: true, characterId: 6, state: state(6) }] });
    assert.strictEqual(recoveryKernel.snapshot().lateAcks, 1, 'the late ack is dropped');
    assert.strictEqual(recoveryKernel.states.get(6).state.simulation.revision, 3, 'a dropped ack changes no state');

    // A sent step waits for its commit ack past 30 s (main's commit queue holds
    // it): it is not requeued, its stall is no wake, and the ack lands.
    let sentNow = now;
    const sentKernel = recordingKernel({ resolveSolo: resolver, emit: () => {}, now: () => sentNow });
    sentKernel.upsert(standOn(sentKernel, { state: state(8) }, { id: 'spot' }));
    sentKernel.tick();
    const sentAt = sentNow;
    await sentKernel.resolveChain;
    sentKernel.flush(null, true);
    assert.strictEqual(sentKernel.nextWakeAt(), Number(sentKernel.heap.peek()?.dueAt ?? Infinity),
        'a sent step\'s stall is no wake');
    sentNow = sentAt + 60000;
    sentKernel.tick();
    assert.strictEqual(sentKernel.inFlight.size, 1, 'a sent step keeps its slot until its commit ack');
    assert.strictEqual(sentKernel.snapshot().stallRecoveries, 0);
    commitAck(sentKernel, { results: [{ ok: true, characterId: 8,
        state: state(8, { simulation: { revision: 4 } }) }] });
    assert.strictEqual(sentKernel.snapshot().lateAcks, 0, 'the ack of a slow commit is not late');
    assert.strictEqual(sentKernel.inFlight.size, 0);
    assert.strictEqual(sentKernel.states.get(8).state.simulation.revision, 4, 'the slow commit\'s state lands');

    // A stalled party step (its proposal never sent) frees every member and
    // requeues the party by its leader.
    let partyStallNow = now;
    const partyStallKernel = recordingKernel({ resolveSolo: resolver, emit: unsent, now: () => partyStallNow,
        resolveParty: ({ timestamp }) => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: timestamp + 60000 }) });
    [260, 261].forEach(id => partyStallKernel.upsert({ state: state(id, { party: { partyId: 'stall-party', leaderId: 260 } }) }));
    partyStallKernel.partyPut('stall-party', { partyId: 'stall-party', leaderId: 260, memberIds: [260, 261], stats: {},
        status: 'active', nextResolveAt: partyStallNow - 1000, revision: 4 });
    partyStallKernel.tick();
    assert.deepStrictEqual(lastSteps(partyStallKernel), [260, 261]);
    await partyStallKernel.resolveChain;
    partyStallKernel.flush(null, true);
    partyStallNow += 30000;
    partyStallKernel.tick();
    assert.strictEqual(partyStallKernel.inFlight.size, 0, 'a stalled party step frees every member');
    assert.strictEqual(partyStallKernel.partyRuns.size, 0);
    assert.strictEqual(partyStallKernel.snapshot().stallRecoveries, 2, 'each freed member counts');
    assert.strictEqual(partyStallKernel.scheduleTokens.get(260).dueAt, partyStallNow + 1000, 'the leader requeues the party');
    assert.notStrictEqual(partyStallKernel.scheduleTokens.get(261)?.dueAt, partyStallNow + 1000, 'a member is not requeued alone');

    const orphanKernel = recordingKernel({ resolveSolo: resolver, emit: () => {}, now: () => recoveryNow });
    orphanKernel.upsert(standOn(orphanKernel, {
        state: state(7, { timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow + 3600000 } })
    }, { id: 'spot' }));
    const orphanedEntry = orphanKernel.heap.values.find(entry => entry.kind !== 'alarm' && entry.characterId === 7);
    assert.strictEqual(orphanKernel.heap.remove(orphanedEntry), true);
    orphanKernel.consumeHeapEntry(orphanedEntry);
    assert.strictEqual(orphanKernel.scheduleTokens.has(7), false);
    orphanKernel.tick();
    assert.strictEqual(orphanKernel.scheduleTokens.has(7), false, 'safety has no startup/full-population pass');
    recoveryNow += 30 * 60000;
    orphanKernel.pause(); orphanKernel.tick();
    assert.equal(orphanKernel.scheduleTokens.has(7), false, 'there is no autonomous second safety sweep');
    assert.equal(orphanKernel.states.safetyNodes, undefined);
    assert.equal(typeof orphanKernel.recoverOrphanedSchedules, 'undefined');
    assert.equal(orphanKernel.ensureScheduled(7), true, 'the addressed main sweep restores a local orphan');
    assert.equal(orphanKernel.ensureScheduled(7), false, 'a healthy scheduled state is not repaired twice');

    const ackRaceKernel = recordingKernel({
        resolveSolo: resolver,
        emit: () => {},
        now: () => recoveryNow
    });
    ackRaceKernel.upsert(standOn(ackRaceKernel, { state: state(8, {
        timing: { lastResolvedAt: recoveryNow - 1000, nextResolveAt: recoveryNow }
    }) }, { id: 'spot' }));
    ackRaceKernel.tick();
    await ackRaceKernel.resolveChain;
    ackRaceKernel.flush(null, true);
    ackRaceKernel.upsert(standOn(ackRaceKernel, { state: state(8, {
        timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow },
        simulation: { revision: 5 }
    }) }, { id: 'newer-catalog' }));
    assert.strictEqual(ackRaceKernel.scheduleTokens.has(8), false,
        'a newer catalog snapshot must not schedule a second writer while the prior revision is in flight');
    commitAck(ackRaceKernel, { results: [{
        ok: true,
        characterId: 8,
        state: state(8, {
            timing: { lastResolvedAt: recoveryNow, nextResolveAt: recoveryNow },
            simulation: { revision: 4 }
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
    const partyKernel = recordingKernel({
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
    partyKernel.upsert(standOn(partyKernel, { state: members[0] }, { id: 'party-spot' }));
    partyKernel.partyPut(party.partyId, party);
    partyKernel.upsert({ state: members[1] });
    partyKernel.upsert({
        state: {
            ...members[1],
            simulation: { revision: 9 }
        }
    });
    partyKernel.tick();
    assert.deepStrictEqual(partyMessages, [], 'a party step goes out without a claim');
    assert.deepStrictEqual(lastSteps(partyKernel), [20, 21]);
    await partyKernel.resolveChain;
    const partyProposal = partyMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(partyProposal.payload.proposals.length, 2, 'party compute must produce one CAS proposal per member');
    assert.deepStrictEqual(partyProposal.payload.proposals.map(entry => entry.revision), [3, 9],
        'each member commits on its own current revision, not the leader snapshot');
    assert.deepStrictEqual(partyProposal.payload.proposals.map(entry => entry.proposalId), [`20:${now}`, `21:${now}`],
        'party members share the step start');
    assert(partyProposal.payload.proposals.every((proposalEntry) => proposalEntry.options.allowParty === true));
    assert(partyProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 20).partyResolution,
        'the leader proposal must carry the party durable update');
    assert(!partyMessages.some((entry) => entry.type === 'command_request'), 'party combat compute must never fall back to main');

    const refreshMessages = [], refreshed = [];
    const refreshMembers = [state(120, { party: { partyId: 'refresh-party' }, stats: { equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 55 } } } }),
        state(121, { party: { partyId: 'refresh-party' }, stats: { equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 56 } } } })];
    const refreshParty = { partyId: 'refresh-party', status: 'active', leaderId: 120, memberIds: [120, 121], stats: {}, nextResolveAt: now };
    const refreshKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
        resolveParty: ({ members, timestamp }) => ({ memberResults: members.map(member => ({ state: member, result: {} })),
            partyPatch: {}, events: [], nextResolveAt: timestamp + 45000 }),
        projectResolve: state => ({ state }),
        planPartyRequirement: ({ state }) => { refreshed.push(state.characterId); return { acquisitionPlan: state.characterId === 120
            ? { status: 'active', strategy: 'market', target: { selfId: 55 } } : state.stats.equipmentPlan }; },
        emit: (type, payload) => refreshMessages.push({ type, payload }) });
    refreshKernel.upsert(standOn(refreshKernel, { state: refreshMembers[0] }, { id: 'refresh-spot' }));
    refreshKernel.upsert({ state: refreshMembers[1] });
    refreshKernel.partyPut(refreshParty.partyId, { ...refreshParty, requirementRefresh: true }); refreshKernel.tick();
    await refreshKernel.resolveChain;
    const refreshProposal = refreshMessages.find(message => message.type === 'proposal_batch').payload.proposals.find(proposal => proposal.partyResolution);
    assert.deepStrictEqual(refreshed, [120, 121], 'the party resolve refreshes each member after its projection');
    assert.deepStrictEqual(refreshProposal.partyResolution.memberPlans.map(row => row.characterId), [120], 'only changed requirement keys cross the worker boundary');
    assert.strictEqual(refreshProposal.partyResolution.requirementRefreshedAt, now);
    assert.strictEqual(refreshKernel.partyRequirementProgress.size, 0, 'completed refresh scratch is released');

    // A member whose own step moved its kit opens the re-plan with
    // no due mark from main; members already passed wait for the next step.
    for (const moved of [false, true]) {
        const kitMessages = [], kitPlanned = [];
        const kitKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
            resolveParty: ({ members, timestamp }) => ({ memberResults: members.map(member => ({ state: member, result: {} })),
                partyPatch: {}, events: [], nextResolveAt: timestamp + 45000 }),
            projectResolve: state => ({ state, kitMoved: moved && state.characterId === 121 }),
            planPartyRequirement: ({ state }) => { kitPlanned.push(state.characterId); return { acquisitionPlan: state.stats.equipmentPlan }; },
            emit: (type, payload) => kitMessages.push({ type, payload }) });
        kitKernel.upsert(standOn(kitKernel, { state: refreshMembers[0] }, { id: 'refresh-spot' }));
        kitKernel.upsert({ state: refreshMembers[1] });
        kitKernel.partyPut(refreshParty.partyId, refreshParty); kitKernel.tick();
        await kitKernel.resolveChain;
        assert.deepStrictEqual(kitPlanned, moved ? [121] : [], 'a moved kit opens the re-plan at that member');
        assert.strictEqual(kitKernel.partyRequirementProgress.has('refresh-party'), moved,
            'the re-plan stays open for the member passed before the raise');
    }

    // A pending join main recorded on the party row: the leader's step runs
    // the recruit check on this thread's copy of the recruit, its proposal
    // carries the answer, and the party row leaves the step without it.
    // A recruit mid-step keeps the join pending; after a decline or gone recruit
    // the next formation pass picks again.
    for (const outcome of ['accepted', 'declined', 'gone', 'unavailable']) {
        const joinMessages = [], reviewed = [];
        const recruitId = outcome === 'gone' ? 999 : 122;
        const joinParty = { ...refreshParty, partyId: `join-${outcome}`,
            stats: { pendingRecruits: { ids: [recruitId] } } };
        const joinMembers = refreshMembers.map(member => ({ ...member, party: { partyId: joinParty.partyId } }));
        const joinKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
            resolveParty: ({ members, timestamp }) => ({ memberResults: members.map(member => ({ state: member, result: {} })),
                partyPatch: {}, events: [], nextResolveAt: timestamp + 45000 }),
            projectResolve: state => ({ state }),
            reviewRecruits: ({ members }) => {
                reviewed.push(members.map(member => member.characterId));
                return outcome === 'accepted' ? { memberGoals: [], incomeReviews: [], lastIncomeReviewAt: now, agreement: null } : null;
            },
            emit: (type, payload) => joinMessages.push({ type, payload }) });
        joinKernel.upsert(standOn(joinKernel, { state: joinMembers[0] }, { id: 'refresh-spot' }));
        joinKernel.upsert({ state: joinMembers[1] });
        joinKernel.partyPut(joinParty.partyId, joinParty);
        // The recruit is not due: it waits idle, not started by this tick.
        if (outcome !== 'gone') joinKernel.upsert({ state: state(122, { timing: { lastResolvedAt: now, nextResolveAt: now + 3600000 } }) });
        if (outcome === 'unavailable') { const busy = joinKernel.busy.bind(joinKernel);
            joinKernel.busy = id => Number(id) === 122 || busy(id); }
        joinKernel.tick();
        await joinKernel.resolveChain;
        const leader = joinMessages.find(message => message.type === 'proposal_batch').payload.proposals
            .find(proposal => proposal.partyResolution);
        assert.strictEqual(leader.partyResolution.recruitCheck.outcome, outcome);
        assert.deepStrictEqual(leader.partyResolution.party.stats.pendingRecruits,
            outcome === 'unavailable' ? { ids: [122] } : undefined,
            'the party row leaves the leader\'s step without its pending join, unless a recruit is mid-step');
        assert.deepStrictEqual(reviewed, ['gone', 'unavailable'].includes(outcome) ? [] : [[120, 121, 122]],
            'the check reads the members with the recruit, once');
        if (outcome === 'accepted') {
            assert.deepStrictEqual(leader.partyResolution.recruitCheck.recruitIds, [122]);
            assert.deepStrictEqual(leader.partyResolution.recruitCheck.memberIds, [120, 121]);
            assert.deepStrictEqual(leader.partyResolution.recruitCheck.sources.map(row => [row.characterId, row.revision]), [[122, 3]]);
        }
    }

    for (const complete of [false, true]) {
        const materialMessages = [], objective = { materialParty: true, status: 'open', reason: 'craft_material', spotId: 'material-spot' };
        const materialParty = { ...refreshParty, partyId: `material-${complete}`, updatedAt: now - 1,
            stats: { objective, agreement: { mode: 'need', materialNeeds: [{ characterId: 120, collected: 0 }] } } };
        const materialMembers = refreshMembers.map(member => ({ ...member,
            party: { partyId: materialParty.partyId }, activity: 'grouped' }));
        const materialKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
            resolveParty: ({ members, timestamp }) => complete
                ? invoke('GameServer/Bot/Population/BackgroundPartyResolver').resolve({ party: materialParty,
                    members, spot: { id: objective.spotId }, timestamp })
                : { memberResults: members.map(member => ({ state: member, result: {} })), events: [],
                    partyPatch: { stats: { agreement: { ...materialParty.stats.agreement,
                        materialNeeds: [{ characterId: 120, collected: 1 }] } } }, nextResolveAt: timestamp + 45000 },
            projectResolve: state => ({ state }),
            planPartyRequirement: () => { throw Error('a material hunt rebuilt its wish plan'); },
            emit: (type, payload) => materialMessages.push({ type, payload }) });
        materialKernel.upsert(standOn(materialKernel, { state: materialMembers[0] }, { id: objective.spotId }));
        materialKernel.upsert({ state: materialMembers[1] });
        materialKernel.partyPut(materialParty.partyId, { ...materialParty, requirementRefresh: true }); materialKernel.tick();
        await materialKernel.resolveChain;
        const proposals = materialMessages.find(message => message.type === 'proposal_batch')?.payload.proposals;
        assert(proposals?.length === 2, 'material progress and completion both publish all members without a generic requirement refresh');
        assert(proposals.every(proposal => proposal.atomicGroup?.memberIds.join(',') === '120,121'));
        const change = proposals[0].atomicGroup.partyChanges[0];
        assert.equal(change.status, complete ? 'dissolved' : 'active');
        assert.equal(JSON.parse(change.statsJson).agreement.materialNeeds[0].collected, complete ? 0 : 1);
        assert.equal(materialKernel.partyRequirementProgress.size, 0);
        if (complete) assert(proposals.every(proposal => !proposal.nextState.party?.partyId
            && proposal.nextState.activity === 'hunting'), 'native completion releases every physical state');
    }

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
    const expiredPartyKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('expired party must not enter combat'); },
        emit: (type, payload) => expiredPartyMessages.push({ type, payload }),
        now: () => now
    });
    expiredPartyKernel.upsert(standOn(expiredPartyKernel, { state: expiredPartyMembers[0] }, { id: 'old-party-spot' }));
    expiredPartyKernel.upsert({ state: expiredPartyMembers[1] });
    expiredPartyKernel.partyPut(expiredParty.partyId, expiredParty);
    expiredPartyKernel.tick();
    assert.deepStrictEqual(lastSteps(expiredPartyKernel), [22, 23]);
    await expiredPartyKernel.resolveChain;
    const expiryProposal = expiredPartyMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(expiryProposal.payload.proposals.length, 2, 'expired party release must include every member');
    assert(expiryProposal.payload.proposals.every((proposalEntry) => proposalEntry.atomicGroup?.memberIds.join(',') === '22,23'));
    assert(expiryProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.party.partyId === 'expired-party'));
    assert.strictEqual(expiryProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 22)
        .partyResolution.party.status, 'active');
    assert.strictEqual(expiryProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 23)
        .nextState.activity, expiredPartyMembers[1].activity, 'a review alone preserves current travel/activity');
    assert(expiryProposal.payload.proposals.find(p => p.partyResolution).partyResolution.party.stats.sessionReview.nextAt > now,
        'review must advance its deadline rather than spin on the legacy expiry');

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
    const expiryScheduleKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: resolver,
        emit: (type, payload) => expiryScheduleMessages.push({ type, payload }),
        now: () => expiryScheduleNow
    });
    expiryScheduleKernel.upsert(standOn(expiryScheduleKernel, { state: expiryScheduleMembers[0] }, { id: 'scheduled-expiry-spot' }));
    expiryScheduleKernel.upsert({ state: expiryScheduleMembers[1] });
    expiryScheduleKernel.partyPut(expiryScheduleParty.partyId, expiryScheduleParty);
    expiryScheduleKernel.tick();
    assert.strictEqual(expiryScheduleMessages.length, 0,
        'a valid party must remain scheduled until its earliest resolve or expiry');
    expiryScheduleNow += 5001;
    expiryScheduleKernel.tick();
    assert.deepStrictEqual(lastSteps(expiryScheduleKernel), [25, 26],
        'a valid party must step at session expiry even when nextResolveAt is later');

    const partyDue = expiryScheduleNow + 3000;
    const partyDueLeader = state(27, {
        timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: null },
        party: { partyId: 'party-row-scheduled', leaderId: 27 }
    });
    const partyDueMember = state(28, {
        timing: { lastResolvedAt: expiryScheduleNow - 1000, nextResolveAt: null },
        party: { partyId: 'party-row-scheduled', leaderId: 27 }
    });
    const partyDueParty = {
        partyId: 'party-row-scheduled',
        leaderId: 27,
        memberIds: [27, 28],
        nextResolveAt: partyDue,
        stats: { sessionExpiresAt: expiryScheduleNow + 60000 }
    };
    const partyDueFacts = leading(partyDueParty, [partyDueLeader, partyDueMember]);
    assert.strictEqual(nextDueAt(partyDueLeader, expiryScheduleNow, {}, false, partyDueFacts), partyDue,
        'a newly assigned leader with no personal due time must use the durable party schedule');
    assert.strictEqual(nextDueAt({
        ...partyDueLeader,
        timing: { ...partyDueLeader.timing, nextResolveAt: expiryScheduleNow + 1000 }
    }, expiryScheduleNow, {}, false, partyDueFacts), partyDue,
        'a stale leader schedule must not outrun the authoritative party row');

    const priorityParty = {
        ...partyDueParty,
        nextResolveAt: expiryScheduleNow
    };
    const partyCapacityKernel = recordingKernel({ now: () => expiryScheduleNow, resolveSolo: resolver });
    partyCapacityKernel.upsert({ state: partyDueLeader });
    partyCapacityKernel.upsert({ state: partyDueMember });
    partyCapacityKernel.partyPut(priorityParty.partyId, priorityParty);
    assert.deepStrictEqual(partyCapacityKernel.dueCandidates(expiryScheduleNow, 1), [],
        'an atomic party step must wait when the current capacity cannot fit every member');
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
    const singletonKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('singleton party must be cleaned up before combat'); },
        emit: (type, payload) => singletonMessages.push({ type, payload }),
        now: () => singletonNow
    });
    singletonKernel.upsert(standOn(singletonKernel, { state: singletonMember }, { id: 'singleton-spot' }));
    singletonKernel.partyPut(singletonParty.partyId, singletonParty);
    singletonKernel.tick();
    assert.strictEqual(singletonMessages.length, 0, 'a step sends nothing before its proposal');
    assert.deepStrictEqual(lastSteps(singletonKernel), [24], 'invalid singleton must enter the cleanup path immediately');
    assert.strictEqual(singletonKernel.partyRuns.get('singleton-party').purpose.invalidReason, 'party_min_size');
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
    const partyRouteKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('party combat must not run during route travel'); },
        partyRoute: () => partyRoute,
        emit: (type, payload) => partyRouteMessages.push({ type, payload }),
        now: () => now
    });
    partyRouteKernel.upsert(standOn(partyRouteKernel, { state: partyRouteMembers[0] }, { id: 'starter-field' }));
    partyRouteKernel.upsert({ state: partyRouteMembers[1] });
    partyRouteKernel.partyPut(partyRouteParty.partyId, partyRouteParty);
    // A member's kept solo route: a new state keeps it, the party run's
    // step takes the member and drops it.
    partyRouteKernel.states.get(31).route = { spotId: 'solo-kept' };
    partyRouteKernel.upsert({ state: { ...partyRouteMembers[1], level: 17,
        simulation: { ...partyRouteMembers[1].simulation, revision: Number(partyRouteMembers[1].simulation?.revision || 0) + 1 } } });
    assert.deepStrictEqual(partyRouteKernel.states.get(31).route, { spotId: 'solo-kept' }, 'a committed state keeps the bot\'s route');
    partyRouteKernel.tick();
    assert.strictEqual(partyRouteKernel.states.get(31).route, null, 'the party step drops the member\'s solo route');
    assert.deepStrictEqual(lastSteps(partyRouteKernel), [30, 31]);
    await partyRouteKernel.resolveChain;
    const partyRouteProposal = partyRouteMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(partyRouteProposal.payload.proposals.length, 2);
    assert(partyRouteProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.activity === 'traveling'),
        'a party route must move every member into the same finite travel state');
    // A party's wanted trip waits for its engaged fight, which ends with no new one.
    {
        let fight = null;
        const held = recordingKernel({ resolveSolo: resolver, partyRoute: () => partyRoute, emit: () => {}, now: () => now,
            resolveParty: (options) => { fight = options; return { memberResults: options.members.map(member => ({ state: member, result: {} })),
                events: [], partyPatch: {}, nextResolveAt: options.timestamp + 60000 }; } });
        held.upsert(standOn(held, { state: partyRouteMembers[0] }, { id: 'starter-field' }));
        held.upsert({ state: partyRouteMembers[1] });
        held.partyPut(partyRouteParty.partyId, { ...partyRouteParty, stats: { ...partyRouteParty.stats,
            pveEncounter: { version: 1, key: 'held', hp: 100, slices: 1, at: now } } });
        held.tick();
        await held.resolveChain;
        assert.strictEqual(fight?.lastFight, true, 'the party fights this fight out, then goes');
    }
    assert(partyRouteProposal.payload.proposals.every((proposalEntry) => proposalEntry.nextState.stats.travel.spotId === 'mid-level-field'));
    assert.strictEqual(partyRouteProposal.payload.proposals.find((proposalEntry) => proposalEntry.characterId === 30)
        .partyResolution.party.stats.travel.spotId, 'mid-level-field');

    const compactFallbackMessages = [];
    const compactFallbackKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => { throw new Error('compact party fallback must wait for the authoritative member state'); },
        emit: (type, payload) => compactFallbackMessages.push({ type, payload }),
        now: () => now
    });
    const compactLeader = state(35, { party: { partyId: 'compact-party' } });
    // The member's state never reached this kernel: the party waits for it.
    compactFallbackKernel.upsert({ state: compactLeader });
    compactFallbackKernel.partyPut('compact-party', { partyId: 'compact-party', leaderId: 35, memberIds: [35, 36] });
    compactFallbackKernel.tick();
    assert.deepStrictEqual(lastSteps(compactFallbackKernel), [],
        'a compact party reference must wait until its full authoritative state is loaded');

    const burstMessages = [];
    const burstKernel = recordingKernel({
        resolveSolo: resolver,
        emit: (type, payload) => burstMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 3
    });
    for (let id = 80; id < 85; id++) burstKernel.upsert(standOn(burstKernel, {
        state: state(id, { timing: { lastResolvedAt: 1000, nextResolveAt: now - 1 } })
    }, { id: 'spot' }));
    burstKernel.tick();
    assert.strictEqual(lastSteps(burstKernel).length, 3,
        'a catch-up tick must honor the smaller in-flight burst even when the protocol batch is larger');

    // ~316 KB of bag: the next state alone is over the 240 KB proposal limit.
    const oversizedInventory = Object.fromEntries(Array.from({ length: 2400 }, (_, index) => [
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
        simulation: { revision: 5 }
    });
    const oversizedEmitted = [];
    const oversizedKernel = recordingKernel({
        resolveSolo: resolver,
        emit: (type, payload) => oversizedEmitted.push({ type, payload }),
        now: () => now + 10000
    });
    const oversizedProposal = {
        proposalId: `91:${now}`,
        characterId: 91,
        priority: 'P2',
        enqueuedAt: now,
        revision: 5,
        // The shape the kernel builds: the bag flag next to the whole next state.
        bagChanged: false,
        nextState: oversizedState,
        durable: null,
        result: { events: [], debug: { activity: 'hunting' } },
        options: { allowLifecycle: true }
    };
    oversizedKernel.inFlight.set(91, { state: oversizedState, startedAt: now });
    oversizedKernel.dirty.set(91, oversizedProposal);
    oversizedKernel.flushDue();
    const compactedMessage = oversizedEmitted.find((entry) => entry.type === 'proposal_batch');
    assert(compactedMessage, 'an oversized first proposal must be compacted and emitted');
    assert(Protocol.validateEnvelope(
        Protocol.envelope('proposal_batch', 'epoch', compactedMessage.payload),
        'worker',
        { workerEpoch: 'epoch' }
    ).ok, 'compacted proposal batch must stay within the IPC envelope limit');
    assert.strictEqual(oversizedKernel.snapshot().dirty, 0,
        'an oversized first proposal must not remain stuck in the dirty queue');
    assert.strictEqual(oversizedKernel.snapshot().proposalCompactions, 1);
    assert.strictEqual(oversizedKernel.snapshot().proposalOversize, 1);

    const Delta = require('../src/GameServer/Bot/Population/ColdStateDelta');
    const largeGroup = [];
    for (let id = 200; id < 209; id++) {
        const before = state(id, { stats: { history: 'h'.repeat(40000), removed: 1, list: [1, 2] } });
        const next = { ...before, stats: { history: before.stats.history, list: [3], added: null }, hp: 8 };
        const entry = { ...oversizedProposal, characterId: id, proposalId: `${id}:${now}`,
            nextState: next,
            atomicGroup: { id: 'large-clan', memberIds: Array.from({ length: 9 }, (_, i) => 200 + i) } };
        oversizedKernel.inFlight.set(id, { state: before, startedAt: now });
        oversizedKernel.dirty.set(id, entry);
        largeGroup.push({ before, next });
    }
    oversizedEmitted.length = 0;
    oversizedKernel.flush(null, true);
    const sparse = oversizedEmitted.find(e => e.type === 'proposal_batch');
    assert.strictEqual(sparse.payload.proposals.length, 9, 'nine large members travel as one complete atomic group');
    assert(Protocol.validateEnvelope(Protocol.envelope('proposal_batch', 'epoch', sparse.payload), 'worker').ok);
    sparse.payload.proposals.forEach((p, i) => {
        assert(p.nextStateDelta && !p.nextState);
        assert.deepStrictEqual(Delta.apply(largeGroup[i].before, p.nextStateDelta), largeGroup[i].next,
            'transport retains planning changes, deletions, arrays and nulls against the step base state');
        assert.strictEqual(largeGroup[i].before.stats.removed, 1, 'applying transport must not mutate its base');
    });
    assert.strictEqual(oversizedKernel.snapshot().proposalOversizeRejected, 0);

    const capacityFlushMessages = [];
    const capacityFlushKernel = recordingKernel({
        resolveSolo: resolver,
        emit: (type, payload) => capacityFlushMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 8,
        flushTargetMs: 2000,
        flushHardMs: 5000
    });
    const capacityFlushStates = Array.from({ length: 8 }, (_, index) => state(200 + index));
    capacityFlushStates.forEach((entry) => capacityFlushKernel.upsert(standOn(capacityFlushKernel, {
        state: entry
    }, { id: 'spot', rewards: {} })));
    capacityFlushKernel.tick();
    assert.strictEqual(lastSteps(capacityFlushKernel).length, 8);
    await capacityFlushKernel.resolveChain;
    assert.strictEqual(capacityFlushKernel.snapshot().dirty, 8);
    const readyProposals = [...capacityFlushKernel.dirty.entries()];
    for (const reason of ['forced', 'priority', 'batch']) {
        capacityFlushKernel.flush(null, reason === 'forced', { reason });
        const message = capacityFlushMessages.pop();
        assert.strictEqual(message.type, 'proposal_batch');
        assert.strictEqual(message.payload.capacityBlocked, true,
            `${reason} flush must report a full ownership window before ACK`);
        assert.strictEqual(capacityFlushKernel.inFlight.size, 8,
            'sending proposals must retain ownership until the durable commit ACK');
        readyProposals.forEach(([id, value]) => capacityFlushKernel.dirty.set(id, value));
    }
    capacityFlushKernel.tick();
    const capacityFlushBatch = capacityFlushMessages.find((entry) => entry.type === 'proposal_batch');
    assert.strictEqual(capacityFlushBatch.payload.proposals.length, 8);
    assert.strictEqual(capacityFlushBatch.payload.capacityBlocked, true,
        'the main thread must know that commits are holding all worker slots');
    assert.strictEqual(capacityFlushKernel.snapshot().dirty, 0);
    assert.strictEqual(capacityFlushKernel.snapshot().flushReasons.capacity, 1);
    assert.strictEqual(capacityFlushKernel.snapshot().lastFlushRows, 8);

    // An atomic clan party needs the entire small player window. A few free
    // slots must not leave the completed owners waiting for the ordinary timer.
    const partialMessages = [];
    const partialKernel = recordingKernel({ resolveSolo: resolver, now: () => now,
        maxInFlight: 8, maxAtomicPartySize: 9, emit: (type, payload) => partialMessages.push({ type, payload }) });
    const clanMembers = Array.from({ length: 9 }, (_, i) => state(500 + i, { party: { partyId: 'nine' } }));
    clanMembers.forEach(s => partialKernel.upsert({ state: s }));
    partialKernel.partyPut('nine', { partyId: 'nine', leaderId: 500, memberIds: clanMembers.map(m => m.characterId) });
    for (let id = 600; id < 605; id++) {
        const base = state(id);
        const pending = { ...oversizedProposal, characterId: id, enqueuedAt: now,
            proposalId: `${id}:${now}`, revision: 3, nextState: state(id), result: { events: [], debug: {} } };
        partialKernel.upsert({ state: base });
        partialKernel.inFlight.set(id, { state: base, startedAt: now });
        partialKernel.dirty.set(id, pending);
    }
    partialKernel.tick();
    const drained = partialMessages.find(m => m.type === 'proposal_batch');
    assert.strictEqual(drained.payload.proposals.length, 5, 'an atomic capacity wait must drain completed owners despite free slots');
    assert.strictEqual(drained.payload.capacityBlocked, true, 'main must receive the atomic capacity pressure');
    assert.strictEqual(partialKernel.inFlight.size, 5, 'slots remain owned until the commit acknowledgement');
    commitAck(partialKernel, { results: drained.payload.proposals.map(p => ({ ok: true, characterId: p.characterId,
        state: state(p.characterId, { timing: { nextResolveAt: now + 60000 } }) })) });
    assert.strictEqual(partialKernel.dueCandidates(now + 1000, 8).length, 9, 'the complete clan party can run after the owners commit');

    const throttledPartyMessages = [];
    const throttledPartyKernel = recordingKernel({
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
    throttledPartyKernel.upsert(standOn(throttledPartyKernel, { state: state(39) }, { id: 'spot' }));
    throttledPartyMembers.forEach((member, index) => throttledPartyKernel.upsert(
        index === 0 ? standOn(throttledPartyKernel, { state: member }, { id: 'spot' }) : { state: member }
    ));
    throttledPartyKernel.partyPut(throttledParty.partyId, throttledParty);
    throttledPartyKernel.upsert(standOn(throttledPartyKernel, { state: state(100) }, { id: 'spot' }));
    throttledPartyKernel.tick();
    assert.deepStrictEqual(lastSteps(throttledPartyKernel), [39],
        'a valid atomic party must drain earlier owners instead of letting newer solo work refill the window');
    assert.strictEqual(throttledPartyKernel.snapshot().partyCapacityDeferrals, 1);
    assert(throttledPartyMembers.every((member) => !throttledPartyKernel.inFlight.has(member.characterId)),
        'a throttled atomic party must not step until the window recovers');
    throttledPartyKernel.inFlight.delete(39);
    assert.deepStrictEqual(throttledPartyKernel.dueCandidates(now, 4).map(c => c.characterId), [40, 41, 42, 43, 44]);

    const atomicBurstMessages = [];
    const atomicBurstKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: now + 60000 }),
        emit: (type, payload) => atomicBurstMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 2,
        maxAtomicPartySize: 5
    });
    throttledPartyMembers.forEach((member, index) => atomicBurstKernel.upsert(
        index === 0 ? standOn(atomicBurstKernel, { state: member }, { id: 'spot' }) : { state: member }
    ));
    atomicBurstKernel.partyPut(throttledParty.partyId, throttledParty);
    atomicBurstKernel.tick();
    assert.deepStrictEqual(
        lastSteps(atomicBurstKernel),
        [40, 41, 42, 43, 44],
        'an empty throttled ownership window must admit one bounded atomic party'
    );
    assert.strictEqual(atomicBurstKernel.snapshot().partyCapacityBursts, 1);
    assert.strictEqual(atomicBurstKernel.snapshot().partyCapacityDeferrals, 0);

    const boundedBurstMessages = [];
    const boundedBurstKernel = recordingKernel({
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
    oversizedPartyMembers.forEach((member, index) => boundedBurstKernel.upsert(
        index === 0 ? standOn(boundedBurstKernel, { state: member }, { id: 'spot' }) : { state: member }
    ));
    boundedBurstKernel.partyPut(oversizedParty.partyId, oversizedParty);
    boundedBurstKernel.upsert(standOn(boundedBurstKernel, { state: state(100) }, { id: 'spot' }));
    boundedBurstKernel.tick();
    assert.deepStrictEqual(lastSteps(boundedBurstKernel), [100],
        'a party above the configured atomic bound must defer without blocking solo work');
    assert.strictEqual(boundedBurstKernel.snapshot().partyCapacityBursts, 0);
    assert.strictEqual(boundedBurstKernel.snapshot().partyCapacityDeferrals, 1);

    const capacityMessages = [];
    const capacityKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: () => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: now + 60000 }),
        emit: (type, payload) => capacityMessages.push({ type, payload }),
        now: () => now,
        maxBatch: 64,
        maxInFlight: 64
    });
    const capacityMembers = Array.from({ length: 5 }, (_, index) => state(40 + index, { party: { partyId: 'capacity-party' } }));
    const capacityParty = { partyId: 'capacity-party', leaderId: 40, memberIds: capacityMembers.map((member) => member.characterId) };
    capacityMembers.forEach((member, index) => capacityKernel.upsert(
        index === 0 ? standOn(capacityKernel, { state: member }, { id: 'spot' }) : { state: member }
    ));
    capacityKernel.partyPut(capacityParty.partyId, capacityParty);
    for (let id = 1000; id < 1062; id++) capacityKernel.inFlight.set(id, { startedAt: now });
    capacityKernel.tick();
    assert.deepStrictEqual(lastSteps(capacityKernel), [], 'a party must wait when remaining capacity cannot admit every member');
    assert(capacityMembers.every((member) => !capacityKernel.inFlight.has(member.characterId)),
        'capacity deferral must not start unsent party members');
    capacityKernel.inFlight.clear();
    now += 100;
    capacityKernel.tick();
    assert.strictEqual(lastSteps(capacityKernel).length, 5,
        'the next eligible tick must admit the entire party atomically');

    const fenceKernel = recordingKernel({ resolveSolo: resolver, emit: () => {}, now: () => now });
    fenceKernel.upsert(standOn(fenceKernel, { state: state(9) }, { id: 'spot' }));
    fenceKernel.tick();
    await fenceKernel.resolveChain;
    const fenced = fenceKernel.fence(9);
    assert.strictEqual(fenced.characterId, 9);
    assert(fenced.proposal, 'activation fence must return the latest uncommitted proposal');
    assert.strictEqual(fenceKernel.snapshot().inFlight, 0);

    const errorMessages = [];
    const errorKernel = recordingKernel({
        resolveSolo: () => { throw new Error('synthetic_resolver_error'); },
        emit: (type, payload) => errorMessages.push({ type, payload }),
        now: () => now
    });
    errorKernel.upsert(standOn(errorKernel, { state: state(30) }, { id: 'spot' }));
    errorKernel.tick();
    await errorKernel.resolveChain;
    assert.deepStrictEqual(errorMessages.map(entry => entry.type), ['fault'], 'a resolver error sends no proposal');
    assert.strictEqual(errorKernel.inFlight.size, 0, 'a resolver error ends the step');
    assert.strictEqual(errorKernel.scheduleTokens.get(30).dueAt, now + 1000, 'a resolver error requeues the bot');
    assert.strictEqual(errorKernel.snapshot().errors, 1);

    // The bot's look at its board lines (group E) leaves the worker with its
    // proposal: the main thread applies the new asks after the commit.
    const marketMessages = [];
    const marketKernel = recordingKernel({
        resolveSolo: resolver,
        projectResolve: async (current) => ({ state: current,
            market: { reprices: [{ recordId: 5, lineId: 6, selfId: 1864, price: 990,
                pricing: { seenCounter: 3, seenAt: now } }], withdrawals: [] } }),
        emit: (type, payload) => marketMessages.push({ type, payload }),
        now: () => now
    });
    marketKernel.upsert(standOn(marketKernel, { state: state(40) }, { id: 'spot', rewards: {} }));
    marketKernel.tick();
    await marketKernel.resolveChain;
    marketKernel.flush(null, true);
    const marketProposal = marketMessages.find((entry) => entry.type === 'proposal_batch').payload.proposals[0];
    assert.deepStrictEqual(marketProposal.market.reprices, [{ recordId: 5, lineId: 6, selfId: 1864, price: 990,
        pricing: { seenCounter: 3, seenAt: now } }]);
    assert.strictEqual(marketProposal.market.updates, undefined, 'unchanged quotes send no metadata update');
    assert.strictEqual(marketProposal.nextState.stats.priceBeliefs, undefined, 'line knowledge does not ride in bot stats');
    assert.strictEqual(marketKernel.beginCommand(40, 'market_review'), null, 'board review command kind is retired');
    marketKernel.lookSeen.set(40, new Map([[6, { deals: 3, at: now }]]));
    marketKernel.fence(40);
    assert.strictEqual(marketKernel.lookSeen.has(40), false, 'hot handoff deletes worker line observations');
    marketKernel.upsert({ state: state(41) });
    marketKernel.lookSeen.set(41, new Map([[7, { deals: 3, at: now }]]));
    marketKernel.remove(41);
    assert.strictEqual(marketKernel.lookSeen.has(41), false);
    await marketKernel.shutdown();
    assert.strictEqual(marketKernel.lookSeen.size, 0);

    {
        // A commit ack naming a review: the bot waits for the review command
        // (no step starts), which carries the plan the proposal had and no
        // state; its answer gives the bot back to its schedule. An ack naming
        // nothing sends no command.
        const at = 50000;
        const reviewKernel = recordingKernel({ resolveSolo: () => null, now: () => at });
        const plan = { sell: [], withdraw: [7], buyAds: [], travel: null };
        const committed = {};
        for (const id of [60, 61]) {
            const base = state(id, { timing: { lastResolvedAt: 1000, nextResolveAt: at + 60000 } });
            reviewKernel.upsert({ state: base });
            reviewKernel.inFlight.set(id, { state: base, startedAt: at });
            reviewKernel.dirty.set(id, { proposalId: `${id}:${at}`, characterId: id, revision: 3, priority: 'P1', enqueuedAt: at,
                nextState: base, result: { events: [] }, economyPlan: plan });
            committed[id] = state(id, { simulation: { ...base.simulation, revision: 5 }, timing: { lastResolvedAt: at, nextResolveAt: at } });
        }
        reviewKernel.flush(null, true);
        // A state on the ack is main's (it changed what it committed): not own
        // output, so a pending economy refresh runs on it.
        const ownOutputs = [], nativeSet = reviewKernel.states.set.bind(reviewKernel.states);
        reviewKernel.states.set = (id, entry, ownOutput) => { ownOutputs.push([id, ownOutput]); return nativeSet(id, entry); };
        commitAck(reviewKernel, { results: [
            { ok: true, characterId: 60, revision: 5, state: committed[60], review: ['plan'] },
            { ok: true, characterId: 61, revision: 5, state: committed[61] }] });
        assert.deepStrictEqual(ownOutputs, [[60, null], [61, null]], 'a state ack stores main\'s state');
        const request = sentCommands.get(reviewKernel).get(60);
        assert.strictEqual(request?.kind, 'review');
        assert.deepStrictEqual(request.economyPlan, plan, 'the review carries the committed proposal plan');
        assert.strictEqual(request.state, undefined, 'main reads its own committed state');
        assert.strictEqual(sentCommands.get(reviewKernel).has(61), false, 'an ack naming nothing sends no review');
        reviewKernel.tick();
        assert.strictEqual(everStepped(reviewKernel, 60), false, 'no step starts while the review runs');
        assert.strictEqual(everStepped(reviewKernel, 61), true);
        // The ok review ran the plan this step sent: its state is own output.
        ownOutputs.length = 0;
        commandAck(reviewKernel, { characterId: 60, state: { ...committed[60] } });
        assert.deepStrictEqual(ownOutputs, [[60, 'review']], 'an ok review of the plan sent stores own output');
        reviewKernel.states.set = nativeSet;
        reviewKernel.tick();
        assert.strictEqual(everStepped(reviewKernel, 60), true, 'the answered review gives the bot back to its schedule');
    }

    {
        // An ok ack with the commit's numbers and no state: the bot holds its
        // own proposed state released to main with the row's clock and
        // revisions, the same state main cached, and the review main named runs.
        const at = 55000;
        const numbersKernel = recordingKernel({ resolveSolo: () => null, now: () => at });
        const base = state(62, { timing: { lastResolvedAt: 1000, nextResolveAt: at + 60000 } });
        const next = state(62, { activity: 'resting', timing: { lastResolvedAt: at, nextResolveAt: at + 9000 } });
        numbersKernel.upsert({ state: base });
        numbersKernel.inFlight.set(62, { state: base, startedAt: at });
        numbersKernel.dirty.set(62, { proposalId: `62:${at}`, characterId: 62, revision: 3, priority: 'P1', enqueuedAt: at,
            nextState: next, result: { events: [] } });
        numbersKernel.flush(null, true);
        const ack = { ok: true, characterId: 62, revision: 5, updatedAt: at + 1, inventoryRevision: 3, skillsRevision: 2,
            hennaRevision: 1, review: ['training'] };
        // The rebuilt state is the step's own output: its store says so, and
        // the worker runs no economy refresh for it (own outputs are not inputs).
        const ownOutputs = [], nativeSet = numbersKernel.states.set.bind(numbersKernel.states);
        numbersKernel.states.set = (id, entry, ownOutput) => { ownOutputs.push([id, ownOutput]); return nativeSet(id, entry); };
        commitAck(numbersKernel, { results: [ack] });
        assert.deepStrictEqual(ownOutputs, [[62, 'commit']], 'a numbers ack stores the own commit');
        numbersKernel.states.set = nativeSet;
        const held = numbersKernel.states.get(62).state;
        assert.deepStrictEqual(held, Protocol.committedState(next, ack));
        assert.deepStrictEqual(held.simulation, { revision: 5 });
        assert.deepStrictEqual([held.activity, held.timing, held.updatedAt, held.bagRevision, held.skillsRevision, held.hennaRevision],
            ['resting', next.timing, at + 1, 3, 2, 1], 'the proposal and the ack numbers make the held state');
        assert.strictEqual(numbersKernel.inFlight.has(62), false, 'the proposed state goes with the in-flight record');
        assert.strictEqual(sentCommands.get(numbersKernel).get(62)?.kind, 'review', 'a numbers ack still sends the named review');
        assert.strictEqual(Protocol.committedState(next, { ...ack, updatedAt: undefined }), null, 'a missing number builds nothing');
        // An ok ack whose state cannot be rebuilt is no refusal: counted, the bot
        // keeps its plan as sent and waits for its due.
        const plan = { sell: [], withdraw: [8], buyAds: [], travel: null };
        numbersKernel.upsert({ state: state(63, { timing: { lastResolvedAt: 1000, nextResolveAt: at + 60000 } }) });
        Object.assign(numbersKernel.states.get(63), { economyPlanHash: 4321 });
        numbersKernel.inFlight.set(63, { state: numbersKernel.states.get(63).state, startedAt: at });
        numbersKernel.dirty.set(63, { proposalId: `63:${at}`, characterId: 63, revision: 3, priority: 'P1',
            enqueuedAt: at, nextState: next, result: { events: [] }, economyPlan: plan });
        numbersKernel.flush(null, true);
        commitAck(numbersKernel, { results: [{ ...ack, characterId: 63, updatedAt: undefined, review: ['plan'] }] });
        assert.strictEqual(numbersKernel.ackUnbuilt, 1);
        assert.strictEqual(numbersKernel.inFlight.has(63), false);
        assert.strictEqual(numbersKernel.states.get(63).state.simulation.revision, 3, 'nothing is upserted');
        assert.strictEqual(numbersKernel.states.get(63).economyPlanHash, 4321, 'the plan main named stays sent');
        assert.strictEqual(sentCommands.get(numbersKernel).has(63), false, 'no review on an unbuilt state');
    }

    {
        // A plan the step stamped as sent that no review runs (refused, skipped
        // on a full window, its send failed, or not named after a forced
        // cleanup) is forgotten as sent, so the refresh reproducing it sends it
        // again; the bot's next state still asks for that refresh.
        const at = 60000;
        const plan = { sell: [], withdraw: [9], buyAds: [], travel: null };
        let sendFails = false;
        const planKernel = recordingKernel({ resolveSolo: () => null, now: () => at,
            emit: type => !(sendFails && type === 'command_request') });
        const commitWithPlan = (id, review, inFlightOnly = false) => {
            const base = state(id, { timing: { lastResolvedAt: 1000, nextResolveAt: at + 60000 } });
            planKernel.upsert({ state: base });
            Object.assign(planKernel.states.get(id), { economyPending: 2, economyPlanHash: 1234 });
            planKernel.inFlight.set(id, { state: base, startedAt: at });
            planKernel.dirty.set(id, { proposalId: `${id}:${at}`, characterId: id, revision: 3, priority: 'P1', enqueuedAt: at,
                nextState: base, result: { events: [] }, economyPlan: plan });
            planKernel.flush(null, true);
            if (inFlightOnly) return;
            commitAck(planKernel, { results: [{ ok: true, characterId: id, revision: 5, review,
                state: state(id, { simulation: { ...base.simulation, revision: 5 }, timing: { lastResolvedAt: at, nextResolveAt: at } }) }] });
        };
        const sent = id => planKernel.states.get(id).economyPlanHash;
        commitWithPlan(70, ['plan']);
        assert.strictEqual(sent(70), 1234, 'a review on its way keeps the plan as sent');
        // A refused review ran no plan: its state is an input, not own output.
        const ownOutputs = [], nativeSet = planKernel.states.set.bind(planKernel.states);
        planKernel.states.set = (id, entry, ownOutput) => { ownOutputs.push([id, ownOutput]); return nativeSet(id, entry); };
        commandAck(planKernel, { characterId: 70, ok: false, reason: 'stale_command', state: planKernel.states.get(70).state });
        assert.deepStrictEqual(ownOutputs, [[70, null]], 'a refused review stores no own output');
        planKernel.states.set = nativeSet;
        assert.strictEqual(sent(70), null, 'a refused review forgets its plan as sent');
        assert.strictEqual(planKernel.states.get(70).economyPending, 2, 'the next state still asks for a refresh');
        commitWithPlan(71, ['buff']);
        assert.strictEqual(sent(71), null, 'a plan main did not name is forgotten as sent');
        commitWithPlan(75, undefined);
        assert.strictEqual(sent(75), null, 'a plan of an ack naming no review is forgotten as sent');
        sendFails = true;
        commitWithPlan(72, ['plan']);
        assert.strictEqual(sent(72), null, 'a review whose send failed forgets its plan as sent');
        assert.strictEqual(planKernel.reviewsSkipped, 1, 'a review whose send failed counts as skipped');
        assert.strictEqual(planKernel.commanding.has(72), false, 'a review whose send failed frees its slot');
        sendFails = false;
        planKernel.setMaxInFlight(1);
        commitWithPlan(73, ['plan'], true);
        commitWithPlan(74, ['plan']);
        assert.strictEqual(sent(74), null, 'a review skipped on a full window forgets its plan as sent');
        assert.strictEqual(planKernel.reviewsSkipped, 2);
    }

    // A party run with no member result (no spot): the whole roster commits
    // the party row, fenced on the revision the run read, with the resolver's
    // next due and a goal review; every member stays in flight until the ACK.
    // Main publishes the row before the commit ACK, and the leader is due at
    // that row's time. A refused commit (no new row) puts the leader no
    // sooner than a second away, not at the row's past due.
    const emptyMessages = [];
    let emptyNow = now;
    const emptyKernel = recordingKernel({
        resolveSolo: resolver,
        resolveParty: ({ timestamp }) => ({ memberResults: [], events: [], partyPatch: {}, nextResolveAt: timestamp + 60000,
            debug: { reason: 'missing_party_members_or_spot' } }),
        emit: (type, payload, msgId) => emptyMessages.push({ type, payload, msgId }),
        now: () => emptyNow
    });
    const emptyMembers = [250, 251].map(id => state(id, { party: { partyId: 'empty-party', leaderId: 250 } }));
    const emptyParty = { partyId: 'empty-party', leaderId: 250, memberIds: [250, 251], stats: {}, status: 'active',
        nextResolveAt: emptyNow - 5000, updatedAt: emptyNow - 5000, revision: 4 };
    emptyMembers.forEach(member => emptyKernel.upsert({ state: member }));
    emptyKernel.partyPut(emptyParty.partyId, emptyParty);
    const emptySteps = startedSteps.get(emptyKernel);
    const emptyRound = async () => {
        emptyMessages.length = 0;
        const stepped = emptySteps.length;
        emptyKernel.tick();
        assert.strictEqual(emptySteps.length, stepped + 1);
        assert.deepStrictEqual(lastSteps(emptyKernel), [250, 251]);
        await emptyKernel.resolveChain;
        return emptyMessages.find(entry => entry.type === 'proposal_batch').payload.proposals;
    };
    const emptyCommits = await emptyRound();
    assert.deepStrictEqual(emptyCommits.map(proposal => proposal.characterId), [250, 251], 'the whole roster commits');
    const emptyChange = emptyCommits[0].atomicGroup.partyChanges[0];
    assert(emptyCommits.every(proposal => proposal.atomicGroup.id === emptyCommits[0].atomicGroup.id), 'one group');
    assert.deepStrictEqual([emptyChange.partyId, emptyChange.expectedPartyRevision, emptyChange.nextResolveAt, emptyChange.spotId],
        ['empty-party', 4, emptyNow + 60000, undefined], 'the row change is fenced on the run\'s revision');
    const emptyLeaderCommit = emptyCommits.find(proposal => proposal.partyResolution);
    assert.strictEqual(emptyLeaderCommit.characterId, 250);
    assert.strictEqual(emptyLeaderCommit.partyResolution.reviewGoals, true, 'main reviews the party\'s goals');
    assert(emptyKernel.busy(250) && emptyKernel.busy(251), 'every member stays in flight until the commit ACK');
    emptyKernel.partyPut(emptyParty.partyId, { ...emptyParty, nextResolveAt: emptyNow + 60000, revision: 5 });
    commitAck(emptyKernel, { results: emptyCommits.map(proposal => ({ ok: true, characterId: proposal.characterId,
        state: { ...proposal.nextState, simulation: { revision: 5 } } })) });
    assert.strictEqual(emptyKernel.busy(250), false);
    assert.strictEqual(emptyKernel.scheduleTokens.get(250).dueAt, emptyNow + 60000, 'the leader is due at the row\'s next due');
    emptyNow += 1000;
    const steppedBeforeDue = emptySteps.length;
    emptyKernel.tick();
    assert.strictEqual(emptySteps.length, steppedBeforeDue, 'no step before the row\'s next due');
    emptyNow += 60000;
    const refusedCommits = await emptyRound();
    commitAck(emptyKernel, { results: refusedCommits.map(proposal => ({ ok: false, characterId: proposal.characterId,
        reason: 'party_group_aborted', detail: 'party_revision_stale',
        state: { ...proposal.nextState, simulation: { revision: 6 } } })) });
    assert.strictEqual(emptyKernel.busy(250), false);
    assert(emptyKernel.scheduleTokens.get(250).dueAt >= emptyNow + 1000,
        'a refused commit with no new row waits a second, not the row\'s past due');

    console.log('Cold worker protocol, deterministic kernel, scheduling, and fence checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

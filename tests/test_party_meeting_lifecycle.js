const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
const { ColdSimulationKernel, lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
// The facts a kernel gives lifecycleKind for a bot that leads `led` (its parties table).
const leading = led => ({ leaderParty: () => led, partyMembers: () => [],
    hallNeeded: () => false, playerWaiting: () => false });
const at = Date.now();
const party = { partyId: 'meeting-roster', leaderId: 1, memberIds: [1, 2], status: 'active',
    spotId: 'old-spot', nextResolveAt: at, stats: { sessionReview: { at: at - 300000, nextAt: at - 1 },
        travel: { reason: 'party_spot_replan', arrivalAt: at - 1, spotId: 'group-destination' } } };
const to = { locX: 2000, locY: 0, locZ: 0 };
const members = [1, 2].map(characterId => ({ characterId, phase: 'cold', name: `Member${characterId}`,
    activity: characterId === 1 ? 'grouped' : 'traveling', level: 20, spotId: 'old-spot',
    loc: { locX: 0, locY: 0, locZ: 0 }, party: { partyId: party.partyId, leaderId: 1 },
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
    timing: { lastResolvedAt: at - 1000, nextResolveAt: at, activityStartedAt: at - 1000 },
    simulation: { revision: 1 },
    stats: characterId === 1 ? {} : { tradeMeeting: [7, 1], travel: { from: { locX: 0, locY: 0, locZ: 0 },
        to, startedAt: at - 1000, arrivalAt: at, method: 'walk', reason: 'trade_meeting', meetingId: 7,
        arrivalActivity: 'shopping', arrivalEvent: 'trade_meeting_arrival' } } }));
async function main() {
    for (const activity of ['traveling', 'resting', 'dead', 'shopping']) {
        const leader = { ...members[0], activity, stats: { tradeMeeting: [7, 1] } };
        const follower = { ...members[1], activity };
        assert.equal(lifecycleKind(leader, leading(party)), 'party');
        assert.equal(lifecycleKind(follower, leading(null)), 'party_member');
        assert.equal(Owner.eligibility(follower, { allowLifecycle: true }).reason, 'background_party', 'solo gate remains strict');
    }
    assert.equal(lifecycleKind({ ...members[1], party: null }), 'resolver', 'solo finite meeting travel is unchanged');
    assert.equal(Assembly.meetingPending(members), true);
    const before = JSON.stringify(members);
    const result = Resolver.resolve({ party, members, spot: null, timestamp: at,
        rng: () => { throw Error('an accepted meeting cannot roll a new fight'); } });
    assert.equal(result.debug.reason, 'party_meeting_lifecycle');
    assert.equal(result.atomic, true);
    assert.equal(JSON.stringify(members), before);
    assert.deepEqual(result.memberResults[0].result.patch, {}, 'the waiting hunter is not moved or charged');
    const arrival = result.memberResults[1].result;
    assert.deepEqual(arrival.patch.loc, to);
    assert.equal(arrival.patch.activity, 'shopping');
    assert.equal(arrival.patch.stats.travel, null);
    assert.deepEqual(arrival.patch.stats.tradeMeeting, [7, 1]);
    assert.equal(arrival.events[0].type, 'trade_meeting_arrival');
    assert(result.memberResults.every(entry => entry.result.materialize.exp === 0 && entry.result.materialize.items.length === 0));
    const recovering = [{ ...members[0], activity: 'resting', vitals: { hp: 10, maxHp: 100, mp: 5, maxMp: 50 },
        stats: { restUntil: at + 30000 } }, { ...members[1], stats: { ...members[1].stats,
        travel: { ...members[1].stats.travel, arrivalAt: at + 10000 } } }];
    const recovery = Resolver.resolve({ party, members: recovering, timestamp: at, spot: null });
    assert(recovery.memberResults[0].result.patch.vitals.hp > 10, 'meeting does not stop ordinary recovery');
    assert(recovery.memberResults.every(entry => Number.isFinite(entry.result.nextResolveAt)), 'native recovery keeps finite deadlines');
    assert.equal(recovery.memberResults[1].result.patch.activity, 'traveling', 'another member resting cannot replace meeting travel');
    assert.equal(recovery.memberResults[1].result.patch.stats.travel.reason, 'trade_meeting');
    const dead = [{ ...members[0], activity: 'dead', vitals: { ...members[0].vitals, hp: 0 },
        stats: { ...members[0].stats, coldPvp: { recoverUntil: at + 10000 } } }, members[1]];
    const death = Resolver.resolve({ party, members: dead, timestamp: at, spot: null });
    assert(death.memberResults[0].result.nextResolveAt > at, 'death recovery remains finite');
    assert.equal(death.memberResults[1].result.patch.activity, 'shopping');

    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw Error('meeting follower must not enter solo ownership'); },
        resolveParty: input => Resolver.resolve(input),
        projectResolve: (state, resolution) => ({ ...state, ...resolution.patch }),
        planPartyRequirement: () => { throw Error('held meeting cannot start another economic plan'); },
        partyRoute: () => ({ route: { needed: true, travelMs: 60000, spotId: 'wrong-spot', to: { locX: 9000, locY: 0, locZ: 0 } } }),
        emit: (type, payload) => messages.push({ type, payload }) });
    for (const state of members) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
    }
    kernel.partyPut(party.partyId, { ...party, nextResolveAt: at + 10000 });
    assert.equal(kernel.dueAt(members[0]), at, 'a later group timer does not postpone the due paid arrival');
    kernel.partyRuns.set(party.partyId, { party, members, startedAt: at, requirementRefresh: true,
        spot: null });
    await kernel.resolvePartyStep(party.partyId);
    const batch = messages.find(message => message.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    assert.equal(batch.payload.proposals.length, 2);
    const proposal = batch.payload.proposals.find(entry => entry.characterId === 2);
    assert.deepEqual(proposal.nextState.loc, to, 'review/party-route cannot overwrite an already paid leg');
    assert.equal(proposal.nextState.party.partyId, party.partyId);
    assert.equal(proposal.nextState.activity, 'shopping');
    assert(proposal.atomicGroup && batch.payload.proposals.every(entry => entry.atomicGroup.id === proposal.atomicGroup.id));
    assert.equal(proposal.options.allowParty, true);
    assert(!batch.payload.proposals.some(entry => entry.partyResolution?.requirementRefreshedAt), 'a pending meeting holds the re-plan');

    const selected = [];
    let selectorAt = at;
    const selector = new ColdSimulationKernel({ now: () => selectorAt,
        resolveSolo: () => { throw Error('no personal step for a group meeting'); },
        resolveParty: input => Resolver.resolve(input),
        // As the worker's projection: the round's exp and next due land on the state.
        projectResolve: (state, resolution) => ({ ...state, ...resolution.patch,
            exp: Number(state.exp || 0) + Number(resolution.materialize?.exp || 0),
            timing: { ...state.timing, nextResolveAt: resolution.nextResolveAt ?? state.timing?.nextResolveAt } }),
        emit: (type, payload, msgId) => selected.push({ type, payload, msgId }) });
    const future = members.map(state => state.characterId === 1 ? state : { ...state,
        stats: { ...state.stats, travel: { ...state.stats.travel, arrivalAt: at + 10000 } } });
    for (const state of future) selector.upsert({ state });
    selector.partyPut(party.partyId, party);
    selector.tick();
    assert.equal(selector.inFlight.size, 0, 'expired session review cannot shorten a future physical meeting leg');
    selectorAt += 10000;
    selector.tick();
    const step = selector.partyRuns.get(String(party.partyId));
    assert(step && selector.inFlight.size === 2);
    assert.equal(step.purpose.kind, 'party');
    await selector.resolveChain;
    const selectedBatch = selected.find(message => message.type === 'proposal_batch');
    assert(selectedBatch, JSON.stringify(selected));
    const continuedParty = selectedBatch.payload.proposals.find(entry => entry.partyResolution).partyResolution.party;
    assert.equal(continuedParty.nextResolveAt, selectorAt, 'physical arrival publishes the native next-pass deadline');
    // Main's parties table row arrives before the commit's ack (one flush).
    selector.partyPut(continuedParty.partyId, continuedParty);
    selector.onCommitAck({ results: selectedBatch.payload.proposals.map(proposal => ({
        ok: true, characterId: proposal.characterId, proposalId: proposal.proposalId,
        state: proposal.nextState,
        context: {}
    })) });
    selector.tick();
    const afterArrivalStep = selector.partyRuns.get(String(party.partyId));
    assert(afterArrivalStep && afterArrivalStep !== step, 'the native next-pass transition is admitted once');
    await selector.resolveChain;
    const idleBatch = selected.filter(message => message.type === 'proposal_batch').at(-1);
    const idleParty = idleBatch.payload.proposals.find(proposal => proposal.partyResolution).partyResolution.party;
    assert.equal(idleParty.nextResolveAt, selectorAt + 30000, 'a held completed leg returns to finite lifecycle scheduling');
    assert(idleBatch.payload.proposals.every(proposal => Number(proposal.nextState.exp || 0) === 0));
    selector.partyPut(idleParty.partyId, idleParty);
    selector.onCommitAck({ results: idleBatch.payload.proposals.map(proposal => ({ ok: true,
        characterId: proposal.characterId, proposalId: proposal.proposalId,
        state: proposal.nextState,
        context: {}
    })) });
    for (let i = 0; i < 100; i++) selector.tick();
    assert.equal(selector.inFlight.size, 0,
        'expired session review cannot restart the same held group work before its transition');

    const victoryParty = { ...party, stats: { ...party.stats, objective: { sourceKind: 'raid', raidBossTemplateId: 10484 },
        raidEncounter: { status: 'defeated', bossTemplateId: 10484, defeatedAt: at - 1000 } } };
    for (const arrivalAt of [at - 1000, at + 10000]) {
        const raidMembers = members.map(state => state.characterId === 1 ? state : { ...state,
            stats: { ...state.stats, travel: { ...state.stats.travel, arrivalAt } } });
        const terminal = Resolver.resolveMeetingLifecycle({ party: victoryParty, members: raidMembers, timestamp: at });
        assert.equal(terminal.debug.reason, 'raid_already_defeated');
        assert.equal(terminal.partyPatch.status, 'dissolved');
        assert.equal(terminal.nextResolveAt, null);
        assert(terminal.memberResults.every(({ result }) => result.materialize.exp === 0 && result.materialize.items.length === 0));
        assert.deepEqual(terminal.memberResults[1].result.patch, {}, 'terminal raid grants no reward or replacement journey');
        const raidMessages = [];
        const terminalKernel = new ColdSimulationKernel({ now: () => at,
            resolveSolo: () => { throw Error('completed roster resolves under group ownership'); },
            resolveParty: input => Resolver.resolve(input),
            projectResolve: (state, resolution) => ({ ...state, ...resolution.patch }),
            partyRoute: () => ({ route: { needed: true, travelMs: 60000, spotId: 'wrong-spot' } }),
            emit: (type, payload) => raidMessages.push({ type, payload }) });
        for (const state of raidMembers) {
            terminalKernel.upsert({ state });
            terminalKernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
        }
        terminalKernel.partyPut(victoryParty.partyId, victoryParty);
        assert.equal(terminalKernel.dueAt(raidMembers[0]), at,
            'terminal raid settlement is not delayed by a future personal leg');
        terminalKernel.partyRuns.set(party.partyId, { party: victoryParty, members: raidMembers, startedAt: at,
            spot: null });
        await terminalKernel.resolvePartyStep(party.partyId);
        const raidBatch = raidMessages.find(message => message.type === 'proposal_batch');
        assert(raidBatch, JSON.stringify(raidMessages));
        const detached = raidBatch.payload.proposals.find(entry => entry.characterId === 2);
        assert.equal(detached.nextState.party.partyId, null, 'native worker detachment releases completed raid membership');
        assert.deepEqual(detached.nextState.stats.travel, raidMembers[1].stats.travel, 'future and due personal legs survive detachment');
        assert.deepEqual(detached.nextState.stats.tradeMeeting, [7, 1]);
        assert.equal(detached.atomicGroup.partyChanges[0].status, 'dissolved', 'terminal row is in the same fenced atomic group');
        assert.equal(raidBatch.payload.proposals.find(entry => entry.partyResolution).partyResolution.party.status, 'dissolved');
    }

    const Bridge = require('../src/GameServer/Bot/Population/ColdRaidWorldBridge');
    const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
    const originalSettle = Bridge.settle;
    const settlements = [];
    try {
        Bridge.settle = async input => { settlements.push(input); return { ok: true }; };
        for (const committed of [{ partyRow: { partyId: party.partyId, updatedAt: at } },
            { raidPartyRow: { partyId: party.partyId, updatedAt: at }, raidRespawnAt: at + 60000 }]) {
            const coordinator = new ColdSimulationCoordinator();
            const stop = new Error('stop after settlement step');
            let settled = false;
            coordinator.step = async (name, id, work) => {
                if (settled) throw stop;
                if (name === 'raidSettlement') { await work(); settled = true; }
            };
            const count = settlements.length;
            await assert.rejects(coordinator.afterCommit({ nextState: members[0], proposal: {
                partyResolution: { party: victoryParty } } }, committed), error => error === stop);
            assert.equal(settlements.length, count + 1, 'native postcommit bridge retries defeat for terminal partyRow as well as raidPartyRow');
            assert.equal(settlements.at(-1), victoryParty);
        }
    } finally {
        Bridge.settle = originalSettle;
    }
    assert.equal(Resolver.resolveMeetingLifecycle({ party, members: members.map(state => ({ ...state, stats: {} })), timestamp: at }), null,
        'the terminal meeting event restores the ordinary party path');
    console.log('Party meeting routing, atomic arrival, native recovery and overwrite protection passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

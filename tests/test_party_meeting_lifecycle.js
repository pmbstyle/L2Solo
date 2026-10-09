const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
const { ColdSimulationKernel, lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = Date.now();
const party = { partyId: 'meeting-roster', leaderId: 1, memberIds: [1, 2], status: 'active',
    spotId: 'old-spot', nextResolveAt: at, stats: { sessionExpiresAt: at - 1,
        travel: { reason: 'party_spot_replan', arrivalAt: at - 1, spotId: 'group-destination' } } };
const to = { locX: 2000, locY: 0, locZ: 0 };
const members = [1, 2].map(characterId => ({ characterId, phase: 'cold', name: `Member${characterId}`,
    activity: characterId === 1 ? 'grouped' : 'traveling', level: 20, spotId: 'old-spot',
    loc: { locX: 0, locY: 0, locZ: 0 }, party: { partyId: party.partyId, leaderId: 1 },
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
    timing: { lastResolvedAt: at - 1000, nextResolveAt: at, activityStartedAt: at - 1000 },
    simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 },
    stats: characterId === 1 ? {} : { tradeMeeting: [7, 1], travel: { from: { locX: 0, locY: 0, locZ: 0 },
        to, startedAt: at - 1000, arrivalAt: at, method: 'walk', reason: 'trade_meeting', meetingId: 7,
        arrivalActivity: 'shopping', arrivalEvent: 'trade_meeting_arrival' } } }));
async function main() {
    for (const activity of ['traveling', 'resting', 'dead', 'shopping']) {
        const leader = { ...members[0], activity, stats: { tradeMeeting: [7, 1] } };
        const follower = { ...members[1], activity };
        assert.equal(lifecycleKind(leader, { isPartyLeader: true }), 'party');
        assert.equal(lifecycleKind(follower, { isPartyLeader: false }), 'party_member');
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
        emit: (type, payload) => messages.push({ type, payload }) });
    const requestId = 'meeting-claim';
    const grants = new Map(members.map(state => [state.characterId, { characterId: state.characterId,
        ownerId: 'cold_simulation_owner', leaseId: `group-${state.characterId}`, revision: 1, leaseUntil: at + 30000 }]));
    for (const state of members) {
        kernel.upsert({ state, context: {} });
        kernel.inFlight.set(state.characterId, { state, grant: grants.get(state.characterId), partyId: party.partyId, claimRequestId: requestId });
    }
    const context = { isPartyLeader: true, party: { ...party, nextResolveAt: at + 10000 } };
    assert.equal(kernel.dueAt(members[0], context), at + 10000, 'expired session review does not spin while a paid journey holds the roster');
    kernel.partyRuns.set(party.partyId, { party, members, grants, requestId, requirementRefresh: true,
        spot: null, route: { needed: true, travelMs: 60000, spotId: 'wrong-spot', to: { locX: 9000, locY: 0, locZ: 0 } } });
    await kernel.resolvePartyGrant(party.partyId);
    const batch = messages.find(message => message.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    assert.equal(batch.payload.proposals.length, 2);
    const proposal = batch.payload.proposals.find(entry => entry.characterId === 2);
    assert.deepEqual(proposal.nextState.loc, to, 'review/party-route cannot overwrite an already paid leg');
    assert.equal(proposal.nextState.party.partyId, party.partyId);
    assert.equal(proposal.nextState.activity, 'shopping');
    assert(proposal.atomicGroup && batch.payload.proposals.every(entry => entry.atomicGroup.id === proposal.atomicGroup.id));
    assert.equal(proposal.options.allowParty, true);
    assert.equal(batch.payload.proposals.find(entry => entry.partyResolution).partyResolution.reviewGoals, false);
    assert(!batch.payload.proposals.some(entry => entry.partyResolution?.memberPlans));

    const selected = [];
    const selector = new ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw Error('no personal claim for a group meeting'); },
        resolveParty: input => Resolver.resolve(input),
        projectResolve: (state, resolution) => ({ ...state, ...resolution.patch }),
        emit: (type, payload, msgId) => selected.push({ type, payload, msgId }) });
    const future = members.map(state => state.characterId === 1 ? state : { ...state,
        stats: { ...state.stats, travel: { ...state.stats.travel, arrivalAt: at + 10000 } } });
    for (const state of future) selector.upsert({ state, context: { party, partyMembers: future,
        isPartyLeader: state.characterId === party.leaderId } });
    selector.tick();
    const claim = selected.find(message => message.type === 'claim_request');
    assert(claim && claim.payload.candidates.length === 2);
    assert(claim.payload.candidates.every(candidate => candidate.purpose.kind === 'party'));
    selector.onClaimAck({ grants: claim.payload.candidates.map(candidate => ({ ...grants.get(candidate.characterId),
        ok: true, purpose: candidate.purpose })) }, claim.msgId);
    await selector.resolveChain;
    const selectedBatch = selected.find(message => message.type === 'proposal_batch');
    assert(selectedBatch, JSON.stringify(selected));
    const continuedParty = selectedBatch.payload.proposals.find(entry => entry.partyResolution).partyResolution.party;
    assert.equal(continuedParty.nextResolveAt, at + 10000, 'real group flow waits for the next finite transition');
    selector.onCommitAck({ results: selectedBatch.payload.proposals.map(proposal => ({
        ok: true, characterId: proposal.characterId, inputToken: proposal.token, proposalId: proposal.proposalId,
        state: { ...proposal.nextState, timing: { ...proposal.nextState.timing, nextResolveAt: proposal.result.nextResolveAt } },
        context: { party: continuedParty, partyMembers: future, isPartyLeader: proposal.characterId === party.leaderId }
    })) });
    const claimCount = selected.filter(message => message.type === 'claim_request').length;
    for (let i = 0; i < 100; i++) selector.tick();
    assert.equal(selected.filter(message => message.type === 'claim_request').length, claimCount,
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
            emit: (type, payload) => raidMessages.push({ type, payload }) });
        for (const state of raidMembers) {
            terminalKernel.upsert({ state, context: {} });
            terminalKernel.inFlight.set(state.characterId, { state, grant: grants.get(state.characterId),
                partyId: party.partyId, claimRequestId: requestId });
        }
        terminalKernel.partyRuns.set(party.partyId, { party: victoryParty, members: raidMembers, grants,
            requestId, spot: null, route: { needed: true, travelMs: 60000, spotId: 'wrong-spot' } });
        await terminalKernel.resolvePartyGrant(party.partyId);
        const raidBatch = raidMessages.find(message => message.type === 'proposal_batch');
        assert(raidBatch, JSON.stringify(raidMessages));
        const detached = raidBatch.payload.proposals.find(entry => entry.characterId === 2);
        assert.equal(detached.nextState.party.partyId, null, 'native worker detachment releases completed raid membership');
        assert.deepEqual(detached.nextState.stats.travel, raidMembers[1].stats.travel, 'future and due personal legs survive detachment');
        assert.deepEqual(detached.nextState.stats.tradeMeeting, [7, 1]);
        assert.equal(detached.atomicGroup.partyChanges[0].status, 'dissolved', 'terminal row is in the same fenced atomic group');
        assert.equal(raidBatch.payload.proposals.find(entry => entry.partyResolution).partyResolution.party.status, 'dissolved');
    }

    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const saved = [];
    const originals = [Life.statesForParty, Life.applyResolve, Parties.createOrUpdate, Life.clearParty];
    try {
        Life.statesForParty = async () => members;
        Life.applyResolve = async (state, resolution) => { const next = { ...state, ...resolution.patch }; saved.push(next); return next; };
        Parties.createOrUpdate = async next => next;
        const releases = [];
        Life.clearParty = async (...args) => releases.push(args);
        const legacy = await Population.resolveBackgroundParty(party);
        assert.equal(legacy.debug.reason, 'party_meeting_lifecycle');
        assert.deepEqual(saved[1].loc, to);
        assert.equal(saved[1].activity, 'shopping');
        assert.equal(saved[1].party.partyId, party.partyId);
        saved.length = 0;
        const legacyVictory = await Population.resolveBackgroundParty(victoryParty);
        assert.equal(legacyVictory.party.status, 'dissolved');
        assert.equal(legacyVictory.debug.reason, 'raid_already_defeated');
        assert.deepEqual(releases, [[party.partyId, 'raid_defeated']], 'legacy path uses native member release');
        assert.deepEqual(saved[1].stats.travel, members[1].stats.travel);
        assert.deepEqual(saved[1].stats.tradeMeeting, [7, 1]);
    } finally {
        [Life.statesForParty, Life.applyResolve, Parties.createOrUpdate, Life.clearParty] = originals;
    }
    assert.equal(Resolver.resolveMeetingLifecycle({ party, members: members.map(state => ({ ...state, stats: {} })), timestamp: at }), null,
        'the terminal meeting event restores the ordinary party path');
    console.log('Party meeting routing, atomic arrival, native recovery, overwrite protection and legacy parity passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

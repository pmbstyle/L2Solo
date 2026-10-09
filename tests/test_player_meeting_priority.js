'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

function state(characterId, dueAt, meeting = false) {
    return { characterId, phase: 'cold', activity: meeting ? 'resting' : 'hunting', level: 20,
        stats: meeting ? { tradeMeeting: [38, 1], restUntil: dueAt } : {},
        timing: { lastResolvedAt: dueAt - 1000, nextResolveAt: dueAt },
        simulation: { ownerId: 'legacy_main', revision: 3, leaseId: null, leaseUntil: 0 } };
}
function fixture(maxInFlight = 8) {
    let now = 100000;
    const messages = [];
    const kernel = new ColdSimulationKernel({ maxInFlight, now: () => now,
        resolveSolo: () => ({ patch: { activity: 'hunting' }, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: now + 60000 }),
        emit: (type, payload, msgId) => messages.push({ type, payload, msgId }) });
    return { kernel, messages, advance: ms => { now += ms; }, now: () => now };
}
function addParty(kernel, dueAt) {
    const party = { partyId: 'older-party', leaderId: 10,
        memberIds: Array.from({ length: 8 }, (_, n) => 10 + n), nextResolveAt: dueAt };
    const members = party.memberIds.map(id => ({ ...state(id, dueAt), party: { partyId: party.partyId } }));
    members.forEach(member => kernel.upsert({ state: member, context: member.characterId === 10
        ? { isPartyLeader: true, party, partyMembers: members } : {} }));
}

(async () => {
    // Two ancient solo claims fill part of a player-sized window; the older
    // eight-member party cannot fit behind them. The merchant must still run.
    const waiting = fixture();
    waiting.kernel.upsert({ state: state(1, 1000, true), context: {} });
    waiting.kernel.upsert({ state: state(2, 2000, true), context: {} });
    addParty(waiting.kernel, 3000);
    waiting.kernel.upsert({ state: state(30, 99000, true), context: { playerWaiting: true } });
    waiting.kernel.tick();
    const request = waiting.messages.find(row => row.type === 'claim_request');
    assert.deepEqual(request.payload.candidates.map(row => row.characterId), [30, 1, 2],
        'a ready merchant reaches the waiting player before old claims and a capacity-blocked party');
    waiting.kernel.onClaimAck({ grants: [{ characterId: 30, ownerId: 'cold_simulation_owner',
        revision: 4, leaseId: 'waiting-player', leaseUntil: waiting.now() + 30000 }],
    rejected: [1, 2].map(id => ({ characterId: id, reason: 'background_party',
        state: state(id, id * 1000, true), context: {} })) }, request.msgId);
    await waiting.kernel.resolveChain;
    const committed = waiting.messages.find(row => row.type === 'proposal_batch');
    assert(committed, 'the player transition is sent immediately without waiting for a partial flush window');
    assert.equal(committed.payload.proposals[0].characterId, 30);
    assert.equal(committed.payload.proposals[0].priority, 'P0');

    const rejected = fixture(1);
    rejected.kernel.upsert({ state: state(1, 1000, true), context: {} });
    rejected.kernel.upsert({ state: state(2, 2000), context: {} });
    rejected.kernel.tick();
    const first = rejected.messages.find(row => row.type === 'claim_request');
    rejected.kernel.onClaimAck({ rejected: [{ characterId: 1, reason: 'background_party',
        state: state(1, 1000, true), context: {} }] }, first.msgId);
    rejected.kernel.tick();
    assert.deepEqual(rejected.messages.filter(row => row.type === 'claim_request')
        .map(row => row.payload.candidates[0].characterId), [1, 2],
    'an unchanged rejected row yields to ordinary work instead of retrying each tick');
    assert.equal(rejected.kernel.scheduleTokens.get(1).dueAt, rejected.now() + 1000);
    rejected.advance(999);
    assert.deepEqual(rejected.kernel.dueCandidates(rejected.now(), 1), []);
    rejected.advance(1);
    assert.equal(rejected.kernel.dueCandidates(rejected.now(), 1)[0].characterId, 1);

    const delayed = fixture(1);
    delayed.kernel.upsert({ state: state(1, 1000, true), context: {} }); delayed.kernel.tick();
    delayed.kernel.onClaimAck({ rejected: [{ characterId: 1, reason: 'unavailable', retryAfterMs: 30000,
        state: state(1, 1000, true), context: {} }] }, delayed.messages[0].msgId);
    delayed.advance(1000);
    assert.deepEqual(delayed.kernel.dueCandidates(delayed.now(), 1), [], 'an explicit longer retry delay remains in force');

    const future = fixture(1);
    future.kernel.upsert({ state: state(1, 1000), context: {} });
    future.kernel.upsert({ state: state(30, 101000, true), context: { playerWaiting: true } });
    assert.equal(future.kernel.dueCandidates(future.now(), 1)[0].characterId, 1,
        'waiting players do not block ordinary work while the merchant is still recovering');
    assert.deepEqual(future.kernel.dueCandidates(future.now(), 1), [], 'priority never shortens a finite transition');
    future.advance(1000);
    assert.equal(future.kernel.dueCandidates(future.now(), 1)[0].characterId, 30);

    for (const leader of [false, true]) {
        const grouped = fixture(8), merchant = { ...state(30, 500000, true), activity: 'traveling',
            party: { partyId: 'meeting-party' },
            stats: { tradeMeeting: [43, 1], travel: { arrivalAt: 99000 } } };
        const peer = { ...state(31, 1000), party: { partyId: 'meeting-party' } };
        const party = { partyId: 'meeting-party', leaderId: leader ? 30 : 31,
            memberIds: [30, 31], nextResolveAt: 500000, stats: { sessionReview: { nextAt: 500001 } } };
        grouped.kernel.upsert({ state: merchant, context: { playerWaiting: true,
            isPartyLeader: leader, party, partyMembers: [merchant, peer] } });
        grouped.kernel.upsert({ state: peer, context: { isPartyLeader: !leader, party,
            partyMembers: [merchant, peer] } });
        const candidates = grouped.kernel.dueCandidates(grouped.now(), 8);
        assert.deepEqual(candidates.map(row => [row.characterId, row.purpose.kind]), [[30, 'resolver']],
            'a grouped merchant uses its overdue physical arrival, including when it leads the party');
        assert.equal(grouped.kernel.partyRuns.size, 0, 'the hunt must not acquire or rewrite a meeting participant');
    }

    const suspended = fixture(8);
    const busyMerchant = { ...state(30, 101000, true), party: { partyId: 'waiting-hunt' } };
    const waitingLeader = { ...state(31, 1000), party: { partyId: 'waiting-hunt' } };
    const waitingParty = { partyId: 'waiting-hunt', leaderId: 31, memberIds: [30, 31], nextResolveAt: 1000 };
    suspended.kernel.upsert({ state: busyMerchant, context: { playerWaiting: true } });
    suspended.kernel.upsert({ state: waitingLeader, context: { isPartyLeader: true,
        party: waitingParty, partyMembers: [busyMerchant, waitingLeader] } });
    assert.deepEqual(suspended.kernel.dueCandidates(suspended.now(), 8), [],
        'an old hunt cannot claim a merchant whose independent recovery has not finished');
    assert.equal(suspended.kernel.states.get(30).state.timing.nextResolveAt, 101000);
    suspended.advance(30000);
    suspended.kernel.upsert({ state: { ...busyMerchant, activity: 'grouped', stats: {} }, context: {} });
    assert.deepEqual(suspended.kernel.dueCandidates(suspended.now(), 8)
        .map(row => [row.characterId, row.purpose.kind]), [[30, 'party'], [31, 'party']],
    'the retained party resumes its ordinary atomic hunt after the obligation clears');

    for (const waitingAtEnd of [false, true]) {
        const refresh = fixture(1), merchant = state(30, 99000, true);
        refresh.kernel.upsert({ state: state(1, 1000), context: {} });
        refresh.kernel.upsert({ state: merchant, context: { playerWaiting: !waitingAtEnd } });
        refresh.kernel.upsert({ state: merchant, context: { playerWaiting: waitingAtEnd } });
        assert.equal(refresh.kernel.dueCandidates(refresh.now(), 1)[0].characterId, waitingAtEnd ? 30 : 1,
            'presence changes update priority even when the durable state revision and deadline stay the same');
    }
    const removed = fixture(1);
    removed.kernel.upsert({ state: state(30, 99000, true), context: { playerWaiting: true } });
    removed.kernel.upsert({ state: state(1, 1000), context: {} });
    removed.kernel.remove(30);
    assert.equal(removed.kernel.dueCandidates(removed.now(), 1)[0].characterId, 1,
        'a removed waiting merchant leaves no stale priority node');
    const simultaneous = fixture(1);
    simultaneous.kernel.upsert({ state: state(1, 1000), context: {} });
    for (let id = 63; id >= 32; id--) simultaneous.kernel.upsert({
        state: state(id, 99000 + id, true), context: { playerWaiting: true } });
    for (let id = 32; id <= 63; id++) assert.equal(
        simultaneous.kernel.dueCandidates(simultaneous.now(), 1)[0].characterId, id,
        'multiple waiting players keep their deadline order as earlier transitions leave the queue');
    assert.equal(simultaneous.kernel.dueCandidates(simultaneous.now(), 1)[0].characterId, 1);
    console.log('PASS waiting-player transitions, immediate P0 publication, rejection backoff, finite deadlines and presence changes');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

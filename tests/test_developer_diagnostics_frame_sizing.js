'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdCompetitionFrameSizer, numbersAs32Chars } = require('../src/GameServer/Bot/Population/ColdCompetitionFrameSizer');
const at = 1800000000000;
async function capture(enabled) {
    Config.developerDiagnostics = enabled;
    const members = [1, 2].map(characterId => ({ characterId, phase: 'cold', activity: 'hunting', level: 20,
        timing: { lastResolvedAt: at - 1000, nextResolveAt: at }, stats: { equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 55 } } },
        simulation: { ownerId: 'legacy_main', revision: 3, leaseId: null, leaseUntil: 0 }, updatedAt: at - 1000,
        party: { partyId: 'sizing-party' } }));
    const party = { partyId: 'sizing-party', status: 'active', leaderId: 1, memberIds: [1, 2], stats: {}, nextResolveAt: at };
    const emitted = [];
    const kernel = new ColdSimulationKernel({ now: () => at, resolveSolo: () => { throw Error('unexpected solo'); },
        resolveParty: ({ members, timestamp }) => ({ memberResults: members.map(state => ({ state, result: {} })),
            partyPatch: {}, events: [], nextResolveAt: timestamp + 45000 }),
        projectResolve: state => ({ state }), planPartyRequirement: ({ state }) => ({ acquisitionPlan: state.stats.equipmentPlan }),
        emit: (type, payload, msgId) => emitted.push({ type, payload, msgId }) });
    kernel.upsert({ state: members[0], context: { isPartyLeader: true, party, partyMembers: members,
        spot: { id: 'sizing-spot' }, requirementRefresh: true } });
    kernel.upsert({ state: members[1], context: {} }); kernel.tick();
    const claim = emitted.find(row => row.type === 'claim_request');
    assert(claim, 'actual party claim');
    kernel.onClaimAck({ grants: claim.payload.candidates.map(candidate => ({ ok: true, characterId: candidate.characterId,
        ownerId: 'cold_simulation_owner', revision: candidate.expectedRevision + 1,
        leaseId: 'sizing-' + candidate.characterId, leaseUntil: at + 30000, purpose: candidate.purpose })) }, claim.msgId);
    await kernel.resolveChain;
    assert(emitted.some(row => row.type === 'proposal_batch'), 'actual refreshed party proposals');
    assert(Object.hasOwn(kernel.stats, 'partyRequirementRefreshMaxMs'));
    const proposals = emitted.find(row => row.type === 'proposal_batch').payload.proposals;
    for (const reason of ['priority', 'batch', 'forced', 'direct', 'capacity', 'hard_age', 'target_age']) {
        proposals.forEach(proposal => kernel.dirty.set(proposal.characterId, proposal));
        kernel.flush(null, true, { reason });
    }
    assert.equal(Object.keys(kernel.stats.flushReasons).length, 7);
    if (!enabled) {
        assert.equal(kernel.stats.partyRequirementRefreshes, 0);
        assert.equal(kernel.stats.flushReasons.priority, 0);
        assert.equal(kernel.heartbeatSnapshot().partyRequirementRefreshes, undefined);
    }
    const report = kernel.heartbeatSnapshot(true);
    return Protocol.envelope('heartbeat', 'same-epoch', { ...report,
        competition: { frame: { at, frameId: 1, events: [] }, events: [], recent: [], outcomes: {} } }, 'same-message');
}
(async () => {
    const off = await capture(false), on = await capture(true);
    assert.equal(Buffer.byteLength(JSON.stringify(off, numbersAs32Chars)), Buffer.byteLength(JSON.stringify(on, numbersAs32Chars)),
        'same operational template bytes after native refresh and all flush reasons');
    const events = Array.from({ length: 160 }, (_, id) => ({ at, key: 'near-cap-' + id, action: 'contest',
        actor: { id: 1 }, peer: { id: id + 2 }, text: 'x'.repeat(3000 + id % 10) }));
    for (const limit of [5000, 20000, Protocol.MAX_MESSAGE_BYTES]) {
        const a = new ColdCompetitionFrameSizer(off, [], limit), b = new ColdCompetitionFrameSizer(on, [], limit);
        assert.equal(a.base, b.base);
        const acceptedA = [], acceptedB = [];
        for (const event of events) { if (a.offer(event)) acceptedA.push(event.key); if (b.offer(event)) acceptedB.push(event.key); }
        assert.deepEqual(acceptedA, acceptedB, 'identical near-cap event membership and order');
        assert.equal(a.estimate, b.estimate);
    }
    Config.developerDiagnostics = false;
    console.log('Native refresh/flush shape and near-cap competition admissions match with diagnostics on/off');
})().catch(error => { console.error(error); process.exitCode = 1; });

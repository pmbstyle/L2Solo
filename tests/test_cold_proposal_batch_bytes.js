const assert = require('assert');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

// ColdSimulationKernel PROPOSAL_PAYLOAD_LIMIT_BYTES.
const LIMIT = 240 * 1024;
const MAX_BATCH = 64;

function seeded(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
    };
}

function proposal(characterId, enqueuedAt, padding, atomicGroup = null) {
    return {
        proposalId: `lease-${characterId}:1`,
        characterId,
        priority: 'P2',
        enqueuedAt,
        token: { ok: true, characterId, ownerId: 'cold_simulation_owner', revision: 1, leaseId: `lease-${characterId}` },
        nextState: { characterId, stats: { note: padding } },
        result: { events: [], debug: { activity: 'hunting' } },
        ...(atomicGroup ? { atomicGroup } : {})
    };
}

function kernelWith(proposals) {
    const emitted = [];
    const kernel = new ColdSimulationKernel({
        resolveSolo: async () => ({}),
        emit: (type, payload) => { if (type === 'proposal_batch') emitted.push(payload.proposals); },
        now: () => 10_000_000,
        maxBatch: MAX_BATCH,
        maxInFlight: 128
    });
    proposals.forEach((entry) => kernel.dirty.set(entry.characterId, entry));
    return { kernel, emitted };
}

// The batching rule before the change: serialise the whole growing batch
// for every group that joins it.
function referenceBatches(proposals) {
    const pending = [...proposals].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const batches = [];
    while (pending.length) {
        const batch = [];
        const visited = new Set();
        for (const entry of pending) {
            if (visited.has(entry.characterId)) continue;
            const group = entry.atomicGroup?.id
                ? pending.filter((other) => other.atomicGroup?.id === entry.atomicGroup.id) : [entry];
            if (batch.length + group.length > MAX_BATCH) break;
            group.forEach((member) => visited.add(member.characterId));
            if (Protocol.byteLength({ proposals: [...batch, ...group] }) > LIMIT) break;
            batch.push(...group);
        }
        assert(batch.length, 'reference scenario must not contain an oversized group');
        batches.push(batch.map((entry) => entry.characterId));
        const sent = new Set(batch);
        pending.splice(0, pending.length, ...pending.filter((entry) => !sent.has(entry)));
    }
    return batches;
}

function kernelBatches(proposals) {
    const { kernel, emitted } = kernelWith(proposals);
    for (let guard = 0; kernel.dirty.size && guard < 1000; guard++) kernel.flush(null, true);
    assert.strictEqual(kernel.dirty.size, 0, 'every proposal must leave the dirty queue');
    emitted.forEach((batch) => assert(Protocol.byteLength({ proposals: batch }) <= LIMIT,
        'an emitted batch must stay within the payload limit'));
    return emitted.map((batch) => batch.map((entry) => entry.characterId));
}

// A batch that fills the limit to the byte is sent whole; one more byte moves
// the last proposal to the next batch. Multi-byte characters count as bytes.
{
    const members = [1, 2, 3].map((id) => proposal(id, id, 'ж🙂'.repeat(4000)));
    const base = Protocol.byteLength({ proposals: members });
    const last = members[members.length - 1];
    last.nextState.stats.note += 'x'.repeat(LIMIT - base);
    assert.strictEqual(Protocol.byteLength({ proposals: members }), LIMIT);
    assert.deepStrictEqual(kernelBatches(members), [[1, 2, 3]]);
    last.nextState.stats.note += 'x';
    assert.deepStrictEqual(kernelBatches(members), [[1, 2], [3]]);
}

// Random proposals and atomic groups batch exactly as the full-serialisation rule did.
{
    const random = seeded(20261001);
    const alphabet = ['a', 'z', 'ж', 'ё', '🙂', '"', '\\', '\n'];
    for (let round = 0; round < 40; round++) {
        const proposals = [];
        let id = 1;
        const count = 20 + Math.floor(random() * 120);
        while (proposals.length < count) {
            const groupSize = random() < 0.2 ? 2 + Math.floor(random() * 4) : 1;
            const groupId = groupSize > 1 ? `party-${round}-${id}` : null;
            for (let member = 0; member < groupSize; member++) {
                const length = Math.floor(random() * (random() < 0.1 ? 12000 : 3000));
                const padding = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
                proposals.push(proposal(id, id, padding, groupId ? { id: groupId } : null));
                id += 1;
            }
        }
        assert.deepStrictEqual(kernelBatches(proposals), referenceBatches(proposals), `round ${round}`);
    }
}

console.log('cold proposal batch bytes ok');

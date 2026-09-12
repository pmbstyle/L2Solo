const assert = require('assert');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const now = 2000000000;
const make = (key, targetId = 2, type = 'mob_contested', at = now) => ({ key, sourceId: 1, targetId, type, at });

let snapshot = Policy.empty(1);
const main = new Memory();
const source = { id: 1, clanId: 10, allianceId: 20 };
const target = { id: 2, clanId: 10, allianceId: 20 };
assert.strictEqual(main.assess(source, target, {}, now).disposition, 'unloaded');
main.accept(snapshot);
assert.strictEqual(main.assess(source, target, {}, now).disposition, 'unknown');
assert.strictEqual(main.assess(source, target, {}, now).affiliation, 'own');
for (let i = 0; i < 5; i++) snapshot = Policy.apply(snapshot, make(`contest:${i}`), now).snapshot;
main.accept(snapshot);
let result = main.assess(source, target, {}, now);
assert.strictEqual(result.disposition, 'hostile');
assert.strictEqual(result.affiliation, 'own', 'personal hostility must not erase membership');
assert.strictEqual(main.assess(source, { ...target, clanId: 11 }, {}, now).affiliation, 'ally');
assert.strictEqual(main.assess(source, { ...target, clanId: 11, allianceId: 21 }, {}, now).affiliation, 'outsider');
assert.strictEqual(main.assess(source, target, { attackingMe: true }, now).immediateThreat, true);
assert.strictEqual(main.assess({ id: 1 }, { id: 3 }, {}, now).affiliation, 'outsider', 'zero affiliations are not allies');
assert.strictEqual(main.assess(source, { id: 3 }, { clanStance: 'hostile' }, now).diplomaticEnemy, true);
assert.strictEqual(main.assess(source, target, {}, now + 70 * 86400000).disposition, 'familiar', 'old hostility decays');
assert.strictEqual(Policy.apply(snapshot, make('contest:0'), now).status, 'duplicate');
assert.throws(() => Policy.apply(snapshot, make('contest:0', 3), now), /collision/);
assert.throws(() => Policy.event(make('self', 1)), /self interaction/);
assert.throws(() => Policy.event({ ...make('bad'), type: '__proto__' }), /invalid event/);
assert.strictEqual(Policy.apply(snapshot, make('future', 2, 'attacked', now + 1), now).status, 'future_event');

const worker = new Memory();
worker.accept(main.snapshot(1));
assert.throws(() => Policy.apply(worker.snapshot(1), make('worker-reduce'), now), /read-only/);
assert.deepStrictEqual(worker.assess(source, target, {}, now), main.assess(source, target, {}, now));
const stale = main.snapshot(1);
main.accept(Policy.apply(snapshot, make('help', 2, 'resurrected'), now).snapshot);
assert.strictEqual(main.accept(stale), false, 'late worker/load snapshots cannot overwrite new memory');
const exported = main.snapshot(1);
exported.relations[0].hostility = 99;
assert.notStrictEqual(main.assess(source, target, {}, now).personal.hostility, 99);
const before = worker.snapshot(1);
worker.propose([make('proposal')]);
assert.deepStrictEqual(worker.snapshot(1), before, 'uncommitted cold proposals create no memories');

for (let i = 0; i < 200; i++) snapshot = Policy.apply(snapshot, make(`new:${i}`, i + 10, 'hunted_together', now + i), now + i).snapshot;
for (const kind of ['clan', 'alliance']) for (let i = 0; i < 20; i++) {
    snapshot = Policy.apply(snapshot, { ...make(`${kind}:${i}`, i + 1000, 'helped_in_combat', now + 300 + i), kind }, now + 300 + i).snapshot;
}
for (const [kind, limit] of Object.entries(Policy.LIMITS)) assert.strictEqual(snapshot.relations.filter(row => row.kind === kind).length, limit);
assert(snapshot.recent.length <= Policy.RECENT_LIMIT);
assert(snapshot.relations.every(row => row.reasons.length <= Policy.REASON_LIMIT));
assert.strictEqual(Policy.apply(snapshot, make('contest:0'), now + 400).status, 'expired_event', 'journal eviction must not enable replay');
assert.strictEqual(Policy.apply(snapshot, make('new-but-too-late'), now + 400).status, 'expired_event');
assert(snapshot.relations.some(row => row.kind === 'character' && row.targetId === 2), 'preserve strong old relations');
assert(snapshot.relations.some(row => row.kind === 'character' && row.targetId === 209), 'admit recent acquaintances');

// Equal timestamps at the retention boundary may reject late arrivals, but
// must never silently apply an old key twice, even with a different target.
let tied = Policy.empty(1);
for (let i = 0; i < 130; i++) tied = Policy.apply(tied, make(`tie:${i}`, 2), now).snapshot;
assert.strictEqual(Policy.apply(tied, make('tie:0'), now).status, 'expired_event');
let simultaneous = Policy.empty(1);
for (let i = 0; i < 40; i++) simultaneous = Policy.apply(simultaneous, make(`sim:${i}`, 100 + i), now).snapshot;
assert(simultaneous.relations.some(row => row.targetId === 139), 'recent slots must admit new subjects even at equal timestamps');

async function run() {
    await assert.rejects(worker.recordBatch([make('worker-write')]), /must propose/);
    await assert.rejects(worker.load(1), /cannot load SQL/);
    let reads = 0, finish;
    const loading = new Memory({ load: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
    const a = loading.load(1), b = loading.load(1);
    finish(Policy.empty(1));
    await Promise.all([a, b]);
    assert.strictEqual(reads, 1, 'coalesce simultaneous hydration');
    for (let i = 0; i < 10000; i++) loading.assess(source, target, {}, now);
    assert.strictEqual(reads, 1, 'decision loop never loads SQL');
    const invalid = main.snapshot(1);
    invalid.relations[0].trust = NaN;
    assert.throws(() => new Memory().accept(invalid), /invalid relation/);
    const waiters = [];
    const busy = new Memory({ recordBatch: () => new Promise(resolve => waiters.push(resolve)) });
    const writes = Array.from({ length: 8 }, (_, i) => busy.recordBatch([make(`pending:${i}`)]));
    assert.strictEqual((await busy.recordBatch([make('excess')])).reason, 'memory_busy');
    waiters.forEach(resolve => resolve({ ok: true, statuses: [], snapshots: [] }));
    await Promise.all(writes);
    assert.strictEqual(busy.pendingBatches, 0);
    console.log('Interaction memory policy and hot/cold view checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

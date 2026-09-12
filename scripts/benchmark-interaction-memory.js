// Synthetic bounded population. No server startup and no database access.
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const { performance } = require('perf_hooks');
const count = 2000;
const now = Date.now();
let seed = Policy.empty(1);
let serial = 0;
for (const [kind, limit] of Object.entries(Policy.LIMITS)) {
    for (let i = 0; i < limit; i++) {
        const at = now - 10000 + serial++;
        seed = Policy.apply(seed, { key: `bench:${serial}`, sourceId: 1, targetId: 10000 + i, kind,
            type: 'helped_in_combat', at }, now).snapshot;
    }
}
while (seed.recent.length < Policy.RECENT_LIMIT) {
    const at = now - 10000 + serial++;
    seed = Policy.apply(seed, { key: `bench:${serial}`, sourceId: 1, targetId: 10000, type: 'mob_contested', at }, now).snapshot;
}
if (global.gc) global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const memory = new Memory();
for (let id = 1; id <= count; id++) {
    memory.accept({ ...seed, ownerId: id, recent: seed.recent.map(e => ({ ...e, sourceId: id })) });
}
if (global.gc) global.gc();
const residentBytes = process.memoryUsage().heapUsed - heapBefore;
const identities = Array.from({ length: count }, (_, i) => ({ id: i + 1, clanId: 10, allianceId: 20 }));
const target = { id: 10000, clanId: 10000, allianceId: 10000 };
const context = {};
for (let i = 0; i < 10000; i++) memory.assess(identities[i % count], target, context, now);
const samples = [];
let checksum = 0;
for (let batch = 0; batch < 20; batch++) {
    const start = performance.now();
    for (let i = 0; i < 5000; i++) checksum += memory.assess(identities[i % count], target, context, now).revision;
    samples.push(performance.now() - start);
}
console.log(JSON.stringify({ bots: count, relationsPerBot: seed.relations.length,
    decisions: 100000, totalDecisionMs: samples.reduce((a, b) => a + b, 0),
    p95Batch5000Ms: samples.slice().sort((a, b) => a - b)[18],
    residentMiB: residentBytes / 1024 / 1024, gcAvailable: !!global.gc,
    persistedSnapshotBytes: Buffer.byteLength(JSON.stringify(seed)),
    workerSnapshotBytes: Buffer.byteLength(JSON.stringify(memory.snapshot(1))), checksum }, null, 2));

const MAX_NPCS = 256;
const LEASE_MS = 30000;
const buckets = new Map();

function release(session) {
    const lease = session?.townNpcSlot;
    if (!lease) return;
    const bucket = buckets.get(lease.key);
    if (bucket?.owners[lease.index]?.token === lease.token) bucket.owners[lease.index] = null;
    delete session.townNpcSlot;
}

function reserve(session, key, makePoints, preferred = 0, now = Date.now()) {
    if (session.townNpcSlot?.key !== key) release(session);
    let bucket = buckets.get(key);
    if (!bucket) {
        if (buckets.size >= MAX_NPCS) buckets.delete(buckets.keys().next().value);
        bucket = { points: makePoints(), owners: [] };
        buckets.set(key, bucket);
    }
    const lease = session.townNpcSlot;
    if (lease && bucket.owners[lease.index]?.token === lease.token) {
        bucket.owners[lease.index].until = now + LEASE_MS;
        return bucket.points[lease.index];
    }
    for (let step = 0; step < bucket.points.length; step++) {
        const index = (Math.abs(preferred) + step) % bucket.points.length;
        if (bucket.owners[index]?.until > now) continue;
        const token = Symbol('npc-slot');
        bucket.owners[index] = { token, until: now + LEASE_MS };
        session.townNpcSlot = { key, index, token };
        return bucket.points[index];
    }
    return null;
}

module.exports = { reserve, release, MAX_NPCS, LEASE_MS };

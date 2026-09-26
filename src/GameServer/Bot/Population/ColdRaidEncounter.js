// Local mirror of confirmed cold raid HP. Resolves use private drafts until
// every member's atomic database commit is acknowledged.
const encounters = new Map();
const { AsyncLocalStorage } = require('node:async_hooks');
const working = new AsyncLocalStorage();
const pending = new Map();
const store = () => working.getStore() || encounters;
const PARTICIPANT_LEASE_MS = 120000;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function keyFor(spot = {}, targetNpcId = 0) {
    const id = number(spot.raidBossTemplateId || targetNpcId);
    return id > 0 ? `raid:${id}` : null;
}

function snapshotFromParty(party, key, instanceId) {
    const snapshot = party?.stats?.raidEncounter;
    // A failed snapshot is local to one clan. It must never replace the
    // worker-wide boss authority seen by competing clans.
    return snapshot?.version === 1 && snapshot.key === key && snapshot.status !== 'failed'
        && (!instanceId || snapshot.raidInstanceId === instanceId)
        ? snapshot : null;
}

function begin(party, spot, targetNpcId, timestamp = Date.now()) {
    const key = keyFor(spot, targetNpcId);
    if (!key) return null;
    const instanceId = spot.raidInstanceId || null;
    const authoritative = spot.raidAuthority;
    const partySnapshot = snapshotFromParty(party, key, instanceId);
    const candidates = [authoritative, partySnapshot].filter(snapshot => snapshot?.key === key
        && (!instanceId || snapshot.raidInstanceId === instanceId))
        .sort((a, b) => number(b.updatedAt) - number(a.updatedAt));
    // Hot victory is already rewarded. A stale cold authority must not reopen
    // that generation after its corpse has decayed.
    const persisted = candidates.find(snapshot => snapshot.status === 'defeated')
        || candidates[0];
    let current = store().get(key);
    if (instanceId && current?.raidInstanceId !== instanceId) {
        store().delete(key);
        current = null;
    }
    if (!current || (persisted?.status === 'defeated' && current.status !== 'defeated' && current.hp == null)
        || number(persisted?.updatedAt) > number(current.updatedAt)) {
        if (persisted) store().set(key, structuredClone(persisted));
    }
    const record = store().get(key) || {
        version: 1,
        key,
        bossTemplateId: number(spot.raidBossTemplateId || targetNpcId),
        raidInstanceId: instanceId,
        status: spot.raidWorldAvailable === false ? 'unavailable' : 'active',
        hp: null,
        encounter: null,
        revision: 0,
        updatedAt: timestamp,
        winnerPartyId: null,
        defeatedAt: null
    };
    record.externalEngaged = spot.raidExternallyEngaged === true;
    store().set(key, record);
    return structuredClone(record);
}

function record(party, shared, fight, timestamp = Date.now()) {
    if (!shared?.key) return null;
    const current = store().get(shared.key) || shared;
    if (current.raidInstanceId !== shared.raidInstanceId) return structuredClone(current);
    if (current.status === 'defeated') return structuredClone(current);
    const won = fight?.won === true;
    const encounter = won ? null : fight?.encounter || null;
    const next = {
        ...current,
        version: 1,
        status: won ? 'defeated' : 'active',
        hp: won ? 0 : number(encounter?.hp, number(fight?.debug?.remainingHp, current.hp)),
        maxHp: number(encounter?.mob?.maxHp, number(current.maxHp)) || null,
        encounter,
        participants: { ...(current.participants || {}), [party.partyId]: timestamp },
        revision: number(current.revision) + 1,
        updatedAt: timestamp,
        winnerPartyId: won ? party.partyId : current.winnerPartyId,
        defeatedAt: won ? timestamp : current.defeatedAt
    };
    store().set(shared.key, next);
    return structuredClone(next);
}

function fail(party, shared, timestamp = Date.now(), reason = 'party_death') {
    if (!shared?.key) return null;
    const current = store().get(shared.key) || shared;
    if (current.raidInstanceId !== shared.raidInstanceId) return structuredClone(current);
    if (current.status === 'defeated') return structuredClone(current);
    const hp = Math.max(0, number(current.hp));
    const maxHp = Math.max(1, number(current.maxHp || current.encounter?.mob?.maxHp, hp || 1));
    const failed = {
        ...structuredClone(current),
        status: 'failed',
        hp,
        maxHp,
        remainingHpRatio: Math.max(0, Math.min(1, hp / maxHp)),
        failureReason: reason,
        failedAt: timestamp,
        failedPartyId: party?.partyId || null,
        revision: number(current.revision) + 1,
        updatedAt: timestamp
    };
    const participants = Object.fromEntries(Object.entries(current.participants || {})
        .filter(([id, at]) => id !== party?.partyId && timestamp - number(at) < PARTICIPANT_LEASE_MS));
    const contested = Object.keys(participants).length > 0 || current.externalEngaged === true;
    // The failed party keeps the actual remaining HP for retry policy and
    // telemetry. Reset shared HP only after the last participant withdraws.
    store().set(shared.key, {
        ...current,
        status: 'active',
        hp: contested ? hp : maxHp,
        maxHp,
        encounter: contested ? current.encounter : null,
        participants,
        revision: failed.revision,
        updatedAt: timestamp,
        winnerPartyId: null,
        defeatedAt: null,
        ...(contested ? {} : { resetAt: timestamp })
    });
    return failed;
}

async function stage({ key, id, memberIds }, compute) {
    if (pending.has(key)) throw new Error('raid_step_pending');
    const draft = new Map();
    if (encounters.has(key)) draft.set(key, structuredClone(encounters.get(key)));
    const transaction = { key, id, memberIds, draft, acknowledgements: new Map() };
    pending.set(key, transaction);
    try {
        const result = await working.run(draft, compute);
        return { result, snapshot: draft.get(key) ? structuredClone(draft.get(key)) : null };
    } catch (error) { abort(id); throw error; }
}

function abort(id) {
    for (const [key, transaction] of pending) if (transaction.id === id) pending.delete(key);
}

function acknowledge(id, characterId, ok) {
    const transaction = [...pending.values()].find(entry => entry.id === id);
    if (!transaction || !transaction.memberIds.includes(Number(characterId))) return;
    // ACKs can be paged. Never release the shared boss fence after only one
    // member, including a rejection: the remaining writes must finish first.
    transaction.acknowledgements.set(Number(characterId), ok === true);
    if (!transaction.memberIds.every(id => transaction.acknowledgements.has(id))) return;
    if ([...transaction.acknowledgements.values()].every(Boolean) && transaction.draft.has(transaction.key)) {
        encounters.set(transaction.key, structuredClone(transaction.draft.get(transaction.key)));
    }
    abort(id);
}

function resetForTests() {
    encounters.clear();
    pending.clear();
}

module.exports = { keyFor, begin, record, fail, stage, abort, acknowledge, resetForTests };

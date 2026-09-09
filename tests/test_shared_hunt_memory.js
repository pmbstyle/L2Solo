const assert = require('assert');
require('../src/Global');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Hunt = require('../src/GameServer/Social/SharedHuntMemory');
const at = Date.now();
const memory = new Memory();
memory.accept(Policy.empty(1));
const events = Hunt.eventsFor(1, [1, 2], 'cold-lease', at, memory.assess.bind(memory));
assert.strictEqual(events.length, 1);
assert.deepStrictEqual(Hunt.eventsFor(1, [2], 'cold-lease', at, memory.assess.bind(memory)), events);
let snapshot = Policy.apply(Policy.empty(1), events[0], at).snapshot;
assert.strictEqual(snapshot.relations[0].trust, 1);
assert.strictEqual(Policy.apply(snapshot, events[0], at).status, 'duplicate');
// Simulate a hot callback produced from a stale cache just after a cold commit.
const hotEvent = { ...events[0], key: 'hot-stale', at: at + 1000 };
assert.strictEqual(Policy.apply(snapshot, hotEvent, at + 1000).status, 'rate_limited');
for (let i = 0; i < 5; i++) snapshot = Policy.apply(snapshot,
    { ...events[0], key: `other:${i}`, type: 'healed', at: at + 2000 + i }, at + 2000 + i).snapshot;
assert(snapshot.relations[0].reasons.every(reason => reason.type !== 'hunted_together'));
assert.strictEqual(Policy.apply(snapshot, { ...hotEvent, key: 'after-other-events', at: at + 3000 }, at + 3000).status, 'rate_limited');
memory.accept(snapshot);
assert.deepStrictEqual(Hunt.eventsFor(1, [2], 'next-lease', at + 3000, memory.assess.bind(memory)), []);
const next = { ...events[0], key: 'after-cooldown', at: at + Policy.HUNT_COOLDOWN_MS };
assert.strictEqual(Policy.apply(snapshot, next, next.at).status, 'applied');
const worker = new Memory();
worker.accept(memory.snapshot(1));
assert.deepStrictEqual(worker.assess({ id: 1 }, { id: 2 }, {}, at), memory.assess({ id: 1 }, { id: 2 }, {}, at));
const nine = new Memory();
const ids = Array.from({ length: 9 }, (_, i) => i + 1);
const snapshots = new Map(ids.map(id => [id, Policy.empty(id)]));
snapshots.forEach(value => nine.accept(value));
const batch = Hunt.eventsForGroup(ids, 'nine-first', at, nine.assess.bind(nine));
assert.strictEqual(batch.length, 64);
for (const event of batch) snapshots.set(event.sourceId, Policy.apply(snapshots.get(event.sourceId), event, at).snapshot);
snapshots.forEach(value => nine.accept(value));
assert.strictEqual(Hunt.eventsForGroup(ids, 'nine-second', at + 1000, nine.assess.bind(nine)).length, 8,
    'pairs beyond the transaction budget must remain eligible next resolve');

const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const messages = [];
const kernel = new ColdSimulationKernel({ resolveSolo: () => ({}), maxBatch: 3, emit: (type, value) => messages.push({ type, value }) });
const group = { id: 'hunt-group', memberIds: [2, 3, 4] };
for (let id = 1; id <= 4; id++) kernel.dirty.set(id, { characterId: id, priority: 'P1', enqueuedAt: at,
    ...(id > 1 ? { atomicGroup: group } : {}), result: {} });
assert.strictEqual(kernel.flush(null, true), 1, 'row limit must not split a hunt group');
assert.strictEqual(kernel.flush(null, true), 3);
assert.deepStrictEqual(messages.filter(message => message.type === 'proposal_batch').map(message => message.value.proposals.length), [1, 3]);
messages.length = 0;
for (let id = 1; id <= 3; id++) kernel.dirty.set(id, { characterId: id, priority: 'P1', enqueuedAt: at,
    ...(id > 1 ? { atomicGroup: { id: 'byte-group', memberIds: [2, 3] } } : {}), result: { debug: { text: 'x'.repeat(id === 1 ? 200000 : 40000) } } });
assert.strictEqual(kernel.flush(null, true), 1, 'byte limit must not split a hunt group');
assert.strictEqual(kernel.flush(null, true), 2);

const runtime = invoke('GameServer/Social/InteractionMemoryRuntime');
runtime.accept(Policy.empty(101));
runtime.accept(Policy.empty(102));
const queued = [];
const enqueue = runtime.events.enqueue;
runtime.events.enqueue = event => { queued.push(event); return true; };
const session = (id, bot = true) => ({ accountId: bot ? `bot_${id}` : 'player',
    actor: { fetchId: () => id, fetchIsOnline: () => true, isDead: () => false } });
const a = session(101), b = session(102);
const rewards = [{ session: a, exp: 20, sp: 0 }, { session: b, exp: 20, sp: 0 }];
const npc = { fetchKind: () => 'Monster' };
try {
    Hunt.recordHot(rewards, npc, at);
    assert.deepStrictEqual(queued.map(event => [event.sourceId, event.targetId]), [[101, 102], [102, 101]]);
    queued.length = 0;
    Hunt.recordHot(rewards.slice(0, 1), npc, at);
    Hunt.recordHot(rewards.map(row => ({ ...row, exp: 0 })), npc, at);
    Hunt.recordHot(rewards, { ...npc, fetchIsRaidBoss: () => true }, at);
    b.actor.isDead = () => true;
    Hunt.recordHot(rewards, npc, at);
    assert.strictEqual(queued.length, 0, 'solo, ineligible passengers, raids and dead participants do not create group bonds');
} finally { runtime.events.enqueue = enqueue; }
console.log('Shared hunt hot/cold identity, cooldown, replay and eligibility checks passed');

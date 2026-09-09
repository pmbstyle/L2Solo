const assert = require('assert');
const { decide } = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const { ColdCompetitionMonitor, INTERVAL_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const at = 1800000000000;
const memory = new Memory();
const spot = { id: 'test', npcEntries: [{ selfId: 10, count: 1 }] };
const entries = Array.from({ length: 20 }, (_, i) => ({ state: { characterId: i + 1, name: `Bot${i + 1}`, phase: 'cold',
    activity: 'hunting', level: 40, spotId: 'test', vitals: { hp: 100 }, stats: {} }, context: { spot, targetNpcId: 10 } }));
entries.forEach(e => memory.accept(P.empty(e.state.characterId)));
const make = (capacity = 2) => new ColdCompetitionMonitor({ capacityForSpot: () => capacity, personaFor: () => ({ traits: {} }) });
const monitor = make(), pristine = JSON.stringify(entries);
monitor.sample(entries, memory, at);
assert.strictEqual(monitor.snapshot().evaluated, 0, 'bootstrap must not create catch-up encounters');
for (let i = 1; i <= 480; i++) monitor.sample(entries, memory, at + i * INTERVAL_MS);
const report = monitor.snapshot();
assert(report.evaluated > 10, 'congested independent hunters must produce observable decisions');
assert(report.pvpIntents < report.evaluated / 4, 'ordinary pressure must not produce universal PvP intent');
assert(report.recent.length <= 12);
assert(monitor.pairs.size <= 20 && monitor.bots.size <= 20, 'cooldowns must expire rather than retain encounter history forever');
assert.strictEqual(JSON.stringify(entries), pristine);
assert(entries.every(e => memory.snapshot(e.state.characterId).revision === 0), 'forecasts must never write memories');
const abundant = make(100);
abundant.sample(entries, memory, at); abundant.sample(entries, memory, at + INTERVAL_MS);
assert.strictEqual(abundant.snapshot().pressuredGroups, 0);
const inactive = make();
inactive.sample(entries.map(e => ({ ...e, state: { ...e.state, activity: 'resting' } })), memory, at);
assert.strictEqual(inactive.snapshot().activeHunters, 0);
const teammates = entries.map(e => ({ ...e, state: { ...e.state, party: { partyId: 'one-party' }, activity: 'grouped' },
    context: { ...e.context, party: { partyId: 'one-party', stats: { objective: { npcId: 10 } } } } }));
const party = make(); party.sample(teammates, memory, at);
assert.strictEqual(party.snapshot().pressuredGroups, 0, 'teammates are a single competitor');
const mixed = make();
const mixedEntries = [entries[0], ...teammates.slice(1, 3).map(e => ({ ...e,
    context: { ...e.context, party: { ...e.context.party, updatedAt: at } } }))];
mixed.sample(mixedEntries, memory, at);
for (let i = 1; i <= 60; i++) mixed.sample(mixedEntries, memory, at + i * INTERVAL_MS);
assert(mixed.snapshot().recent.length > 0);
for (const e of mixed.snapshot().recent) {
    const representative = [e.actor, e.peer].find(p => p.partyId === 'one-party');
    assert(representative, 'party identity must survive worker forecast serialization');
    assert.strictEqual(representative.size, 2);
    assert.strictEqual(representative.partyUpdatedAt, at);
}
const unknown = make(); unknown.sample(entries, new Memory(), at); unknown.sample(entries, new Memory(), at + INTERVAL_MS);
assert.strictEqual(unknown.snapshot().evaluated, 0, 'unloaded memory must not masquerade as neutrality');
const slow = make(), fast = make();
for (let t = at; t <= at + 120000; t += 1000) fast.sample(entries, memory, t);
for (let t = at; t <= at + 120000; t += INTERVAL_MS) slow.sample(entries, memory, t);
assert.deepStrictEqual(fast.snapshot(), slow.snapshot(), 'heartbeat frequency must not multiply encounters');
const actors = { actor: { level: 40, size: 1 }, peer: { level: 40, size: 1 } };
const friendly = { ready: true, personal: { affinity: 30, trust: 30, hostility: 0, fear: 0 } };
assert.strictEqual(decide({ ...actors, pressure: 4, towardPeer: friendly, towardActor: friendly, rng: () => 0 }).action, 'offer_party');
assert.strictEqual(decide({ ...actors, pressure: 1, rng: () => { throw Error('abundant resources must not roll conflict'); } }).action, 'coexist');
const hostile = { ready: true, personal: { affinity: -30, trust: -30, hostility: 30, fear: 0 } };
const aggressive = { traits: { caution: 0, empathy: 0, resilience: 0, ambition: 1, assertiveness: 1 } };
const rolls = [0.99, 0, 0];
const confrontation = decide({ actor: { level: 40, size: 2, partyId: 'a' }, peer: { level: 40, size: 2, partyId: 'b' },
    pressure: 4, actorPersona: aggressive, peerPersona: aggressive, towardPeer: hostile, towardActor: hostile, rng: () => rolls.shift() });
assert.strictEqual(confrontation.action, 'contest');
assert.strictEqual(confrontation.pvpIntent, true, 'hostile assertive peers can produce escalation intent, never a real attack');
const cautious = decide({ actor: { level: 30, size: 2, partyId: 'a' }, peer: { level: 60, size: 5, partyId: 'b' },
    pressure: 4, actorPersona: { traits: { caution: 1 } }, towardPeer: hostile, towardActor: hostile, rng: () => 0 });
assert.strictEqual(cautious.action, 'avoid', 'hostility must still allow avoiding a stronger enemy');
console.log('Cold competition pressure, cooldowns, independent parties, cadence and four-hour observation checks passed',
    JSON.stringify({ evaluated: report.evaluated, outcomes: report.outcomes, pvpIntents: report.pvpIntents }));

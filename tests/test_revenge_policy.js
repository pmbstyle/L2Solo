const assert = require('assert');
const Policy = require('../src/GameServer/Social/RevengePolicy');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const { ColdRevengeMonitor, MAX_ACTORS } = require('../src/GameServer/Bot/Population/ColdRevengeMonitor');
const { ColdCompetitionMonitor } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const at = 1800000000000;
const persona = { traits: { assertiveness: 1, caution: 0.1, empathy: 0.2, resilience: 0.2, commitment: 1 } };
const memory = new Memory();
function history(id, target, types, start = at) {
    let snapshot = P.empty(id);
    for (const [i, type] of types.entries()) snapshot = P.apply(snapshot, {
        key: `history:${id}:${i}`, sourceId: id, targetId: target, type, at: start }, start).snapshot;
    return snapshot;
}
memory.accept(history(1, 2, ['attacked', 'killed', 'killed']));
memory.accept(P.empty(2));
const assess = (when = at) => memory.assess({ id: 1 }, { id: 2 }, {}, when);
const social = assess(), chance = Policy.evaluate(social, persona).chance;
assert(chance > 0 && chance <= 0.35);
assert.strictEqual(Policy.evaluate({ ...social, ready: false }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, affiliation: 'own' }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, personal: null, effective: social.personal }, persona).chance, 0,
    'collective hostility alone must not create a personal revenge campaign');
assert.strictEqual(Policy.evaluate(assess(at + 28 * 86400000), persona).chance, 0, 'old grievances cool down');
assert.strictEqual(Policy.evaluate({ ...social, effective: { ...social.personal, trust: 20, affinity: 20 } }, persona).chance, 0,
    'friendship and help can prevent revenge despite retained old hostile history');
assert(Policy.evaluate({ ...social, effective: { ...social.personal, fear: 30 } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, clanSocial: { selfDiscipline: { stage: 'probation' } } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, effective: { ...social.personal, hostility: 45, trust: -30 } }, persona).chance > chance);
const worker = new Memory();
worker.accept(JSON.parse(JSON.stringify(memory.snapshot(1))));
assert.deepStrictEqual(Policy.evaluate(worker.assess({ id: 1 }, { id: 2 }, {}, at), persona), Policy.evaluate(social, persona));
const entries = [1, 2].map(id => ({ state: { characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'hunting',
    spotId: 'spot', loc: { locX: id * 10, locY: 0, locZ: 0 }, vitals: { hp: 100 }, stats: {}, simulation: { revision: 3 } },
    context: { targetNpcId: id, spot: { id: 'spot', npcEntries: [{ selfId: 1 }, { selfId: 2 }] } } }));
const before = JSON.stringify(entries);
const monitor = new ColdRevengeMonitor();
const events = monitor.sample(entries, memory, at, () => persona, () => 0);
assert.strictEqual(events.length, 1, 'independent revenge does not require the same hunt objective or resource pressure');
assert.strictEqual(events[0].action, 'revenge');
assert.strictEqual(events[0].actor.id, 1);
assert.strictEqual(events[0].revengeRoll, 0);
assert.strictEqual(monitor.sample(entries, memory, at + 30000, () => persona, () => 0).length, 0, 'no repeated attempt each scan');
assert.strictEqual(JSON.stringify(entries), before, 'forecasts do not mutate physical state or memory');
const fresh = input => new ColdRevengeMonitor().sample(input, memory, at, () => persona, () => 0);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, party: { partyId: 'same' } } }))).length, 0);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, stats: { revengeUntil: at + 1 } } }))).length, 0);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, loc: { ...e.state.loc, locX: e.state.characterId * 2000 } } }))).length, 0);
const bounded = new ColdRevengeMonitor();
bounded.sample(Array.from({ length: 2000 }, (_, i) => ({ ...entries[0], state: { ...entries[0].state, characterId: i + 100 } })), memory, at, () => persona, () => 0);
assert.strictEqual(bounded.cursor, MAX_ACTORS, 'worker decision work has a fixed actor budget');
const slow = new ColdCompetitionMonitor({ capacityForSpot: () => 100, personaFor: () => persona });
const fast = new ColdCompetitionMonitor({ capacityForSpot: () => 100, personaFor: () => persona });
for (let t = at; t <= at + 120000; t += 1000) fast.sample(entries, memory, t);
for (let t = at; t <= at + 120000; t += 30000) slow.sample(entries, memory, t);
assert.deepStrictEqual(slow.snapshot(), fast.snapshot(), 'heartbeat frequency does not multiply revenge attempts');
console.log('Shared revenge policy: decay, reconciliation, fear, discipline, worker parity and bounded independent encounters passed');

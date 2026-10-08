const assert = require('assert');
const Policy = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const ColdPolicy = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const { ColdCompetitionMonitor, INTERVAL_MS, seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');

assert.strictEqual(ColdPolicy, Policy, 'cold and hot encounters use the same trait reader');
const relations = [
    { ready: true, personal: null },
    { ready: true, personal: { affinity: -30, trust: -30, hostility: 30, fear: 0 } },
    { ready: true, personal: { affinity: 30, trust: 30, hostility: 0, fear: 0 } },
    { ready: true, personal: null, clanSocial: { selfDiscipline: { stage: 'probation' } } }
];
const neutral = { traits: {} };
function decision(actorPersona, peerPersona, relation, seed) {
    const source = seeded(seed);
    let rolls = 0;
    const outcome = Policy.decide({ pressure: 4, actor: { level: 40, size: 1 }, peer: { level: 40, size: 1 },
        actorPersona, peerPersona, towardPeer: relation, towardActor: relation, key: seed,
        rng: () => { rolls++; return source(); } });
    return { outcome, rolls };
}
for (const absent of [undefined, null, {}, { traits: null }]) {
    for (const relation of relations) {
        assert.strictEqual(Policy.escalationChance(absent, relation), Policy.escalationChance(neutral, relation));
        for (let i = 0; i < 50; i++) {
            const seed = `missing-persona:${i}`;
            const expected = decision(neutral, neutral, relation, seed);
            assert.deepStrictEqual(decision(absent, neutral, relation, seed), expected, 'actor fallback preserves decisions and RNG calls');
            assert.deepStrictEqual(decision(neutral, absent, relation, seed), expected, 'peer fallback preserves decisions and RNG calls');
            assert.deepStrictEqual(decision(absent, absent, relation, seed), expected, 'both missing personas use existing neutral traits');
        }
    }
}

// Exercise the actual worker entry point with a lookup returning null.
const at = 1800000000000;
const memory = new Memory();
const spot = { id: 'null-persona', npcEntries: [{ selfId: 10, count: 1 }] };
const entries = Array.from({ length: 8 }, (_, i) => ({ state: { characterId: i + 1, name: `Bot${i + 1}`,
    phase: 'cold', activity: 'hunting', level: 40, spotId: spot.id, vitals: { hp: 100 }, stats: {} },
    context: { spot, targetNpcId: 10 } }));
entries.forEach(e => memory.accept(P.empty(e.state.characterId)));
function forecast(persona) {
    const monitor = new ColdCompetitionMonitor({ capacityForSpot: () => 1, personaFor: () => persona });
    for (let i = 0; i <= 60; i++) monitor.sample(entries, memory, at + i * INTERVAL_MS);
    return monitor.snapshot();
}
const expected = forecast(neutral);
assert(expected.evaluated > 0, 'test must reach an actual resource competition decision');
assert.deepStrictEqual(forecast(null), expected, 'null persona cannot abort worker competition sampling');
assert.deepStrictEqual(forecast(undefined), expected, 'null and missing lookup results have identical worker outcomes');
console.log('Resource competition missing-persona decisions, RNG and native worker parity passed');

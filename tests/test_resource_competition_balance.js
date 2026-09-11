const assert = require('assert');
require('../src/Global');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const Policy = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const people = Array.from({ length: 1700 }, (_, i) => Persona.generate({ characterId: 2000000 + i, stats: { generatedIndex: i } }));
const neutral = { ready: true, personal: null };
const grievance = { ready: true, personal: { affinity: -8, trust: -8, hostility: 12, fear: 2 } };
const friendly = { ready: true, personal: { affinity: 20, trust: 20, hostility: 0, fear: 0 } };
const ordinary = Policy.escalationChance({ traits: {} }, neutral);
assert(ordinary > 0.3 && ordinary < 0.5, 'ordinary strangers can answer a provocation without usually fighting');
assert.strictEqual(Policy.escalationChance({ traits: {} }, { ready: false }), 0);
assert.strictEqual(Policy.escalationChance({ traits: {} }, friendly), 0, 'ordinary friends tolerate an isolated encroachment');
assert(Policy.escalationChance({ traits: { caution: 1, empathy: 1, resilience: 1, assertiveness: 0 } }, neutral) === 0,
    'there is no mandatory PvP probability floor for peaceful personalities');
assert(Policy.escalationChance({ traits: {} }, grievance) > ordinary);
assert(Policy.escalationChance({ traits: {} }, { ...grievance, personal: { ...grievance.personal, fear: 30 } }) < ordinary);
const probation = { ...grievance, clanSocial: { selfDiscipline: { stage: 'probation' } } };
assert(Policy.escalationChance({ traits: {} }, probation) < Policy.escalationChance({ traits: {} }, grievance));

// Actual generated personalities, fixed seeds, and broad gameplay bounds keep
// ordinary provocations alive without turning resource pressure into constant war.
const samples = 15000, report = {};
for (const [name, sizes] of Object.entries({ solo: [1, 1], solo_party: [1, 3], party_solo: [3, 1], parties: [3, 3] })) {
    const counts = {};
    for (const [relationName, relation] of Object.entries({ neutral, grievance, friendly })) {
        const rng = seeded(`balance:${name}`);
        let pvp = 0, contests = 0;
        for (let i = 0; i < samples; i++) {
            const actorPersona = people[Math.floor(rng() * people.length)], peerPersona = people[Math.floor(rng() * people.length)];
            const outcome = Policy.decide({ pressure: 3,
                actor: { level: 40, size: sizes[0], partyId: sizes[0] > 1 ? 'a' : null },
                peer: { level: 40, size: sizes[1], partyId: sizes[1] > 1 ? 'b' : null },
                actorPersona, peerPersona, towardPeer: relation, towardActor: relation, rng });
            pvp += Number(outcome.pvpIntent); contests += Number(outcome.action === 'contest');
        }
        counts[relationName] = { pvp, contests };
    }
    assert(counts.neutral.pvp > samples * 0.06 && counts.neutral.pvp < samples * 0.25, `${name}: crowded neutral encounters sometimes become PvP, with a large peaceful majority`);
    assert(counts.grievance.pvp > counts.neutral.pvp * 1.3, `${name}: remembered offenses materially increase escalation`);
    assert(counts.grievance.pvp < samples * 0.4, `${name}: even resentful hunters usually resolve competition without PvP`);
    assert(counts.friendly.pvp < counts.neutral.pvp / 10, `${name}: friendship protects cooperation`);
    report[name] = counts;
}
console.log('Generated-population resource PvP balance passed', JSON.stringify({ samples, report }));

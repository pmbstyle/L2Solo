const assert = require('assert');

require('./helpers/databaseIsolation');
require('../src/Global');

// The shared weighted score remains diagnostic. Admission now uses the
// authored TendencyRoll contract: deterministic per decision, bounded .02-.98.
// Keep the original personas and score expectations; check the current lottery
// and its required-party/known-partner inputs independently of score >= 45.
const Background = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const Roll = invoke('GameServer/Bot/AI/TendencyRoll');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const probability = value => Math.max(0.02, Math.min(0.98, value));

const extra = { caution: 0.5, ambition: 0.5, assertiveness: 0.5, resilience: 0.5 };
function persona(primaryDrive, sociability, commitment, empathy) {
    return { primaryDrive, archetype: 'pinned', traits: { sociability, commitment, empathy, ...extra } };
}

// [drive, sociability, commitment, empathy, background score]
const rows = [
    ['social', 0.82, 0.66, 0.66, 86],
    ['social', 0.30, 0.30, 0.30, 45],
    ['progression', 0.60, 0.40, 0.35, 51],
    ['progression', 0.48, 0.65, 0.55, 52],
    ['wealth', 0.36, 0.45, 0.38, 27],
    ['wealth', 0.70, 0.60, 0.60, 52],
    ['wealth', 0.00, 0.00, 0.00, -8],
    ['social', 1.00, 1.00, 1.00, 108]
];
for (const [drive, sociability, commitment, empathy, background] of rows) {
    const p = persona(drive, sociability, commitment, empathy);
    const intent = Background.backgroundIntent({ characterId: 1, persona: p, stats: {} });
    assert.strictEqual(intent.score, background, `background score ${drive} ${sociability}/${commitment}/${empathy}`);
    assert.strictEqual(intent.accept, Roll.roll('party_intent', 1, undefined) < probability(background / 100),
        `background seeded admission ${drive} ${sociability}`);
    assert.deepStrictEqual(Background.backgroundIntent({ characterId: 1, persona: p, stats: {} }), intent,
        'checking the same background decision again must preserve its roll');
}

const loner = persona('wealth', 0.20, 0.20, 0.20);
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 3 } } } }).reason,
    'established_party_bonds', 'background: a partner of 3+ runs supplies the established-bond tendency bonus');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 2 } } } }).accept,
    Roll.roll('party_intent', 1, undefined) < probability(10 / 100), 'background: fewer runs receive no bond bonus');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, activity: 'party_wait', stats: {} }).score,
    100, 'background: a required party is always accepted');
assert.strictEqual(Social.relationship({ trust: 10 }), 'trusted', 'the native relationship classifier supplies the known-partner fact');
assert.strictEqual(Roll.chance(-8), 0.02);
assert.strictEqual(Roll.chance(108), 0.98);
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyRequest: { priority: 'required' } } }).accept,
    true, 'the explicit required-party goal remains unconditional');

assert.strictEqual(Background.baseScore(loner), 0.2 * 55 + 0.2 * 25 + 0.2 * 10 - 8);

console.log('Persona party scores: one shared base checked');

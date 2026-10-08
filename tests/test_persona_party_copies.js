const assert = require('assert');

require('./helpers/databaseIsolation');
require('../src/Global');

// The shared weighted score remains diagnostic. Admission now uses the
// authored TendencyRoll contract: deterministic per decision, bounded .02-.98.
// Keep the original personas and score expectations; check the current lottery
// and its required-party/known-partner inputs independently of score >= 45.
const Background = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const Invite = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');
const Roll = invoke('GameServer/Bot/AI/TendencyRoll');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const probability = value => Math.max(0.02, Math.min(0.98, value));

const extra = { caution: 0.5, ambition: 0.5, assertiveness: 0.5, resilience: 0.5 };
function persona(primaryDrive, sociability, commitment, empathy) {
    return { primaryDrive, archetype: 'pinned', traits: { sociability, commitment, empathy, ...extra } };
}

// [drive, sociability, commitment, empathy, background score, invite score]
// Without trust or familiarity the invite score is the background score
// clamped to 0..100.
const rows = [
    ['social', 0.82, 0.66, 0.66, 86, 86],
    ['social', 0.30, 0.30, 0.30, 45, 45],
    ['progression', 0.60, 0.40, 0.35, 51, 51],
    ['progression', 0.48, 0.65, 0.55, 52, 52],
    ['wealth', 0.36, 0.45, 0.38, 27, 27],
    ['wealth', 0.70, 0.60, 0.60, 52, 52],
    ['wealth', 0.00, 0.00, 0.00, -8, 0],
    ['social', 1.00, 1.00, 1.00, 108, 100]
];
for (const [drive, sociability, commitment, empathy, background, invite] of rows) {
    const p = persona(drive, sociability, commitment, empathy);
    const intent = Background.backgroundIntent({ characterId: 1, persona: p, stats: {} });
    assert.strictEqual(intent.score, background, `background score ${drive} ${sociability}/${commitment}/${empathy}`);
    assert.strictEqual(intent.accept, Roll.roll('party_intent', 1, undefined) < probability(background / 100),
        `background seeded admission ${drive} ${sociability}`);
    assert.deepStrictEqual(Background.backgroundIntent({ characterId: 1, persona: p, stats: {} }), intent,
        'checking the same background decision again must preserve its roll');
    const answer = Invite.evaluate({ characterId: 1, persona: p }, { trust: 0, familiarity: 0 });
    assert.strictEqual(answer.score, invite, `invite score ${drive} ${sociability}/${commitment}/${empathy}`);
    assert.strictEqual(answer.probability, probability(invite / 100));
    assert.strictEqual(answer.roll, Roll.roll('party_invite', 1, 0, 0));
    assert.strictEqual(answer.accept, answer.roll < answer.probability, `invite seeded admission ${drive} ${sociability}`);
    assert.deepStrictEqual(Invite.evaluate({ characterId: 1, persona: p }, { trust: 0, familiarity: 0 }), answer);
}

// Extra inputs each copy reads and the other does not.
const loner = persona('wealth', 0.20, 0.20, 0.20);
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 3 } } } }).reason,
    'established_party_bonds', 'background: a partner of 3+ runs supplies the established-bond tendency bonus');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 2 } } } }).accept,
    Roll.roll('party_intent', 1, undefined) < probability(10 / 100), 'background: fewer runs receive no bond bonus');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, activity: 'party_wait', stats: {} }).score,
    100, 'background: a required party is always accepted');
assert.strictEqual(Invite.evaluate({ characterId: 1, persona: loner }, { trust: 5, familiarity: 0 }).score,
    30, 'invite: trust adds 4 per point to the shared score (10)');
assert.strictEqual(Invite.evaluate({ characterId: 1, persona: loner }, { trust: 0, familiarity: 4 }).score,
    16, 'invite: familiarity adds 1.5 per point');
const trustedWithoutRuns = Invite.evaluate({ characterId: 1, persona: loner }, { trust: 10, familiarity: 0 });
assert.strictEqual(trustedWithoutRuns.probability, 0.5, 'trust still changes the score, but has no established-party bonus without a run');
assert.strictEqual(trustedWithoutRuns.accept, trustedWithoutRuns.roll < 0.5);
assert.strictEqual(Social.relationship({ trust: 10 }), 'trusted', 'the native relationship classifier supplies the known-partner fact');
const trustedWithRun = Invite.evaluate({ characterId: 1, persona: loner }, { trust: 10, familiarity: 0, groupRuns: 1 });
assert.strictEqual(trustedWithRun.score, trustedWithoutRuns.score);
assert.strictEqual(trustedWithRun.probability, 0.55, 'a trusted completed group run adds commitment / 4');
assert.strictEqual(trustedWithRun.roll, trustedWithoutRuns.roll, 'group-run history changes tendency, never the decision seed');
assert.strictEqual(trustedWithRun.accept, trustedWithRun.roll < 0.55);

// A literal bounded sequence of decision events covers both native outcomes,
// without replacing actors or forcing Math.random to manufacture admission.
let accepted = 0, declined = 0;
for (let inviteAttempts = 0; inviteAttempts < 64; inviteAttempts++) {
    const memory = { trust: 10, familiarity: 0, groupRuns: 1, inviteAttempts };
    const decision = Invite.evaluate({ characterId: 1, persona: loner }, memory);
    assert.strictEqual(decision.roll, Roll.roll('party_invite', 1, 0, inviteAttempts));
    assert.strictEqual(decision.accept, decision.roll < 0.55);
    assert.deepStrictEqual(Invite.evaluate({ characterId: 1, persona: loner }, memory), decision);
    if (decision.accept) accepted++; else declined++;
}
assert(accepted > 0 && declined > 0, 'even a trusted partner can accept or decline distinct seeded invitations');
assert.strictEqual(Roll.chance(-8), 0.02);
assert.strictEqual(Roll.chance(108), 0.98);
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyRequest: { priority: 'required' } } }).accept,
    true, 'the explicit required-party goal remains unconditional');

assert.strictEqual(Background.baseScore(loner), 0.2 * 55 + 0.2 * 25 + 0.2 * 10 - 8);

console.log('Persona party scores: one shared base checked');

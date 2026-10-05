const assert = require('assert');

require('../src/Global');

// "Does this persona want a party" (N6a step 3.1): the background party
// intent among bots (PersonaPartyPolicy.backgroundIntent) and the answer to a
// player's party invite (PersonaPartyDecisionPolicy.evaluate) were two copies
// with different weights. Decided (user, 2026-10-05, option A): one shared
// base score with the bot-to-bot weights, PersonaPartyPolicy.baseScore =
// 55 sociability + 25 commitment + 10 empathy + drive (social +18,
// progression +4, wealth -8). The invite's own weights (60 / 10 / 10, drive
// +18 / +6 / -12) are gone, so its expectations below changed; what belongs
// to each situation stays:
//   backgroundIntent: not clamped; accepts at 45 or with a partner of 3+
//     runs, and always for a required party.
//   evaluate: + 4 trust + 1.5 familiarity, clamped 0..100; accepts at 45 or
//     for a trusted or friendly player.
const Background = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const Invite = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');

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
    assert.strictEqual(intent.accept, background >= 45, `background accept ${drive} ${sociability}`);
    const answer = Invite.evaluate({ characterId: 1, persona: p }, { trust: 0, familiarity: 0 });
    assert.strictEqual(answer.score, invite, `invite score ${drive} ${sociability}/${commitment}/${empathy}`);
    assert.strictEqual(answer.accept, invite >= 45, `invite accept ${drive} ${sociability}`);
}

// Extra inputs each copy reads and the other does not.
const loner = persona('wealth', 0.20, 0.20, 0.20);
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 3 } } } }).reason,
    'established_party_bonds', 'background: a partner of 3+ runs overrides the score');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, stats: { partyHistory: { 9: { runs: 2 } } } }).accept,
    false, 'background: fewer runs do not');
assert.strictEqual(Background.backgroundIntent({ characterId: 1, persona: loner, activity: 'party_wait', stats: {} }).score,
    100, 'background: a required party is always accepted');
assert.strictEqual(Invite.evaluate({ characterId: 1, persona: loner }, { trust: 5, familiarity: 0 }).score,
    30, 'invite: trust adds 4 per point to the shared score (10)');
assert.strictEqual(Invite.evaluate({ characterId: 1, persona: loner }, { trust: 0, familiarity: 4 }).score,
    16, 'invite: familiarity adds 1.5 per point');
assert.strictEqual(Invite.evaluate({ characterId: 1, persona: loner }, { trust: 10, familiarity: 0 }).accept,
    true, 'invite: a trusted player is always accepted');

assert.strictEqual(Background.baseScore(loner), 0.2 * 55 + 0.2 * 25 + 0.2 * 10 - 8);

console.log('Persona party scores: one shared base checked');

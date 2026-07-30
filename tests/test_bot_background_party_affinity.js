const assert = require('assert');

require('../src/Global');

const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');

const tank = { characterId: 1, level: 15, party: { role: 'tank' } };
const healer = { characterId: 2, level: 15, party: { role: 'healer' } };
const familiarBuffer = { characterId: 3, level: 15, party: { role: 'buffer' }, stats: { partyHistory: { 1: { runs: 4, lastGroupedAt: 1 } } } };
const strangerBuffer = { characterId: 4, level: 15, party: { role: 'buffer' } };

const history = PartyAffinity.recordRun(tank, [tank, healer], 100);
assert.deepStrictEqual(history, { 2: { runs: 1, lastGroupedAt: 100 } });
assert.strictEqual(PartyAffinity.affinity(familiarBuffer, [tank, healer]), 4);
const familiarPreference = PersonaPartyPolicy.preference(familiarBuffer, [tank, healer], { tank: 1, healer: 1 });
const strangerPreference = PersonaPartyPolicy.preference(strangerBuffer, [tank, healer], { tank: 1, healer: 1 });
assert(familiarPreference.score > strangerPreference.score, 'commitment must amplify a proven party history rather than replace it with random personality');
assert(familiarPreference.reasons.includes('familiar_party'), 'party preference explanations must expose why a familiar group won');
assert.deepStrictEqual(
    PartyComposition.selectRecruits([tank, healer], [strangerBuffer, familiarBuffer], { maxSize: 3 }).map((state) => state.characterId),
    [3],
    'a familiar bot should win between otherwise equal candidates'
);

const personaCandidates = Array.from({ length: 100 }, (_, index) => ({
    characterId: 1000 + index,
    level: 15,
    party: { role: 'buffer' }
}));
const byPersonaPreference = personaCandidates.slice().sort((a, b) => (
    PersonaPartyPolicy.preference(a, [tank, healer], { tank: 1, healer: 1 }).score
    - PersonaPartyPolicy.preference(b, [tank, healer], { tank: 1, healer: 1 }).score
));
const lowPreferenceFamiliar = {
    ...byPersonaPreference[0],
    stats: { partyHistory: { 1: { runs: 1, lastGroupedAt: 1 } } }
};
const highPreferenceStranger = byPersonaPreference.at(-1);
assert(
    PersonaPartyPolicy.preference(highPreferenceStranger, [tank, healer], { tank: 1, healer: 1 }).score
    > PersonaPartyPolicy.preference(lowPreferenceFamiliar, [tank, healer], { tank: 1, healer: 1 }).score,
    'the test needs contrasting persona preferences'
);
assert.deepStrictEqual(
    PartyComposition.selectRecruits([tank, healer], [highPreferenceStranger, lowPreferenceFamiliar], { maxSize: 3 }).map((state) => state.characterId),
    [lowPreferenceFamiliar.characterId],
    'a proven party bond must outrank a stronger persona preference'
);
const lowPreferenceNear = { ...byPersonaPreference[0], level: 15 };
const highPreferenceFar = { ...byPersonaPreference.at(-1), level: 19 };
assert.deepStrictEqual(
    PartyComposition.selectRecruits([tank, healer], [highPreferenceFar, lowPreferenceNear], { maxSize: 3 }).map((state) => state.characterId),
    [lowPreferenceNear.characterId],
    'a closer level match must outrank a stronger persona preference'
);

const crowdedHistory = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    String(index + 100),
    { runs: index === 0 ? 50 : 1, lastGroupedAt: index === 0 ? 1 : 1000 + index }
]));
const retained = PartyAffinity.recordRun({ characterId: 99, stats: { partyHistory: crowdedHistory } }, [], 2000);
assert.strictEqual(Object.keys(retained).length, PartyAffinity.HISTORY_LIMIT);
assert(retained['100'], 'an old but strong bond must survive history pruning');
assert(retained['119'], 'a recent bond must survive history pruning');

console.log('Bot background party affinity checks passed');

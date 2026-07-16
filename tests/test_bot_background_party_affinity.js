const assert = require('assert');

require('../src/Global');

const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');

const tank = { characterId: 1, level: 15, party: { role: 'tank' } };
const healer = { characterId: 2, level: 15, party: { role: 'healer' } };
const familiarBuffer = { characterId: 3, level: 15, party: { role: 'buffer' }, stats: { partyHistory: { 1: { runs: 4, lastGroupedAt: 1 } } } };
const strangerBuffer = { characterId: 4, level: 15, party: { role: 'buffer' } };

const history = PartyAffinity.recordRun(tank, [tank, healer], 100);
assert.deepStrictEqual(history, { 2: { runs: 1, lastGroupedAt: 100 } });
assert.strictEqual(PartyAffinity.affinity(familiarBuffer, [tank, healer]), 4);
assert.deepStrictEqual(
    PartyComposition.selectRecruits([tank, healer], [strangerBuffer, familiarBuffer], { maxSize: 3 }).map((state) => state.characterId),
    [3],
    'a familiar bot should win between otherwise equal candidates'
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

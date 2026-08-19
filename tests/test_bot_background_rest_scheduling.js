const assert = require('assert');

require('../src/Global');

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

const timestamp = 1_000_000;
const restUntil = timestamp + 24 * 60 * 60 * 1000;
const exhausted = {
    characterId: 81,
    name: 'TiredSolo',
    level: 20,
    levelBand: '18-22',
    activity: 'resting',
    vitals: { hp: 10, maxHp: 800, mp: 0, maxMp: 420 },
    stats: { classId: 11, role: 'mage', restUntil },
    party: { role: 'dps' }
};

const solo = BackgroundResolver.resolveSolo({ state: exhausted, spot: null, elapsedMs: 0, timestamp });
assert.strictEqual(solo.patch.activity, 'resting');
assert.strictEqual(solo.nextResolveAt, restUntil, 'a resting solo bot must sleep until its persisted recovery deadline');

const party = { partyId: 'rest-scheduling', cohesion: 0.7, risk: 0.2, stats: { restUntil } };
const spot = { id: 'test_spot', name: 'Test Spot', center: {}, rewards: { exp: 1, sp: 1, adenaMin: 1, adenaMax: 1 } };
const restedParty = BackgroundPartyResolver.resolve({
    party,
    members: [exhausted, {
        ...exhausted,
        characterId: 82,
        name: 'ReadyMember',
        vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 },
        stats: { classId: 1, role: 'dps' }
    }],
    spot,
    elapsedMs: 0,
    timestamp
});
assert.strictEqual(restedParty.nextResolveAt, restUntil, 'a resting party must share one recovery deadline');
assert(restedParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'ready members must remain seated with their recovering party');
assert.strictEqual(restedParty.partyPatch.stats.restUntil, restUntil, 'the common party deadline must be persisted');

const combatRestParty = BackgroundPartyResolver.resolve({
    party: { partyId: 'combat-rest', cohesion: 0.7, risk: 0.2, roleCoverage: { dps: 2 }, stats: {} },
    members: [
        { ...exhausted, characterId: 83, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 1, maxMp: 420 }, stats: { classId: 5, role: 'tank' }, party: { role: 'tank' } },
        { ...exhausted, characterId: 84, activity: 'grouped', vitals: { hp: 800, maxHp: 800, mp: 420, maxMp: 420 }, stats: { classId: 1, role: 'dps' }, party: { role: 'dps' } }
    ],
    spot,
    elapsedMs: 10_000,
    timestamp,
    rng: () => 0
});
assert(combatRestParty.partyPatch.stats.restUntil > timestamp, 'combat exhaustion must create a shared party recovery deadline immediately');
assert.strictEqual(combatRestParty.nextResolveAt, combatRestParty.partyPatch.stats.restUntil);
assert(combatRestParty.memberResults.every(({ result }) => result.patch.activity === 'resting'), 'a party combat rest must seat every living member together');
assert(
    combatRestParty.memberResults.some(({ result }) => Number(result.materialize.exp || 0) > 0),
    'the combat window that triggered rest must still award its completed fight rewards'
);
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 1 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), false,
    'an empty-MP physical DPS must not stop the whole party');
assert.strictEqual(BackgroundResolver.needsRest({ stats: { classId: 5 } }, {
    hp: 800, maxHp: 800, mp: 0, maxMp: 420
}, { party: true, hpThreshold: 0.3, mpThreshold: 0.18 }), true,
    'an empty-MP tank must still trigger party recovery because Hate is part of its primary job');

console.log('Bot background rest scheduling checks passed');

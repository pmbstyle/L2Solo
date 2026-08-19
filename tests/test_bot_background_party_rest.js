const assert = require('assert');

require('../src/Global');

const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
invoke('GameServer/DataCache').init();

const now = 1_750_000_000_000;
const members = [
    {
        characterId: 81,
        name: 'TiredTank',
        level: 40,
        levelBand: '38-42',
        activity: 'resting',
        vitals: { hp: 200, maxHp: 1500, mp: 50, maxMp: 500 },
        stats: { classId: 5, role: 'tank', restUntil: now + 600000 },
        party: { role: 'tank' }
    },
    {
        characterId: 82,
        name: 'ReadyDps',
        level: 40,
        levelBand: '38-42',
        activity: 'grouped',
        vitals: { hp: 1300, maxHp: 1300, mp: 500, maxMp: 500 },
        stats: { classId: 1, role: 'dps' },
        party: { role: 'dps' }
    }
];

const result = BackgroundPartyResolver.resolve({
    party: { partyId: 'rest-party', leaderId: 81, cohesion: 0.7, risk: 0.2, stats: {} },
    members,
    spot: { id: 'execution_ground', name: 'Execution Ground', density: 3, avgLevel: 40 },
    elapsedMs: 30000,
    timestamp: now + 30000,
    rng: () => 0
});

assert.strictEqual(result.debug.fights, 0, 'a party with a resting member must not keep fighting');
assert.strictEqual(result.events.length, 0, 'a resting party must not emit hunt events');
assert.strictEqual(result.memberResults.length, members.length);
assert(result.memberResults[0].result.patch.vitals.hp > members[0].vitals.hp, 'the exhausted member must recover HP');
assert(result.memberResults[0].result.patch.vitals.mp > members[0].vitals.mp, 'the exhausted member must recover MP');
result.memberResults.forEach(({ result }) => {
    assert.deepStrictEqual(result.materialize, { exp: 0, sp: 0, adena: 0, items: [] }, 'party recovery must not award combat rewards');
});
assert.deepStrictEqual(result.memberResults[1].result.events, [],
    'a ready member held in party rest must not claim it returned to hunting');

const recovered = BackgroundPartyResolver.resolve({
    party: { partyId: 'rest-party', leaderId: 81, cohesion: 0.7, risk: 0.2, stats: { restUntil: now - 1 } },
    members: members.map((member) => ({
        ...member,
        activity: 'resting',
        vitals: { ...member.vitals, hp: member.vitals.maxHp, mp: member.vitals.maxMp },
        stats: { ...member.stats, restUntil: now - 1 }
    })),
    spot: { id: 'execution_ground', name: 'Execution Ground', density: 3, avgLevel: 40 },
    elapsedMs: 3000,
    timestamp: now,
    rng: () => 0
});
assert(recovered.memberResults.every(({ result: memberResult }) => memberResult.patch.activity === 'grouped'),
    'a recovered party must resume its grouped lifecycle, not become solo hunters');
assert(recovered.memberResults.every(({ result: memberResult }) => (
    memberResult.events.some((event) => event.type === 'recovered')
)), 'party recovery must be announced only when the shared rest actually completes');

console.log('Bot background party rest checks passed');

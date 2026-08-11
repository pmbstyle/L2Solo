const assert = require('assert');

const Leaderboards = require('../src/WorldObserver/public/leaderboards');

const actors = [
    { id: 1, kind: 'bot', name: 'Rich Orc', level: 44, exp: 500, raceId: 3, raceName: 'Orc', classId: 44, className: 'Orc Fighter', adena: 900000, equipmentValue: 120000 },
    { id: 2, kind: 'player', name: 'Player', level: 46, exp: 100, raceId: 0, raceName: 'Human', classId: 1, className: 'Warrior', adena: 200000, equipmentValue: 800000 },
    { id: 3, kind: 'bot', name: 'Veteran', level: 46, exp: 900, raceId: 0, raceName: 'Human', classId: 1, className: 'Warrior', adena: 100000, equipmentValue: 300000 },
    { id: 4, kind: 'bot', name: 'Service', level: 80, exp: 999, raceId: 4, raceName: 'Dwarf', classId: 57, className: 'Warsmith', adena: 9999999, equipmentValue: 9999999, staticService: true }
];

assert.deepStrictEqual(
    Leaderboards.rankActors(actors, 'level').map((actor) => actor.id),
    [3, 2, 1],
    'progress ranking must include players, break level ties by EXP, and exclude static services'
);
assert.deepStrictEqual(
    Leaderboards.rankActors(actors, 'adena').map((actor) => actor.id),
    [1, 2, 3],
    'wealth ranking must sort by current Adena'
);
assert.deepStrictEqual(
    Leaderboards.rankActors(actors, 'equipmentValue').map((actor) => actor.id),
    [2, 3, 1],
    'gear ranking must sort by estimated equipped value'
);
assert.deepStrictEqual(
    Leaderboards.rankActors(actors, 'level', { raceKey: 'id:0', classKey: 'id:1' }).map((actor) => actor.id),
    [3, 2],
    'race and class filters must compose without excluding a matching player'
);
assert.deepStrictEqual(Leaderboards.raceOptions(actors), [
    { key: 'id:0', label: 'Human' },
    { key: 'id:3', label: 'Orc' }
], 'race options must be unique, sorted, and free of static service-only races');
assert.deepStrictEqual(Leaderboards.classOptions(actors, 'id:0'), [
    { key: 'id:1', label: 'Warrior' }
], 'class choices must scope to the selected race');
assert.strictEqual(Leaderboards.raceName({ classId: 106 }), 'Dark Elf', 'legacy snapshots must still derive race from a third-class id');

console.log('World Observer leaderboard checks passed');

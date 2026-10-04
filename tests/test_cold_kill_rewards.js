// Golden values for cold kill rewards: exp, SP, adena (rolled and the spot's
// fallback range), drops, spoil, the party adena split and the drop owner.
// A seeded random source makes every draw repeatable, so a change of reward
// rules or of the order of random draws moves these values.
const assert = require('assert');

process.env.L2NODE_PROGRESSION_RATE = 'x10';
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

DataCache.init();

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const orcs = {
    id: 'pin_orcs',
    name: 'Pin orcs',
    avgLevel: 10,
    density: 3,
    npcEntries: [{ selfId: 93, count: 2 }, { selfId: 96, count: 1 }, { selfId: 98, count: 1 }],
    npcSelfIds: [93, 96, 98],
    npcNames: ['Orc Fighter', 'Orc Lieutenant', 'Orc Fighter Leader'],
    rewards: { exp: 100, sp: 10, adenaMin: 20, adenaMax: 40 },
    mob: { hp: 200, damage: 10 },
    center: { x: 0, y: 0, z: 0 }
};
// No reward data: exp and SP come from the spot, adena from its fallback range.
const unknown = { ...orcs, id: 'pin_unknown', npcEntries: [], npcSelfIds: [999999], npcNames: [] };
const spots = { pin_orcs: orcs, pin_unknown: unknown };

// Strong saved gear so each fight is a single blow and the rewards dominate the draws.
function member(characterId, classId, level, spotId) {
    return {
        characterId,
        name: `Pin${characterId}`,
        level,
        activity: 'hunting',
        spotId,
        vitals: { hp: 2000, maxHp: 2000, mp: 800, maxMp: 800 },
        classId,
        party: { role: 'dps' },
        stats: {
            classId,
            coldCombat: {
                classId,
                equipment: { pAtk: 4000, atkSpd: 900, accur: 300, critical: 40, pDef: 2000, mDef: 1000, evasion: 200, weaponKind: 'blunt' }
            }
        }
    };
}

const compact = (materialize) => [
    materialize.exp, materialize.sp, materialize.adena, materialize.items.map((item) => [item.selfId, item.amount])
];
const TIMESTAMP = 1790000000000;

// [spot, seed, classId, level, [exp, sp, adena, [[itemId, amount]...]]]
// Class 53 (Dwarven Fighter) is a spoiler; class 0 (Human Fighter) is not.
const SOLO = [
    ['pin_orcs', 1, 53, 15, [3910, 150, 742, [[1921, 1], [1867, 1], [1799, 10]]]],
    ['pin_orcs', 1, 0, 14, [3910, 150, 742, [[1921, 1], [1867, 1]]]],
    ['pin_orcs', 2, 53, 15, [3910, 150, 739, [[1870, 1], [1799, 10]]]],
    ['pin_orcs', 2, 0, 14, [3910, 150, 739, [[1870, 1]]]],
    ['pin_orcs', 3, 53, 15, [3910, 150, 705, []]],
    ['pin_orcs', 3, 0, 14, [3910, 150, 705, []]],
    ['pin_orcs', 7, 53, 15, [3630, 120, 644, [[1870, 1]]]],
    ['pin_orcs', 7, 0, 14, [3630, 120, 644, [[1870, 1]]]],
    ['pin_unknown', 4, 53, 15, [1000, 100, 210, []]],
    ['pin_unknown', 4, 0, 14, [1000, 100, 210, []]]
];

for (const [spotId, seed, classId, level, expected] of SOLO) {
    const result = BackgroundResolver.resolveSolo({
        state: member(81, classId, level, spotId),
        spot: spots[spotId],
        elapsedMs: 30000,
        rng: seeded(seed),
        timestamp: TIMESTAMP
    });
    assert.strictEqual(result.debug.wins, 1, `solo ${spotId} seed ${seed} class ${classId} must win one fight`);
    assert.deepStrictEqual(compact(result.materialize), expected,
        `solo kill rewards changed: ${spotId} seed ${seed} class ${classId}`);
}

// [spot, seed, [[classId, level]...], per member [exp, sp, adena, items]]
const PARTY = [
    ['pin_orcs', 11, [[53, 15], [0, 16], [10, 14]], [
        [7360, 280, 959, [[1799, 10], [736, 10]]],
        [8380, 310, 958, [[1060, 1], [1870, 1]]],
        [6400, 240, 958, [[1870, 1]]]
    ]],
    ['pin_orcs', 12, [[53, 15], [0, 16], [10, 14]], [
        [6850, 250, 877, [[1870, 1], [1867, 10], [1802, 1], [1867, 10], [1921, 10]]],
        [7790, 260, 877, [[1802, 1]]],
        [5950, 210, 876, [[1921, 1], [1870, 1]]]
    ]],
    ['pin_orcs', 13, [[0, 15], [53, 13]], [
        [11180, 400, 1395, [[1921, 1], [1060, 1]]],
        [8400, 300, 1394, [[1921, 1], [1867, 1], [1867, 1], [1867, 10]]]
    ]],
    ['pin_orcs', 14, [[0, 15], [18, 16], [31, 15], [44, 14]], [
        [6060, 200, 717, [[1802, 1], [1870, 1]]],
        [6900, 240, 716, []],
        [6060, 200, 716, [[1867, 1]]],
        [5280, 200, 716, []]
    ]],
    ['pin_unknown', 15, [[53, 15], [0, 16], [10, 14]], [
        [1840, 200, 347, []],
        [2120, 200, 347, []],
        [1600, 160, 346, []]
    ]]
];

for (const [spotId, seed, team, expected] of PARTY) {
    const result = BackgroundPartyResolver.resolve({
        party: { partyId: 'pin', cohesion: 1, risk: 0, roleCoverage: {} },
        members: team.map(([classId, level], index) => member(91 + index, classId, level, spotId)),
        spot: spots[spotId],
        elapsedMs: 60000,
        rng: seeded(seed),
        timestamp: TIMESTAMP
    });
    assert.strictEqual(result.debug.wins, 4, `party ${spotId} seed ${seed} must win four fights`);
    assert.deepStrictEqual(result.memberResults.map((entry) => compact(entry.result.materialize)), expected,
        `party kill rewards changed: ${spotId} seed ${seed}`);
}

console.log('test_cold_kill_rewards: ok');

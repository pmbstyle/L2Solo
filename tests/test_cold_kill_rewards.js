// Golden values for cold kill rewards: exp, SP, adena (rolled and the spot's
// fallback range), drops, spoil, the party adena split and the drop owner.
// A seeded random source makes every draw repeatable, so a change of reward
// rules or of the order of random draws moves these values. Every won kill,
// solo or party, rolls its drop and spoil. The spoiler's
// Spoil landing roll comes after exp, SP and adena, so only loot depends on it.
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
    ['pin_orcs', 2, 53, 15, [3910, 150, 739, [[1870, 1]]]],
    ['pin_orcs', 2, 0, 14, [3910, 150, 739, [[1870, 1]]]],
    ['pin_orcs', 3, 53, 15, [3910, 150, 705, [[1799, 10]]]],
    ['pin_orcs', 3, 0, 14, [3910, 150, 705, []]],
    ['pin_orcs', 7, 53, 15, [3630, 120, 644, [[1870, 1], [1867, 10]]]],
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
        [9040, 340, 1200, [[1799, 10], [1799, 10], [1867, 10], [37, 1]]],
        [10290, 370, 1200, [[1867, 1], [1867, 1], [1867, 1], [2005, 1], [1867, 1]]],
        [7860, 290, 1199, []]
    ]],
    ['pin_orcs', 12, [[53, 15], [0, 16], [10, 14]], [
        [8660, 320, 1108, [[1060, 1], [1867, 10], [1867, 1], [1867, 10], [1921, 1], [1870, 1], [1921, 10]]],
        [9850, 340, 1108, []],
        [7520, 270, 1108, [[1802, 1]]]
    ]],
    ['pin_orcs', 13, [[0, 15], [53, 13]], [
        [14080, 510, 1714, [[49, 1], [1060, 1], [1921, 1], [1867, 1]]],
        [10580, 380, 1714, [[1799, 10], [1799, 10], [1867, 10], [1870, 1]]]
    ]],
    ['pin_orcs', 14, [[0, 15], [18, 16], [31, 15], [44, 14]], [
        [7420, 240, 875, [[1060, 1]]],
        [8450, 290, 875, [[1867, 1]]],
        [7420, 240, 874, [[1802, 1]]],
        [6460, 240, 874, []]
    ]],
    ['pin_unknown', 15, [[53, 15], [0, 16], [10, 14]], [
        [2300, 250, 547, []],
        [2650, 250, 547, []],
        [2000, 200, 546, []]
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
    // 60 s is five 12-second windows. At density 3 and cohesion 1 a party
    // fights once per window, the solo combat limit, instead of the former
    // cap of four fights per resolve.
    assert.strictEqual(result.debug.wins, 5, `party ${spotId} seed ${seed} must win five fights`);
    assert.deepStrictEqual(result.memberResults.map((entry) => compact(entry.result.materialize)), expected,
        `party kill rewards changed: ${spotId} seed ${seed}`);
}

// Fights per party resolve follow the solo window rule: a solo bot fights at
// most once per 12-second window, and a party over the same elapsed time gets
// at least as many fights (here exactly one per window, at density 3 and
// cohesion 1), however long the time between resolves. Every won fight rolls
// its drop: the drop roll is replaced by one fixed item per kill, so each win
// must bring exactly one item to some member.
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const rollRewardsForFight = BackgroundDropResolver.rollRewardsForFight;
BackgroundDropResolver.rollRewardsForFight = () => ({
    adena: 1,
    items: [{ selfId: 1867, amount: 1 }]
});
try {
    for (const elapsedMs of [60000, 120000, 180000]) {
        const windows = Math.floor(elapsedMs / 12000);
        let soloWins = 0;
        for (let window = 0; window < windows; window++) {
            soloWins += BackgroundResolver.resolveSolo({
                state: member(81, 0, 14, 'pin_orcs'),
                spot: orcs,
                elapsedMs: 12000,
                rng: seeded(100 + window),
                timestamp: TIMESTAMP + window * 12000
            }).debug.wins;
        }
        const party = BackgroundPartyResolver.resolve({
            party: { partyId: 'pin', cohesion: 1, risk: 0, roleCoverage: {} },
            // No spoiler, so every item is a drop.
            members: [[0, 15], [18, 16], [10, 14]].map(([classId, level], index) => member(91 + index, classId, level, 'pin_orcs')),
            spot: orcs,
            elapsedMs,
            rng: seeded(elapsedMs),
            timestamp: TIMESTAMP
        });
        assert.strictEqual(soloWins, windows, `solo must win one fight per 12 s window over ${elapsedMs} ms`);
        assert.strictEqual(party.debug.wins, windows, `party must win one fight per 12 s window over ${elapsedMs} ms`);
        assert.ok(party.debug.wins >= soloWins, `party must fight at least as often as solo over ${elapsedMs} ms`);
        const drops = party.memberResults.reduce((sum, entry) => (
            sum + entry.result.materialize.items.filter((item) => item.selfId === 1867).length
        ), 0);
        assert.strictEqual(drops, party.debug.wins, `party must roll a drop for every win over ${elapsedMs} ms`);
    }
} finally {
    BackgroundDropResolver.rollRewardsForFight = rollRewardsForFight;
}

console.log('test_cold_kill_rewards: ok');

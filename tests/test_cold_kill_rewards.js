// Golden values for cold kill rewards: exp, SP, adena (rolled and the spot's
// fallback range), drops, spoil, the party adena split and the drop owner.
// A seeded random source makes every draw repeatable, so a change of reward
// rules or of the order of random draws moves these values. Every won kill,
// solo or party, rolls its drop and spoil. The spoiler's
// Spoil landing roll comes after exp, SP and adena, so only loot depends on it.
const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-kill-rewards');

process.env.L2NODE_PROGRESSION_RATE = 'x10';
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

DataCache.init();

// Pure cold outcome controls use an already-owned original object id; this
// does not manufacture inventory, award training or initialize a database.
const ColdSoulCrystal = invoke('GameServer/Bot/Population/ColdSoulCrystal');
const crystalFighter = () => ({ state: { stats: { soulCrystalQuest: true },
    inventory: { 4629: { selfId: 4629, amount: 1, instances: [{ id: 778899, amount: 1 }] } } },
    vitals: { hp: 100 }, soulCrystalMark: { objectId: 778899, fromId: 4629, completeAt: 1 } });
let crystalDraws = 0;
const crystalRoll = () => { crystalDraws++; return 0; };
const noQuest = crystalFighter();
noQuest.state.stats = {};
assert.strictEqual(ColdSoulCrystal.outcome(noQuest, { selfId: 583 }, crystalRoll, { at: 1 }), null);
assert.strictEqual(crystalDraws, 0, 'an ineligible quest does not consume the reward stream');
const noMark = crystalFighter();
noMark.soulCrystalMark = null;
assert.strictEqual(ColdSoulCrystal.outcome(noMark, { selfId: 583 }, crystalRoll, { at: 1 }), null);
assert.strictEqual(crystalDraws, 0, 'an unmarked kill does not consume the reward stream');
const numericFighter = crystalFighter(), lazyFighter = crystalFighter();
const numericChange = ColdSoulCrystal.outcome(numericFighter, { selfId: 583 }, 0, { at: 1 });
const lazyChange = ColdSoulCrystal.outcome(lazyFighter, { selfId: 583 }, crystalRoll, { at: 1 });
assert.strictEqual(crystalDraws, 1, 'one eligible marked outcome consumes exactly one draw');
assert.deepStrictEqual(lazyChange, numericChange, 'lazy and existing numeric native outcomes are identical');
assert.deepStrictEqual(lazyFighter.state.inventory, numericFighter.state.inventory);
assert.strictEqual(lazyChange.objectId, 778899);
assert.strictEqual(lazyChange.toId, 4630);
assert.strictEqual(lazyFighter.state.inventory[4629], undefined);
assert.strictEqual(lazyFighter.state.inventory[4630].amount, 1);

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
    const state = {
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
    // Owned characters fight with their learned kit only (113e1791); each
    // member carries the database-learned skills of its class and level, so
    // the Dwarven Fighter has Spoil.
    state.stats.coldCombat = ColdCombatProfile.legacySnapshot(state, ColdCombatProfile.skillRecordsFromTree(classId, level), TIMESTAMP);
    return state;
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

// The original EXP/SP goldens predate the C4 over-level kill penalty.
// First reproduce them independently with the penalty disabled, then apply
// the documented (5/6) exponent per killed NPC before party rounding. Loot,
// Adena, members, seeds and five-fight windows remain the original goldens.
function partyProgression(team, spot, ids, penalize) {
    const levels = team.map(([, level]) => level);
    const bonuses = [1, 1.30, 1.39, 1.50, 1.54, 1.58, 1.63, 1.67, 1.71];
    const bonus = bonuses[levels.length - 1];
    const weightSum = levels.reduce((sum, level) => sum + level ** 2, 0);
    const cutoff = weightSum * (1 - 1 / (1 + bonus - bonuses[levels.length - 2]));
    assert(levels.every(level => level ** 2 >= cutoff), 'all unchanged fixture members are eligible');
    return levels.map(level => ids.reduce((total, npcId) => {
        const npc = DataCache.npcs.find(row => Number(row.selfId) === Number(npcId));
        const npcLevel = Number(npc?.template?.level || spot.avgLevel);
        // The three authored Orc templates have no Strong Type HP bonus.
        if (npc) assert(!npc.skills?.length, 'the pinned Orc reward requires no passive multiplier');
        const exp = npc ? npcLevel ** 2 * npc.rewards.exp : spot.rewards.exp;
        const sp = npc ? npc.rewards.sp : spot.rewards.sp;
        const gap = Math.max(...levels) - npcLevel;
        const factor = penalize && gap > 5 ? (5 / 6) ** (gap - 5) : 1;
        const weight = level ** 2 / weightSum;
        total[0] += Math.round(Math.round(exp * factor * bonus * weight) * 10);
        total[1] += Math.round(Math.round(sp * factor * bonus * weight) * 10);
        return total;
    }, [0, 0]));
}

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
    const defeated = result.debug.defeatedNpcIds;
    assert.strictEqual(defeated.length, spotId === 'pin_unknown' ? 0 : 5,
        'authored NPCs are concrete; the unchanged unknown spot uses five fallback reward pools');
    const killed = Array.from({ length: 5 }, (_, index) => defeated[index] || 0);
    assert.deepStrictEqual(partyProgression(team, spots[spotId], killed, false), expected.map(row => row.slice(0, 2)),
        `original no-gap reward goldens still describe the same kills: ${spotId} seed ${seed}`);
    const progression = partyProgression(team, spots[spotId], killed, true);
    const withGap = expected.map((row, index) => [...progression[index], ...row.slice(2)]);
    assert.deepStrictEqual(result.memberResults.map((entry) => compact(entry.result.materialize)), withGap,
        `C4 gap rewards and original loot goldens: ${spotId} seed ${seed}`);
}

// Fights per party resolve follow the solo window rule: a solo bot fights at
// most once per 12-second window, and a party over the same elapsed time gets
// at least as many fights (here exactly one per window, at density 3 and
// cohesion 1), within one resolve interval. Every won fight rolls
// its drop: the drop roll is replaced by one fixed item per kill, so each win
// must bring exactly one item to some member.
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const rollRewardsForFight = BackgroundDropResolver.rollRewardsForFight;
BackgroundDropResolver.rollRewardsForFight = () => ({
    adena: 1,
    items: [{ selfId: 1867, amount: 1 }]
});
try {
    for (const elapsedMs of [60000, 120000]) {
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

// The windows of one party resolve are counted from at most the longest
// resolve interval (135 s, 11 windows): a party does not catch up on a long
// gap such as a server stop, as a solo bot does not.
const gapWins = [135000, 8 * 3600000].map((elapsedMs) => BackgroundPartyResolver.resolve({
    party: { partyId: 'pin', cohesion: 1, risk: 0, roleCoverage: {} },
    members: [[0, 15], [18, 16], [10, 14]].map(([classId, level], index) => member(91 + index, classId, level, 'pin_orcs')),
    spot: orcs,
    elapsedMs,
    rng: seeded(21),
    timestamp: TIMESTAMP
}).debug.wins);
assert.strictEqual(gapWins[0], 11, 'party must win one fight per window over 135 s');
assert.strictEqual(gapWins[1], gapWins[0], 'an 8 h gap must give the same fight count as 135 s');

console.log('test_cold_kill_rewards: ok');

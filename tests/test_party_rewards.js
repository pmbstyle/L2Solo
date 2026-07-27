const assert = require('assert');

require('../src/Global');

const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');

function member(level) {
    return { actor: { fetchLevel: () => level } };
}

const equalLevelShares = NpcDied.partyRewardShares([member(20), member(20)], 100, 20);
assert.deepStrictEqual(
    equalLevelShares.map(({ exp, sp }) => ({ exp, sp })),
    [{ exp: 65, sp: 13 }, { exp: 65, sp: 13 }],
    'two same-level members should split the C4 1.30 party reward bonus equally'
);

const weightedShares = NpcDied.partyRewardShares([member(20), member(30)], 130, 26);
assert.deepStrictEqual(
    weightedShares.map(({ exp, sp }) => ({ exp, sp })),
    [{ exp: 52, sp: 10 }, { exp: 117, sp: 23 }],
    'eligible members should receive party rewards proportionally to squared level'
);

const cutoffShares = NpcDied.partyRewardShares([member(20), member(1)], 100, 20);
assert.deepStrictEqual(
    cutoffShares.map(({ session, exp, sp }) => ({ level: session.actor.fetchLevel(), exp, sp })),
    [{ level: 20, exp: 100, sp: 20 }],
    'an extreme low-level passenger should be excluded by the automatic party cutoff'
);

console.log('Party reward checks passed');

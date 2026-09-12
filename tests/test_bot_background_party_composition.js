const assert = require('assert');

require('../src/Global');

const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PartyRewards = invoke('GameServer/Actor/PartyRewardMath');

function bot(characterId, level, role) {
    return { characterId, level, party: { role } };
}

const candidates = [
    bot(1, 20, 'dps'),
    bot(2, 20, 'healer'),
    bot(3, 21, 'tank'),
    bot(4, 19, 'buffer'),
    bot(5, 20, 'mage'),
    bot(6, 28, 'dps')
];
const members = PartyComposition.selectMembers(candidates, { minSize: 2, maxSize: 5 });
const beginners = [bot(101, 1, 'healer'), bot(102, 4, 'tank'), bot(103, 4, 'dps'), bot(104, 1, 'dps')];
const beginnerGroup = PartyComposition.selectMembers(beginners, { minSize: 2, maxSize: 5 });
assert(beginnerGroup.length >= 2);
assert.strictEqual(PartyRewards.validMemberIndexes(beginnerGroup.map(m => m.level)).length, beginnerGroup.length,
    'low-level formation must not create members excluded from XP despite a small numeric level gap');
assert.deepStrictEqual(PartyComposition.selectRecruits([beginners[0], beginners[3]], [beginners[1]], { maxSize: 5 }), [],
    'a recruit must not take existing beginners out of XP distribution');
const memberIds = members.map((state) => state.characterId);

assert.strictEqual(members.length, 5);
assert(memberIds.includes(2), 'a nearby healer should be preferred');
assert(memberIds.includes(3), 'a nearby tank should be preferred');
assert(memberIds.includes(4), 'a nearby buffer should be preferred');
assert(!memberIds.includes(6), 'a bot outside the party level band should not be grouped');
assert.strictEqual(PartyComposition.chooseLeader(members).characterId, 3, 'the tank should lead a balanced background party');
assert.deepStrictEqual(PartyComposition.roleCoverage(members), { tank: 1, healer: 1, buffer: 1, dps: 1, mage: 1 });

const spread = PartyComposition.selectMembers([
    bot(11, 10, 'dps'),
    bot(12, 12, 'mage'),
    bot(13, 17, 'healer')
], { minSize: 2, maxSize: 3 });
assert.strictEqual(spread.length, 2);
assert(Math.max(...spread.map((state) => state.level)) - Math.min(...spread.map((state) => state.level)) <= PartyComposition.DEFAULT_LEVEL_RANGE);

const recruits = PartyComposition.selectRecruits([
    bot(21, 15, 'tank'),
    bot(22, 15, 'healer')
], [
    bot(23, 15, 'dps'),
    bot(24, 15, 'buffer'),
    bot(25, 23, 'buffer')
], { maxSize: 5 });
assert.deepStrictEqual(recruits.map((state) => state.characterId), [24, 23]);
assert.strictEqual(PartyComposition.roleForState({ characterId: 30, level: 39, stats: { classId: 56, role: 'crafter' } }), 'spoiler',
    'a sub-40 dwarf must fill the spoiler role even on the future crafting branch');
assert.strictEqual(PartyComposition.roleForState({ characterId: 31, level: 40, stats: { classId: 57, role: 'crafter' } }), 'dps',
    'a post-40 non-spoiler dwarf must fill a DPS combat slot');

console.log('Bot background party composition checks passed');

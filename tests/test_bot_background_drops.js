const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

DataCache.init();

const spot = {
    id: 'starter_gremlin',
    name: 'Gremlin field',
    avgLevel: 1,
    density: 1,
    npcSelfIds: [1],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 },
    mob: { hp: 8, damage: 1 }
};

const direct = BackgroundDropResolver.rollForFight({ spot, killerLevel: 1, rng: () => 0 });
assert.strictEqual(direct.length, 2, 'cold loot must roll every normal drop group, like the hot NPC path');
assert.strictEqual(direct[0].selfId, 1121, 'the selected item must come from the real Gremlin rewards');
assert.strictEqual(direct[0].kind, 'Armor.Wear');
assert.strictEqual(direct[0].sourceMobLevel, 1, 'background loot must retain the source-mob level for sale policy');
assert.strictEqual(direct[1].selfId, 1864, 'a later guaranteed material group must not be discarded');

const mixedRewardRoll = BackgroundDropResolver.rollRewardsForFight({
    spot: {
        avgLevel: 67,
        npcEntries: [{ selfId: 1509, count: 1 }],
        npcSelfIds: [1509],
        npcNames: ['Splinter Stakato Walker']
    },
    killerLevel: 67,
    npcSelfId: 1509,
    rng: () => 0
});
assert(mixedRewardRoll.adena > 0, 'a mixed reward group may select its Adena entry');
assert(!mixedRewardRoll.items.some((item) => [2391, 4082].includes(item.selfId)),
    'a mixed group must not also award one of the item alternatives after selecting Adena');

const originalRewardGroupRoll = ProgressionRates.rewardGroupRoll;
let rolledNpcLevel = null;
ProgressionRates.rewardGroupRoll = (group, kind, context, rng) => {
    rolledNpcLevel = context.npcLevel;
    return originalRewardGroupRoll(group, kind, context, rng);
};
BackgroundDropResolver.rollForFight({ spot: { ...spot, avgLevel: 99 }, killerLevel: 1, npcSelfId: 1, rng: () => 0 });
ProgressionRates.rewardGroupRoll = originalRewardGroupRoll;
assert.strictEqual(rolledNpcLevel, 1, 'deep-blue rules must use the defeated NPC level, not the spot average');

const nameOnly = BackgroundDropResolver.rollForFight({
    spot: { ...spot, npcSelfIds: [], npcNames: ['Gremlin'] },
    killerLevel: 1,
    rng: () => 0
});
assert.strictEqual(nameOnly[0].selfId, 1121, 'world spots without reward ids must resolve the real drop list by NPC name');

const state = {
    characterId: 71,
    name: 'ColdHunter',
    level: 1,
    levelBand: '1-3',
    activity: 'hunting',
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
    stats: {},
    party: { role: 'dps' }
};
// 40 s: the walk to the spot's mobs alone takes longer than the old 12 s window (T106 spot walk).
const result = BackgroundResolver.resolveSolo({ state, spot, elapsedMs: 40000, rng: () => 0 });
assert.strictEqual(result.materialize.items.length, 2);
assert.strictEqual(result.materialize.items[0].selfId, 1121);
assert.strictEqual(result.materialize.items[0].name, "Apprentice's Shoes");
assert.strictEqual(result.materialize.items[0].kind, 'Armor.Wear');
assert.strictEqual(result.materialize.adena, 7, 'cold combat must roll the exact NPC Adena group');

const partyResult = BackgroundPartyResolver.resolve({
    party: { partyId: 'drop_party', cohesion: 1, risk: 0, roleCoverage: {} },
    members: [{ ...state, characterId: 72 }, { ...state, characterId: 73 }],
    spot,
    elapsedMs: 10000,
    rng: () => 0
});
const partyItems = partyResult.memberResults.flatMap((entry) => entry.result.materialize.items);
assert.strictEqual(partyItems[0].selfId, 1121, 'party rewards should use the same real drop data');

const originalRewards = DataCache.npcRewards, originalNpcs = DataCache.npcs;
try {
    const first = { selfId: 910001, template: { name: ' Shared ' }, rewards: [{}] };
    const second = { selfId: 910002, template: { name: 'SHARED' }, spoils: [{}] };
    DataCache.npcRewards = [{ selfId: 910000, template: { name: 'shared' }, rewards: [] }, first, second, first];
    DataCache.npcs = [{ selfId: 910010, template: { name: 'Shared' } }];
    const named = { npcNames: ['shared', ' SHARED '] };
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(named, () => 0), first);
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(named, () => 0.5), second,
        'empty rows do not enter cold candidates; duplicate source rows retain their ordinal weight');
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(named, () => 0.9), first,
        'a repeated reward reference still contributes a separate cold candidate');
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(named, () => { throw Error('unexpected roll'); }, 910010), first,
        'a defeated world NPC alias resolves the first matching named reward without rolling');
    const weighted = { ...named, npcEntries: [{ selfId: 910001, count: 4 }] };
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(weighted, () => 0.79), first);
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(weighted, () => 0.81), second,
        'known IDs exclude all matching name duplicates; ID counts retain their original candidate weight');
    const appended = { selfId: 910003, template: { name: 'shared' }, rewards: [{}] };
    DataCache.npcRewards.push(appended);
    assert.strictEqual(BackgroundDropResolver.rewardDataForSpot(named, () => 0.99), appended,
        'growth of the reward source refreshes the common name relation');
} finally { DataCache.npcRewards = originalRewards; DataCache.npcs = originalNpcs; }

const strongNpc = DataCache.npcs.find(row => Number(row.selfId) === 37);
const strongProgression = BackgroundDropResolver.progressionForFight({ spot, npcSelfId: 37, rng: () => 0 });
assert.strictEqual(strongProgression.exp, strongNpc.template.level ** 2 * strongNpc.rewards.exp * 2,
    'cold experience uses the NPC owner\'s permanent Strong Type multiplier');
assert.strictEqual(strongProgression.sp, strongNpc.rewards.sp * 2);

console.log('Bot background drop checks passed');

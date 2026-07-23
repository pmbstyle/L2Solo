const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
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
assert.strictEqual(direct.length, 1);
assert.strictEqual(direct[0].selfId, 1121, 'the selected item must come from the real Gremlin rewards');
assert.strictEqual(direct[0].kind, 'Armor.Wear');
assert.strictEqual(direct[0].sourceMobLevel, 1, 'background loot must retain the source-mob level for sale policy');

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
const result = BackgroundResolver.resolveSolo({ state, spot, elapsedMs: 12000, rng: () => 0 });
assert.strictEqual(result.materialize.items.length, 1);
assert.strictEqual(result.materialize.items[0].selfId, 1121);
assert.strictEqual(result.materialize.items[0].name, "Apprentice's Shoes");
assert.strictEqual(result.materialize.items[0].kind, 'Armor.Wear');
assert(result.materialize.adena > 0, 'real item drops complement, rather than replace, normal adena rewards');

const partyResult = BackgroundPartyResolver.resolve({
    party: { partyId: 'drop_party', cohesion: 1, risk: 0, roleCoverage: {} },
    members: [{ ...state, characterId: 72 }, { ...state, characterId: 73 }],
    spot,
    elapsedMs: 10000,
    rng: () => 0
});
const partyItems = partyResult.memberResults.flatMap((entry) => entry.result.materialize.items);
assert.strictEqual(partyItems[0].selfId, 1121, 'party rewards should use the same real drop data');

console.log('Bot background drop checks passed');

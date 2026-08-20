const assert = require('assert');

require('../src/Global');

const NpcRewards = invoke('GameServer/World/Generics/NpcRewards');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

const originalFetchRewards = DataCache.fetchNpcRewardsFromSelfId;
const originalFetchItem = DataCache.fetchItemFromSelfId;
const originalRewardGroupRoll = ProgressionRates.rewardGroupRoll;
const originalObserveDrop = BotLootEtiquette.observeDrop;
const originalQueueGroundPickup = PartyCompanionService.queueRandomGroundPickup;
const originalRandom = Math.random;

try {
    DataCache.fetchNpcRewardsFromSelfId = (_selfId, callback) => callback({
        rewards: [
            {
                overall: 100,
                items: [{ selfId: 955, name: 'Scroll: Enchant Weapon (Grade D)', min: 1, max: 1, chance: 100 }]
            },
            {
                overall: 100,
                items: [{ selfId: 1865, name: 'Varnish', min: 1, max: 1, chance: 100 }]
            }
        ]
    });
    DataCache.fetchItemFromSelfId = (selfId, callback) => callback(selfId === 955
        ? {
            selfId,
            template: { kind: 'Other.Scroll', name: 'Scroll: Enchant Weapon (Grade D)' },
            etc: { stackable: false, consumable: true }
        }
        : {
            selfId,
            template: { kind: 'Other.Material', name: 'Varnish' },
            etc: { stackable: true }
        });
    ProgressionRates.rewardGroupRoll = () => ({ hit: true, itemRate: 3 });
    Math.random = () => 0.99;

    const groundDrops = [];
    const observedDrops = [];
    const directAwards = [];
    BotLootEtiquette.observeDrop = (_session, _npc, selfId, amount) => observedDrops.push({ selfId, amount });
    PartyCompanionService.queueRandomGroundPickup = () => null;

    const world = {
        spawnItem(_session, selfId, amount, _coords, onSpawn) {
            groundDrops.push({ selfId, amount });
            onSpawn?.({ fetchId: () => 800001 });
        },
        purchaseItem(_session, selfId, amount) { directAwards.push({ selfId, amount }); }
    };
    const npc = {
        fetchSelfId: () => 20001,
        fetchLevel: () => 20,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300
    };
    const playerSession = {
        accountId: 'player',
        actor: { fetchId: () => 1, fetchLevel: () => 20 }
    };
    const botSession = {
        accountId: 'bot_reward_test',
        actor: { fetchId: () => 2, fetchLevel: () => 20 }
    };

    NpcRewards.call(world, playerSession, npc);
    NpcRewards.call(world, botSession, npc);

    assert.deepStrictEqual(groundDrops, [
        { selfId: 955, amount: 1 },
        { selfId: 955, amount: 1 },
        { selfId: 955, amount: 1 },
        { selfId: 1865, amount: 3 }
    ], 'scaled non-stackable drops must spawn separate instances while stackable drops stay consolidated');
    assert.deepStrictEqual(observedDrops, [
        { selfId: 955, amount: 3 },
        { selfId: 1865, amount: 3 }
    ], 'loot observers must receive the complete scaled amount for both item kinds');
    assert.deepStrictEqual(directAwards, [
        { selfId: 955, amount: 1 },
        { selfId: 955, amount: 1 },
        { selfId: 955, amount: 1 },
        { selfId: 1865, amount: 3 }
    ], 'bot direct rewards must persist non-stackables separately without splitting resource stacks');
} finally {
    DataCache.fetchNpcRewardsFromSelfId = originalFetchRewards;
    DataCache.fetchItemFromSelfId = originalFetchItem;
    ProgressionRates.rewardGroupRoll = originalRewardGroupRoll;
    BotLootEtiquette.observeDrop = originalObserveDrop;
    PartyCompanionService.queueRandomGroundPickup = originalQueueGroundPickup;
    Math.random = originalRandom;
}

console.log('NPC non-stackable reward amount checks passed');

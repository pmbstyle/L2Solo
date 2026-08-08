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
const originalScaleAmount = ProgressionRates.scaleAmount;
const originalObserveDrop = BotLootEtiquette.observeDrop;
const originalQueueGroundPickup = PartyCompanionService.queueRandomGroundPickup;
const originalRandom = Math.random;

try {
    DataCache.fetchNpcRewardsFromSelfId = (_selfId, callback) => callback({
        rewards: [
            {
                overall: 100,
                items: [{ selfId: 123, name: 'Saber', min: 1, max: 1, chance: 100 }]
            },
            {
                overall: 100,
                items: [{ selfId: 1865, name: 'Varnish', min: 1, max: 1, chance: 100 }]
            }
        ]
    });
    DataCache.fetchItemFromSelfId = (selfId, callback) => callback(selfId === 123
        ? {
            selfId,
            template: { kind: 'Weapon.Sword', name: 'Saber' },
            etc: { stackable: false }
        }
        : {
            selfId,
            template: { kind: 'Other.Material', name: 'Varnish' },
            etc: { stackable: true }
        });
    ProgressionRates.rewardGroupRoll = () => ({ hit: true, amountMultiplier: 3 });
    ProgressionRates.scaleAmount = () => 3;
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
        { selfId: 123, amount: 1 },
        { selfId: 1865, amount: 3 }
    ], 'scaled drops must clamp a weapon to one while preserving a material stack');
    assert.deepStrictEqual(observedDrops, [
        { selfId: 123, amount: 1 },
        { selfId: 1865, amount: 3 }
    ], 'loot observers must receive canonical non-stackable and stackable amounts');
    assert.deepStrictEqual(directAwards, [
        { selfId: 123, amount: 1 },
        { selfId: 1865, amount: 3 }
    ], 'bot direct rewards must clamp equipment without reducing resource stacks');
} finally {
    DataCache.fetchNpcRewardsFromSelfId = originalFetchRewards;
    DataCache.fetchItemFromSelfId = originalFetchItem;
    ProgressionRates.rewardGroupRoll = originalRewardGroupRoll;
    ProgressionRates.scaleAmount = originalScaleAmount;
    BotLootEtiquette.observeDrop = originalObserveDrop;
    PartyCompanionService.queueRandomGroundPickup = originalQueueGroundPickup;
    Math.random = originalRandom;
}

console.log('NPC non-stackable reward amount checks passed');

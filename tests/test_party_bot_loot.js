const assert = require('assert');

require('../src/Global');

const NpcRewards = invoke('GameServer/World/Generics/NpcRewards');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');

const originalRewards = DataCache.fetchNpcRewardsFromSelfId;
const originalRollGroup = ProgressionRates.rollGroup;
const originalGroupRate = ProgressionRates.groupRate;
const originalScaleAmount = ProgressionRates.scaleAmount;
const originalRandom = Math.random;

try {
    DataCache.fetchNpcRewardsFromSelfId = (_id, callback) => callback({
        rewards: [{ overall: 100, items: [{ selfId: 57, min: 10, max: 10, chance: 100 }] }]
    });
    ProgressionRates.rollGroup = () => ({ hit: true, amountMultiplier: 1 });
    ProgressionRates.groupRate = () => 1;
    ProgressionRates.scaleAmount = (amount) => amount;
    Math.random = () => 0;

    const spawned = [];
    const purchased = [];
    const world = {
        spawnItem(session, selfId, amount, coords) { spawned.push({ session, selfId, amount, coords }); },
        purchaseItem(session, selfId, amount) { purchased.push({ session, selfId, amount }); }
    };
    const leaderSession = { actor: { fetchId: () => 1 } };
    const botSession = {
        accountId: 'bot_looter',
        partyCompanion: true,
        followPlayerSession: leaderSession,
        actor: { fetchId: () => 2 }
    };
    const npc = {
        fetchSelfId: () => 999,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300
    };

    NpcRewards.call(world, botSession, npc);

    assert.strictEqual(spawned.length, 1, 'a companion bot kill should create a visible ground drop for the party');
    assert.strictEqual(spawned[0].selfId, 57);
    assert.strictEqual(purchased.length, 0, 'a companion bot kill must not silently route the drop into bot inventory');
} finally {
    DataCache.fetchNpcRewardsFromSelfId = originalRewards;
    ProgressionRates.rollGroup = originalRollGroup;
    ProgressionRates.groupRate = originalGroupRate;
    ProgressionRates.scaleAmount = originalScaleAmount;
    Math.random = originalRandom;
}

console.log('Party bot loot checks passed');

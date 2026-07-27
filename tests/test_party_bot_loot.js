const assert = require('assert');

require('../src/Global');

const NpcRewards = invoke('GameServer/World/Generics/NpcRewards');
const World = invoke('GameServer/World/World');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BotManager = invoke('GameServer/Bot/BotManager');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ActorGenerics = require('../src/GameServer/Actor/Generics');
const Attack = invoke('GameServer/Actor/Attack');

const originalRewards = DataCache.fetchNpcRewardsFromSelfId;
const originalRollGroup = ProgressionRates.rollGroup;
const originalGroupRate = ProgressionRates.groupRate;
const originalScaleAmount = ProgressionRates.scaleAmount;
const originalRandom = Math.random;
const originalBotSessions = BotManager.sessions;
const originalPickupExec = ActorGenerics.pickupExec;
const originalWorldItems = World.items;
const originalWorldUsers = World.user;
const originalFetchNpcsInRadius = World.fetchNpcsInRadius;

try {
    DataCache.fetchNpcRewardsFromSelfId = (_id, callback) => callback({
        rewards: [{ overall: 100, items: [{ selfId: 57, min: 10, max: 10, chance: 100 }] }]
    });
    ProgressionRates.rollGroup = () => ({ hit: true, amountMultiplier: 1 });
    ProgressionRates.groupRate = () => 1;
    ProgressionRates.scaleAmount = (amount) => amount;
    Math.random = () => 0;
    const pickupCalls = [];
    ActorGenerics.pickupExec = (session, actor, data, onComplete) => pickupCalls.push({ session, actor, data, onComplete });

    const spawned = [];
    const purchased = [];
    const world = {
        spawnItem(session, selfId, amount, coords, onSpawn) {
            const item = {
                fetchId: () => 500001,
                fetchLocX: () => coords.locX,
                fetchLocY: () => coords.locY,
                fetchLocZ: () => coords.locZ
            };
            spawned.push({ session, selfId, amount, coords });
            onSpawn(item);
        },
        purchaseItem(session, selfId, amount) { purchased.push({ session, selfId, amount }); }
    };
    const leaderSession = {
        partyCompanionSettings: { distribution: 1 },
        actor: {
            fetchId: () => 1,
            fetchLocX: () => 100,
            fetchLocY: () => 200,
            fetchIsOnline: () => true,
            isDead: () => false
        }
    };
    function pickupBot(id, locX) {
        return {
            fetchId: () => id,
            fetchLocX: () => locX,
            fetchLocY: () => 200,
            fetchLocZ: () => -310,
            fetchIsOnline: () => true,
            isDead: () => false,
            isBlocked: () => false,
            fetchHead: () => 0,
            state: {
                hit: false,
                fetchSeated: () => false,
                fetchPickinUp: () => false,
                fetchTowards: () => false,
                fetchHits() { return this.hit; },
                fetchCasts: () => false,
                combat: false,
                fetchCombats() { return this.combat; },
                setTowards() {},
                setHits(value) { this.hit = value; }
            },
            automation: { abortAll() {} }
        };
    }
    const closestBot = pickupBot(2, 110);
    closestBot.attack = new Attack();
    const distantBot = pickupBot(3, 800);
    const botSession = {
        accountId: 'bot_looter',
        partyCompanion: true,
        followPlayerSession: leaderSession,
        plan: 'following',
        actor: closestBot,
        dataSendToMeAndOthers() {}
    };
    const distantBotSession = {
        accountId: 'bot_far_looter',
        partyCompanion: true,
        followPlayerSession: leaderSession,
        plan: 'following',
        actor: distantBot,
        dataSendToMeAndOthers() {}
    };
    BotManager.sessions = [botSession, distantBotSession];
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
    assert.deepStrictEqual(pickupCalls.map(({ session, actor, data }) => ({ session, actor, data })), [{ session: botSession, actor: closestBot, data: { id: 500001 } }], 'with Random loot the closest active companion should immediately start normal server-side pickup');
    assert.strictEqual(distantBot.storedPickup, undefined, 'only one nearest companion should receive the pickup order');
    pickupCalls[0].onComplete();

    closestBot.state.combat = true;
    PartyCompanionService.queueRandomGroundPickup(botSession, {
        fetchId: () => 500002,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -310
    });
    PartyCompanionService.queueRandomGroundPickup(botSession, {
        fetchId: () => 500003,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -310
    });
    assert.strictEqual(pickupCalls.length, 1, 'a drop arriving while the party is in combat should wait instead of interrupting the fight');
    closestBot.state.combat = false;
    PartyCompanionService.startQueuedGroundPickup(botSession);
    assert.deepStrictEqual(pickupCalls[1] && { session: pickupCalls[1].session, actor: pickupCalls[1].actor, data: pickupCalls[1].data }, { session: botSession, actor: closestBot, data: { id: 500002 } }, 'a queued hot-bot pickup should execute server-side after combat instead of waiting for a client position packet');
    pickupCalls[1].onComplete();
    assert.deepStrictEqual(pickupCalls[2] && { session: pickupCalls[2].session, actor: pickupCalls[2].actor, data: pickupCalls[2].data }, { session: botSession, actor: closestBot, data: { id: 500003 } }, 'multiple drops assigned to the same bot should be picked up in FIFO order');
    pickupCalls[2].onComplete();

    botSession.partyGroundPickupQueue = [{ id: 500007 }];
    leaderSession.actor.isDead = () => true;
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), false, 'queued loot must wait for a dead party member to be resurrected');
    assert.strictEqual(pickupCalls.length, 3, 'a pending resurrection must preempt queued loot');
    leaderSession.actor.isDead = () => false;
    leaderSession.partyCompanionSettings = { distribution: 1, pullMode: 'bot', pullerId: closestBot.fetchId() };
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), false, 'a bot newly assigned as puller must not execute stale queued loot before its first pull tick');
    botSession.partyGroundPickupQueue = [];
    leaderSession.partyCompanionSettings = { distribution: 1 };
    leaderSession.partyPullState = {};

    // Loot reconciliation must not depend on the death that produced the
    // item. A pre-existing drop is still party loot once the group is idle.
    World.items = {
        spawns: [{
            fetchId: () => 500004,
            fetchLocX: () => 130,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.deepStrictEqual(pickupCalls[3] && { session: pickupCalls[3].session, actor: pickupCalls[3].actor, data: pickupCalls[3].data }, { session: botSession, actor: closestBot, data: { id: 500004 } }, 'an idle hot party should collect reachable loot that was already lying on the ground');
    pickupCalls[3].onComplete();

    // A returning puller is travelling, not fighting at camp. It must not
    // block recovery of an older drop that another companion can collect.
    closestBot.state.combat = true;
    leaderSession.partyPullState = { phase: 'return', pullerId: closestBot.fetchId() };
    World.items = {
        spawns: [{
            fetchId: () => 500005,
            fetchLocX: () => 130,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    leaderSession.lastGroundLootScanAt = 0;
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.deepStrictEqual(pickupCalls[4] && { session: pickupCalls[4].session, actor: pickupCalls[4].actor, data: pickupCalls[4].data }, { session: distantBotSession, actor: distantBot, data: { id: 500005 } }, 'a distant return pull should let another companion collect old loot without interrupting the puller');
    pickupCalls[4].onComplete();

    // An NPC already targeting the party is combat even before a companion
    // has started its own hit/cast animation; loot must not delay defense.
    closestBot.state.combat = false;
    leaderSession.partyPullState = {};
    const incomingThreat = {
        fetchId: () => 800001,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => leaderSession.actor.fetchId(),
        fetchLocX: () => 130,
        fetchLocY: () => 200
    };
    World.user = { sessions: [leaderSession, botSession, distantBotSession] };
    World.fetchNpcsInRadius = () => [incomingThreat];
    World.items = {
        spawns: [{
            fetchId: () => 500006,
            fetchLocX: () => 130,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    leaderSession.lastGroundLootScanAt = 0;
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.strictEqual(pickupCalls.length, 5, 'an incoming NPC threat must block ground pickup before party members start their own combat action');
} finally {
    DataCache.fetchNpcRewardsFromSelfId = originalRewards;
    ProgressionRates.rollGroup = originalRollGroup;
    ProgressionRates.groupRate = originalGroupRate;
    ProgressionRates.scaleAmount = originalScaleAmount;
    Math.random = originalRandom;
    BotManager.sessions = originalBotSessions;
    ActorGenerics.pickupExec = originalPickupExec;
    World.items = originalWorldItems;
    World.user = originalWorldUsers;
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
}

console.log('Party bot loot checks passed');

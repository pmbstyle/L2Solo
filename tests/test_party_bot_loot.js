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
    World.user = { sessions: [leaderSession, botSession, distantBotSession] };
    World.fetchNpcsInRadius = () => [];
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

    const activeThreat = {
        fetchId: () => 900001,
        fetchAttackable: () => true,
        isDead: () => false,
        fetchDestId: () => closestBot.fetchId(),
        fetchLocX: () => 100,
        fetchLocY: () => 200
    };
    World.npc = { spawns: [activeThreat] };
    World.fetchNpcsInRadius = () => [activeThreat];
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
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
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
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), true, 'an assigned puller should collect queued ground loot while no pull is active');
    assert.deepStrictEqual(pickupCalls[3] && { session: pickupCalls[3].session, actor: pickupCalls[3].actor, data: pickupCalls[3].data }, { session: botSession, actor: closestBot, data: { id: 500007 } }, 'idle puller loot should use the normal server-side pickup path');
    pickupCalls[3].onComplete();
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
    leaderSession.lastGroundLootScanAt = 0;
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.deepStrictEqual(pickupCalls[4] && { session: pickupCalls[4].session, actor: pickupCalls[4].actor, data: pickupCalls[4].data }, { session: botSession, actor: closestBot, data: { id: 500004 } }, 'an idle hot party should collect reachable loot that was already lying on the ground');
    pickupCalls[4].onComplete();

    closestBot.storedPickup = { id: 499999 };
    World.items = {
        spawns: [{
            fetchId: () => 500008,
            fetchLocX: () => 130,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    leaderSession.lastGroundLootScanAt = 0;
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.deepStrictEqual(pickupCalls[5] && { session: pickupCalls[5].session, actor: pickupCalls[5].actor, data: pickupCalls[5].data }, { session: botSession, actor: closestBot, data: { id: 500008 } }, 'a stale client pickup must not block a companion from collecting later ground loot');
    assert.strictEqual(closestBot.storedPickup, undefined, 'companion loot reconciliation should clear stale client pickup state');
    pickupCalls[5].onComplete();

    leaderSession.lastGroundLootScanAt = 0;
    World.items = { spawns: [] };
    const emptyScanStartedAt = Date.now();
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.strictEqual(
        leaderSession.lastGroundLootScanAt >= emptyScanStartedAt,
        true,
        'an idle ground-loot scan should retain its shared throttle when no items are available'
    );

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
    assert.deepStrictEqual(pickupCalls[6] && { session: pickupCalls[6].session, actor: pickupCalls[6].actor, data: pickupCalls[6].data }, { session: distantBotSession, actor: distantBot, data: { id: 500005 } }, 'a distant return pull should let another companion collect old loot without interrupting the puller');
    pickupCalls[6].onComplete();

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
    assert.strictEqual(pickupCalls.length, 7, 'an incoming NPC threat must block ground pickup before party members start their own combat action');

    // A follow/combat movement command can cancel Automation's pickup timer
    // before PickupExec reaches its completion callback. The queue must retry
    // rather than becoming permanently unavailable after that one dropped
    // completion.
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    World.items = { spawns: [] };
    botSession.partyGroundPickupQueue = [{ id: 500009 }];
    botSession.partyGroundPickupInProgress = false;
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), true, 'a queued pickup should start normally before a simulated cancellation');
    const cancelledPickup = pickupCalls[7];
    botSession.partyGroundPickupDeadlineAt = Date.now() - 1;
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), true, 'an expired pickup action should be retried instead of locking future loot');
    const retriedPickup = pickupCalls[8];
    cancelledPickup.onComplete();
    assert.deepStrictEqual(botSession.partyGroundPickupQueue, [{ id: 500009 }], 'a stale completion must not remove the retried pickup from the queue');
    retriedPickup.onComplete();
    assert.deepStrictEqual(botSession.partyGroundPickupQueue, [], 'the current pickup completion should remove the recovered queue entry');

    closestBot.fetchCollectiveRunSpd = () => 120;
    closestBot.automation.ticksToMove = () => 21000;
    World.items = {
        spawns: [{
            fetchId: () => 500010,
            fetchLocX: () => 2500,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    botSession.partyGroundPickupQueue = [{ id: 500010 }];
    botSession.partyGroundPickupInProgress = false;
    assert.strictEqual(PartyCompanionService.startQueuedGroundPickup(botSession), true, 'a distant pickup should start normally');
    const longWalkPickup = pickupCalls[9];
    assert.strictEqual(
        PartyCompanionService.startQueuedGroundPickup(botSession),
        false,
        'a valid long walk should remain in progress instead of being cancelled by the short fallback timeout'
    );
    longWalkPickup.onComplete();
    assert.deepStrictEqual(botSession.partyGroundPickupQueue, [], 'a completed long walk should still clear its queue entry');

    // By Turn and By Turn Including Spoil still require a physical companion
    // to collect the ground object before the normal distribution resolver
    // assigns it to the current recipient.
    leaderSession.partyCompanionSettings = { distribution: 3 };
    World.items = {
        spawns: [{
            fetchId: () => 500011,
            fetchLocX: () => 130,
            fetchLocY: () => 200,
            fetchLocZ: () => -310
        }]
    };
    leaderSession.lastGroundLootScanAt = 0;
    PartyCompanionService.reconcileGroundLoot(botSession);
    assert.deepStrictEqual(
        pickupCalls[10] && { session: pickupCalls[10].session, actor: pickupCalls[10].actor, data: pickupCalls[10].data },
        { session: botSession, actor: closestBot, data: { id: 500011 } },
        'By Turn loot should still be collected from the ground by an available companion'
    );
    pickupCalls[10].onComplete();
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

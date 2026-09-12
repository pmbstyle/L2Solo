const assert = require('assert');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Data = invoke('GameServer/DataCache');
const Rates = invoke('GameServer/ProgressionRates');
const Bots = invoke('GameServer/Bot/BotManager');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Loot = invoke('GameServer/Bot/AI/PartyCompanionService');
const Rewards = invoke('GameServer/World/Generics/NpcRewards');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const Automation = invoke('GameServer/Automation');
const saved = [];
const actors = [];
function replace(object, key, value) {
    const old = object[key];
    saved.push(() => object[key] = old);
    object[key] = value;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function bot(id, x) {
    const session = { accountId: `bot_${id}`, botSession: true, plan: 'hunting', packets: [],
        dataSendToMe() {}, dataSendToMeAndOthers(packet) { this.packets.push(packet); } };
    session.actor = {
        session, x, z: 0, automation: new Automation(),
        fetchId: () => id, fetchLevel: () => 40, fetchHead: () => 0,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ() { return this.z; },
        setLocXYZ(loc) { this.x = loc.locX; this.z = loc.locZ; },
        fetchCollectiveRunSpd: () => 200, fetchIsOnline: () => true, isDead: () => false,
        state: { towards: false, casts: false, pickup: false,
            fetchSeated: () => false, fetchHits: () => false,
            fetchCasts() { return this.casts; }, setTowards(v) { this.towards = v; },
            fetchPickinUp() { return this.pickup; }, setPickinUp(v) { this.pickup = v; } }
    };
    actors.push(session.actor);
    return session;
}

(async () => {
    try {
        replace(Data, 'fetchNpcRewardsFromSelfId', (_id, cb) => cb({ rewards: [{}] }));
        replace(Data, 'fetchItemFromSelfId', (id, cb) => cb({ selfId: id, etc: { stackable: true } }));
        replace(Rates, 'rewardGroupRoll', () => ({ hit: true, itemRate: 1 }));
        replace(Rates, 'selectDropItem', () => ({ selfId: 57 }));
        replace(Rates, 'rollDropAmount', () => 11);
        replace(Math, 'random', () => 0);
        replace(World, 'items', { spawns: [] });
        replace(World, 'npc', { spawns: [] });
        replace(World, 'fetchNpcsInRadius', () => []);
        const purchases = [];
        let nextId = 700000;
        replace(World, 'spawnItem', (_s, selfId, amount, coords, cb) => {
            const id = ++nextId;
            const item = { model: coords, fetchId: () => id, fetchSelfId: () => selfId,
                fetchAmount: () => amount, fetchLocX: () => coords.locX,
                fetchLocY: () => coords.locY, fetchLocZ: () => coords.locZ };
            World.items.spawns.push(item);
            cb(item);
        });
        replace(World, 'fetchItem', async id => World.items.spawns.find(i => i.fetchId() === id));
        replace(World, 'purchaseItem', (s, id, amount) => purchases.push([s.actor.fetchId(), id, amount]));
        replace(World, 'pickupItem', Pickup.bind(World));
        const npc = { fetchSelfId: () => 20, fetchLocX: () => 300, fetchLocY: () => 0,
            fetchLocZ: () => 0, fetchLevel: () => 40 };

        for (const grouped of [false, true]) {
            const leader = bot(grouped ? 2 : 1, 0);
            const follower = grouped ? bot(3, -300) : null;
            const sessions = follower ? [leader, follower] : [leader];
            replace(Bots, 'sessions', sessions);
            replace(World, 'user', { sessions });
            if (grouped) {
                sessions.forEach(s => s.hotBackgroundPartyId = 'test');
                replace(Parties, 'find', () => ({ partyId: 'test', status: 'hot', leaderId: 2, memberIds: [2, 3] }));
            }
            purchases.length = 0;
            // A native support cast must finish before loot can claim movement.
            leader.actor.state.casts = true;
            Rewards.call(World, follower || leader, npc);
            const item = World.items.spawns[0];
            assert(item, 'hot rewards must first create a ground object');
            assert.strictEqual(item.model.partyLootLeaderId, leader.actor.fetchId());
            assert.deepStrictEqual(purchases, [], 'neither solo nor party receives an instant inventory award');
            assert.strictEqual(leader.partyGroundPickupInProgress, undefined, 'loot cannot interrupt a support cast');
            leader.actor.state.casts = false;
            leader.pendingSupportCast = { expiresAt: Date.now() + 10000 };
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), false, 'a pending support approach also owns movement');
            leader.pendingSupportCast = null;
            leader.pvpDefense = {};
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), false, 'PvP takes priority over collecting loot');
            leader.pvpDefense = null;
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), true, 'the closest bot (including a party leader) starts pickup');
            await wait(350);
            assert(leader.actor.x > 0 && leader.actor.x < item.fetchLocX(), 'native pickup interpolates the bot toward the item');
            assert(leader.packets.some(packet => packet[0] === 0x01), 'the client receives visible movement');
            assert.deepStrictEqual(purchases, [], 'inventory stays unchanged while running');
            assert.strictEqual(World.items.spawns.length, 1, 'loot remains on the ground during travel');
            assert.strictEqual(Loot.startQueuedGroundPickup(leader), true, 'pickup keeps ownership of the AI tick during movement');
            assert.strictEqual(Loot.reconcileGroundLoot(leader), 0, 'reconciliation does not assign the same object twice');
            await wait(2000);
            assert.strictEqual(leader.actor.x, item.fetchLocX(), 'the collector reaches the ground object');
            assert.strictEqual(World.items.spawns.length, 0, 'native pickup removes the ground item after arrival');
            assert.deepStrictEqual(purchases, grouped ? [[2, 57, 6], [3, 57, 5]] : [[1, 57, 11]],
                'physical pickup preserves solo ownership and native party Adena distribution');
            assert.strictEqual(Pickup.call(World, leader, leader.actor, item), false, 'a second claimant cannot duplicate the reward');
            assert.deepStrictEqual(leader.partyGroundPickupQueue, [], 'completion releases the queue');
        }
        console.log('Hot ground loot: native drop, movement, arrival, solo/party ownership and combat/support priority passed');
    } finally {
        actors.forEach(actor => actor.automation.abortAll(actor, { notifyClient: false }));
        saved.reverse().forEach(restore => restore());
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

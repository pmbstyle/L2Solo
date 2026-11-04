'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('pk-drop-pickup-enchant');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Drops = invoke('GameServer/Actor/Generics/PkDeathDrop');
const Spawn = invoke('GameServer/World/Generics/SpawnItem');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Native = require('./helpers/nativeMarketFixture');
Data.init();

async function session(id) {
    return { accountId: `pickup_${id}`, actor: {
        fetchId: () => id, fetchKarma: () => 100, fetchPk: () => 6,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        isDead: () => false, fetchIsOnline: () => true,
        backpack: new Backpack({ id, items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) })
    }, dataSendToMe() {}, dataSendToMeAndOthers() {} };
}

(async () => {
    await Database.init();
    const previousSpawn = World.spawnItem, previousUserInfo = Response.userInfo, previousUser = World.user;
    try {
        await Native.character(Database, 9401, 'PkOwner', 'pk_pickup_owner');
        await Native.character(Database, 9402, 'Collector', 'pk_pickup_collector');
        await Database.setItem(9401, { selfId: 123, name: 'Saber', amount: 1, enchant: 7 });
        await Database.setItem(9401, { selfId: 19, name: 'Shield', amount: 1, enchant: 4 });
        const petData = { name: 'Pickup Wolf', level: 15, exp: 0 };
        await Database.setItem(9401, { selfId: 2375, name: 'Wolf Collar', amount: 1, petData });
        await Database.setItem(9401, { selfId: 5789, name: 'Soulshot for Beginners', amount: 600 });
        await Database.setItem(9401, { selfId: 5790, name: 'Spiritshot for Beginners', amount: 300 });
        await Database.setItem(9402, { selfId: 123, name: 'Saber', amount: 1 });
        const owner = await session(9401), collector = await session(9402);
        const awards = [], ground = { items: { nextId: 700001, spawns: [] },
            fetchVisibleUsers: (...args) => World.fetchVisibleUsers(...args),
            purchaseItem(...args) { const award = Purchase(...args); awards.push(award); return award; } };
        World.spawnItem = (...args) => Spawn.call(ground, ...args);
        World.user = { sessions: [], revision: 0 };
        const Model = invoke('GameServer/Model/Actor');
        const observer = (id, x, online = true) => {
            const packets = [];
            const recipient = { accountId: `drop_observer_${id}`, fetchAccountId() { return this.accountId; },
                dataSendToMe: packet => packets.push(packet) };
            recipient.actor = new Model({ id, name: recipient.accountId, username: recipient.accountId,
                clanId: 0, isOnline: false, locX: x, locY: 1000, locZ: 0 });
            recipient.actor.session = recipient;
            World.insertUser(recipient); recipient.actor.setIsOnline(online);
            return packets;
        };
        const nearby = observer(9410, 1100), far = observer(9411, 20000), offline = observer(9412, 1000, false);
        Drops.spawn(9401, { locX: 1000, locY: 1000, locZ: 0 }, [{ selfId: 123, amount: 1, enchant: 7 }]);
        const coldDrop = ground.items.spawns.pop();
        assert(coldDrop, 'a cold victim leaves an actual ground item');
        assert.deepEqual(nearby, [Response.spawnItem(coldDrop)], 'nearby players receive the native cold PK spawn packet');
        assert.deepEqual(far, [], 'distant players receive no spawn packet');
        assert.deepEqual(offline, [], 'offline actors receive no spawn packet');
        // Inventory and spawn packets remain native; this fixture has no combat stats.
        Response.userInfo = () => Buffer.alloc(0);
        assert.equal(Drops.drop(owner, owner.actor, () => 0).length, 3);
        assert.deepEqual((await Database.fetchItems(9401)).map(item => [item.selfId, item.amount]),
            [[5789, 600], [5790, 300]], 'queued PK removals keep both protected beginner stacks');
        assert.deepEqual(ground.items.spawns.map(item => item.fetchEnchantLevel()).sort((a, b) => a - b), [0, 4, 7]);
        for (const item of [...ground.items.spawns]) {
            // Resolve a stale copy by object ID; only the canonical drop owns metadata.
            assert.equal(Pickup.call(ground, collector, collector.actor, { fetchId: () => item.fetchId() }), true);
            assert.equal(Pickup.call(ground, collector, collector.actor, item), false, 'a drop is awarded once');
        }
        await Promise.all(awards);
        const carried = collector.actor.backpack.fetchItems();
        assert.deepEqual(carried.filter(item => item.fetchSelfId() === 123).map(item => item.fetchEnchantLevel()), [0, 7]);
        assert.equal(carried.find(item => item.fetchSelfId() === 19).fetchEnchantLevel(), 4);
        assert.deepEqual(carried.find(item => item.fetchSelfId() === 2375).fetchPetData(), petData);
        await Database.close();
        Database.init();
        const restored = (await session(9402)).actor.backpack.fetchItems();
        assert.deepEqual(restored.filter(item => item.fetchSelfId() === 123).map(item => item.fetchEnchantLevel()), [0, 7]);
        assert.equal(restored.find(item => item.fetchSelfId() === 19).fetchEnchantLevel(), 4);
        assert.deepEqual(restored.find(item => item.fetchSelfId() === 2375).fetchPetData(), petData);
        console.log('PASS native PK drop → ground pickup: separate enchanted instances and pet data survive reopening');
    } finally {
        World.spawnItem = previousSpawn;
        World.user = previousUser;
        Response.userInfo = previousUserInfo;
        await Database.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

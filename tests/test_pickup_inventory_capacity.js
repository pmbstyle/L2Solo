'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('pickup-capacity');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Response = invoke('GameServer/Network/Response');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Native = require('./helpers/nativeMarketFixture');
let nextObject = 700000;
function item(selfId, amount = 1) {
    const template = Data.items.find(row => row.selfId === selfId);
    return new Item(++nextObject, { ...utils.crushOb(template), amount });
}
function session(items = [], race = 0, maxLoad = 1000000, expand = 0) {
    const backpack = new Backpack({ id: 9601, items: [], paperdoll: {} });
    backpack.items = items;
    return { accountId: 'pickup_test', actor: {
        fetchId: () => 9601, fetchRace: () => race, fetchMaxLoad: () => maxLoad,
        isDead: () => false, fetchIsOnline: () => true, backpack,
        skillset: { fetchSkill: () => ({ fetchLevel: () => expand }) }
    }, packets: [], dataSendToMe(packet) { this.packets.push(packet); },
    deleted: [], dataSendToMeAndOthers(packet, ground) { this.deleted.push(ground.fetchId()); } };
}
function world(drops, award = () => {}) {
    return { items: { spawns: drops }, awards: [], purchaseItem(...args) {
        this.awards.push(args);
        return award(...args);
    } };
}
function pick(world, session, drop) { return Pickup.call(world, session, session.actor, drop); }
function filled(count) { return Array.from({ length: count }, () => item(955)); }

(async () => {
    await Database.init();
    Data.init();
    const original = { userInfo: Response.userInfo, allocations: Party.adenaAllocations, recipient: Party.resolveLootSession };
    Response.userInfo = () => Buffer.from([4]);
    Party.resolveLootSession = source => source;
    Party.adenaAllocations = (source, amount) => [{ session: source, amount }];
    try {
        const full = session(filled(80));
        const scroll = item(955), fullWorld = world([scroll]);
        assert.equal(pick(fullWorld, full, scroll), false);
        assert.deepEqual(fullWorld.items.spawns, [scroll], 'a rejected pickup keeps its ground object');
        assert.equal(fullWorld.awards.length, 0);
        assert.deepEqual(full.deleted, [], 'a rejected pickup broadcasts no deletion');
        assert.equal(full.packets[0][0], 0x25, 'release the client action when capacity rejects pickup');
        assert.equal(full.packets.at(-1).readInt32LE(1), 129, 'native inventory-full feedback');

        const stack = item(1865, 4);
        const fullWithStack = session([...filled(79), stack]);
        const varnish = item(1865, 5), stackWorld = world([varnish]);
        assert.equal(pick(stackWorld, fullWithStack, varnish), true, 'an existing stack needs no free slot');
        const newStack = item(1867, 1);
        stackWorld.items.spawns.push(newStack);
        assert.equal(pick(stackWorld, fullWithStack, newStack), false, 'a different material needs its own slot');

        const heavy = item(1865, 40);
        const tooHeavy = session([], 0, heavy.fetchMass() * heavy.fetchAmount() - 1);
        const weightWorld = world([heavy]);
        assert.equal(pick(weightWorld, tooHeavy, heavy), false, 'stack weight is multiplied by quantity');
        assert.deepEqual(weightWorld.items.spawns, [heavy]);
        assert.equal(tooHeavy.packets.at(-1).readInt32LE(1), 422, 'native weight-limit feedback');
        const exact = item(955), exactSession = session([], 0, exact.fetchMass());
        assert.equal(pick(world([exact]), exactSession, exact), true, 'exact maximum weight is allowed');

        // Hold the first persistence operation open. The next claim must see
        // that pending slot even though it is absent from the live backpack.
        let finish;
        const nearFull = session(filled(79));
        const first = item(955), second = item(955);
        const pendingWorld = world([first, second], () => new Promise(resolve => { finish = resolve; }));
        assert.equal(pick(pendingWorld, nearFull, first), true);
        assert.equal(pick(pendingWorld, nearFull, second), false, 'two pending non-stackables cannot take one slot');
        assert.deepEqual(pendingWorld.items.spawns, [second]);
        finish(); await Promise.resolve();
        pendingWorld.purchaseItem = () => undefined;
        assert.equal(pick(pendingWorld, nearFull, second), true, 'settled writes release their reservations');

        const materialOne = item(1865, 1), materialTwo = item(1865, 1), different = item(1867, 1);
        const sameStack = session(filled(79));
        const finishStacks = [];
        const concurrentStacks = world([materialOne, materialTwo, different], () => new Promise(resolve => finishStacks.push(resolve)));
        assert.equal(pick(concurrentStacks, sameStack, materialOne), true);
        assert.equal(pick(concurrentStacks, sameStack, materialTwo), true, 'pending copies of one stack share a slot');
        assert.equal(pick(concurrentStacks, sameStack, different), false);
        finishStacks.forEach(done => done()); await Promise.resolve();

        const weighted = session([], 0, 200);
        const w1 = item(955), w2 = item(955);
        const weightedWorld = world([w1, w2], () => new Promise(resolve => { finish = resolve; }));
        assert.equal(pick(weightedWorld, weighted, w1), true);
        assert.equal(pick(weightedWorld, weighted, w2), false, 'pending awards reserve weight too');
        finish(); await Promise.resolve();

        for (const [race, expansion, slots] of [[4, 0, 100], [0, 1, 86], [4, 2, 112]]) {
            const expanded = session(filled(slots - 1), race, 1000000, expansion);
            const one = item(955), two = item(955);
            const expandedWorld = world([one, two], () => new Promise(resolve => { finish = resolve; }));
            assert.equal(pick(expandedWorld, expanded, one), true, 'respect dwarf/Expand Inventory capacity');
            assert.equal(pick(expandedWorld, expanded, two), false);
            finish(); await Promise.resolve();
        }

        const leader = session(filled(79)), member = session(filled(80));
        const coins = item(57, 40), partyWorld = world([coins]);
        Party.adenaAllocations = () => [{ session: leader, amount: 20 }, { session: member, amount: 20 }];
        assert.equal(pick(partyWorld, leader, coins), false, 'a full recipient retains the entire party drop');
        assert.equal(partyWorld.awards.length, 0);
        Party.adenaAllocations = () => [{ session: leader, amount: 40 }];
        assert.equal(pick(partyWorld, leader, coins), true, 'rejected party allocation releases earlier reservations');
        Party.resolveLootSession = () => member;
        const assigned = item(955), assignedWorld = world([assigned]);
        assert.equal(pick(assignedWorld, session([]), assigned), false, 'check the actual party loot recipient');
        Party.resolveLootSession = source => source;

        // Real award queue and SQLite: the accepted 80th item must survive a
        // reopen, while the rejected 81st item remains available on the ground.
        await Native.character(Database, 9601, 'Capacity', 'capacity_test');
        for (let index = 0; index < 79; index++) await Database.setItem(9601, { selfId: 955, amount: 1 });
        const persisted = session([]);
        persisted.actor.backpack = new Backpack({ id: 9601, items: await Database.fetchItems(9601), paperdoll: {} });
        const awards = [];
        const accepted = item(955), rejected = item(955);
        const actualWorld = world([accepted, rejected], (...args) => {
            const result = Purchase(...args); awards.push(result); return result;
        });
        assert.equal(pick(actualWorld, persisted, accepted), true);
        assert.equal(pick(actualWorld, persisted, rejected), false);
        await Promise.all(awards);
        assert.equal(persisted.actor.backpack.fetchItems().length, 80);
        assert.equal((await Database.fetchItems(9601)).length, 80);
        assert.deepEqual(actualWorld.items.spawns, [rejected]);
        await Database.close(); await Database.init();
        assert.equal((await Database.fetchItems(9601)).length, 80);
        console.log('Pickup capacity: slots, stack weight, pending awards, dwarf/skill limits, party recipients and SQLite reopen passed');
    } finally {
        Response.userInfo = original.userInfo;
        Party.adenaAllocations = original.allocations;
        Party.resolveLootSession = original.recipient;
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

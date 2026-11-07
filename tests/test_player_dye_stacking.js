'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('player-dye-stacking');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const World = invoke('GameServer/World/World');
const Pickup = invoke('GameServer/World/Generics/PickupItem');
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const Deposit = invoke('GameServer/Network/Request/WarehouseDeposit');
const Withdraw = invoke('GameServer/Network/Request/WarehouseWithdraw');
const Response = invoke('GameServer/Network/Response');
const Native = require('./helpers/nativeMarketFixture');

async function player(id, account) {
    return { accountId: account, activeNpcTalk: { objectId: 7005001, selfId: 7005 },
        actor: { fetchId: () => id, fetchLocX: () => 0, fetchLocY: () => 0,
            fetchRace: () => 0, fetchMaxLoad: () => 1000000,
            backpack: new Backpack({ id, items: await Database.fetchItems(id), paperdoll: {} }) },
        sent: [], dataSendToMe(packet) { this.sent.push(packet); }, dataSendToMeAndOthers() {} };
}
function transferPacket(items, amount) {
    const packet = Buffer.alloc(5 + items.length * 8);
    packet.writeInt32LE(items.length, 1);
    items.forEach((item, index) => {
        packet.writeInt32LE(item.fetchId(), 5 + index * 8);
        packet.writeInt32LE(amount, 9 + index * 8);
    });
    return packet;
}
function assertInventory(session, expected) {
    const items = session.actor.backpack.fetchItems();
    const packet = Response.itemsList(items);
    assert.equal(packet.readUInt16LE(3), expected.size, 'one native inventory row per dye type');
    for (let index = 0; index < expected.size; index++) {
        const offset = 5 + index * 28;
        const id = packet.readUInt32LE(offset + 6);
        assert.equal(packet.readUInt32LE(offset + 10), expected.get(id));
        assert.equal(items.filter(item => item.fetchSelfId() === id).length, 1);
    }
}

(async () => {
    await Database.init(); Data.init();
    const original = { npc: World.npc, userInfo: Response.userInfo };
    Response.userInfo = () => Buffer.from([4]);
    World.npc = { spawns: [{ fetchId: () => 7005001, fetchSelfId: () => 7005,
        fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 }] };
    try {
        const dyes = Data.items.filter(item => item.template?.kind === 'Other.Tattoo');
        assert.equal(dyes.length, 180);
        assert(dyes.every(item => item.etc.stackable === true), 'all ordinary and greater dyes must stack');
        for (const selfId of [729, 730, 951, 952, 955, 956, 6575, 6576]) {
            assert.equal(Data.items.find(item => item.selfId === selfId).etc.stackable, false,
                'C4 enchant scrolls keep their existing non-stackable policy');
        }
        await Native.character(Database, 9621, 'DyePlayer', 'dye_player');
        let session = await player(9621, 'dye_player');
        const selected = [4469, 4553, 4589, 4601], awards = [];
        const world = { items: { spawns: [] }, purchaseItem(...args) {
            const pending = Purchase(...args); awards.push(pending); return pending;
        } };
        let objectId = 7001000;
        // Burst pickups must merge into one physical object even before the
        // first insert resolves; exercise ordinary and greater dye templates.
        for (const selfId of selected) for (const amount of [1, 2, 30]) {
            const template = Data.items.find(item => item.selfId === selfId);
            const drop = new Item(++objectId, { ...utils.crushOb(template), amount });
            world.items.spawns.push(drop);
            assert.equal(Pickup.call(world, session, session.actor, drop), true);
        }
        await Promise.all(awards);
        assert.equal(world.items.spawns.length, 0);
        assertInventory(session, new Map(selected.map(id => [id, 33])));
        const saved = await Database.fetchItems(9621);
        assert.equal(saved.length, 4);
        assert(saved.every(row => row.amount === 33));

        // Use real native requests, rather than only the transfer SQL helper.
        session.activeWarehouse = { type: 'personal', mode: 'deposit' };
        await Deposit(session, transferPacket(session.actor.backpack.fetchItems(), 20));
        assertInventory(session, new Map(selected.map(id => [id, 13])));
        const stored = await Warehouse.list(session);
        assert.equal(stored.length, 4);
        assert(stored.every(item => item.fetchAmount() === 20));
        const offers = Response.wareHouseWithdrawalList(stored, 0);
        assert.equal(offers.readUInt16LE(7), 4);
        session.activeWarehouse.mode = 'withdraw';
        await Withdraw(session, transferPacket(stored, 15));
        assertInventory(session, new Map(selected.map(id => [id, 28])));
        assert((await Warehouse.list(session)).every(item => item.fetchAmount() === 5));
        await Database.close(); await Database.init();
        session = await player(9621, 'dye_player');
        assertInventory(session, new Map(selected.map(id => [id, 28])));
        assert((await Warehouse.list(session)).every(item => item.fetchAmount() === 5));

        await Native.character(Database, 9622, 'LegacyDyes', 'legacy_dyes');
        for (let index = 0; index < 5; index++) await Database.setItem(9622, { selfId: 4601, amount: 1 });
        for (let index = 0; index < 2; index++) await Database.setItem(9622, { selfId: 955, amount: 1 });
        const legacy = await player(9622, 'legacy_dyes');
        assert.equal(legacy.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 4601).length, 5,
            'changing a template alone does not merge distinct persisted object IDs');
        const compacted = await Database.compactStackableInventory(dyes.map(item => item.selfId), 'compact-stackable-inventory-v3');
        assert.equal(compacted.rowsRemoved, 4);
        const repaired = await player(9622, 'legacy_dyes');
        const dyeItems = repaired.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 4601);
        assert.equal(dyeItems.length, 1);
        assert.equal(dyeItems[0].fetchAmount(), 5, 'startup repair preserves every old dye');
        assert.equal(repaired.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 955).length, 2,
            'startup dye repair keeps separate enchant scroll objects');
        assert.equal((await Database.compactStackableInventory(dyes.map(item => item.selfId), 'compact-stackable-inventory-v3')).skipped, true);
        console.log('Player dyes: burst pickup -> one physical/native inventory stack -> bulk warehouse transfer -> reopen; legacy copies merge without changing scrolls');
    } finally {
        World.npc = original.npc; Response.userInfo = original.userInfo;
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

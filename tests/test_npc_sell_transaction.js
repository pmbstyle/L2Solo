'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('npc-sale-transaction');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Sell = invoke('GameServer/Network/Request/Sell');
const Purchase = invoke('GameServer/World/Generics/PurchaseItem');
const Rules = invoke('GameServer/Items/NpcSellRules');
const InventoryLimits = invoke('GameServer/Inventory/InventoryLimits');
const Response = invoke('GameServer/Network/Response');
const Native = require('./helpers/nativeMarketFixture');

function packet(lines) {
    const buffer = Buffer.alloc(9 + 12 * lines.length);
    buffer.writeInt32LE(lines.length, 5);
    lines.forEach((line, index) => {
        buffer.writeInt32LE(line.objectId, 9 + index * 12);
        buffer.writeInt32LE(line.selfId, 13 + index * 12);
        buffer.writeInt32LE(line.amount, 17 + index * 12);
    });
    return buffer;
}
let nextId = 9800;
async function session(stock, adena = 100) {
    const id = ++nextId;
    await Native.character(Database, id, `Sale${id}`, `sale_${id}`);
    if (adena) await Database.setItem(id, { selfId: 57, name: 'Adena', amount: adena });
    for (const [selfId, amount] of stock) await Database.setItem(id, { selfId, amount });
    const backpack = new Backpack({ id, items: await Database.fetchItems(id), paperdoll: {} });
    const result = { actor: { fetchId: () => id, backpack }, packets: [], dataSendToMe(data) { this.packets.push(data); } };
    result.activeNpcSellShop = { items: new Map(Rules.rows(result.actor).map(row =>
        [row.item.fetchId(), { selfId: row.item.fetchSelfId(), price: row.price }])) };
    return result;
}
function lines(session, selfId, amount = 1) {
    return session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === selfId)
        .map(item => ({ objectId: item.fetchId(), selfId, amount }));
}
const rows = session => Database.fetchItems(session.actor.fetchId());
const balance = session => session.actor.backpack.fetchTotalAdena();

(async () => {
    await Database.init();
    Data.init();
    const originalUserInfo = Response.userInfo;
    const originalWarn = utils.infoWarn;
    const warnings = [];
    Response.userInfo = () => Buffer.from([4]);
    utils.infoWarn = (prefix, ...args) => {
        if (prefix === 'Sell') warnings.push(require('node:util').format(...args));
        else originalWarn(prefix, ...args);
    };
    try {
        const bulk = await session(Array.from({ length: 30 }, () => [955, 1]));
        const all = lines(bulk, 955);
        const price = Rules.npcBuyPrice(bulk.actor.backpack.fetchItemFromSelfId(955).fetchPrice());
        await Promise.all([Sell(bulk, packet(all)), Sell(bulk, packet(all.slice(0, 1)))]);
        assert.equal(balance(bulk), 100 + 30 * price, 'overlapping requests pay for exactly 30 scrolls');
        assert.equal(Native.amount(await rows(bulk), 955), 0);
        assert.equal(Native.amount(await rows(bulk), 57), balance(bulk), 'durable and live payouts agree');
        await Sell(bulk, packet(all));
        assert.equal(balance(bulk), 100 + 30 * price, 'replaying sold object IDs never pays again');

        for (const [race, expansion, count] of [[0, 4, 101], [0, 8, 128], [4, 8, 148]]) {
            const expanded = await session(Array.from({ length: count }, () => [955, 1]), 0);
            expanded.actor.fetchRace = () => race;
            expanded.actor.skillset = { fetchSkill: id => id === 1372 ? { fetchLevel: () => expansion } : null };
            assert(count <= InventoryLimits.forActor(expanded.actor), 'fixture fits the expanded inventory');
            const selected = lines(expanded, 955);
            const offers = Response.sellList(Rules.rows(expanded.actor), 0);
            assert.equal(offers.readUInt16LE(9), count, 'every selected item is offered by the native shop');
            await Sell(expanded, packet(selected));
            assert.equal(Native.amount(await rows(expanded), 955), 0, `${count} sale rows must all be consumed`);
            assert.equal(balance(expanded), count * price, `${count} sale rows pay exactly once`);
            assert.equal(Native.amount(await rows(expanded), 57), count * price);
            assert(!expanded.packets.some(packet => packet[0] === 0x25), 'a valid expanded sale must not fail');
            await Sell(expanded, packet(selected));
            assert.equal(balance(expanded), count * price, 'expanded sale replay cannot pay again');
        }

        const partial = await session([[1539, 12]]);
        await Sell(partial, packet(lines(partial, 1539, 5)));
        assert.equal(partial.actor.backpack.fetchItemFromSelfId(1539).fetchAmount(), 7);
        const partialPrice = Rules.npcBuyPrice(partial.actor.backpack.fetchItemFromSelfId(1539).fetchPrice());
        assert.equal(balance(partial), 100 + 5 * partialPrice);
        await Promise.all([Sell(partial, packet(lines(partial, 1539, 2))), Purchase(partial, 57, 40)]);
        assert.equal(balance(partial), 140 + 7 * partialPrice, 'pickup credit cannot overwrite a sale payout');
        assert.equal(Native.amount(await rows(partial), 1539), 5);
        assert.equal(Native.amount(await rows(partial), 57), balance(partial));

        const duplicate = await session([[955, 1], [955, 1]]);
        const selected = lines(duplicate, 955);
        await Sell(duplicate, packet([selected[0], selected[0], selected[1]]));
        assert.equal(Native.amount(await rows(duplicate), 955), 2, 'duplicate IDs reject the whole batch');
        assert.equal(balance(duplicate), 100);

        const retired = await session([[955, 1]]);
        const originalSale = Database.sellItemsToNpc;
        let entered, release;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        Database.sellItemsToNpc = async (...args) => { entered(); await gate; return originalSale(...args); };
        const actor = retired.actor;
        try {
            const pending = Sell(retired, packet(lines(retired, 955)));
            await waiting;
            retired.actor = null;
            release(); await pending;
        } finally { Database.sellItemsToNpc = originalSale; retired.actor = actor; }
        assert.equal(Native.amount(await rows(retired), 955), 1, 'retired actor cannot complete a pending sale');
        assert.equal(balance(retired), 100);
        assert.deepEqual(warnings, [], 'replays, duplicate IDs and retired actors are normal sale refusals');

        // The live backpack can be stale after another physical transfer. A
        // missing later source must not consume the earlier source or pay out.
        await Database.deleteItem(duplicate.actor.fetchId(), selected[1].objectId);
        await Sell(duplicate, packet(selected));
        assert.equal(Native.amount(await rows(duplicate), 955), 1);
        assert.equal(duplicate.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 955).length, 2);
        assert.equal(balance(duplicate), 100);
        assert.match(warnings.shift(), /npc_sale_item_changed/, 'unexpected durable inventory drift must remain visible');

        const rollback = await session([[955, 1], [955, 1]]);
        await Database.execute([`CREATE TEMP TRIGGER fail_npc_payout BEFORE UPDATE ON items
            WHEN OLD.selfId = 57 BEGIN SELECT RAISE(ABORT, 'test payout failure'); END`]);
        await Sell(rollback, packet(lines(rollback, 955)));
        assert.equal(Native.amount(await rows(rollback), 955), 2, 'failed payout rolls back source deletes');
        assert.equal(Native.amount(await rows(rollback), 57), 100);
        assert.equal(rollback.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 955).length, 2);
        assert.equal(balance(rollback), 100, 'failed transaction never publishes to the live wallet');
        assert.match(warnings.shift(), /test payout failure/, 'persistence failures must still be logged');
        await Database.execute(['DROP TRIGGER fail_npc_payout']);

        const emptyWallet = await session([[955, 1], [955, 1]], 0);
        const disjoint = lines(emptyWallet, 955);
        await Promise.all(disjoint.map(line => Sell(emptyWallet, packet([line]))));
        assert.equal(balance(emptyWallet), price * 2);
        assert.equal((await rows(emptyWallet)).filter(row => row.selfId === 57).length, 1, 'one new Adena stack');

        const overflow = await session([[955, 1]], 0x7fffffff - 1);
        await Sell(overflow, packet(lines(overflow, 955)));
        assert.equal(Native.amount(await rows(overflow), 955), 1, 'unrepresentable payout retains the item');
        assert.equal(balance(overflow), 0x7fffffff - 1);
        assert.match(warnings.shift(), /npc_sale_adena_overflow/);
        for (const malformed of [Buffer.alloc(0), Buffer.alloc(8), packet([]), packet(lines(overflow, 955)).subarray(0, 20)]) {
            await Sell(overflow, malformed);
        }
        const enormous = Buffer.alloc(9); enormous.writeInt32LE(0x7fffffff, 5);
        await Sell(overflow, enormous);
        const tooMany = Array.from({ length: InventoryLimits.MAX_CAPACITY + 1 }, (_, index) => ({
            objectId: 100000 + index, selfId: 955, amount: 1, price, expectedAmount: 1
        }));
        overflow.packets.length = 0;
        await Sell(overflow, packet(tooMany));
        assert.deepEqual(overflow.packets.map(packet => packet[0]), [0x25], 'over-limit sale packets remain bounded');
        await assert.rejects(Database.sellItemsToNpc(overflow.actor.fetchId(), tooMany,
            () => { throw Error('oversized transaction must not begin'); }), /invalid_npc_sale/);
        assert.equal(Native.amount(await rows(overflow), 955), 1);
        assert.deepEqual(warnings, [], 'malformed sale requests must not be logged as server failures');

        await Database.close();
        await Database.init();
        assert.equal(Native.amount(await rows(bulk), 57), 100 + 30 * price, 'correct payout survives reopening');
        assert.equal(Native.amount(await rows(rollback), 955), 2, 'rollback survives reopening');
        console.log('NPC sale transaction: expanded inventories, overlap, replay, duplicates, stale rows, rollback, pickup credit and payout bounds passed');
    } finally {
        Response.userInfo = originalUserInfo;
        utils.infoWarn = originalWarn;
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

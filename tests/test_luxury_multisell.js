const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Backpack = invoke('GameServer/Actor/Backpack');
const Response = invoke('GameServer/Network/Response');
const Opcodes = invoke('GameServer/Network/Opcodes');
const Talk = invoke('GameServer/World/Generics/NpcTalk');
const Bypass = invoke('GameServer/World/Generics/NpcTalkResponse');
const Shop = invoke('GameServer/Items/LuxuryShopService');
const Catalog = invoke('GameServer/World/Generics/NpcExchangeShopLists');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-luxury-multisell-'));
options.default.Database.path = path.join(directory, 'test.sqlite');
Response.userInfo = () => Buffer.from([0x04]);

// Product/C-crystal/D-crystal rows from the pinned C4 7097/7098 XML lists.
const source = {
    7097: [[71,573,2865],[72,573,2865],[76,1075,5375],[161,573,2865],[162,1075,5375],
        [192,573,2865],[200,1075,5375],[226,573,2865],[233,1075,5375],[263,573,2865],
        [265,1075,5375],[281,573,2865],[283,1075,5375],[298,573,2865],[95,1075,5375]],
    7098: [[354,127,635],[381,79,395],[60,360,1800],[397,95,475],[2387,59,295],
        [400,207,1035],[420,129,645],[439,95,475],[441,184,920],[471,59,295],
        [472,115,575],[2429,32,160],[64,62,310],[2452,32,160],[608,62,310],[631,34,170],
        [103,65,325],[852,39,195],[854,74,370],[883,26,130],[885,49,245],[915,52,260],[917,99,495]]
};
const npc = selfId => ({ fetchId: () => 100000 + selfId, fetchSelfId: () => selfId,
    fetchName: () => selfId === 7097 ? 'Galladucci' : 'Alexandria', fetchTitle: () => 'Trader',
    fetchLocX: () => 79599, fetchLocY: () => 145522, fetchLocZ: () => -3494 });

function sessionFor(id) {
    const actor = { fetchId: () => id, fetchName: () => `LuxuryTest${id}`, fetchIsOnline: () => true,
        x: 79599, maxLoad: 1000000, fetchLocX: () => actor.x, fetchLocY: () => 145522, fetchLocZ: () => -3494,
        fetchMaxLoad: () => actor.maxLoad, fetchPrivateStoreType: () => 0, isDead: () => false,
        state: { fetchCombats: () => false, fetchHits: () => false, fetchCasts: () => false },
        backpack: new Backpack({ id, items: [], paperdoll: {} }), statusUpdateVitals() { this.loadUpdated = true; } };
    return { actor, packets: [], dataSendToMe(packet) { this.packets.push(packet); } };
}
async function add(session, selfId, amount) {
    const template = Data.items.find(item => item.selfId === selfId);
    const row = await Database.setItem(session.actor.fetchId(), {
        selfId, name: template.template.name, amount, slot: template.etc.slot || 0, equipped: false
    });
    session.actor.backpack.insertItem(Number(row.insertId), selfId, { amount });
}
const count = (session, id) => session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === id).reduce((sum, item) => sum + item.fetchAmount(), 0);
const receipts = session => session.packets.filter(packet => packet[0] === 0x64 && [29,30].includes(packet.readInt32LE(1)));
function choose(listId, entryId, amount) {
    const buffer = Buffer.alloc(13);
    buffer[0] = 0xa7;
    [listId, entryId, amount].forEach((value, index) => buffer.writeInt32LE(value, 1 + index * 4));
    return buffer;
}
function open(session, id) {
    Talk(session, npc(id));
    const html = session.packets.filter(packet => packet[0] === 0x0f).at(-1).subarray(5).toString('utf16le');
    assert.match(html, new RegExp(`bypass -h multisell ${id}`));
    assert.match(html, id === 7097 ? /Buy Weapons/ : /Buy Armor/);
    assert.match(html, new RegExp(`html ${id}-quest`));
    assert.match(html, /sell-shop/);
    assert.doesNotMatch(html, /exchange-shop buy/);
    Bypass(session, { link: `multisell ${id}` });
    assert.equal(session.packets.at(-1)[0], 0x25, 'release the client action after opening');
    return session.packets.at(-2);
}
function checkList(buffer, id) {
    assert.equal(buffer[0], 0xd0);
    assert.deepEqual([1,5,9,13,17].map(offset => buffer.readInt32LE(offset)), [id,1,1,40,source[id].length]);
    let offset = 21;
    source[id].forEach(([product, crystalC, crystalD], index) => {
        assert.equal(buffer.readInt32LE(offset), (index + 1) * 100000);
        assert.equal(buffer[offset + 4], 1);
        assert.equal(buffer.readInt16LE(offset + 5), 1);
        assert.equal(buffer.readInt16LE(offset + 7), 2);
        offset += 9;
        assert.equal(buffer.readInt16LE(offset), product);
        if (id === 7097 && index === 0) {
            assert.equal(buffer.readInt32LE(offset + 2), 0x4000, 'Flamberge is two-handed');
            assert.equal(buffer.readInt16LE(offset + 6), 0, 'weapon type');
        }
        if (id === 7098 && index === 0) {
            assert.equal(buffer.readInt32LE(offset + 2), 0x400, 'Chain Mail Shirt chest slot');
            assert.equal(buffer.readInt16LE(offset + 6), 1, 'armor type');
        }
        if ([852,854,883,885].includes(product)) {
            assert.equal(buffer.readInt32LE(offset + 2), product < 880 ? 0x06 : 0x30,'jewelry template fits either side');
            assert.equal(buffer.readInt16LE(offset + 6),2,'accessory type');
        }
        assert.equal(buffer.readInt32LE(offset + 8), 1);
        assert.equal(buffer.readInt16LE(offset + 12), 0);
        offset += 14;
        for (const [selfId, amount] of [[1459, crystalC], [1458, crystalD]]) {
            assert.equal(buffer.readInt16LE(offset), selfId);
            assert.equal(buffer.readInt16LE(offset + 2), 5, 'crystal type');
            assert.equal(buffer.readInt32LE(offset + 4), amount);
            assert.equal(buffer.readInt16LE(offset + 8), 0);
            offset += 10;
        }
    });
    assert(buffer.subarray(offset).every(byte => byte === 0), 'only packet padding follows the entries');
}

async function run() {
    const seed = new DatabaseSync(options.default.Database.path);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.prepare("INSERT INTO accounts(username, password) VALUES ('luxury_test', 'test')").run();
    for (const id of [1,2,3,4,5,6,7]) seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (?, 'luxury_test', ?, 0, 0, 40, 100, 100, 0, 0, 0, 0, 79599, 145522, -3494)`).run(id, `LuxuryTest${id}`);
    seed.close();
    Database.init(); Data.init();
    World.npc = { spawns: [npc(7097), npc(7098)] };
    const buyer = sessionFor(1), foreign = sessionFor(2);
    for (const id of [7097,7098]) {
        assert.deepEqual(Catalog.fetchForNpc(id).map(row => [row.result.selfId, ...row.required.map(item => item.amount)]), source[id]);
        checkList(open(buyer, id), id);
    }
    open(buyer, 7097);
    await add(buyer, 1459, 3000); await add(buyer, 1458, 16000); await add(buyer, 57, 12345);
    await add(foreign, 1459, 9999); await add(foreign, 1458, 9999);
    const foreignRows = await Database.fetchItems(2);
    await Opcodes.table[0xa7](buyer, choose(7097, 400000, 2));
    assert.equal(count(buyer, 161), 2, 'native packet buys two Silver Axes');
    assert.equal(buyer.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 161).length, 2, 'separate equipment instances');
    assert.equal(count(buyer, 1459), 1854); assert.equal(count(buyer, 1458), 10270);
    assert.equal(count(buyer, 57), 12345); assert(buyer.actor.loadUpdated);
    assert(buyer.packets.some(packet => packet[0] === 0x1b), 'inventory update reaches the client');
    assert.deepEqual(receipts(buyer), [Response.consoleText(29, [{kind:3,value:161},{kind:1,value:2}])],
        'a multi-item exchange sends the normal pickup message with the received quantity');
    const before = await Database.fetchItems(1);
    for (const [listId, entryId, amount] of [[7098,100000,1],[7097,4,1],[7097,400001,1],
        [7097,1600000,1],[7097,400000,0],[7097,400000,-1],[7097,400000,5001]]) {
        await Opcodes.table[0xa7](buyer, choose(listId,entryId,amount));
        assert.deepEqual(await Database.fetchItems(1), before, 'invalid selections spend nothing');
    }
    await Opcodes.table[0xa7](buyer, Buffer.from([0xa7]));
    Bypass(buyer, { link: 'exchange-shop buy 3' });
    assert.deepEqual(await Database.fetchItems(1), before, 'old HTML purchase cannot bypass native validation');
    buyer.actor.x += 1000;
    await assert.rejects(Shop.exchange(buyer,7097,400000,1), /unavailable/);
    buyer.actor.x -= 1000;
    buyer.actor.maxLoad = 1;
    await Opcodes.table[0xa7](buyer,choose(7097,400000,1));
    assert.equal(buyer.packets.at(-2).readInt32LE(1),422);
    buyer.actor.maxLoad = 1000000;
    await Opcodes.table[0xa7](buyer,choose(7097,500000,3));
    assert.equal(buyer.packets.at(-2).readInt32LE(1),351, 'insufficient crystals use the C4 message');
    assert.deepEqual(await Database.fetchItems(1), before);
    await Database.execute([`CREATE TEMP TRIGGER fail_luxury_product BEFORE INSERT ON items WHEN NEW.selfId=161
        BEGIN SELECT RAISE(ABORT,'luxury product failure'); END`]);
    await assert.rejects(Shop.exchange(buyer,7097,400000,1), /luxury product failure/);
    assert.deepEqual(await Database.fetchItems(1), before, 'failed product insert rolls back both crystal costs');
    assert.equal(count(buyer,1459),1854); assert.equal(count(buyer,1458),10270);
    assert.equal(receipts(buyer).length,1,'rejected and rolled-back exchanges never announce receipt');
    await Database.execute(['DROP TRIGGER fail_luxury_product']);
    const concurrent = await Promise.allSettled([Shop.exchange(buyer,7097,400000,1),Shop.exchange(buyer,7097,400000,1)]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length,1, 'only one pending exchange');
    assert.equal(count(buyer,161),3); assert.equal(count(buyer,1459),1281); assert.equal(count(buyer,1458),7405);
    assert.equal(receipts(buyer).length,2,'a concurrent rejected request emits no duplicate receipt');
    assert.deepEqual(receipts(buyer).at(-1),Response.consoleText(30,[{kind:3,value:161}]),
        'one item uses the same pickup message as ground loot');
    open(buyer,7098);
    await Opcodes.table[0xa7](buyer,choose(7098,1300000,1));
    assert.equal(count(buyer,64),1); assert.equal(count(buyer,568),0,'source boots ID is preserved');
    assert.equal(count(buyer,1459),1219); assert.equal(count(buyer,1458),7095);
    assert.deepEqual(receipts(buyer).at(-1),Response.consoleText(30,[{kind:3,value:64}]),
        'Alexandria announces her exchanged armor too');
    const unchanged = await Database.fetchItems(1);
    Bypass(buyer,{link:'multisell 7097'});
    assert.equal(buyer.activeMultiSell,null,'cannot open the other merchant list');
    await assert.rejects(Shop.exchange(buyer,7098,1300000,1),/selection/);
    open(buyer,7098);
    Bypass(buyer,{link:'sell-shop'});
    assert.equal(buyer.activeMultiSell,null,'selling cancels the multisell capability');
    open(buyer,7098);
    Database.registerCharacterWriteFlush(async () => { buyer.actor.x += 1000; });
    await assert.rejects(Shop.exchange(buyer,7098,1300000,1),/unavailable/,'range is rechecked after the persistence queue');
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    buyer.actor.x -= 1000;
    assert.deepEqual(await Database.fetchItems(1),unchanged);
    assert.deepEqual(await Database.fetchItems(2),foreignRows,'other owners keep their crystals');
    const empty = sessionFor(3);
    open(empty,7097);
    await assert.rejects(Shop.exchange(empty,7097,400000,1),/missing_materials/,'another owner cannot fund an exchange');
    await add(empty,1459,300); await add(empty,1459,273);
    await add(empty,1458,2000); await add(empty,1458,865);
    await Opcodes.table[0xa7](empty,choose(7097,400000,1));
    assert.equal(count(empty,161),1,'ingredients can span several inventory rows');
    assert.equal(count(empty,1459),0); assert.equal(count(empty,1458),0,'exhausted crystal rows are removed');
    assert.equal((await Database.fetchItems(3)).length,1);
    const crowded = sessionFor(4);
    open(crowded,7097);
    await add(crowded,1459,573); await add(crowded,1458,2865);
    for (let i = 0; i < 78; i++) await add(crowded,17,1);
    assert.equal(crowded.actor.backpack.fetchItems().length,80);
    await Shop.exchange(crowded,7097,400000,1);
    assert.equal(crowded.actor.backpack.fetchItems().length,79,'two exhausted crystal stacks free slots before the new weapon');
    assert.equal((await Database.fetchItems(4)).length,79,'physical inventory uses the same final slot count');
    assert.equal(count(crowded,161),1); assert.equal(count(crowded,1459),0); assert.equal(count(crowded,1458),0);
    const split = sessionFor(6);
    open(split,7097);
    await add(split,1459,300); await add(split,1459,273);
    await add(split,1458,2000); await add(split,1458,865);
    for (let i = 0; i < 76; i++) await add(split,17,1);
    await Shop.exchange(split,7097,400000,1);
    assert.equal(split.actor.backpack.fetchItems().length,77,'all four fully consumed rows free inventory slots');
    assert.equal((await Database.fetchItems(6)).length,77);
    const mixed = sessionFor(7);
    await add(mixed,1459,573); await add(mixed,1458,2866);
    for (let i = 0; i < 78; i++) await add(mixed,17,1);
    const direct = await Database.exchangeLuxuryItems(7,{listId:7097,entryId:400000,amount:1});
    assert.equal(direct.products.length,1,'the native transaction also works without a UI validation callback');
    const mixedItems = await Database.fetchItems(7);
    assert.equal(mixedItems.length,80,'only the exhausted C-crystal stack frees a slot');
    assert.equal(mixedItems.find(item => item.selfId===1458).amount,1,'a partial crystal stack still occupies its slot');
    await add(empty,1459,1146); await add(empty,1458,5730);
    for (let i = 0; i < 77; i++) await add(empty,17,1);
    await Shop.exchange(empty,7097,400000,2);
    assert.equal(count(empty,161),3,'two freed stacks can fund two outputs at the normal capacity');
    assert.equal((await Database.fetchItems(3)).length,80);
    assert.deepEqual(receipts(empty).at(-1),Response.consoleText(29,[{kind:3,value:161},{kind:1,value:2}]),
        'receipt reports the two new items even when another copy is already owned');
    const dwarf = sessionFor(5);
    open(dwarf,7097);
    await add(dwarf,1459,1147); await add(dwarf,1458,5731);
    for (let i = 0; i < 78; i++) await add(dwarf,17,1);
    const fullBefore = await Database.fetchItems(5);
    await assert.rejects(Shop.exchange(dwarf,7097,400000,2),/inventory_full/,'partial stacks free no slots in the live backpack');
    await assert.rejects(Database.exchangeLuxuryItems(5,{listId:7097,entryId:400000,amount:2}),/inventory_full/,
        'the native transaction independently rejects final inventory overflow');
    assert.deepEqual(await Database.fetchItems(5),fullBefore,'overflow spends no crystals');
    assert.equal(dwarf.actor.backpack.fetchItems().length,80);
    dwarf.actor.fetchRace = () => 4;
    await Database.execute(['UPDATE characters SET race=4 WHERE id=5']);
    await Shop.exchange(dwarf,7097,400000,2);
    assert.equal(count(dwarf,161),2,'dwarven inventory capacity also applies in the transaction');
    assert.equal((await Database.fetchItems(5)).length,82);
    assert.deepEqual(receipts(dwarf).at(-1),Response.consoleText(29,[{kind:3,value:161},{kind:1,value:2}]),
        'dwarven exchange reports the received quantity');
    const dwarfItems = await Database.fetchItems(5);
    for (const flag of ['activeTrade','activeEnchantItem','botTrade']) {
        buyer[flag] = {};
        await assert.rejects(Shop.exchange(buyer,7098,1300000,1),/unavailable/);
        delete buyer[flag];
    }
    Talk(buyer,npc(7097));
    assert.equal(buyer.activeMultiSell,null,'a new NPC conversation invalidates the old list');
    await Database.close(); Database.init();
    assert.deepEqual(await Database.fetchItems(1),unchanged,'native purchases survive SQLite reopen');
    assert.deepEqual(await Database.fetchItems(5),dwarfItems);
    console.log('PASS luxury multisell: 38 C4 entries, native packet route, quantities, exact crystal costs, guards, atomic rollback and SQLite reopen');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    await Database.close(); fs.rmSync(directory,{recursive:true,force:true});
});

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
const Item = invoke('GameServer/Item/Item');
const Npc = invoke('GameServer/Npc/Npc');
const Service = invoke('GameServer/Items/CrystallizationStationService');
const Station = invoke('GameServer/World/GiranCrystallizationStation');
const Talk = invoke('GameServer/World/Generics/NpcTalk');
const Bypass = invoke('GameServer/World/Generics/NpcBypasses/CrystallizationStation');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const ConsoleText = invoke('GameServer/ConsoleText');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-crystallization-station-'));
const file = path.join(directory, 'test.sqlite');
options.default.Database.path = file;
const template = id => Data.items.find(item => item.selfId === id);
const html = session => session.packets.filter(p => p[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
const npc = { fetchId: () => 987654, fetchSelfId: () => Station.npcId,
    fetchName: () => 'Crystallization Station', fetchTitle: () => 'Service Fee: 15%',
    fetchLocX: () => Station.loc.locX, fetchLocY: () => Station.loc.locY, fetchLocZ: () => Station.loc.locZ };

function sessionFor(id) {
    const actor = { fetchId: () => id, fetchName: () => `StationTest${id}`, fetchIsOnline: () => true,
        fetchLocX: () => actor.x, fetchLocY: () => Station.loc.locY, fetchLocZ: () => Station.loc.locZ,
        x: Station.loc.locX, fetchPrivateStoreType: () => 0, isDead: () => false,
        state: { fetchCombats: () => false, fetchHits: () => false, fetchCasts: () => false },
        backpack: new Backpack({ items: [], paperdoll: {} }), statusUpdateVitals() { this.loadUpdated = true; } };
    return { actor, packets: [], activeNpcTalk: { selfId: Station.npcId, objectId: npc.fetchId() },
        dataSendToMe(packet) { this.packets.push(packet); } };
}

async function add(session, selfId, amount = 1, enchant = 0) {
    const data = template(selfId);
    const result = await Database.setItem(session.actor.fetchId(), {
        selfId, name: data.template.name, amount, enchant, slot: data.etc.slot || 0
    });
    session.actor.backpack.insertItem(Number(result.insertId), selfId, { amount, enchant });
    return session.actor.backpack.fetchItemRaw(Number(result.insertId));
}

async function run() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('station_test','test')");
    for (let id = 1; id <= 2; id++) seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,'station_test',?,0,0,40,500,250,0,0,0,0,?,?,?)`)
        .run(id, `StationTest${id}`, Station.loc.locX, Station.loc.locY, Station.loc.locZ);
    seed.close();
    Database.init(); Data.init();
    const a = sessionFor(1), b = sessionFor(2);
    World.npc = { spawns: [npc] }; World.user = { sessions: [a, b] };
    assert.equal(Data.npcs.filter(n => n.selfId === Station.npcId).length, 1);
    const spawns = Data.npcSpawns.flatMap(group => group.spawns).filter(n => n.selfId === Station.npcId);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].coords, [{ ...Station.loc, head: 37264 }]);
    assert.equal(spawns[0].bias, 0);
    const stationActor = new Npc(123456, utils.crushOb(Station.npcs[0]));
    assert.equal(stationActor.fetchDispSelfId(), 1008126, 'the custom service uses a real C4 client model');
    assert.equal(stationActor.fetchAttackable(), false);

    // Published C4 bonuses: D weapon +4 adds 450, C armor +4 adds 36.
    const synthetic = data => new Item(1, { amount: 1, equipped: false, ...data });
    assert.deepEqual(Service.quote(synthetic({ kind: 'Weapon.Sword', rank: 'd', cristals: 100, enchant: 4 })),
        { crystalId: 1458, crystalName: template(1458).template.name, gross: 550, fee: 83, net: 467 });
    assert.equal(Service.quote(synthetic({ kind: 'Armor.Jewel', rank: 'c', cristals: 100, enchant: 4 })).gross, 136);
    for (const [grade, crystalId] of [['d',1458], ['c',1459], ['b',1460], ['a',1461], ['s',1462]]) {
        const quote = Service.quote(synthetic({ kind: 'Armor.Chain', rank: grade, cristals: 100 }));
        assert.equal(quote.crystalId, crystalId);
        assert.equal(quote.fee, 15); assert.equal(quote.net, 85);
    }
    for (const data of [
        { kind: 'Weapon.Sword', rank: 'none', cristals: 100 },
        { kind: 'Other.Material', rank: 'd', cristals: 100 },
        { kind: 'Armor.Chain', rank: 'd', cristals: 0 },
        { kind: 'Armor.Chain', rank: 'd', cristals: 100, equipped: true },
        { kind: 'Armor.Chain', rank: 'd', cristals: 100, amount: 2 }
    ]) assert.equal(Service.quote(synthetic(data)), null);

    const boots = await add(a, 40), adena = await add(a, 57, 12345);
    const worn = await add(a, 45), noGrade = await add(a, 1);
    worn.setEquipped(true); await Database.updateItemEquipState(1, worn.fetchId(), true, worn.fetchSlot());
    const foreign = await add(b, 40);

    // Opening the NPC dialog can run inside an arrival timer. Ordinary service
    // refusals must stay inside the interaction handler instead of crashing it.
    const beforeRejectedTalk = await Database.fetchItems(1);
    for (const [reason, block, restore] of [
        ['combat', () => { a.actor.state.fetchCombats = () => true; }, () => { a.actor.state.fetchCombats = () => false; }],
        ['casting', () => { a.actor.state.fetchCasts = () => true; }, () => { a.actor.state.fetchCasts = () => false; }],
        ['trade', () => { a.activeTrade = {}; }, () => { delete a.activeTrade; }],
        ['enchanting', () => { a.activeEnchantItem = {}; }, () => { delete a.activeEnchantItem; }],
        ['distance', () => { a.actor.x += 1000; }, () => { a.actor.x = Station.loc.locX; }]
    ]) {
        Service.preview(a, boots.fetchId());
        const beforePackets = a.packets.length;
        block();
        try {
            let opening;
            assert.doesNotThrow(() => { opening = Talk(a, npc); }, `${reason}: opening the station must not escape the timer callback`);
            await assert.doesNotReject(() => Promise.resolve(opening), `${reason}: the dialog must not leave an unhandled rejection`);
            assert.equal(a.activeCrystallization, null, `${reason}: a rejected reopening clears the old confirmation`);
            assert.match(html(a), /outside combat, trade or enchanting/, `${reason}: explain how to retry`);
            assert(a.packets.slice(beforePackets).some(packet => packet.equals(invoke('GameServer/Network/Response').actionFailed())));
        } finally { restore(); }
    }
    assert.deepEqual(await Database.fetchItems(1), beforeRejectedTalk, 'rejected dialogs do not change items or crystal stacks');
    Talk(a, npc);
    assert.match(html(a), /crystallization-station preview/);
    assert.match(html(a), /15%/);
    assert(!html(a).includes(`preview ${worn.fetchId()}"`));
    assert(!html(a).includes(`preview ${noGrade.fetchId()}"`));
    assert.throws(() => Service.preview(a, foreign.fetchId()), /eligible/);
    const token = Service.preview(a, boots.fetchId());
    assert.match(html(a), /Crystals: 38/);
    assert.match(html(a), /rounded up\): 6/);
    assert.match(html(a), /You receive: 32/);
    assert((await Database.fetchItems(1)).some(row => row.id === boots.fetchId()), 'preview does not consume anything');
    await assert.rejects(Service.crystallize(a, 'forged-token'), /again/);
    const attempts = await Promise.allSettled([Service.crystallize(a, token), Service.crystallize(a, token)]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(a.actor.backpack.fetchItemRaw(boots.fetchId()), undefined);
    assert.equal(a.actor.backpack.fetchItemFromSelfId(1458).fetchAmount(), 32);
    const pickupMessages = () => a.packets.filter(packet => packet[0] === 0x64);
    const pickup = pickupMessages()[0];
    assert.equal(pickupMessages().length, 1, 'one successful crystallization sends one loot message');
    assert.deepEqual(pickup, invoke('GameServer/Network/Response').consoleText(ConsoleText.caption.pickupAmountOf, [
        { kind: ConsoleText.kind.item, value: 1458 }, { kind: ConsoleText.kind.number, value: 32 }
    ]), 'use the normal loot packet with the reward after the fee');
    assert(a.actor.loadUpdated, 'crystallization refreshes client inventory load');
    await assert.rejects(Service.crystallize(a, token), /again/);
    assert.equal(pickupMessages().length, 1, 'rejected retries do not announce a reward');
    assert.equal(adena.fetchAmount(), 12345, 'the fee is paid only in output crystals');

    // A buffered crystal-stack amount is flushed before atomically adding the reward.
    const crystals = a.actor.backpack.fetchItemFromSelfId(1458);
    crystals.setAmount(50); WriteQueue.itemAmount(1, crystals.fetchId(), 50);
    const second = await add(a, 40);
    await Bypass(a, ['crystallization-station', 'preview', String(second.fetchId())]);
    await Bypass(a, ['crystallization-station', 'apply', a.activeCrystallization.token]);
    assert.match(html(a), /Received 32/);
    assert.equal(crystals.fetchAmount(), 82);
    assert.deepEqual(pickupMessages().at(-1), pickup, 'announce 32 newly received crystals rather than the stack total of 82');
    assert.equal((await Database.fetchItems(1)).find(row => row.id === crystals.fetchId()).amount, 82);

    const change = await add(a, 40);
    let changedToken = Service.preview(a, change.fetchId());
    change.setEquipped(true);
    await assert.rejects(Service.crystallize(a, changedToken), /changed/);
    change.setEquipped(false);
    changedToken = Service.preview(a, change.fetchId());
    await Database.updateItemEquipState(1, change.fetchId(), true, change.fetchSlot());
    await assert.rejects(Service.crystallize(a, changedToken), /source changed/);
    await Database.updateItemEquipState(1, change.fetchId(), false, change.fetchSlot());
    changedToken = Service.preview(a, change.fetchId());
    await Database.updateItemEnchantLevel(1, change.fetchId(), 1);
    await assert.rejects(Service.crystallize(a, changedToken), /source changed/);
    change.setEnchantLevel(1);

    // Leaving the NPC during an asynchronous persistence flush must keep the source.
    changedToken = Service.preview(a, change.fetchId());
    Database.registerCharacterWriteFlush(async () => { a.actor.x += 1000; });
    try { await assert.rejects(Service.crystallize(a, changedToken), /nearby/); }
    finally { Database.registerCharacterWriteFlush(WriteQueue.flushCharacter); a.actor.x = Station.loc.locX; }
    assert((await Database.fetchItems(1)).some(row => row.id === change.fetchId()));
    changedToken = Service.preview(a, change.fetchId());
    a.activeCrystallization.expiresAt = Date.now() - 1;
    await assert.rejects(Service.crystallize(a, changedToken), /again/);
    changedToken = Service.preview(a, change.fetchId());
    Talk(a, npc);
    await assert.rejects(Service.crystallize(a, changedToken), /again/);
    for (const key of ['activeTrade', 'botTrade', 'activeEnchantItem']) {
        a[key] = {}; assert.throws(() => Service.preview(a, change.fetchId()), /nearby/); delete a[key];
    }
    a.actor.state.fetchCombats = () => true;
    assert.throws(() => Service.preview(a, change.fetchId()), /nearby/);
    a.actor.state.fetchCombats = () => false;
    a.actor.isDead = () => true;
    assert.throws(() => Service.preview(a, change.fetchId()), /nearby/);
    a.actor.isDead = () => false;

    // SQLite rejects malformed outputs without deleting the item.
    for (const crystalAmount of [0, -1, 1.5, Infinity]) await assert.rejects(Database.crystallizeInventoryItem(1, {
        sourceId: change.fetchId(), sourceSelfId: 40, crystalId: 1458, crystalAmount
    }), /invalid crystal amount/);
    await assert.rejects(Database.crystallizeInventoryItem(2, {
        sourceId: change.fetchId(), sourceSelfId: 40, crystalId: 1458, crystalAmount: 1
    }), /source changed/);
    assert((await Database.fetchItems(1)).some(row => row.id === change.fetchId()));

    // Create and persist an enchanted reward in a previously absent grade stack.
    const cTemplate = Data.items.find(item => item.etc?.rank === 'c' && item.etc.cristals > 0 && item.template.kind.startsWith('Weapon.'));
    const enchanted = await add(a, cTemplate.selfId, 1, 7);
    const expected = Number(cTemplate.etc.cristals) + 45 * 11;
    const reward = Service.quote(enchanted);
    assert.equal(reward.gross, expected);
    await Service.crystallize(a, Service.preview(a, enchanted.fetchId()));
    assert.equal(a.actor.backpack.fetchItemFromSelfId(1459).fetchAmount(), expected - Math.ceil(expected * 15 / 100));
    for (let i = 0; i < 7; i++) await add(a, 40);
    Service.menu(a);
    assert.match(html(a), /Next/);
    Service.menu(a, 1);
    assert.match(html(a), /Previous/);
    assert(html(a).length < 8192);
    const beforeClose = await Database.fetchItems(1);
    await Database.close(); Database.init();
    assert.deepEqual(await Database.fetchItems(1), beforeClose, 'items and crystals survive SQLite reopen');
    assert.equal((await Database.fetchItems(1)).find(row => row.selfId === 57).amount, 12345);
    assert((await Database.fetchItems(2)).some(row => row.id === foreign.fetchId()), 'other owners keep their items');
    console.log('Crystallization station: C4 enchanted yields, 15% fee, menus, replay/range/equip/ownership guards, atomic stacks and SQLite reopen passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
});

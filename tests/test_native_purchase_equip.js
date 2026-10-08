'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('native-purchase-equip');
require('../src/Global'); fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Native = require('./helpers/nativeMarketFixture');
invoke('GameServer/DataCache').init();
async function owner(id) {
    await Native.character(Database, id, `Equip${id}`, `bot_equip_${id}`);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 5000 });
    return Life.upsertState({ characterId: id, accountName: `bot_equip_${id}`, phase: 'cold', activity: 'shopping', level: 40,
        adena: 5000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        currentRegion: 'Gludio', loc: { locX: -14900, locY: 123000, locZ: -3100 }, timing: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { classId: 0, money: [36000, 0, 0, 0],
            equipmentPlan: { status: 'active', target: { selfId: 45, slot: 6, name: 'Bone Helmet' } } } }, 'native_equip_fixture');
}
const details = (command, autoEquip = true) => ({ selfId: 45, name: 'Bone Helmet', amount: 1, unitPrice: 1000,
    stackable: false, slot: 6, autoEquip, economyCommand: command });
async function run() {
    await Database.init();
    let state = await owner(9301);
    let admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    let result;
    try { result = await Database.purchaseNpcInventoryItem(9301, details(admitted.command, false)); }
    finally { Commit.finish(9301, admitted.command); }
    assert.equal((await Database.fetchItems(9301)).find(row => row.selfId === 45).equipped, 0);
    const replay = await Database.purchaseNpcInventoryItem(9301, details(admitted.command, true));
    assert(replay.replayed); assert.equal((await Database.fetchItems(9301)).find(row => row.selfId === 45).equipped, 0, 'replay cannot run a different auto-equip policy');
    assert.equal(Native.amount(await Database.fetchItems(9301), 57), 4000);
    state = Commit.acceptRow(result.coldLifeRow);
    admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    try { result = await Database.purchaseNpcInventoryItem(9301, details(admitted.command)); }
    finally { Commit.finish(9301, admitted.command); }
    const physical = await Database.fetchItems(9301), accepted = Commit.acceptRow(result.coldLifeRow);
    assert.equal(Native.amount(physical, 45), 2); assert.equal(physical.filter(row => row.selfId === 45 && row.equipped).length, 1);
    assert.equal(accepted.inventory[45].equippedCount, 1); assert.equal(accepted.stats.equipmentPlan, undefined);
    assert.equal(accepted.stats.equipment.find(row => row.selfId === 45).slot, 6);
    state = await owner(9302); admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    await Database.execute(["CREATE TEMP TRIGGER refuse_equip BEFORE UPDATE OF equipped ON items WHEN NEW.characterId=9302 BEGIN SELECT RAISE(ABORT,'equip rollback'); END"]);
    try { await assert.rejects(Database.purchaseNpcInventoryItem(9302, details(admitted.command)), /equip rollback/); }
    finally { Commit.finish(9302, admitted.command); }
    assert.equal(Native.amount(await Database.fetchItems(9302), 57), 5000);
    assert.equal(Native.amount(await Database.fetchItems(9302), 45), 0, 'failed equip rolls back the purchased item as well as the payment');
    await Database.execute(['DROP TRIGGER refuse_equip']);
    const retry = await Database.purchaseNpcInventoryItem(9302, details(admitted.command));
    assert(retry.ok); assert.equal(Native.amount(await Database.fetchItems(9302), 57), 4000);
    const again = await Database.purchaseNpcInventoryItem(9302, details(admitted.command));
    assert(again.replayed); assert.equal(Native.amount(await Database.fetchItems(9302), 45), 1);
    console.log('Native cold gear: actual flags/slots and plan, explicit hold, rollback, retry and replay passed');
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });

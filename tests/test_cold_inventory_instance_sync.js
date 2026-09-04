const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Summary = invoke('GameServer/Bot/Population/InventorySummary');

async function main() {
    DataCache.init();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-instances-'));
    const databasePath = path.join(directory, 'test.sqlite');
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec(`INSERT INTO accounts(username,password) VALUES ('bot_instances','test');
        INSERT INTO clans(id,name,level,leaderId) VALUES (71,'InstancesClan',1,21);
        INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (21,'bot_instances','InstanceProbe',50,3,31,500,500,0,0,0,0,0,0,0,71);
        INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,inventorySummary,statsJson,updatedAt)
        VALUES (21,'bot_instances','InstanceProbe',31,'hunting','cold','{}','{"classId":50,"role":"buffer"}',1);
        INSERT INTO items(id,characterId,selfId,name,amount,enchant,equipped,slot)
        VALUES (101,21,881,'Elven Ring',1,6,1,4);
        INSERT INTO clan_warehouse_items(id,clanId,selfId,name,kind,amount,enchant)
        VALUES (201,71,879,'Enchanted Ring','Armor.Jewel',1,0);`);
    seed.close();
    options.default.Database.path = databasePath;
    Database.init();
    await LifeState.init();
    const execute = (sql, params = []) => Database.execute([sql, params]);
    const rings = async () => (await Database.fetchItems(21)).filter((item) => item.selfId === 881);
    try {
        const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(21));
        inventory['57'] = { selfId: 57, name: 'Adena', amount: 1000000, stackable: true };
        let state = await LifeState.upsertState({ ...(await LifeState.findByCharacterId(21)), inventory, adena: 1000000 }, 'instance_test_seed');
        const purchased = await LifeState.applyMarketPurchase(state, { selfId: 881, price: 62300, sourceType: 'npc' }, 1);
        assert(purchased, 'a second ring purchase must succeed');
        assert.strictEqual(purchased.inventory['881'].amount, 2);
        assert.strictEqual(purchased.inventory['881'].instances.length, 2, 'purchase must add an instance as well as increase amount');
        let rows = await rings();
        assert.strictEqual(rows.length, 2, 'both paid-for rings must materialize');
        assert.deepStrictEqual(rows.map((row) => row.enchant).sort(), [0, 6], 'new ring must not inherit +6');
        assert.deepStrictEqual(rows.map((row) => row.slot).sort(), [4, 5]);
        const ids = rows.map((row) => row.id).sort();
        await Database.syncInventorySummary(21, purchased.inventory);
        await Database.syncInventorySummary(21, purchased.inventory);
        assert.deepStrictEqual((await rings()).map((row) => row.id).sort(), ids, 'pending instance IDs must not churn physical objects');

        // Recreate an existing incomplete snapshot: count=2, one instance and
        // one physical ring, while the cold paperdoll claims both slots.
        await execute('DELETE FROM items WHERE characterId = 21 AND selfId = 881 AND id != 101');
        const broken = structuredClone(purchased.inventory);
        broken['881'].instances = [broken['881'].instances.find((instance) => instance.id === 101)];
        await execute('UPDATE bot_life_state SET inventorySummary = ?, activity = ? WHERE characterId = 21', [JSON.stringify(broken), 'hunting']);
        const request = { clanId: 71, characterId: 21, warehouseId: 201, expectedPhase: 'cold' };
        const refused = await Database.exchangeClanWarehouseEquipment(request);
        assert.strictEqual(refused.code, 'inventory_not_materialized', 'warehouse must not fill a phantom empty slot');
        assert.strictEqual((await Database.fetchClanWarehouseItems(71)).length, 1);
        assert.strictEqual((await execute('SELECT * FROM clan_warehouse_ledger')).length, 0, 'guard must not return/withdraw anything');

        state = { ...purchased, activity: 'hunting', inventory: broken };
        const refreshed = await LifeState.refreshInventory(state, { equip: true });
        assert.strictEqual(refreshed.inventory['881'].instances.length, 2, 'normal refresh must heal an older incomplete snapshot');
        assert.strictEqual((await rings()).length, 2);
        await LifeState.upsertState(refreshed, 'instance_refresh');
        assert.strictEqual((await Database.exchangeClanWarehouseEquipment(request)).code, 'not_an_upgrade');

        // An identity captured before another sync must reuse its corresponding
        // unclaimed row, preserving enchant, rather than insert/delete forever.
        const staleIds = structuredClone(refreshed.inventory);
        staleIds['881'].instances[1].id = 999999;
        const beforeStale = (await rings()).map((row) => row.id).sort();
        await Database.syncInventorySummary(21, staleIds);
        await Database.syncInventorySummary(21, staleIds);
        assert.deepStrictEqual((await rings()).map((row) => row.id).sort(), beforeStale);

        await execute(`INSERT INTO clan_warehouse_items(id,clanId,selfId,name,kind,amount,enchant)
            VALUES (202,71,881,'Elven Ring','Armor.Jewel',1,3)`);
        const exchanged = await LifeState.applyClanWarehouseExchange({ ...request, warehouseId: 202 });
        assert(exchanged.ok, JSON.stringify(exchanged));
        assert.deepStrictEqual(exchanged.returned.map((row) => row.enchant), [0], 'exchange must return the weaker real copy');
        const afterExchange = await LifeState.refreshInventory(exchanged.state, { equip: true });
        const afterSale = await LifeState.applyNpcLiquidation(afterExchange, [{ selfId: 881, count: 2, npcPrice: 100 }]);
        assert.strictEqual(afterSale.adena, afterExchange.adena, 'received/worn rings must not become NPC sale surplus');
        rows = await rings();
        assert.deepStrictEqual(rows.map((row) => row.enchant).sort(), [3, 6]);
        assert.deepStrictEqual(rows.map((row) => row.slot).sort(), [4, 5]);
        const returned = (await Database.fetchClanWarehouseItems(71)).filter((row) => row.selfId === 881);
        assert.deepStrictEqual(returned.map((row) => row.enchant), [0]);

        // Selling surplus must retain the equipped identity even if listed last.
        const sold = { selfId: 881, amount: 1, equippedSlots: [5], instances: [
            { id: 777, amount: 1, enchant: 0, equipped: false, slot: 0 },
            { id: 101, amount: 1, enchant: 6, equipped: true, slot: 5 }
        ] };
        const retained = Summary.completeInstances(sold);
        assert.deepStrictEqual(retained.instances.map((instance) => [instance.id, instance.enchant, instance.slot]), [[101, 6, 5]]);
        assert.strictEqual(sold.instances.length, 2, 'normalization must not mutate the input');
        const grown = Planner.equipInventoryUpgrades(state, broken);
        assert.strictEqual(grown['881'].instances.length, 2, 'cold optimizer must complete instances before physical persistence');
        assert.deepStrictEqual(grown['881'].instances.map((instance) => instance.enchant).sort(), [0, 6]);
        console.log('Cold inventory instance synchronization checks passed');
    } finally {
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

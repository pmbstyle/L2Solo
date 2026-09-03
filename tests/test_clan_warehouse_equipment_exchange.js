const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ClanService = invoke('GameServer/Clan/ClanService');
const Warehouse = invoke('GameServer/Warehouse/ClanWarehouse');
const Exchange = invoke('GameServer/Clan/ClanWarehouseEquipmentService');
const Policy = invoke('GameServer/Clan/ClanWarehouseEquipmentPolicy');
const Manager = invoke('GameServer/Bot/BotManager');
const Backpack = invoke('GameServer/Model/Backpack');
const World = invoke('GameServer/World/World');

async function main() {
    DataCache.init();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-gear-exchange-'));
    const databasePath = path.join(directory, 'test.sqlite');
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec(`INSERT INTO accounts(username,password) VALUES ('player','test'),('bot_gear','test');
        INSERT INTO clans(id,name,level,leaderId) VALUES (71,'ExchangeClan',1,11),(72,'OtherClan',1,24);`);
    for (const [id, classId, clanId, account] of [[11,4,71,'player'], [21,10,71,'bot_gear'], [22,4,71,'bot_gear'], [24,4,72,'bot_gear']]) {
        seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
            VALUES (?,?,?, ?,0,20,500,250,0,0,0,0,0,0,0,?)`).run(id, account, `Gear${id}`, classId, clanId);
        if (account !== 'player') seed.prepare(`INSERT INTO bot_life_state
            (characterId,accountName,characterName,level,activity,phase,inventorySummary,statsJson,updatedAt)
            VALUES (?,? ,?,20,'hunting','cold','{}',?,1)`).run(id, account, `Gear${id}`, JSON.stringify({ classId, coldCombat: { charges: 2 } }));
    }
    seed.close();
    options.default.Database.path = databasePath;
    Database.init();
    await LifeState.init();
    await ClanService.init();
    const sword = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Weapon.Sword' && item.etc?.slot === 7);
    assert(sword);
    const swordId = Number(sword.selfId);
    const execute = (sql, params = []) => Database.execute([sql, params]);
    const insert = async (id, owner, enchant, equipped = 0, selfId = swordId, slot = 7) => {
        await execute('INSERT INTO items(id,characterId,selfId,name,amount,enchant,equipped,slot) VALUES (?,?,?, ?,1,?,?,?)',
            [id, owner, selfId, 'Exchange gear', enchant, equipped, equipped ? slot : 0]);
    };
    const player = {
        fetchId: () => 11, fetchClanId: () => 71, fetchClanPrivileges: () => 2047,
        fetchLocX: () => 0, fetchLocY: () => 0,
        backpack: { items: [], fetchItems() { return this.items; } }
    };
    World.npc = { spawns: [{ fetchId: () => 900, fetchSelfId: () => 30001,
        fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 }] };
    const session = { actor: player, activeNpcTalk: { objectId: 900, selfId: 30001, title: 'Warehouse Keeper' },
        activeWarehouse: { type: 'clan', clanId: 71, mode: 'deposit' } };
    async function deposit(id, enchant) {
        await insert(id, 11, enchant);
        player.backpack.items.push(Policy.materialize({ id, selfId: swordId, amount: 1, enchant, equipped: false }));
        await Warehouse.deposit(session, [{ objectId: id, amount: 1 }]);
    }
    const originals = [];
    function stub(object, name, replacement) {
        const original = object[name];
        originals.push(() => { object[name] = original; });
        object[name] = replacement;
    }
    try {
        await insert(101, 22, 0, 1);
        await deposit(102, 3);
        let equipped = await execute('SELECT * FROM items WHERE characterId = 22 AND equipped = 1');
        assert.strictEqual(equipped.length, 1);
        assert.strictEqual(equipped[0].enchant, 3, 'native player deposit must immediately exchange a cold clan member');
        let stock = await Database.fetchClanWarehouseItems(71);
        assert.strictEqual(stock.length, 1);
        assert.strictEqual(stock[0].enchant, 0, 'the replaced item must return to the clan warehouse');
        assert.strictEqual((await execute('SELECT * FROM items WHERE characterId IN (21,24)')).length, 0,
            'incompatible mage and foreign-clan bot must not receive the sword');
        let cached = await LifeState.findByCharacterId(22);
        assert.strictEqual(cached.inventory[swordId].amount, 1);
        assert.strictEqual(cached.stats.equipment[0].enchant, 3);
        assert.strictEqual(cached.stats.coldCombat.charges, 2, 'exchange must preserve combat state');
        const firstLedger = await execute('SELECT * FROM clan_warehouse_ledger WHERE characterId = 22');
        assert.deepStrictEqual(firstLedger.map((row) => row.operation).sort(), ['deposit', 'withdraw']);
        assert.strictEqual((await Exchange.resolveClan(71)).exchanged, 0, 'equal or weaker stock must not churn');

        await execute("UPDATE bot_life_state SET phase = 'hot' WHERE characterId = 22");
        const backpack = new Backpack(Array.from({ length: 16 }, () => ({})));
        backpack.items = equipped.map((row) => Policy.materialize(row));
        backpack.equipPaperdoll(7, equipped[0].id, swordId);
        let hitting = true;
        let statRefreshes = 0;
        let appearances = 0;
        const actor = { backpack, fetchId: () => 22, fetchClanId: () => 71, fetchLevel: () => 20, fetchClassId: () => 4,
            fetchName: () => 'Gear22', isDead: () => false, state: { fetchHits: () => hitting, fetchCasts: () => false } };
        const botSession = { actor, accountId: 'bot_gear', dataSendToMe() {}, dataSendToOthers() { appearances++; } };
        Manager.sessions.push(botSession);
        stub(invoke(global.path.actor), 'calculateStats', () => { statRefreshes++; });
        stub(invoke('GameServer/Skills/ToggleSkills'), 'syncEquipment', () => {});
        stub(invoke('GameServer/Network/Response'), 'itemsList', () => Buffer.alloc(0));
        stub(invoke('GameServer/Network/Response'), 'charInfo', () => Buffer.alloc(0));
        stub(invoke('GameServer/Inventory/ShotStock'), 'ensureActorStock', () => Promise.resolve());
        stub(invoke('GameServer/Inventory/ShotStock'), 'enableAutoShot', () => {});
        await deposit(103, 6);
        assert.strictEqual(backpack.fetchEquippedWeapon().fetchEnchantLevel(), 3, 'an active swing must defer the exchange');
        hitting = false;
        await Exchange.resolveBatch(Date.now() + 2000);
        assert.strictEqual(backpack.fetchEquippedWeapon().fetchEnchantLevel(), 6);
        assert.strictEqual(backpack.items.length, 1, 'live backpack must remove the old object');
        assert.strictEqual(statRefreshes, 1);
        assert.strictEqual(appearances, 1);
        stock = await Database.fetchClanWarehouseItems(71);
        assert.deepStrictEqual(stock.map((row) => row.enchant).sort(), [0,3]);
        equipped = await execute('SELECT * FROM items WHERE characterId = 22 AND equipped = 1');
        assert.strictEqual(equipped[0].id, backpack.fetchEquippedWeapon().fetchId());

        await execute("UPDATE bot_life_state SET phase = 'cold' WHERE characterId = 22");
        Manager.sessions = Manager.sessions.filter((entry) => entry !== botSession);
        await execute(`INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,enchant,reservedAmount)
            VALUES (71,?,'Reserved','Weapon.Sword',1,9,1)`, [swordId]);
        const reserved = (await Database.fetchClanWarehouseItems(71)).find((row) => row.enchant === 9);
        assert.strictEqual((await Database.exchangeClanWarehouseEquipment({ clanId:71, characterId:22, warehouseId:reserved.id, expectedPhase:'cold' })).ok, false);
        await execute('UPDATE clan_warehouse_items SET reservedAmount = 0 WHERE id = ?', [reserved.id]);
        await execute(`CREATE TRIGGER fail_exchange BEFORE INSERT ON items WHEN NEW.characterId = 22 AND NEW.enchant = 9
            BEGIN SELECT RAISE(ABORT, 'exchange rollback probe'); END`);
        await assert.rejects(Database.exchangeClanWarehouseEquipment({ clanId:71, characterId:22, warehouseId:reserved.id, expectedPhase:'cold' }), /rollback probe/);
        assert.strictEqual((await execute('SELECT enchant FROM items WHERE characterId = 22 AND equipped = 1'))[0].enchant, 6);
        assert((await Database.fetchClanWarehouseItems(71)).some((row) => row.id === reserved.id));
        assert(!(await Database.fetchClanWarehouseItems(71)).some((row) => row.enchant === 6), 'rollback must undo the return too');
        await execute('DROP TRIGGER fail_exchange');
        const request = { clanId:71, characterId:22, warehouseId:reserved.id, expectedPhase:'cold' };
        const staleState = await LifeState.findByCharacterId(22);
        const race = await Promise.all([LifeState.applyClanWarehouseExchange(request), LifeState.applyClanWarehouseExchange(request)]);
        assert.strictEqual(race.filter((result) => result.ok).length, 1, 'one warehouse object may be consumed only once');
        assert.strictEqual((await execute('SELECT enchant FROM items WHERE characterId = 22 AND equipped = 1'))[0].enchant, 9);
        assert.strictEqual((await LifeState.findByCharacterId(22)).inventory[swordId].amount, 1, 'same-ID swaps must not duplicate summary counts');
        assert.strictEqual(await LifeState.upsertState(staleState, 'stale_exchange_probe'), null,
            'a delayed legacy save must not resurrect the returned equipment');

        cached = await LifeState.findByCharacterId(22);
        cached = await LifeState.upsertState({ ...cached, activity: 'grouped', party: { partyId: 'exchange-party' } }, 'test_group');
        const owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
        const lease = await owner.claim(cached, { allowParty: true, allowLifecycle: true });
        assert(lease.ok, JSON.stringify(lease));
        await deposit(104, 12);
        const afterWorkerExchange = await LifeState.findByCharacterId(22);
        assert.strictEqual(afterWorkerExchange.stats.equipment[0].enchant, 12, 'a worker-owned party member must also exchange gear');
        assert.strictEqual(afterWorkerExchange.party.partyId, 'exchange-party', 'exchange must preserve party membership');
        assert.strictEqual((await owner.commit(lease, cached, { allowParty: true, allowLifecycle: true })).ok, false,
            'a pre-exchange worker proposal cannot restore the returned item');

        // Use small explicit equipment templates to cover layout decisions.
        const originalItems = DataCache.items;
        const fixture = (selfId, kind, slot, pDef, mDef = 0) => ({ selfId,
            template: { name: `Gear fixture ${selfId}`, kind, price: 100 },
            etc: { slot, rank: 'd', stackable: false }, stats: { pDef, mDef } });
        DataCache.items = [...originalItems,
            fixture(990001, 'Armor.Chain', 10, 40), fixture(990002, 'Armor.Chain', 11, 30),
            fixture(990003, 'Armor.Chain', 15, 100), fixture(990004, 'Armor.Jewel', 4, 0, 20)];
        try {
            const tank = { level: 20, classId: 4 };
            const row = (id, selfId, slot, enchant = 0) => ({ id, selfId, slot, amount: 1, equipped: true, enchant });
            const full = { id: 1000, selfId: 990003, amount: 1, enchant: 0 };
            const torso = Policy.plan(tank, [row(1,990001,10), row(2,990002,11)], full);
            assert.deepStrictEqual(torso.returned.map((item) => item.id), [1,2]);
            assert.strictEqual(Policy.plan(tank, [row(1,990003,15)], { ...full, selfId:990001 }), null,
                'a lone top must not replace a full-body layout');
            const ring = { id:1001, selfId:990004, amount:1, enchant:3 };
            const jewelry = Policy.plan(tank, [row(3,990004,4,6), row(4,990004,5,0)], ring);
            assert.strictEqual(jewelry.slot, 5);
            assert.deepStrictEqual(jewelry.returned.map((item) => item.id), [4], 'return only the weaker ring');
            assert.strictEqual(Policy.plan({level:19,classId:4}, [], ring), null, 'grade must respect level');
            assert.strictEqual(Policy.plan(tank, [row(3,990004,4,6), row(4,990004,5,6)], ring), null,
                'enchanted equipment must not be replaced with a weaker copy');
        } finally { DataCache.items = originalItems; }
        console.log('Clan warehouse equipment exchange checks passed');
    } finally {
        originals.reverse().forEach((restore) => restore());
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

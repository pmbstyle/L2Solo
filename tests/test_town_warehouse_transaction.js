'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const token = require('node:crypto').randomUUID();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `l2-town-warehouse-${token}-`));
const worldPath = path.join(directory, `${token}-world.sqlite`);
const historyPath = path.join(directory, `${token}-history.sqlite`);
const configPath = path.join(directory, `${token}.ini`);
fs.writeFileSync(configPath, fs.readFileSync(path.resolve(__dirname, '../config/default.ini'), 'utf8')
    .replace(/^path\s*=.*$/m, `path = ${worldPath}\nhistoryPath = ${historyPath}`));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = configPath;
require('../src/Global');
assert.equal(options.default.Database.path, worldPath);
assert.equal(options.default.Database.historyPath, historyPath);
assert(path.isAbsolute(worldPath) && worldPath.includes(token));
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
const STEM = 1864, ids = [719801, 719802, 719803, 719804, 719805, 719806];

async function seed(id, activity = 'shopping', town = true) {
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
    const stock = await Database.execute([
        'INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,?,?,20,0)', [id, STEM, 'Stem']]);
    const state = await Life.upsertState({ characterId: id, accountName: 'quests', name: `TownWarehouse${id}`,
        phase: 'cold', activity, level: 40, adena: 100000, currentRegion: 'Giran',
        loc: town ? { locX: 83396, locY: 147904, locZ: -3400 } : { locX: 120000, locY: 100000, locZ: -3400 },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, timing: {},
        stats: { equipmentPlan: { strategy: 'craft', status: 'active', materials: [{ selfId: STEM, amount: 20 }] } }
    }, 'town_warehouse_fixture');
    assert.equal(Improvement.inTown(state), town);
    return { state, item: { id: Number(stock.insertId), selfId: STEM, name: 'Stem', amount: 20, stackable: true } };
}

async function untouched(id) {
    assert.equal((await Database.fetchWarehouseItems(id))[0].amount, 20);
    const bag = await Database.fetchItems(id);
    assert.equal(bag.filter(row => row.selfId === STEM).length, 0);
    assert.equal(bag.find(row => row.selfId === 57).amount, 100000);
    const [row] = await Database.execute(['SELECT inventorySummary,adena FROM bot_life_state WHERE characterId=?', [id]]);
    assert.equal(Number(JSON.parse(row.inventorySummary)[STEM]?.amount || 0), 0);
    assert.equal(row.adena, 100000);
}

async function run() {
    Data.init();
    const seedDb = new DatabaseSync(worldPath);
    seedDb.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seedDb.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    const insert = seedDb.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests',?,0,0,40,0,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`);
    for (const id of ids) insert.run(id, `TownWarehouse${id}`);
    seedDb.close();
    await Database.init();
    await Life.init();
    try {
        for (const [id, activity] of [[ids[0], 'shopping'], [ids[1], 'merchant']]) {
            const { state } = await seed(id, activity);
            const released = await Warehouse.releaseCold(state, { inTown: true });
            assert.equal(released.released, true, `${activity} releases its actual reserved stock in town`);
            assert.equal(released.items.reduce((n, row) => n + row.amount, 0), 20);
            assert.equal((await Database.fetchWarehouseItems(id)).length, 0);
            const bag = await Database.fetchItems(id);
            assert.equal(bag.find(row => row.selfId === STEM).amount, 20);
            assert.equal(bag.find(row => row.selfId === 57).amount, 100000);
            assert.equal(Life.cachedState(id).inventory[STEM].amount, 20);
            assert.equal(Life.cachedState(id).adena, 100000);
        }
        const field = await seed(ids[2], 'shopping', false);
        assert.equal((await Warehouse.releaseCold(field.state)).released, false, 'field activity does not imply town access');
        assert.equal((await Warehouse.releaseCold(field.state, { inTown: true })).released, false,
            'a caller flag cannot grant warehouse access at a field location');
        await untouched(ids[2]);

        const queued = await seed(ids[3]);
        let reached, resume;
        const captured = new Promise(resolve => { reached = resolve; });
        const gate = new Promise(resolve => { resume = resolve; });
        Database.registerCharacterWriteFlush(async id => { if (id === ids[3]) { reached(); await gate; } });
        const withdrawal = Warehouse.releaseCold(queued.state, { inTown: true });
        await captured;
        // Native legacy movement writes can preserve simulationRevision. The
        // original town intent must therefore also compare its location.
        await Database.execute(['UPDATE bot_life_state SET locX=120000,locY=100000 WHERE characterId=?', [ids[3]]]);
        resume();
        const moved = await withdrawal;
        Database.registerCharacterWriteFlush(null);
        assert.equal(moved.released, false, 'a queued transfer cannot reuse town access after movement');
        assert.equal(moved.reason, 'economy_state_changed');
        await untouched(ids[3]);

        const rollback = await seed(ids[4]);
        await Database.execute([`CREATE TRIGGER fail_town_warehouse_projection BEFORE UPDATE OF inventorySummary ON bot_life_state
            WHEN NEW.characterId=${ids[4]} BEGIN SELECT RAISE(ABORT,'town_warehouse_rollback'); END`]);
        await assert.rejects(Warehouse.releaseCold(rollback.state, { inTown: true }), /town_warehouse_rollback/);
        await untouched(ids[4]);
        await Database.execute(['DROP TRIGGER fail_town_warehouse_projection']);

        const guarded = await seed(ids[5]);
        const transfer = (state = guarded.state, inTown = true) => Database.transferWarehouseToInventory(ids[5], guarded.item, { coldState: state, inTown });
        await assert.rejects(transfer(guarded.state, false), /economy_state_changed/, 'a cold transfer needs explicit captured town access');
        await Database.execute(['UPDATE items SET amount=90000 WHERE characterId=? AND selfId=57', [ids[5]]]);
        await assert.rejects(transfer(), /economy_state_changed/, 'the physical wallet must still match the captured and saved wallet');
        await Database.execute(['UPDATE items SET amount=100000 WHERE characterId=? AND selfId=57', [ids[5]]]);
        await untouched(ids[5]);
        const wrongBag = { ...guarded.state, inventory: { ...guarded.state.inventory, [STEM]: { selfId: STEM, amount: 1 } } };
        await assert.rejects(transfer(wrongBag), /economy_state_changed/, 'a stale captured bag cannot consume warehouse stock');
        await untouched(ids[5]);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [ids[5]]]);
        await assert.rejects(transfer(), /economy_state_changed/, 'a newer state revision fences the town intent');
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=? WHERE characterId=?', [guarded.state.simulation.revision, ids[5]]]);
        await Database.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?',
            [JSON.stringify({ equipmentPlan: { ...guarded.state.stats.equipmentPlan, materials: [{ selfId: STEM, amount: 18 }] } }), ids[5]]]);
        await assert.rejects(transfer(), /economy_state_changed/, 'a newer material reservation fences the town intent');
        await Database.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?', [JSON.stringify(guarded.state.stats), ids[5]]]);
        await untouched(ids[5]);
        console.log('PASS native shopping/merchant town withdrawals, field denial, queued movement, wallet/bag/revision/reservation fences and atomic rollback');
    } finally {
        Database.registerCharacterWriteFlush(null);
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

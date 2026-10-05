const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');

async function run() {
    const id = 710081;
    const world = await createWorld([{ id, classId: 0, level: 40 }], 'warehouse-transaction');
    try {
        await Life.init();
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        const state = await Life.upsertState({ characterId: id, accountName: 'quests', name: 'WarehouseFence',
            level: 40, phase: 'cold', activity: 'hunting', adena: 100000, currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, stats: {}, timing: {} });
        const stock = await Database.execute(['INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,?,?,20,0)',
            [id, 1864, 'Stem']]);
        const item = { id: Number(stock.insertId), selfId: 1864, name: 'Stem', amount: 20, stackable: true };
        const withdraw = () => Database.transferWarehouseToInventory(id, item, { coldState: state });
        const untouched = async () => {
            assert.equal((await Database.fetchWarehouseItems(id))[0].amount, 20);
            assert.equal((await Database.fetchItems(id)).filter(row => row.selfId === 1864).length, 0);
            const [row] = await Database.execute(['SELECT inventorySummary,adena FROM bot_life_state WHERE characterId=?', [id]]);
            assert.equal(Number(JSON.parse(row.inventorySummary)[1864]?.amount || 0), 0);
            assert.equal(row.adena, 100000);
        };
        for (const [column, value] of [['simulationOwner', 'cold_simulation_owner'], ['phase', 'hot'],
            ['activity', 'shopping'], ['partyId', 'party-other']]) {
            await Database.execute([`UPDATE bot_life_state SET ${column}=? WHERE characterId=?`, [value, id]]);
            await assert.rejects(withdraw, /economy_state_changed/, `${column} is checked inside the withdrawal transaction`);
            await untouched();
            await Database.execute(['UPDATE bot_life_state SET simulationOwner=?,phase=?,activity=?,partyId=NULL WHERE characterId=?',
                ['legacy_main', 'cold', 'hunting', id]]);
        }
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        await assert.rejects(withdraw, /economy_state_changed/, 'stale revision cannot move warehouse stock');
        await untouched();
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=? WHERE characterId=?', [state.simulation.revision, id]]);
        await Database.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?',
            [JSON.stringify({ equipmentPlan: { strategy: 'craft', status: 'active', materials: [{ selfId: 1864, missing: 18 }] } }), id]]);
        await assert.rejects(withdraw, /economy_state_changed/, 'a newer crafting reservation fences an already prepared withdrawal');
        await untouched();
        await Database.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?', [JSON.stringify(state.stats), id]]);
        await Database.execute([`CREATE TRIGGER fail_warehouse_projection BEFORE UPDATE OF inventorySummary ON bot_life_state
            WHEN NEW.characterId=${id} BEGIN SELECT RAISE(ABORT,'warehouse_projection_probe'); END`, []]);
        await assert.rejects(withdraw, /warehouse_projection_probe/, 'projection failure rolls back the physical transfer too');
        await untouched();
        await Database.execute(['DROP TRIGGER fail_warehouse_projection', []]);
        const result = await withdraw();
        assert(result.coldLifeRow, 'successful withdrawal returns its atomically committed lifecycle row');
        assert.equal(JSON.parse(result.coldLifeRow.inventorySummary)[1864].amount, 20);
        assert.equal(result.coldLifeRow.adena, 100000);
        assert.equal(result.coldLifeRow.simulationRevision, state.simulation.revision + 1);
        assert.equal((await Database.fetchWarehouseItems(id)).length, 0);
        await world.reopen(id);
        const [saved] = await Database.execute(['SELECT inventorySummary,adena FROM bot_life_state WHERE characterId=?', [id]]);
        assert.equal(JSON.parse(saved.inventorySummary)[1864].amount, 20, 'projection survives reopen');
        assert.equal((await Database.fetchItems(id)).find(row => row.selfId === 1864).amount, 20);
        assert.equal(saved.adena, 100000);
        console.log('Warehouse transaction: authoritative owner/reservation fences and atomic physical/projection rollback passed');
    } finally { await world.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

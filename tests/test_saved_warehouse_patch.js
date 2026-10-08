const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-saved-warehouse-patch');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const id = 719111;

async function run() {
    invoke('GameServer/DataCache').init();
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests',?,0,0,60,0,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`).run(id, `Quest${id}`);
    seed.close();
    await Database.init();
    const sale = Market.saleDecision;
    const transfer = Database.transferWarehouseToInventory;
    try {
        await Life.init();
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        let state = await Life.upsertState({ characterId: id, accountName: 'quests', name: 'WithdrawalProbe',
            phase: 'cold', activity: 'hunting', level: 60, adena: 1000000, currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, loadProbe: 'x'.repeat(22000), marketSellRetryAfter: 1791220000000 } }, 'withdrawal_probe');
        for (let i = 0; i < 30; i++) await Database.execute([
            'INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,1864,\'Stem\',1,0)', [id]]);
        await Database.execute(['CREATE TABLE withdrawal_stats_writes(n INTEGER)']);
        await Database.execute([`CREATE TRIGGER withdrawal_stats_write AFTER UPDATE OF statsJson ON bot_life_state
            BEGIN INSERT INTO withdrawal_stats_writes VALUES(1); END`]);
        Market.saleDecision = () => ({ listings: [{ selfId: 1864, count: 30 }], npc: [], answers: [] });
        // Warm the shared spot-value datapack before measuring per-withdrawal work.
        invoke('GameServer/Bot/Economy/ItemDisposition').saleCandidates(state, { unlimited: true });
        const parse = JSON.parse, parsedBytes = [];
        JSON.parse = (text, ...args) => { parsedBytes.push(typeof text === 'string' ? text.length : 0); return parse(text, ...args); };
        let moved;
        assert(invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state), 'withdrawal uses a real town location');
        try { moved = await Warehouse.releaseCold(state, { inTown: true }); }
        finally { JSON.parse = parse; }
        assert(moved.released);
        assert.equal(moved.items.length, 30);
        assert.equal((await Database.fetchWarehouseItems(id)).length, 0);
        assert.equal((await Database.execute(['SELECT COUNT(*) AS n FROM withdrawal_stats_writes']))[0].n, 1, '30 item transfers make one stats patch');
        assert(Math.max(0, ...parsedBytes) < 4000, `whole stats were parsed during withdrawal (${Math.max(...parsedBytes)} bytes)`);
        const [row] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
        const stats = JSON.parse(row.statsJson);
        assert.equal(stats.loadProbe.length, 22000, 'the SQL patch preserves unrelated saved stats');
        assert.equal(stats.marketSellRetryAfter, null);
        assert(stats.lastWarehouseWithdrawal.items.length <= 8);
        assert(Buffer.byteLength(JSON.stringify(stats.lastWarehouseWithdrawal)) <= 120);
        assert(stats.lastWarehouseWithdrawal.items.flat().every(Number.isFinite));
        assert.deepEqual(Life.cachedState(id).stats.lastWarehouseWithdrawal, stats.lastWarehouseWithdrawal);
        const prioritized = Warehouse.withdrawalRecord(Array.from({ length: 20 }, (_, i) => ({ selfId: 1900 + i,
            amount: i + 1, reason: i < 2 ? 'market' : 'craft' })), 123);
        assert.deepEqual(prioritized.items.slice(0, 2), [[1901, 2, 1], [1900, 1, 1]], 'market rows precede large craft rows');
        assert(prioritized.items.length <= 8);
        assert(Buffer.byteLength(JSON.stringify(prioritized)) <= 120);

        state = Life.cachedState(id);
        for (const amount of [3, 4]) await Database.execute([
            'INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,1864,\'Stem\',?,0)', [id, amount]]);
        await Database.execute(['DELETE FROM withdrawal_stats_writes']);
        Market.saleDecision = () => ({ listings: [{ selfId: 1864, count: 37 }], npc: [], answers: [] });
        Database.transferWarehouseToInventory = async (...args) => {
            const result = await transfer(...args);
            const current = Life.acceptInventoryProjection(result.coldLifeRow);
            assert((await Owner.claim(current, { allowLifecycle: true, leaseMs: 30000 })).ok);
            return result;
        };
        assert(invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state));
        const partial = await Warehouse.releaseCold(state, { inTown: true });
        assert(partial.aborted && partial.released);
        assert.equal(partial.items.length, 1);
        assert.equal(partial.state.simulation.ownerId, Owner.OWNER_ID, 'record patch preserves the newer worker owner');
        assert.equal((await Database.execute(['SELECT COUNT(*) AS n FROM withdrawal_stats_writes']))[0].n, 1, 'stopped withdrawal still patches once');
        const [stopped] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
        assert.deepEqual(JSON.parse(stopped.statsJson).lastWarehouseWithdrawal.items, [[1864, 3, 1]]);
        console.log('Saved withdrawal: 30 rows, one small stats patch, no whole-state parse, numeric capped record and partial-handoff preservation passed');
    } finally {
        Market.saleDecision = sale; Database.transferWarehouseToInventory = transfer;
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

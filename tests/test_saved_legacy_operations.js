'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-saved-legacy-operations');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const id = 719114, at = 1791221234567;
const exact = { playedHours: 10.5, wishFocus: ['gear:2', 1234.56789, 100000],
    dormantWishes: [['gear:3', 3, 4, 5, 1234.56789, 6]],
    money: [77000, 1.3e-5, 15000, 0], coldCombat: { clock: 0.12345678912345 } };

async function readStats() {
    const [row] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
    return { stats: JSON.parse(row.statsJson), raw: row.statsJson };
}
async function run() {
    invoke('GameServer/DataCache').init();
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests','LegacyOperations',0,0,60,0,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`).run(id);
    seed.close();
    await Database.init();
    try {
        await Life.init();
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        await Life.upsertState({ characterId: id, accountName: 'quests', name: 'LegacyOperations',
            phase: 'cold', activity: 'hunting', level: 60, adena: 1000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, stats: exact }, 'legacy_operation_seed');
        const legacy = { ...exact,
            lastWarehouseWithdrawal: { at, items: Array.from({ length: 91 }, (_, index) => ({
                selfId: 1864 + index, name: `Legacy material ${index}`, amount: index + 1,
                reason: index < 2 ? 'market' : 'craft' })) },
            lastNpcLiquidation: { at, payout: 2378.2, sold: Array.from({ length: 57 }, (_, index) => ({
                selfId: 2000 + index, amount: index + 1, price: 12.34 })) }
        };
        // Real old SQL state bypasses today's operation writers. An unrelated
        // save must bound it even if this bot never visits the warehouse again.
        await Database.execute(['UPDATE bot_life_state SET statsJson=? WHERE characterId=?', [JSON.stringify(legacy), id]]);
        let [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        const loaded = Life.acceptLifecycleRow(row);
        assert.equal(loaded.stats.lastWarehouseWithdrawal.items.length, 91);
        assert.equal(loaded.stats.lastNpcLiquidation.sold.length, 57);
        await Life.upsertState({ ...loaded, stats: { ...loaded.stats, unrelatedNumber: 42 } }, 'unrelated_operation_save');
        const { stats, raw } = await readStats();
        for (const [record, field] of [[stats.lastWarehouseWithdrawal, 'items'], [stats.lastNpcLiquidation, 'sold']]) {
            assert(record[field].length > 0 && record[field].length <= 8);
            assert(Buffer.byteLength(JSON.stringify(record)) <= 120);
            assert(record[field].every(tuple => tuple.length === 3 && tuple.every(Number.isFinite)));
            assert.equal(record.at, at, 'the old timestamp is not rounded');
        }
        assert.deepEqual(stats.lastWarehouseWithdrawal.items.slice(0, 2), [[1865, 2, 1], [1864, 1, 1]],
            'old market rows retain priority ahead of large craft rows');
        assert.deepEqual(stats.lastNpcLiquidation.sold[0], [2056, 57, 12]);
        assert.equal(stats.lastNpcLiquidation.payout, 2378, 'only Adena payout rounds to whole money');
        for (const [key, value] of Object.entries(exact)) assert.deepEqual(stats[key], value, `${key} stays exact`);
        assert.equal(stats.unrelatedNumber, 42);
        assert(!raw.includes('Legacy material') && !raw.includes('"reason"'));
        assert.equal(Life.cachedState(id).adena, 1000000);
        assert.equal((await Database.fetchItems(id)).find(item => item.selfId === 57).amount, 1000000);
        await Database.close(); await Database.init();
        assert.deepEqual((await readStats()).stats, stats, 'the normalization is durably saved');
        row = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
        const saved = Life.acceptLifecycleRow(row);
        await Life.upsertState({ ...saved, stats: { ...saved.stats, unrelatedNumber: 43 } }, 'second_unrelated_operation_save');
        const again = (await readStats()).stats;
        assert.deepEqual(again.lastWarehouseWithdrawal, stats.lastWarehouseWithdrawal);
        assert.deepEqual(again.lastNpcLiquidation, stats.lastNpcLiquidation);
        for (const [key, value] of Object.entries(exact)) assert.deepEqual(again[key], value);
        console.log('Legacy operations: native 91/57 SQL records normalize on unrelated save, numeric8/120B, priority, exact clocks, durable reopen and idempotence PASS');
    } finally { await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

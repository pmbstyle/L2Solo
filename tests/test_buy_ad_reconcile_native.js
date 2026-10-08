'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('buy-ad-reconcile');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Native = require('./helpers/nativeMarketFixture');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
Config.developerDiagnostics = true; Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '9201';
const config = (selfId, count, price = 10, town = 'Dion') => ({ storeType: 3, town, title: 'Inputs',
    lines: [{ selfId, count, price, name: `Input ${selfId}`, enchant: 0, stackable: true }] });
const records = () => Database.fetchAfkTradeShops(9201);
const wallet = async () => Native.amount(await Database.fetchItems(9201), 57);
const expected = rows => Object.fromEntries(rows.map(row => [row.id, row.revision]));
async function run() {
    Database.init(); Data.init();
    await Native.character(Database, 9201, 'RetainedBuyer', 'bot_retained_buyer');
    await Database.setItem(9201, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Afk.openBotRecords(9201, 'buy_ad', [config(1864, 100)]);
    const [old] = await records();
    const grown = await Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 120)], { expected: expected([old]) });
    const [current] = await records();
    assert.equal(current.id, old.id, 'compatible record retains its native identity');
    assert.equal(current.lines[0].id, old.lines[0].id);
    assert.equal(current.createdAt, old.createdAt);
    assert.equal(current.escrowAdena, 0);
    assert.equal(current.custodyPolicy, 1);
    assert.equal(await wallet(), 10000);
    assert.equal(grown.closed.length, 0);
    assert.equal(grown.retained[0].id, old.id);
    const boardRevision = Afk.boardIndex().itemRevision(1864);
    // An unchanged review must neither touch physical money nor invalidate
    // the market index. SQLite triggers expose even a write of the same value.
    for (const table of ['items', 'afk_trade_lines', 'afk_trade_shops']) {
        await Database.execute([`CREATE TEMP TRIGGER forbid_${table} BEFORE UPDATE ON ${table}
            BEGIN SELECT RAISE(ABORT, 'unchanged review wrote'); END`]);
    }
    try {
        const unchanged = await Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 120)], { expected: expected([current]) });
        assert.equal(unchanged.changed.length, 0);
        assert.equal(unchanged.ownerInventory, null);
        assert.deepEqual(await records(), [current]);
        assert.equal(Afk.boardIndex().itemRevision(1864), boardRevision);
    } finally {
        for (const table of ['items', 'afk_trade_lines', 'afk_trade_shops']) await Database.execute([`DROP TRIGGER forbid_${table}`]);
    }
    await assert.rejects(Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 150)], { expected: expected([old]) }), /shop_changed/);
    assert.equal(await wallet(), 10000);
    const replaced = await Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 80), config(1865, 20)], { expected: expected(await records()) });
    assert.equal(await wallet(), 10000, 'alternative intentions hold no money');
    assert.equal(replaced.retained[0].id, old.id);
    const two = await records();
    await Afk.replaceBotRecords(9201, 'buy_ad', [config(1865, 20), config(1864, 80)], { expected: expected(two) });
    assert.deepEqual(await records(), two, 'input ordering is not record identity');
    // A changed plan may reduce the actual remaining count after a native fill.
    await Native.character(Database, 9202, 'RetainedSeller', 'player_retained_seller');
    const stock = await Database.setItem(9202, { selfId: 1864, name: 'Stem', amount: 30, stackable: true });
    const ad = (await records()).find(row => row.lines[0].selfId === 1864);
    await assert.rejects(Database.sellToAfkTradeShop(9202, { shopId: ad.id, ownerId: 9201, lineId: ad.lines[0].id,
        objectId: Number(stock.insertId), selfId: 1864, amount: 30, expectedPrice: 10, expectedRevision: ad.revision }), /trade_meeting_required/);
    const filled = (await records()).find(row => row.id === ad.id);
    assert.equal(filled.lines[0].count, 80, 'an unaccepted response cannot fill an intention');
    await Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 40)], { expected: expected(await records()) });
    const [rest] = await records();
    assert.equal(rest.id, old.id);
    assert.equal(rest.lines[0].fills, filled.lines[0].fills, 'native fill cursor survives reconciliation');
    assert.equal(rest.escrowAdena, 0);
    assert.equal(await wallet(), 10000, 'resizing an intention neither debits nor refunds');
    const before = await records();
    await assert.rejects(Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 100000)], { expected: expected(before) }), /not_enough_adena/);
    assert.deepEqual(await records(), before, 'failed funding is atomic');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    await Life.upsertState({ characterId: 9201, accountName: 'bot_retained_buyer', name: 'RetainedBuyer',
        phase: 'cold', activity: 'hunting', level: 40, adena: await wallet(), currentRegion: 'Dion',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(9201)),
        loc: { locX: 19000, locY: 145000, locZ: -3100 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        stats: {} }, 'missing_native_funding_fixture');
    await assert.rejects(Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 80)], { expected: expected(before) }), /economy_funding_missing/);
    assert.deepEqual(await records(), before, 'unknown native funding cannot grow reservations');
    await Life.upsertState({ characterId: 9201, accountName: 'bot_retained_buyer', name: 'RetainedBuyer',
        phase: 'cold', activity: 'hunting', level: 40, adena: await wallet(), currentRegion: 'Dion',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(9201)),
        loc: { locX: 19000, locY: 145000, locZ: -3100 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        stats: { money: [36000, 0.001, 9000, 0, 0.001, 400, 1864] } }, 'native_funding_fixture');
    await assert.rejects(Afk.replaceBotRecords(9201, 'buy_ad', [config(1864, 120)], { expected: expected(before) }), /economy_funding_changed/);
    assert.deepEqual(await records(), before);
    const metadata = { ...config(1864, 40, 999), title: 'Updated title' };
    const meta = await Afk.replaceBotRecords(9201, 'buy_ad', [metadata], { expected: expected(before) });
    assert.equal(meta.ownerInventory, null, 'metadata does not fence the physical inventory');
    assert.equal(meta.retained[0].lines[0].price, 10, 'opening prices do not overwrite the retained repricing authority');
    assert.equal(await wallet(), 10000);
    console.log('Native retained buy ads: delta, no-op, stale replay, reorder, add/remove, direct-fill refusal and individual funding passed');
}
run().then(async () => {
    await Database.close();
    const rows = fs.readFileSync(require('node:path').join(fixture.directory, 'logs/economy-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const growth = rows.find(row => row.phase === 'buy_ad_reconcile' && row.reason === 'changed');
    assert.equal(growth.reserveDelta, 0); assert(growth.recordId > 0); assert(growth.revision > 0);
    console.log('Conditional ad telemetry records zero custody movement');
}).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });

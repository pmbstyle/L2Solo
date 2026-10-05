// The board's records (step 3.3, group A): a move between a bag and a record
// is one transaction (a failure moves nothing, a replay moves nothing twice);
// per-bot caps refuse a record and leave the item or the money where it was;
// the leave rule closes every record of an owner; a record has no deadline
// and closes by events only (user, 2026-10-05); what the board owes a bot
// survives a restart.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BoardRules = require('../src/GameServer/AfkTrade/BoardRules');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');

const databasePath = path.join(process.cwd(), 'tmp', 'test-board-records.sqlite');
const HOUR = 60 * 60 * 1000;
const MATERIALS = [1864, 1865, 1866, 1867, 1868, 1869];

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

let created = 0;
async function makeBot(items) {
    const account = `bot_records_${++created}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name: `Records${created}`, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    await LifeState.upsertState({
        characterId: id, accountName: account, name: `Records${created}`, level: 40, adena: Number(inventory[57]?.amount || 0),
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran', loc: { locX: 82700, locY: 148600, locZ: -3470 },
        inventory, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true }, timing: {}
    }, 'test_seed');
    return id;
}

async function bag(id) {
    const totals = {};
    for (const row of await Database.fetchItems(id)) totals[row.selfId] = Number(totals[row.selfId] || 0) + Number(row.amount);
    return totals;
}

// Everything an owner holds: its bag, its records (sell lines, escrow) and
// what waits for it on the board.
async function holdings(id) {
    const totals = await bag(id);
    for (const record of await Database.fetchAfkTradeShops(id)) {
        totals[57] = Number(totals[57] || 0) + Number(record.escrowAdena || 0);
        if (Number(record.storeType) !== 1) continue;
        for (const line of record.lines) totals[line.selfId] = Number(totals[line.selfId] || 0) + Number(line.count);
    }
    for (const row of await Database.execute(['SELECT selfId, amount FROM board_settlements WHERE ownerId = ?', [id]])) {
        totals[row.selfId] = Number(totals[row.selfId] || 0) + Number(row.amount);
    }
    return totals;
}

async function rowOf(id, selfId) {
    return (await Database.fetchItems(id)).find((row) => Number(row.selfId) === selfId);
}

const sellAd = async (id, selfId, count = 10, price = 100) => ({
    kind: 'sell_ad', storeType: 1, title: 'ad', town: 'Giran', locX: 0, locY: 0, locZ: 0,
    lines: [{ objectId: Number((await rowOf(id, selfId)).id), selfId, name: `Item ${selfId}`, count, price, stackable: true }]
});
const buyAd = (selfId, count = 1, price = 100, kind = 'buy_ad') => ({
    kind, storeType: 3, title: 'wtb', town: 'Giran', locX: 0, locY: 0, locZ: 0,
    lines: [{ selfId, name: `Item ${selfId}`, count, price, stackable: true }]
});

async function injected(sql, work) {
    await Database.execute([sql]);
    try {
        await assert.rejects(work, /injected/);
    } finally {
        await Database.execute(['DROP TRIGGER IF EXISTS temp.inject_board']);
    }
}

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await AfkTrade.init();

    // A move that fails half way moves nothing: the bag keeps the stems, no
    // record stands.
    const mover = await makeBot([{ selfId: 57, name: 'Adena', amount: 100000 }, ...MATERIALS.map((selfId) => ({ selfId, name: `Item ${selfId}`, amount: 20 }))]);
    const start = await holdings(mover);
    await injected(`CREATE TEMP TRIGGER inject_board BEFORE INSERT ON main.afk_trade_lines
        BEGIN SELECT RAISE(ABORT, 'injected line failure'); END`, async () => AfkTrade.publishBot(mover, await sellAd(mover, 1864)));
    assert.deepStrictEqual(await bag(mover), start, 'a failed sell move leaves the bag whole');
    assert.strictEqual((await Database.fetchAfkTradeShops(mover)).length, 0);
    await injected(`CREATE TEMP TRIGGER inject_board BEFORE INSERT ON main.afk_trade_lines
        BEGIN SELECT RAISE(ABORT, 'injected line failure'); END`, () => AfkTrade.publishBot(mover, buyAd(1870, 2, 500)));
    assert.deepStrictEqual(await bag(mover), start, 'a failed buy move leaves the wallet whole');

    // A move done once; its replay and a second ad for the same item change
    // nothing.
    const opened = await AfkTrade.publishBot(mover, await sellAd(mover, 1864));
    assert.strictEqual(opened.kind, 'sell_ad');
    assert.strictEqual((await bag(mover))[1864], 10, 'the ad holds the stems it sells');
    await assert.rejects(AfkTrade.publishBot(mover, await sellAd(mover, 1864)), /board_ad_exists/);
    const bought = await AfkTrade.replaceBotRecords(mover, 'buy_ad', [buyAd(1870, 2, 500)], { expected: {} });
    assert.strictEqual(bought.opened[0].escrowAdena, 1000);
    await assert.rejects(AfkTrade.replaceBotRecords(mover, 'buy_ad', [buyAd(1870, 2, 500)], { expected: {} }),
        /afk_trade_shop_changed/, 'a replayed move finds the board changed and moves nothing');
    assert.deepStrictEqual(await holdings(mover), start, 'nothing lost or doubled by the moves');
    // A close that fails half way keeps the record and the bag as they were.
    const before = await bag(mover);
    await injected(`CREATE TEMP TRIGGER inject_board BEFORE UPDATE ON main.items WHEN NEW.characterId = ${mover}
        BEGIN SELECT RAISE(ABORT, 'injected bag failure'); END`, () => AfkTrade.closeBotRecord(mover, opened.id, { expectedRevision: opened.revision }));
    assert.deepStrictEqual(await bag(mover), before);
    assert.strictEqual((await Database.fetchAfkTradeShops(mover)).length, 2);

    // Caps: 5 sell ads, 5 buy ads, 1 order, 3 shop lines; over a cap the
    // record is refused and the item or the money stays.
    for (const selfId of MATERIALS.slice(1, 5)) await AfkTrade.publishBot(mover, await sellAd(mover, selfId));
    assert.strictEqual(AfkTrade.ownerRecords(mover).filter((record) => record.kind === 'sell_ad').length, BoardRules.BOT_RECORDS.sell_ad);
    await assert.rejects(AfkTrade.publishBot(mover, await sellAd(mover, MATERIALS[5])), /board_cap_reached/);
    assert.strictEqual((await bag(mover))[MATERIALS[5]], 20, 'a refused ad leaves its item in the bag');
    for (const selfId of [1871, 1872, 1873, 1874]) await AfkTrade.publishBot(mover, buyAd(selfId));
    const wallet = (await bag(mover))[57];
    await assert.rejects(AfkTrade.publishBot(mover, buyAd(1875)), /board_cap_reached/);
    assert.strictEqual((await bag(mover))[57], wallet, 'a refused buy ad leaves its money in the wallet');
    await AfkTrade.publishBot(mover, buyAd(1876, 1, 100, 'order'));
    await assert.rejects(AfkTrade.publishBot(mover, buyAd(1877, 1, 100, 'order')), /board_cap_reached/);
    // A dwarf may show 4 lines in a store (C4); a bot's shop still holds 3.
    const shopper = await makeBot(MATERIALS.map((selfId) => ({ selfId, name: `Item ${selfId}`, amount: 20 })));
    await Database.execute(['UPDATE characters SET race = 4 WHERE id = ?', [shopper]]);
    const shopLines = await Promise.all(MATERIALS.slice(0, 4).map(async (selfId) => (await sellAd(shopper, selfId)).lines[0]));
    await assert.rejects(Database.createAfkTradeShop(shopper, { storeType: 1, town: 'Giran', lines: shopLines }), /board_cap_reached/);
    assert.deepStrictEqual(await bag(shopper), Object.fromEntries(MATERIALS.map((selfId) => [selfId, 20])));

    // The leave rule: every record of every kind closes; items and escrow go
    // back; nothing waits on the board.
    await AfkTrade.publishBot(shopper, { storeType: 1, town: 'Giran', locX: 81000, locY: 148000, locZ: -3466,
        appearance: {}, lines: shopLines.slice(0, 3) });
    assert.strictEqual(AfkTrade.ownerRecords(mover).length, 11, "5 sell ads, 5 buy ads, 1 order");
    await AfkTrade.leave(mover);
    await AfkTrade.leave(shopper);
    assert.strictEqual((await Database.fetchAfkTradeShops(mover)).length, 0);
    assert.strictEqual((await Database.fetchAfkTradeShops(shopper)).length, 0);
    assert.strictEqual(AfkTrade.ownerRecords(mover).length, 0);
    assert.strictEqual(AfkTrade.findOwnerProjection(shopper), null);
    assert.deepStrictEqual(await bag(mover), start, 'the leaving bot has all its items and money back');
    assert.deepStrictEqual(Database.boardSettlementOwners(), []);
    assert.strictEqual(LifeState.cachedState(mover).adena, start[57], 'its cold state follows');

    // No lifetime: a record older than 12 hours of uptime stays open, across
    // a restart too; a deadline a world ran with is gone (migration 56).
    const keeper = await makeBot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
    const ad = await AfkTrade.publishBot(keeper, await sellAd(keeper, 1864));
    assert.strictEqual(Number(ad.expiresAt), 0, 'a new record has no deadline');
    await Database.execute(['UPDATE afk_trade_shops SET createdAt = ?, updatedAt = ? WHERE id = ?',
        [Date.now() - 13 * HOUR, Date.now() - 13 * HOUR, ad.id]]);
    await AfkTrade._resetForTests();
    assert.strictEqual(await AfkTrade.init(), 1);
    assert.strictEqual((await Database.fetchAfkTradeShops(keeper)).length, 1, 'a record 13 hours old stays open');
    assert(AfkTrade.ownerRecords(keeper).length === 1 && AfkTrade.offers(1864, AfkTrade.SELL).length === 1,
        'and stays on the board');
    assert.strictEqual((await bag(keeper))[1864], undefined, 'its stems stay in the record');

    // What the board owes a bot survives a restart: a deal on a record of a
    // bot the worker holds waits; after a restart (the lease recovered) the
    // board merges it.
    const holder = await makeBot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
    const buyer = await makeBot([{ selfId: 57, name: 'Adena', amount: 100000 }]);
    const holderAd = await AfkTrade.publishBot(holder, await sellAd(holder, 1864, 10, 100));
    await Database.execute(["UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner' WHERE characterId = ?", [holder]]);
    LifeState.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [holder]]))[0]);
    await AfkTrade.buyFromShop(buyer, AfkTrade.recordStore(holderAd.id), 1864, 3);
    assert.deepStrictEqual(Database.boardSettlementOwners(), [holder], 'the leased seller\'s 300 adena wait on the board');
    assert.strictEqual((await bag(holder))[57], undefined);
    await AfkTrade._resetForTests();
    await Database.close();
    Database.init();
    await Database.execute(["UPDATE bot_life_state SET simulationOwner = 'legacy_main' WHERE characterId = ?", [holder]]);
    LifeState.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [holder]]))[0]);
    assert.deepStrictEqual(Database.boardSettlementOwners(), [holder], 'the settlement is still known after a restart');
    await AfkTrade.init();
    await AfkTrade.settlePending();
    assert.strictEqual((await bag(holder))[57], 300, 'the seller gets its price at its next save');
    assert.strictEqual(LifeState.cachedState(holder).adena, 300);
    assert.deepStrictEqual(Database.boardSettlementOwners(), []);

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('Board records: moves, caps, leave, no lifetime and restart checks passed');
}

run().catch(async (error) => {
    console.error(error);
    try { await AfkTrade._resetForTests(); } catch (_) { /* cleanup only */ }
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});

// The old world at the board's first start (step 3.3, Q8 option B): every
// bot record closes once and gives back what it holds (stock to the bag,
// escrow to the wallet); a bot's physical stall or budget-backed buy stall
// is cancelled (its stock and money never left the bag); players' AFK shops
// stay as they are and get a deadline. Totals over every owner do not move,
// and a second start does nothing.
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

const databasePath = path.join(process.cwd(), 'tmp', 'test-board-world-migration.sqlite');

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

let created = 0;
async function character(account, items, stats = null, activity = 'hunting') {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name: `Old${++created}`, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    if (stats) {
        const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
        await LifeState.upsertState({
            characterId: id, accountName: account, name: `Old${created}`, level: 40, adena: Number(inventory[57]?.amount || 0),
            phase: 'cold', activity, currentRegion: 'Giran', loc: { locX: 82700, locY: 148600, locZ: -3470 },
            inventory, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats, timing: {}
        }, 'test_seed');
    }
    return id;
}

async function totals() {
    const sum = {};
    const add = (rows) => rows.forEach((row) => { sum[row.selfId] = Number(sum[row.selfId] || 0) + Number(row.amount); });
    add(await Database.execute(['SELECT selfId, SUM(amount) AS amount FROM items GROUP BY selfId']));
    add(await Database.execute([`SELECT lines.selfId, SUM(lines.count) AS amount FROM afk_trade_lines lines
        JOIN afk_trade_shops shops ON shops.id = lines.shopId WHERE shops.storeType = 1 AND shops.status = 'active' GROUP BY lines.selfId`]));
    add(await Database.execute(["SELECT 57 AS selfId, SUM(escrowAdena) AS amount FROM afk_trade_shops WHERE status = 'active'"]));
    add(await Database.execute(['SELECT selfId, SUM(amount) AS amount FROM board_settlements GROUP BY selfId']));
    return sum;
}

async function bag(id, selfId) {
    return (await Database.fetchItems(id)).filter((row) => Number(row.selfId) === selfId)
        .reduce((total, row) => total + Number(row.amount), 0);
}

async function lifeRow(id) {
    const [row] = await Database.execute(['SELECT activity, adena, inventorySummary, statsJson FROM bot_life_state WHERE characterId = ?', [id]]);
    return { ...row, inventory: JSON.parse(row.inventorySummary), stats: JSON.parse(row.statsJson) };
}

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    // An old world: a bot's AFK sell shop and AFK buy order (the author's
    // single shop each), a bot standing at a physical stall, a bot with a
    // budget-backed buy stall, a player's AFK shop.
    const seller = await character('bot_old_seller', [{ selfId: 57, name: 'Adena', amount: 100 }, { selfId: 1864, name: 'Stem', amount: 30 }], { generatedCold: true });
    const orderer = await character('bot_old_orderer', [{ selfId: 57, name: 'Adena', amount: 10000 }], { generatedCold: true });
    const stall = { storeType: 1, town: 'Giran', items: [{ selfId: 1865, name: 'Varnish', count: 5, price: 90 }] };
    const merchant = await character('bot_old_merchant', [{ selfId: 1865, name: 'Varnish', amount: 5 }],
        { generatedCold: true, marketStore: stall, marketReturn: { regionName: 'Field', spotId: 'field', loc: { locX: 1, locY: 2, locZ: 3 } } }, 'merchant');
    const budget = { storeType: 3, budgetBacked: true, town: 'Giran', items: [{ selfId: 1866, name: 'Suede', count: 2, price: 50 }] };
    const budgetBuyer = await character('bot_old_budget', [{ selfId: 57, name: 'Adena', amount: 700 }],
        { generatedCold: true, marketStore: budget }, 'merchant');
    const player = await character('old_player', [{ selfId: 1864, name: 'Stem', amount: 8 }]);
    const stemOf = async (id) => Number((await Database.fetchItems(id)).find((row) => Number(row.selfId) === 1864).id);
    await Database.createAfkTradeShop(seller, { storeType: 1, town: 'Giran', locX: 81000, locY: 148000, locZ: -3466,
        lines: [{ objectId: await stemOf(seller), selfId: 1864, name: 'Stem', count: 20, price: 100, stackable: true }] });
    await Database.createAfkTradeShop(orderer, { storeType: 3, town: 'Giran', locX: 81100, locY: 148000, locZ: -3466,
        lines: [{ selfId: 1867, name: 'Animal Skin', count: 10, price: 300, stackable: true }] });
    const playerShop = await Database.createAfkTradeShop(player, { storeType: 1, town: 'Dion', locX: 15600, locY: 143000, locZ: -2700,
        lines: [{ objectId: await stemOf(player), selfId: 1864, name: 'Stem', count: 8, price: 77, stackable: true }] });
    // Before the board these records had no deadline, and the schema
    // migration marked the world as one that traded.
    await Database.execute(['UPDATE afk_trade_shops SET expiresAt = 0']);
    await Database.execute(["INSERT INTO world_meta (key, value) VALUES ('boardMigrationPending', '1')"]);
    const before = await totals();

    await AfkTrade.init();
    assert.deepStrictEqual(await totals(), before, 'no item or adena appears or vanishes');
    assert.strictEqual(await bag(seller, 1864), 30, 'the bot\'s stems are back in its bag');
    assert.strictEqual(await bag(orderer, 57), 10000, 'the bot\'s escrow is back in its wallet');
    assert.strictEqual((await lifeRow(seller)).inventory['1864'].amount, 30, 'its cold state follows its bag');
    assert.strictEqual((await lifeRow(orderer)).adena, 10000);
    assert.strictEqual(LifeState.cachedState(orderer).adena, 10000, 'and so does the cached state');
    const merchantRow = await lifeRow(merchant);
    assert.strictEqual(merchantRow.stats.marketStore, undefined, 'the physical stall is cancelled');
    assert.strictEqual(merchantRow.activity, 'shopping', 'the stall keeper goes back on its way');
    assert.strictEqual(await bag(merchant, 1865), 5, 'its stock never left the bag');
    const budgetRow = await lifeRow(budgetBuyer);
    assert.strictEqual(budgetRow.stats.marketStore, undefined, 'the budget-backed buy stall is cancelled');
    assert.strictEqual(budgetRow.activity, 'hunting');
    assert.strictEqual(budgetRow.adena, 700, 'its money never left the wallet');
    const records = await Database.fetchAfkTradeShops();
    assert.deepStrictEqual(records.map((record) => record.id), [playerShop.shop.id], 'only the player\'s shop stands');
    assert.deepStrictEqual(records[0].lines.map((line) => [line.selfId, line.count, line.price]), [[1864, 8, 77]],
        'the player\'s shop keeps its stock and its prices');
    assert(Math.abs(Number(records[0].expiresAt) - (Date.now() + BoardRules.LIFETIME_MS)) < 60000, 'and gets a deadline');
    assert(AfkTrade.findOwnerProjection(player), 'and stands in the world');

    // A second start finds nothing to do.
    await AfkTrade._resetForTests();
    const again = await Database.migrateBoardWorld();
    assert.strictEqual(again.skipped, true);
    assert.strictEqual(await AfkTrade.init(), 1);
    assert.deepStrictEqual(await totals(), before);

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('Board world migration: bot records closed once, stalls cancelled, player shops kept, totals unchanged');
}

run().catch(async (error) => {
    console.error(error);
    try { await AfkTrade._resetForTests(); } catch (_) { /* cleanup only */ }
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});

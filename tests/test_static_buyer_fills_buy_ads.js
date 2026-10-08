'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-buyer-ads-'));
const config = path.join(directory, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(directory, 'world.sqlite')}\nhistoryPath=${path.join(directory, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Actor = invoke('GameServer/Actor/Actor');
const World = invoke('GameServer/World/World');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Trade = invoke('GameServer/Bot/TradeService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Npc = invoke('GameServer/Items/NpcSellRules');
const ITEM = 1867;
let sequence = 0;
const previousUser = World.user;

async function character({ bot = false, skins = 0 } = {}) {
    const number = ++sequence, account = `${bot ? 'bot_' : ''}static_ads_${number}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `SkinTrader${number}`, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, equipped: false, slot: 0 });
    if (skins) await Database.setItem(id, { selfId: ITEM, name: 'Animal Skin', amount: skins, equipped: false, slot: 0 });
    const session = { accountId: account, botSession: bot, socket: { write() {} },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor(session, { ...(await Database.fetchCharacters(account))[0],
        ...utils.crushOb(Data.classTemplates.find(row => row.classId === 0)),
        items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
    World.user.sessions.push(session);
    return session;
}
async function order(price, count, owner = null) {
    const session = owner || await character({ bot: true });
    const created = await Database.createAfkTradeShop(session.actor.fetchId(), { kind: 'buy_ad', storeType: 3, town: 'Giran',
        lines: [{ selfId: ITEM, name: 'Animal Skin', count, price, enchant: 0, stackable: true }] });
    // Native publish normally refreshes the owner's escrow deduction too.
    session.actor.backpack.items = [];
    for (const row of created.ownerInventory) session.actor.backpack.insertItem(row.id, row.selfId, row);
    Afk.refreshRecord(created.shop);
    return { session, shop: created.shop };
}
function buyer() {
    const source = { storeType: 3, town: 'Giran', items: [{ selfId: ITEM, count: 999999, price: 1 }] };
    return { storeType: 3, town: 'Giran', items: Trade.normalizeStoreItems(source, { staticStore: true }) };
}
function money(session) { return session.actor.backpack.fetchTotalAdena(); }
async function worldAdena() {
    const [row] = await Database.execute([`SELECT
        COALESCE((SELECT SUM(amount) FROM items WHERE selfId = 57), 0)
        + COALESCE((SELECT SUM(escrowAdena) FROM afk_trade_shops), 0) AS total`]);
    return Number(row.total);
}
async function held(id) {
    const rows = await Database.fetchItems(id);
    const [pending] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM board_settlements WHERE ownerId = ? AND selfId = ?', [id, ITEM]]);
    return rows.filter(row => row.selfId === ITEM).reduce((sum, row) => sum + row.amount, 0) + Number(pending.amount);
}
async function remaining(shop) {
    return (await Database.fetchAfkTradeShops(shop.ownerId, { activeOnly: false })).find(row => row.id === shop.id)?.lines[0]?.count || 0;
}
async function sale(session, amount, extra = {}) {
    const store = buyer();
    const item = session.actor.backpack.fetchItemFromSelfId(ITEM);
    return Trade.sellToStore(session.actor, store, ITEM, amount, { objectId: item.fetchId(),
        expectedUnitPrice: Trade.storeItemPrice(store, store.items[0], session.actor), ...extra });
}
async function check(name, work) {
    Afk._resetForTests();
    await work();
    console.log('PASS ' + name);
}

async function run() {
    Data.init();
    Database.init();
    assert(Database.isReady());
    World.user = { sessions: [], revision: 0 };
    const buyback = Npc.npcBuyPrice(Trade.itemBasePrice(ITEM));
    await check('three units consume bot escrow; only two buy-back units create adena', async () => {
        const player = await character({ skins: 5 }), bid = await order(100, 3);
        const before = await worldAdena(), balance = money(player);
        const result = await sale(player, 5);
        assert.equal(result.totalAdena, 300 + 2 * buyback);
        assert.equal(money(player) - balance, result.totalAdena);
        assert.equal(result.adQty, 3); assert.equal(result.adAdena, 300);
        assert.equal(result.npcQty, 2); assert.equal(result.npcAdena, 2 * buyback);
        assert.equal(result.budgetBacked, false);
        assert.equal(await remaining(bid.shop), 0);
        assert.equal(Afk.recordStore(bid.shop.id), null, 'filled ad is removed from the board');
        assert.equal(await held(bid.session.actor.fetchId()), 3);
        assert.equal(await worldAdena() - before, 2 * buyback);
    });
    await check('best bid fills first across two ads', async () => {
        const player = await character({ skins: 5 }), high = await order(120, 2), low = await order(100, 4);
        const before = await worldAdena();
        const result = await sale(player, 5);
        assert.equal(result.totalAdena, 540); assert.equal(result.adQty, 5); assert.equal(result.npcQty, 0);
        assert.equal(await remaining(high.shop), 0); assert.equal(await remaining(low.shop), 1);
        assert.equal(await held(high.session.actor.fetchId()), 2); assert.equal(await held(low.session.actor.fetchId()), 3);
        assert.equal(await worldAdena(), before);
    });
    await check('one click fills at most five orders', async () => {
        const player = await character({ skins: 6 }), bids = [];
        for (let i = 0; i < 6; i++) bids.push(await order(100 + i, 1));
        const before = await worldAdena();
        const result = await sale(player, 6);
        assert.equal(result.adQty, 5); assert.equal(result.npcQty, 1);
        assert.equal(result.adAdena, 105 + 104 + 103 + 102 + 101);
        assert.equal(await remaining(bids[0].shop), 1); assert.equal(await worldAdena() - before, buyback);
    });
    await check('no order uses the native buy-back', async () => {
        const player = await character({ skins: 5 }), before = await worldAdena();
        const result = await sale(player, 5);
        assert.equal(result.adQty, 0); assert.equal(result.totalAdena, 5 * buyback);
        assert.equal(await worldAdena() - before, 5 * buyback);
    });
    await check('viewer quote and fill exclude his own best order', async () => {
        const player = await character({ skins: 5 }), own = await order(200, 5, player), bot = await order(100, 2);
        const store = buyer();
        assert.equal(Trade.storeItemPrice(store, store.items[0], player.actor), 100);
        Trade.refreshStorePrices(store, player.actor);
        assert.equal(store.items[0].price, 100, 'native and HTML windows share the viewer price');
        const result = await sale(player, 2, { expectedUnitPrice: 100 });
        assert.equal(result.adAdena, 200); assert.equal(await remaining(own.shop), 5); assert.equal(await remaining(bot.shop), 0);
    });
    await check('a changed bid refuses the old window price before mutation', async () => {
        const player = await character({ skins: 5 }), bid = await order(100, 3);
        const changed = await Database.repriceAfkTradeShop(bid.session.actor.fetchId(), bid.shop.lines[0].id, 110);
        Afk.refreshRecord(changed.shop);
        const before = await worldAdena(), balance = money(player);
        await assert.rejects(sale(player, 5, { expectedUnitPrice: 100 }), /Store price changed/);
        assert.equal(money(player), balance); assert.equal(await worldAdena(), before); assert.equal(await remaining(bid.shop), 3);
    });
    await check('stale ad errors skip to the next order; unrelated errors stop', async () => {
        const player = await character({ skins: 3 }), high = await order(120, 1), low = await order(100, 2);
        const original = Afk.sellToShop;
        try {
            Afk.sellToShop = async (...args) => {
                if (args[1].shopId === high.shop.id) throw Error('afk_trade_budget_changed');
                return original(...args);
            };
            const result = await sale(player, 3);
            assert.equal(result.adQty, 2); assert.equal(result.npcQty, 1); assert.equal(await remaining(high.shop), 1);
            assert.equal(await remaining(low.shop), 0);
            const before = money(player);
            Afk.sellToShop = async () => { throw Error('unexpected_storage_error'); };
            const other = await character({ skins: 1 });
            await assert.rejects(sale(other, 1), /unexpected_storage_error/);
            assert.equal(money(player), before);
        } finally { Afk.sellToShop = original; }
    });
    await check('a bot keeps the capped authored static price without filling an ad', async () => {
        const bot = await character({ bot: true, skins: 1 }), bid = await order(1000, 1), store = buyer();
        const source = { storeType: 3, items: [{ selfId: ITEM, count: 999999, price: 1 }] };
        const price = Pricing.botPriceFor(source, source.items[0]);
        const before = await worldAdena();
        const result = await Trade.sellToStore(bot.actor, store, ITEM, 1);
        assert.equal(result.totalAdena, price); assert.equal(await remaining(bid.shop), 1);
        assert.equal(await worldAdena() - before, price);
    });
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Afk._resetForTests(); World.user = previousUser;
    await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
});

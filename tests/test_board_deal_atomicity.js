// Requirements of the board (step 3.3, E18, E23, E24): a deal is one
// world-DB transaction, all or nothing; a seller without the item is not
// paid; a failed deal leaves nothing behind. Checked through the public
// paths a cold bot uses to sell (ColdMarketListingService.open), to buy
// (MarketOpportunity.bestOffer + ColdMarketService.buyOffer), to ask for an
// item (ColdMarketBuyStoreService.open) and to sell into an ask
// (ColdMarketBuyStoreService.sellToBestBuyer). Failures are injected with
// temporary SQLite triggers on one character's items.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStores = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');

const databasePath = path.join(process.cwd(), 'tmp', 'test-board-deal-atomicity.sqlite');
const STEM = 1864;

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

let created = 0;
async function makeBot(name, items) {
    const account = `bot_deal_${++created}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    for (const entry of items) {
        await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...entry });
    }
    const rows = await Database.fetchItems(id);
    const inventory = LifeState.inventorySummaryFromItems(rows);
    return LifeState.upsertState({
        characterId: id, accountName: account, name, level: 40, exp: 0, sp: 0,
        adena: Number(inventory[57]?.amount || 0), phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        loc: { locX: 82700, locY: 148600, locZ: -3470 }, inventory,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, marketReturn: { regionName: 'Giran', spotId: null, loc: { locX: 82700, locY: 148600, locZ: -3470 } } },
        timing: {}
    }, 'test_seed');
}

async function tableExists(name) {
    const rows = await Database.execute([`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]]);
    return rows.length > 0;
}

// Every unit of `selfId` the characters hold: in their bags, in the board
// records they own (sell lines, escrow) and in settlements not yet merged.
async function holdings(ids, selfId) {
    const list = ids.map(Number).join(',');
    const [bag] = await Database.execute([`SELECT COALESCE(SUM(amount), 0) AS amount FROM items
        WHERE characterId IN (${list}) AND selfId = ?`, [selfId]]);
    let total = Number(bag.amount);
    if (selfId === 57) {
        const [escrow] = await Database.execute([`SELECT COALESCE(SUM(escrowAdena), 0) AS amount FROM afk_trade_shops
            WHERE ownerId IN (${list}) AND status = 'active'`]);
        total += Number(escrow.amount);
    } else {
        const [lines] = await Database.execute([`SELECT COALESCE(SUM(lines.count), 0) AS amount FROM afk_trade_lines lines
            JOIN afk_trade_shops shops ON shops.id = lines.shopId
            WHERE shops.ownerId IN (${list}) AND shops.status = 'active' AND shops.storeType = 1 AND lines.selfId = ?`, [selfId]]);
        total += Number(lines.amount);
    }
    if (await tableExists('board_settlements')) {
        const [settled] = await Database.execute([`SELECT COALESCE(SUM(amount), 0) AS amount FROM board_settlements
            WHERE ownerId IN (${list}) AND selfId = ?`, [selfId]]);
        total += Number(settled.amount);
    }
    return total;
}

async function bagAmount(id, selfId) {
    const [row] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM items WHERE characterId = ? AND selfId = ?', [id, selfId]]);
    return Number(row.amount);
}

async function failItemsOf(characterId) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = event === 'INSERT' ? 'NEW' : 'OLD';
        await Database.execute([`CREATE TEMP TRIGGER IF NOT EXISTS inject_items_${event.toLowerCase()}_${characterId}
            BEFORE ${event} ON main.items WHEN ${row}.characterId = ${Number(characterId)}
            BEGIN SELECT RAISE(ABORT, 'injected items failure'); END`]);
    }
}

async function healItemsOf(characterId) {
    for (const event of ['insert', 'update', 'delete']) {
        await Database.execute([`DROP TRIGGER IF EXISTS temp.inject_items_${event}_${characterId}`]);
    }
}

function marketWeapon() {
    return DataCache.items.find((item) => item?.etc?.rank === 'c' && item.template?.kind?.startsWith('Weapon.')
        && Number(item.template?.price || 0) > 1000 && Number(item.etc?.slot || 0) === 7);
}

// A seller lists the weapon through the cold sale path; deals of it on the
// board are the buyers that make the listing worth it (group E).
async function listWeapon(name, weapon) {
    const seller = await makeBot(name, [{ selfId: 57, name: 'Adena', amount: 500 },
        { selfId: weapon.selfId, name: weapon.template.name, amount: 1, slot: weapon.etc.slot }]);
    // One decision point for the visit, the same in every run.
    const at = 1800000000000;
    const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
    for (let deal = 0; deal < 12; deal++) {
        MarketCounters.deal(weapon.selfId, Number(weapon.template.price) * 2, 1, at - (12 - deal) * 300000, 999999);
    }
    const listed = await ListingService.open(seller, { now: at, random: () => 0.1 });
    assert.strictEqual(listed.listed, true, `${name}: the weapon is listed`);
    return listed.state;
}

async function buyerBot(name) {
    return makeBot(name, [{ selfId: 57, name: 'Adena', amount: 10000000 }]);
}

const failures = [];
async function check(label, work) {
    try {
        await work();
        console.log(`${label}: pass`);
    } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.log(`${label}: FAIL ${error.message}`);
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
    const weapon = marketWeapon();
    assert(weapon, 'the datapack holds a C-grade weapon');

    // E18: the seller's half of a purchase fails. The buyer's money must not
    // vanish: it is the seller's (in its bag or still on the board).
    await check('E18', async () => {
        const seller = await listWeapon('E18Seller', weapon);
        const buyer = await buyerBot('E18Buyer');
        const ids = [seller.characterId, buyer.characterId];
        const adena = await holdings(ids, 57);
        const weapons = await holdings(ids, weapon.selfId);
        const offer = MarketOpportunity.bestOffer(weapon.selfId, { town: 'Giran', budget: buyer.adena, buyerCharacterId: buyer.characterId });
        assert(offer && Number(offer.sourceId) === seller.characterId, 'E18: the buyer finds the seller\'s listing');
        await failItemsOf(seller.characterId);
        const result = await ColdMarketService.buyOffer(LifeState.snapshot(buyer.characterId), offer);
        await healItemsOf(seller.characterId);
        assert.strictEqual(await holdings(ids, 57), adena, 'E18: no adena is created or destroyed');
        assert.strictEqual(await holdings(ids, weapon.selfId), weapons, 'E18: no weapon is created or destroyed');
        if (result.purchased) {
            assert.strictEqual(await bagAmount(buyer.characterId, weapon.selfId), 1, 'E18: the buyer holds what it paid for');
            await AfkTrade.settlePending?.();
            assert.strictEqual(await bagAmount(seller.characterId, 57), 500 + Number(offer.price),
                'E18: the seller gets the price once its bag can be written');
        }
    });

    // E23: the listed weapon left the seller's bag by another path. A seller
    // without the item is never paid.
    await check('E23', async () => {
        const seller = await listWeapon('E23Seller', weapon);
        await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = ?', [seller.characterId, weapon.selfId]]);
        const current = LifeState.snapshot(seller.characterId);
        const inventory = { ...current.inventory };
        delete inventory[String(weapon.selfId)];
        await LifeState.upsertState({ ...current, inventory }, 'test_stock_left');
        const buyer = await buyerBot('E23Buyer');
        const ids = [seller.characterId, buyer.characterId];
        const adena = await holdings(ids, 57);
        const weapons = await holdings(ids, weapon.selfId);
        const offer = MarketOpportunity.bestOffer(weapon.selfId, { town: 'Giran', budget: buyer.adena, buyerCharacterId: buyer.characterId });
        if (offer && Number(offer.sourceId) === seller.characterId) {
            await ColdMarketService.buyOffer(LifeState.snapshot(buyer.characterId), offer);
        }
        assert.strictEqual(await holdings(ids, weapon.selfId), weapons, 'E23: no weapon is created by a sale');
        assert.strictEqual(await holdings(ids, 57), adena, 'E23: no adena is created or destroyed');
    });

    // E24: a seller fills a buy ask and its own write fails. Nothing may be
    // left half done: the buyer keeps its money, the seller its stems.
    await check('E24', async () => {
        const buyer = await makeBot('E24Buyer', [{ selfId: 57, name: 'Adena', amount: 100000 }]);
        const goal = { type: 'buy_craft_material', status: 'active',
            target: { itemId: STEM, itemName: 'Stem', amount: 3, adena: 200 },
            plan: { expectedBenefit: 'market_buy_craft_material', priceSource: 'offer', sourceType: 'afk_bot_store', marketTown: 'Giran' } };
        const opened = await BuyStores.open(buyer, goal);
        assert.strictEqual(opened.opened, true, 'E24: the buyer asks for stems');
        const seller = await makeBot('E24Seller', [{ selfId: STEM, name: 'Stem', amount: 2 }]);
        const ids = [buyer.characterId, seller.characterId];
        const adena = await holdings(ids, 57);
        const stems = await holdings(ids, STEM);
        const buyerStems = await bagAmount(buyer.characterId, STEM);
        await failItemsOf(seller.characterId);
        await BuyStores.sellToBestBuyer(LifeState.snapshot(seller.characterId), 'Giran');
        await healItemsOf(seller.characterId);
        assert.strictEqual(await holdings(ids, 57), adena, 'E24: no adena is created or destroyed');
        assert.strictEqual(await holdings(ids, STEM), stems, 'E24: no stem is created or destroyed');
        assert.strictEqual(await bagAmount(seller.characterId, STEM), 2, 'E24: the failed sale leaves the seller its stems');
        assert.strictEqual(await bagAmount(buyer.characterId, STEM), buyerStems, 'E24: the failed sale gives the buyer nothing');
    });

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    assert.deepStrictEqual(failures, [], 'every board deal requirement holds');
    console.log('Board deal atomicity checks passed (E18, E23, E24)');
}

run().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});

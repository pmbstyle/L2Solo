// Suspects of step 3.3 group C, checked on a board in a test database:
// E45 a buy ad and a sell line cross in two towns with no trip;
// E46 a bot's shop moves to another town at a review;
// E47 D-grade shots are routed as no-grade;
// E48 the market prices trips a bot with karma cannot make;
// E49 a deleted character's records stay on the board in memory.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const OfferOrder = invoke('GameServer/Bot/Economy/OfferOrder');
const Shared = invoke('GameServer/Network/Shared');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-board-trip-suspects.sqlite');

const VARNISH = 1865;
const SOULSHOT_D = 1463;
const TI = { locX: -84700, locY: 244200, locZ: -3730 };
const ELVEN = { locX: 46600, locY: 49700, locZ: -3060 };

function clean() {
    for (const file of [databasePath, databasePath.replace(/\.sqlite$/, '.history.sqlite')]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function character(name, loc = TI) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...loc };
}

async function bot(account, name, items, loc = TI, stats = {}) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, character(name, loc))).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    const state = await LifeState.upsertState({
        characterId: id, accountName: account, name, phase: 'cold', activity: 'hunting', level: 40,
        adena: Number(inventory['57']?.amount || 0), loc: { ...loc }, currentRegion: 'Talking Island', inventory,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true, ...stats }, timing: {}
    }, 'test_board_trip_suspects');
    return { id, state };
}

const failures = [];
async function check(name, body) {
    try {
        await body();
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
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

    // E45: a bot's buy ad in Dion and another bot's sell ad in Giran cross;
    // nobody travels, so no deal may happen (design 4.4, 4.6).
    await check('E45', async () => {
        // A bot's buy ad reserves money only through its worker's money packet
        // (5d87d87a): the packet funds the 20 Varnish bid (4000) at r .001.
        const buyer = await bot('bot_e45_buyer', 'E45Buyer', [{ selfId: 57, name: 'Adena', amount: 1000000 }], TI,
            { money: [1000000, .0001, 0, 0, .001, 4000, VARNISH] });
        const seller = await bot('bot_e45_seller', 'E45Seller', [{ selfId: VARNISH, name: 'Varnish', amount: 30 }]);
        await AfkTrade.openBotRecords(buyer.id, 'buy_ad', [{ storeType: AfkTrade.BUY, title: 'wtb', town: 'Dion',
            locX: 15631, locY: 142885, locZ: -2704,
            lines: [{ selfId: VARNISH, name: 'Varnish', count: 20, price: 200, enchant: 0, slot: 0, stackable: true }] }]);
        const row = (await Database.fetchItems(seller.id)).find((item) => Number(item.selfId) === VARNISH);
        await AfkTrade.openBotRecords(seller.id, 'sell_ad', [{ storeType: AfkTrade.SELL, title: 'wts', town: 'Giran',
            locX: 83396, locY: 147904, locZ: -3400,
            lines: [{ objectId: Number(row.id), selfId: VARNISH, name: 'Varnish', count: 20, price: 100, enchant: 0, slot: 0,
                stackable: true }] }]);
        // The base code crossed them at once (AfkTradeService.matchAfkOrders).
        const matched = AfkTrade.matchAfkOrders ? await AfkTrade.matchAfkOrders(seller.id) : null;
        const trades = (matched?.trades?.length || 0)
            + (AfkTrade.ownerRecords(buyer.id).length === 1 && AfkTrade.ownerRecords(seller.id).length === 1 ? 0 : 1);
        assert.strictEqual(trades, 0, `E45: ${trades} deal(s) between Giran and Dion with no trip`);
    });

    // E46: a bot's shop stays in its town (design 4.15, N51): a review after
    // the bot moved its hunt to another village keeps it where it stands.
    await check('E46', async () => {
        const owner = await bot('bot_e46_owner', 'E46Owner', [{ selfId: VARNISH, name: 'Varnish', amount: 30 }]);
        const row = (await Database.fetchItems(owner.id)).find((item) => Number(item.selfId) === VARNISH);
        await AfkTrade.publishBot(owner.id, { storeType: AfkTrade.SELL, title: 'wts', town: 'Talking Island', ...TI,
            head: 0, appearance: {}, lines: [{ objectId: Number(row.id), selfId: VARNISH, name: 'Varnish', count: 21,
                price: 100, enchant: 0, slot: 0, stackable: true }] });
        await Database.setItem(owner.id, { selfId: VARNISH, name: 'Varnish', amount: 5, enchant: 0, equipped: false, slot: 0 });
        const moved = await LifeState.upsertState({ ...LifeState.snapshot(owner.id), loc: { ...ELVEN },
            currentRegion: 'Elven Village' }, 'test_e46_moved');
        const synced = await LifeState.syncExternalInventory(owner.id, 'test_e46_loot', moved) || moved;
        const evaluate = ListingPolicy.evaluate;
        ListingPolicy.evaluate = () => ({ listings: [{ selfId: VARNISH, name: 'Varnish', count: 26, price: 100, rank: 'none' }],
            decisions: [] });
        try {
            await BotAfkMarket.reconcile(synced, { type: 'sell_inventory', status: 'active',
                plan: { expectedBenefit: 'market_sale_inventory' } });
        } finally {
            ListingPolicy.evaluate = evaluate;
        }
        const town = AfkTrade.findOwnerProjection(owner.id)?.shop?.town;
        assert.strictEqual(town, 'Talking Island', `E46: the shop moved to ${town}`);
    });

    // E47: a D-grade shot is D-grade stock: its shop goes where D grade
    // trades, not to a starter village.
    await check('E47', async () => {
        const town = MarketTownPolicy.targetTownForItems({ characterId: 1, loc: { ...ELVEN } }, [{ selfId: SOULSHOT_D }]);
        assert(['Dion', 'Gludio'].includes(town), `E47: Soulshot D goes to ${town}`);
    });

    // E48: a bot with karma cannot enter a town other than Floran (design
    // 5.6-5.8): no trip there is priced, its records stand in Floran.
    await check('E48', async () => {
        const red = { characterId: 2, level: 40, adena: 100000, loc: { ...TI }, inventory: { 736: { selfId: 736, amount: 5 } },
            stats: { karma: 500 } };
        const cost = OfferOrder.tripCost(red)('Giran');
        assert.strictEqual(cost, Infinity, `E48: a trip to Giran priced at ${cost} for a bot with karma`);
        const town = MarketTownPolicy.targetTownForItems(red, [{ selfId: VARNISH }]);
        assert.strictEqual(town, 'Floran Village', `E48: a bot with karma trades in ${town}`);
    });

    // E49: deleting a character takes its records off the board at once.
    await check('E49', async () => {
        const owner = await bot('e49_account', 'E49Owner', [{ selfId: VARNISH, name: 'Varnish', amount: 30 }]);
        const row = (await Database.fetchItems(owner.id)).find((item) => Number(item.selfId) === VARNISH);
        await AfkTrade.openBotRecords(owner.id, 'sell_ad', [{ storeType: AfkTrade.SELL, title: 'wts', town: 'Giran',
            locX: 83396, locY: 147904, locZ: -3400,
            lines: [{ objectId: Number(row.id), selfId: VARNISH, name: 'Varnish', count: 20, price: 100, enchant: 0, slot: 0,
                stackable: true }] }]);
        assert.strictEqual(AfkTrade.ownerRecords(owner.id).length, 1);
        const fetchCharacters = Shared.fetchCharacters;
        const enterCharacterHall = Shared.enterCharacterHall;
        let entered = null;
        Shared.fetchCharacters = () => Promise.resolve([{ id: owner.id, name: 'E49Owner' }]);
        Shared.enterCharacterHall = () => { entered = true; };
        try {
            const buffer = Buffer.alloc(5);
            buffer.writeInt32LE(0, 1);
            invoke('GameServer/Network/Request/CharDelete')({ accountId: 'e49_account' }, buffer);
            for (let wait = 0; wait < 50 && !entered; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            Shared.fetchCharacters = fetchCharacters;
            Shared.enterCharacterHall = enterCharacterHall;
        }
        const left = AfkTrade.ownerRecords(owner.id).length + AfkTrade.boardIndex().ownerLines(owner.id).length;
        assert.strictEqual(left, 0, `E49: ${left} record(s) or line(s) of a deleted character on the board`);
    });

    AfkTrade._resetForTests();
    if (failures.length) {
        failures.forEach((failure) => console.error(failure));
        process.exitCode = 1;
    } else {
        console.log('Board trip suspects E45-E49: checked');
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { Database.close?.(); } catch (_) { /* closed */ }
    clean();
});

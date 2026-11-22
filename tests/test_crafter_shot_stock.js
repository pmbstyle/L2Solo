// A crafter's shot supply in a town without a D shot store: a Create Item 4 Warsmith
// in Giran takes the D and C shots it crafts on consignment at its visit (no adena,
// owed at the shot anchor, 7 x datapack), no B shot; it lists its D soulshots as one
// board line at the anchor; no static shot row sells to a bot; a
// hunter in Giran with adena and no shots plans its restock from the crafter's line and
// buys its D soulshots there; at the crafter's next visit it pays the store the anchor
// of the units sold, journalled as the fixed_wts purchase it stands for.
const assert = require('assert');
const fs = require('fs');

process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('crafter-shot-stock');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };

const D_SS = 1463;
const GIRAN = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Giran').center;
const units = (items, id) => items.filter(item => Number(item.selfId) === id).reduce((sum, item) => sum + Number(item.amount), 0);

let serial = 0;
async function seed({ classId, level, adena, items = [], stats = {} }) {
    const account = `bot_shot_stock_${++serial}`, name = `ShotStock${serial}`;
    await Database.createAccount(account, 'secret');
    const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
    const id = Number((await Database.createCharacter(account, { name, race, classId, maxHp: 3000, maxMp: 1200,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: GIRAN.locX, locY: GIRAN.locY, locZ: GIRAN.locZ })).insertId);
    await Database.execute(['UPDATE characters SET level=?, exp=? WHERE id=?', [level, Number(DataCache.experience[level - 1]), id]]);
    for (const item of [{ selfId: 57, name: 'Adena', amount: adena }, ...items]) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    const now = Date.now();
    return LifeState.upsertState({ characterId: id, accountName: account, name, level, phase: 'cold', activity: 'shopping',
        currentRegion: 'Giran', spotId: null, adena, loc: GIRAN, vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId, generatedCold: true, money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000,
            moneyPrice: 0.00001, refillReserve: 0, firstUnfundedPrice: 0 }), ...stats },
        timing: { activityStartedAt: now - 60000, lastResolvedAt: now - 1000, nextResolveAt: now } }, 'crafter_shot_fixture');
}

(async () => {
    await Database.init(); DataCache.init(); await LifeState.init(); await Afk.init();
    const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
    const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
    const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
    const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const now = Date.now();
    // No gear allowance: the visit stocks shots only.
    const noGear = { c: { pieces: 0, at: now }, b: { pieces: 0, at: now }, a: { pieces: 0, at: now } };
    const adena = 2500000;
    let crafter = await seed({ classId: 57, level: 40, adena, stats: { gnomeAllowance: noGear } });
    const id = crafter.characterId;
    assert(!Fixed.offers(D_SS).some(row => row.town === 'Giran'), 'Giran has no D shot store row');

    // 1. The visit: the D and C shots of its Create Item level, none above, no adena paid.
    crafter = await Cold.crafterStock(crafter);
    const bag = await Database.fetchItems(id);
    const shotIds = [1463, 1464, 1465, 2510, 2511, 2512, 3948, 3949, 3950];
    assert.deepStrictEqual(shotIds.filter(shot => units(bag, shot) > 0), [1463, 1464, 2510, 2511, 3948, 3949],
        'the D and C shots in its bag, no B shot');
    assert.strictEqual(units(bag, D_SS), Stock.SHOT_STOCK_UNITS, 'a lot of D soulshots');
    assert.strictEqual(units(bag, 57), adena, 'the consigned shots cost no adena');
    const ceiling = invoke('GameServer/Bot/Economy/PriceAnchor').shotAnchor(D_SS), cost = Math.floor(0.6 * ceiling);
    assert(ceiling > 10, `x50: the D soulshot's anchor ${ceiling} is above its datapack 10`);
    assert.deepStrictEqual(crafter.stats.gnomeStock[D_SS], { cost, ceiling, owed: Stock.SHOT_STOCK_UNITS },
        'it owes the D soulshots at the suppliers\' cost, 0.6 x the anchor, asking the anchor');

    // 2. Its sale lists the D soulshots on the board, one line, at the anchor.
    const market = ListingPolicy.evaluate(crafter, { now, decisionPoint: 'stock' });
    const lines = market.listings.filter(entry => Number(entry.selfId) === D_SS);
    assert.strictEqual(lines.length, 1, `one D soulshot line (${market.decisions.filter(entry => Number(entry.item?.selfId) === D_SS)
        .map(entry => `${entry.action}/${entry.reason}`)})`);
    const [line] = lines;
    assert.strictEqual(line.price, ceiling, `ask ${line.price} at the anchor ${ceiling}`);
    assert(!market.npc.some(entry => Number(entry.selfId) === D_SS), 'never sold to an NPC');
    const lot = bag.find(item => Number(item.selfId) === D_SS);
    await Afk.publishBot(id, { kind: 'shop', storeType: Afk.SELL, town: 'Giran', title: 'Shots',
        lines: [{ objectId: lot.id, selfId: D_SS, name: lot.name, count: line.count, price: line.price, enchant: 0, stackable: true, slot: 0 }] });

    // 3. A hunter in Giran buys its D soulshots there.
    const hunterAdena = 5000000;
    // A D-grade sword: its kit fires D soulshots.
    let hunter = await seed({ classId: 0, level: 25, adena: hunterAdena,
        items: [{ selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }] });
    assert.strictEqual(invoke('GameServer/Inventory/ShotStock').planForState(hunter).selfId, D_SS, 'the hunter fires D soulshots');
    // Its money packet, as its worker builds it: the D soulshots are its survival kit.
    const steps = require('../src/GameServer/Bot/Economy/EconomicTrip').prepare(hunter);
    let next; do next = steps.next(); while (!next.done);
    hunter = await LifeState.upsertState({ ...hunter, stats: { ...hunter.stats, ...invoke('GameServer/Bot/Economy/EconomyContext')
        .forState(hunter, { timestamp: now, routeRows: next.value }).statsPacket } }, 'crafter_shot_hunter_money');
    // No static shot row sells to a bot: a Giran D shot store row would be refused.
    assert(!Fixed.offers(D_SS).length, 'no static D soulshot row for a bot');
    assert(!invoke('GameServer/Bot/Economy/ProductionPolicy').allowsFixed({ selfId: D_SS }, hunter), 'a static shot row is refused');
    // With adena and no D shots its restock plans a purchase at the crafters' ceiling.
    const restock = invoke('GameServer/Inventory/ShotStock').restockPlan(hunter, { plan: invoke('GameServer/Inventory/ShotStock').planForState(hunter) });
    assert(restock.needed && restock.amount > 0 && restock.unitPrice === ceiling, `the hunter plans a D soulshot restock at ${ceiling} (${JSON.stringify({ needed: restock.needed, amount: restock.amount, unitPrice: restock.unitPrice })})`);
    const plan = Cold.planPurchase(hunter, D_SS, 1000, { towns: ['Giran'], purpose: 'shots', money: hunterAdena });
    assert(plan && plan.lines.some(entry => Number(entry.line?.ownerId ?? entry.line?.sourceId) === id),
        `the hunter's shot purchase reads the crafter's line (${JSON.stringify(plan?.lines?.map(entry => entry.line?.ownerId))})`);
    const bought = await Cold.buyHere(hunter, plan);
    assert.strictEqual(bought.units, 1000, 'the hunter bought 1000 D soulshots');
    assert.strictEqual(units(await Database.fetchItems(hunter.characterId), D_SS), 1000, 'in its bag');
    assert.strictEqual(bought.spent, 1000 * line.price, 'at the crafter\'s ask');

    // 4. The crafter's next visit pays the store its cost a unit for the 1000 sold, out of the
    // sale's proceeds.
    const wallet = async () => units(await Database.fetchItems(id), 57);
    crafter = await LifeState.upsertState({ ...crafter, adena: await wallet(),
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)) }, 'crafter_shot_sale') || crafter;
    crafter = await Cold.crafterStock(crafter);
    assert.strictEqual(await wallet(), adena + bought.spent - 1000 * cost, 'the visit pays the cost of the sold units');
    assert.strictEqual(crafter.adena, adena + bought.spent - 1000 * cost, 'its state follows the wallet');
    let trades = [];
    for (let attempt = 0; attempt < 50 && !trades.length; attempt++) {
        trades = await Database.readHistory(['SELECT * FROM market_trades WHERE channel = ? AND buyerCharacterId = ?', ['fixed_wts', id]]);
        if (!trades.length) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(trades.map(trade => [Number(trade.selfId), Number(trade.quantity), Number(trade.unitPrice)]),
        [[D_SS, 1000, cost]], 'one fixed_wts purchase journalled at the cost');

    // 5. A hunter arriving in Giran with part of its target D soulshots, above its one-hour
    // line (no trip of its own), tops them up at the crafter's line and leaves with its target.
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    let topped = await seed({ classId: 0, level: 25, adena: hunterAdena,
        items: [{ selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }] });
    const toppedSteps = require('../src/GameServer/Bot/Economy/EconomicTrip').prepare(topped);
    do next = toppedSteps.next(); while (!next.done);
    const packet = Economy.forState(topped, { timestamp: now, routeRows: next.value }).statsPacket;
    // Short of its target by a twentieth of the crafter's lot, which its line covers.
    const held = Economy.keptKit({ ...topped, stats: { ...topped.stats, ...packet } }).stock('shots').target - Stock.SHOT_STOCK_UNITS / 20;
    await Database.setItem(topped.characterId, { selfId: D_SS, name: 'Soulshot: D-grade', amount: held, equipped: false, slot: 0, enchant: 0 });
    topped = await LifeState.upsertState({ ...topped, stats: { ...topped.stats, ...packet },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(topped.characterId)) }, 'crafter_shot_topped');
    const before = Economy.keptKit(topped).stock('shots');
    assert(before.current === held && held >= before.line && held < before.target,
        `the hunter holds ${held} D soulshots, at or above its line ${before.line}, below its target ${before.target}`);
    // The crafter shows its restocked D soulshots on its board line again.
    const shown = (await Database.fetchItems(id)).find(item => Number(item.selfId) === D_SS);
    await Afk.publishBot(id, { kind: 'shop', storeType: Afk.SELL, town: 'Giran', title: 'Shots',
        lines: [{ objectId: shown.id, selfId: D_SS, name: shown.name, count: Number(shown.amount), price: line.price, enchant: 0, stackable: true, slot: 0 }] });
    await Cold.finishTownErrands(topped);
    assert.strictEqual(units(await Database.fetchItems(topped.characterId), D_SS), before.target,
        `the hunter leaves Giran with its target ${before.target} D soulshots`);

    console.log('crafter shot stock: ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
});

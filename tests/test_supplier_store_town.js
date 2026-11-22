// A supplier's store town (SupplierRoles.storeTown): a quarter of the D suppliers sit in
// Dion and half of the C+ suppliers in Giran (the grade's trade hub), the rest in the towns
// where that grade's bots arrive to shop, more where more arrive. A town arrival is counted
// once whichever way it comes: a far bot's step into town at its commit, a near body's
// arrival. A D crafter whose shop stands in the Dark Elven Village and whose seat is in
// Gludin (where the D bots arrive) takes Gludin at its restock, stocks there and moves its
// shop with its D soulshots to Gludin; standing elsewhere, it travels to Gludin with its lines.
const assert = require('assert');
const fs = require('fs');

process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('supplier-store-town');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };

const D_SS = 1463;
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const at = name => Town.marketTown(name).center;

// The share of `count` seated suppliers (characterIds 1..count) in each town.
function seats(Roles, stats, arrivals, count = 2000, base = {}) {
    const towns = new Map();
    for (let id = 1; id <= count; id++) {
        const town = Roles.storeTown({ characterId: id, ...base, stats: { ...stats } }, () => arrivals);
        towns.set(town, (towns.get(town) || 0) + 1 / count);
    }
    return towns;
}
const near = (actual, expected, label) => assert(Math.abs((actual || 0) - expected) < 0.02,
    `${label}: ${(actual || 0).toFixed(3)} vs ${expected.toFixed(3)}`);

(async () => {
    await Database.init(); DataCache.init(); await LifeState.init(); await Afk.init();
    const Roles = invoke('GameServer/Bot/Economy/SupplierRoles');
    const Arrivals = invoke('GameServer/Bot/Economy/TownArrivals');
    const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
    const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
    assert.deepStrictEqual({ ...Roles.HUB_SHARE }, { d: 0.25, 'c+': 0.5 }, 'a quarter of D\'s suppliers in Dion, half of C+\'s in Giran');

    // 1. D crafters (Create Item 3: D shots, no C shot): Dion keeps its quarter plus its
    // arrivals' part; Gludin, with three times Dion's D arrivals, the rest.
    const dCrafter = { classId: 57, dwarvenCraftLevel: 3 };
    const dArrivals = new Map([['Gludin', 300], ['Dion', 100]]);
    assert.strictEqual(Roles.gradeGroupOf({ stats: dCrafter }), 'd');
    const d = seats(Roles, dCrafter, dArrivals);
    near(d.get('Dion'), 0.25 + 0.75 * 100 / 400, 'D crafters in Dion');
    near(d.get('Gludin'), 0.75 * 300 / 400, 'D crafters in Gludin');
    assert(d.get('Gludin') > d.get('Dion'), 'the town where most D bots arrive holds the most D suppliers');

    // 2. C+ crafters (Create Item 5) and C spoilers: Giran keeps half; Oren (three times
    // Gludin's C+ arrivals) three times Gludin's suppliers.
    const cArrivals = new Map([['Oren', 300], ['Gludin', 100]]);
    for (const [label, stats, base] of [['C crafters', { classId: 57, dwarvenCraftLevel: 5 }, {}],
        ['C spoilers', { classId: 55 }, { level: 45 }]]) {
        const c = seats(Roles, stats, cArrivals, 2000, base);
        near(c.get('Giran'), 0.5, `${label} in Giran`);
        near(c.get('Oren'), 0.5 * 0.75, `${label} in Oren`);
        near(c.get('Gludin'), 0.5 * 0.25, `${label} in Gludin`);
        assert(!c.get('Dion'), `${label}: Dion is no hub of theirs and no C+ bot arrives there`);
    }
    // No arrival yet: every supplier sits in its hub; a station trader keeps its seat.
    assert.deepStrictEqual([...seats(Roles, dCrafter, new Map(), 200).keys()], ['Dion']);
    assert.strictEqual(Roles.storeTown({ characterId: 1, stats: { classId: 57, stationTrader: { slot: 0, town: 'Oren' } } },
        () => cArrivals), null);

    // 2b. The arrivals counted: a far D hunter's step from its spot into Gludin (committed on
    // main), a near D body's arrival in the Dark Elven Village, each once by its town and
    // grade; a far step that stays in the field, a C hunter and a station trader count
    // nowhere under D. Orc Village hunters who shop in Gludin are Gludin's.
    Arrivals.reset();
    const dHunter = { characterId: 9001, phase: 'cold', level: 25, activity: 'hunting', currentRegion: 'Orc Village', stats: {} };
    const inGludin = { ...dHunter, activity: 'shopping', currentRegion: 'Gludin' };
    Arrivals.committed(dHunter, inGludin);
    Arrivals.committed(dHunter, { ...dHunter, activity: 'resting' });
    Arrivals.committed({ ...dHunter, level: 45 }, { ...inGludin, level: 45 });
    Arrivals.committed(dHunter, { ...inGludin, stats: { stationTrader: { slot: 0, town: 'Gludin' } } });
    Arrivals.arrived({ ...dHunter, phase: 'hot' }, 'Dark Elven Village');
    assert.deepStrictEqual([...Arrivals.arrivals('d')], [['Gludin', 1], ['Dark Elven Village', 1]], 'one D arrival in each town');
    assert.deepStrictEqual([...Arrivals.arrivals('c+')], [['Gludin', 1]], 'the C hunter under C+');
    Arrivals.reset();

    // 3. The game: a D crafter, seated in Gludin, its shop in the Dark Elven Village.
    for (let n = 0; n < 1000; n++) Arrivals.arrived({ level: 25, stats: {} }, 'Gludin');
    let serial = 0, id = 0, account = '', name = '';
    // The seat is a fixed point by characterId: the first character whose seat is past Dion's quarter.
    do {
        account = `bot_store_town_${++serial}`; name = `StoreTown${serial}`;
        await Database.createAccount(account, 'secret');
        const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === 57)?.template?.race || 0);
        const dev = at('Dark Elven Village');
        id = Number((await Database.createCharacter(account, { name, race, classId: 57, maxHp: 3000, maxMp: 1200,
            sex: 0, face: 0, hair: 0, hairColor: 0, locX: dev.locX, locY: dev.locY, locZ: dev.locZ })).insertId);
    } while (Roles.storeTown({ characterId: id, stats: dCrafter }) !== 'Gludin');
    await Database.execute(['UPDATE characters SET level=?, exp=? WHERE id=?', [30, Number(DataCache.experience[29]), id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, equipped: false, slot: 0, enchant: 0 });
    await Database.setItem(id, { selfId: D_SS, amount: 5000, equipped: false, slot: 0, enchant: 0 });
    const now = Date.now();
    const noGear = { c: { pieces: 0, at: now }, b: { pieces: 0, at: now }, a: { pieces: 0, at: now } };
    const standing = (state, town) => LifeState.upsertState({ ...state, currentRegion: town, loc: at(town), activity: 'shopping' },
        'store_town_fixture');
    let crafter = await LifeState.upsertState({ characterId: id, accountName: account, name, level: 30, phase: 'cold',
        activity: 'shopping', currentRegion: 'Dark Elven Village', spotId: null, adena: 1000000, loc: at('Dark Elven Village'),
        vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { ...dCrafter, generatedCold: true, gnomeAllowance: noGear,
            gnomeStock: { [D_SS]: { cost: 70, ceiling: Stock.shotCeiling(D_SS), owed: 5000 } },
            money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000, moneyPrice: 0.00001,
                refillReserve: 0, firstUnfundedPrice: 0 }) },
        timing: { activityStartedAt: now - 60000, lastResolvedAt: now - 1000, nextResolveAt: now } }, 'store_town_fixture');
    // Its committed step from the field into Gludin is one D arrival there (BotLifeState's commit).
    const arrivedBefore = Arrivals.arrivals('d').get('Gludin');
    crafter = await LifeState.upsertState({ ...crafter, activity: 'hunting', currentRegion: null }, 'store_town_fixture');
    crafter = await LifeState.upsertState({ ...crafter, activity: 'shopping', currentRegion: 'Gludin', loc: at('Gludin') }, 'store_town_fixture');
    assert.strictEqual(Arrivals.arrivals('d').get('Gludin'), arrivedBefore + 1, 'its arrival in Gludin counted once');
    crafter = await standing(crafter, 'Dark Elven Village');
    // Before any restock it has no store town: its shop opens where it stands.
    let listed = await Market.listOnBoard(crafter, { decided: Market.saleDecision(crafter, { now }), now });
    assert.strictEqual(Afk.findOwnerProjection(id)?.shop?.town, 'Dark Elven Village', `a shop in the Dark Elven Village (${listed.reason})`);

    // Its restock in the Dark Elven Village seats it in Gludin; a sale there sends it to Gludin with its lines.
    crafter = await Cold.crafterStock(await standing(LifeState.cachedState(id), 'Dark Elven Village'));
    assert.strictEqual(crafter.stats.storeTown?.town, 'Gludin', 'its store town is Gludin');
    crafter = await LifeState.upsertState(crafter, 'store_town_fixture') || crafter;
    listed = await Market.listOnBoard(crafter, { decided: Market.saleDecision(crafter, { now }), now });
    assert.strictEqual(listed.shopTown, 'Gludin', 'it takes its lines to Gludin');
    assert.strictEqual(Afk.findOwnerProjection(id)?.shop?.town, 'Dark Elven Village', 'its shop stays until it stands in Gludin');

    // In Gludin: its restock stocks Gludin's D soulshots, its shop moves there with them.
    crafter = await Cold.crafterStock(await standing(LifeState.cachedState(id), 'Gludin'));
    crafter = await LifeState.upsertState(crafter, 'store_town_fixture') || crafter;
    listed = await Market.listOnBoard(crafter, { decided: Market.saleDecision(crafter, { now }), now });
    assert.strictEqual(listed.shopTown, null, `it lists where it stands (${listed.reason || ''})`);
    const shop = Afk.findOwnerProjection(id)?.shop;
    assert(shop && shop.town === 'Gludin', `its shop stands in Gludin (${shop?.town})`);
    assert.strictEqual(Afk.ownerRecords(id).filter(record => record.kind === 'shop').length, 1, 'one shop, the old one closed');
    const shots = shop.lines.filter(line => Number(line.selfId) === D_SS);
    assert.strictEqual(shots.length, 1, `its D soulshots in the Gludin shop (${shop.lines.map(line => line.selfId)})`);
    assert(Number(shots[0].count) >= 5000, `the whole stack (${shots[0].count})`);
    Arrivals.reset();

    console.log('supplier store town: ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
});

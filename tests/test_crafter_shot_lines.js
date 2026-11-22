// A crafter's graded shots take its board places before its gear: a Warsmith (a dwarf:
// four shop lines) standing in Gludin with four consigned C swords and 20000 consigned
// D soulshots, the swords bid for and the shots traded there lately, opens its shop in Gludin (it has a
// square for shops) and lists the D soulshots in it, the whole stack at one line, the
// gear in the three lines left and its sell ads; with no interest in them the shots
// keep the price order (gear first). It asks the anchor, above its cost: a consigned unit is owed only when sold, an unsold one stays its stock for the
// next buyer, so a slow tail of the stack is no loss to it. A graded shot keeps one price,
// the anchor: deals at a cheaper line in its town leave its ask there.
const assert = require('assert');
const fs = require('fs');

process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('crafter-shot-lines');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };

const D_SS = 1463, SWORDS = [72, 73, 74, 76];
const GLUDIN = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Gludin').center;

(async () => {
    await Database.init(); DataCache.init(); await LifeState.init(); await Afk.init();
    const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
    const Flow = require('../src/GameServer/Bot/Economy/MarketTradeDemand');
    const now = Date.now();

    const account = 'bot_shot_lines_1', name = 'ShotLines1', classId = 57;
    await Database.createAccount(account, 'secret');
    const race = Number(DataCache.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
    const id = Number((await Database.createCharacter(account, { name, race, classId, maxHp: 3000, maxMp: 1200,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: GLUDIN.locX, locY: GLUDIN.locY, locZ: GLUDIN.locZ })).insertId);
    await Database.execute(['UPDATE characters SET level=?, exp=? WHERE id=?', [40, Number(DataCache.experience[39]), id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, equipped: false, slot: 0, enchant: 0 });
    for (const sword of SWORDS) await Database.setItem(id, { selfId: sword, amount: 1, equipped: false, slot: 0, enchant: 0 });
    await Database.setItem(id, { selfId: D_SS, amount: 20000, equipped: false, slot: 0, enchant: 0 });
    // Every unit is its consigned stock (CrafterStock: cost, ceiling, owed).
    const cost = Math.max(1, Math.floor(invoke('GameServer/Bot/Economy/PriceAnchor').shotAnchor(D_SS)
        * invoke('GameServer/Bot/Economy/SupplierRoles').COST_RATE));
    const gnomeStock = { [D_SS]: { cost, ceiling: Stock.shotCeiling(D_SS), owed: 20000 } };
    for (const sword of SWORDS) gnomeStock[sword] = { cost: 1000000, ceiling: Stock.askCeiling(sword), owed: 1 };
    const crafter = await LifeState.upsertState({ characterId: id, accountName: account, name, level: 40, phase: 'cold',
        activity: 'shopping', currentRegion: 'Gludin', spotId: null, adena: 1000000, loc: GLUDIN,
        vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId, generatedCold: true, gnomeStock,
            money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000, moneyPrice: 0.00001,
                refillReserve: 0, firstUnfundedPrice: 0 }) },
        timing: { activityStartedAt: now - 60000, lastResolvedAt: now - 1000, nextResolveAt: now } }, 'crafter_shot_lines_fixture');
    assert.strictEqual(invoke('GameServer/AfkTrade/BoardRules').shopLines(crafter, Afk.SELL), 4, 'a dwarf shop holds four lines');

    // 1. With no interest in any of them the shots keep the price order: the swords fill the shop.
    Flow.reset();
    const quiet = Market.saleDecision(crafter, { now }).listings;
    assert.deepStrictEqual(quiet.map(item => Number(item.selfId)).sort((a, b) => a - b), [...SWORDS, D_SS].sort((a, b) => a - b),
        'the sale lists the four swords and the shots');
    assert.notStrictEqual(Number(Listing.prioritizeListings(quiet, { board: Afk.boardIndex(), characterId: id, timestamp: now })
        .slice(0, 4).find(item => Number(item.selfId) === D_SS)?.selfId), D_SS, 'unwanted shots wait behind the gear');

    // 2. Another bot bids for each sword at its ceiling (the gear's strongest interest), and
    // the D soulshots traded in Gludin within the hour: the shots still come first.
    Afk.boardIndex().put({ id: 990001, ownerId: id + 1000, kind: 'buy_ad', storeType: 3, town: 'Gludin',
        lines: SWORDS.map((sword, at) => ({ id: 990010 + at, selfId: sword, count: 1, price: Stock.askCeiling(sword) })) });
    Flow.deal(D_SS, 3000, 'Gludin', now - 600000); Flow.deal(D_SS, 3000, 'Gludin', now - 300000);
    const decided = Market.saleDecision(crafter, { now });
    const ranked = Listing.prioritizeListings(decided.listings, { board: Afk.boardIndex(), characterId: id, timestamp: now });
    assert.strictEqual(Number(ranked[0].selfId), D_SS, `the wanted D soulshots rank first (${ranked.map(item => item.selfId)})`);

    // 3. Before it lists, the D soulshots have been dealing at the crafters' cost and its
    // town's buyers take some 3000 (a known town demand): the stack's ask is above its cost,
    // not at it; a hunter's same stack of loot, whose unsold units are worth only the NPC
    // buy-back, asks lower to clear it.
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    for (let n = 0; n < 12; n++) Counters.deal(D_SS, cost, 2000, now - n * 60000, id + 2000 + n, 'Gludin', id + 3000 + n);
    const demand = units => (selfId, enchant, town) => Number(selfId) !== D_SS || enchant ? null : { known: true,
        selfId: D_SS, enchant: 0, town, origin: 'public_market_demand', authority: { selfId: D_SS, revision: 1 },
        applicableUnits: units, delayHours: 0, observedAt: now, availability: { from: now, until: now } };
    const shotAsk = (state, units) => Number(Market.saleDecision(state, { now, demandFor: demand(units) }).listings
        .find(item => Number(item.selfId) === D_SS)?.price);
    const ask = shotAsk(crafter, 3000);
    assert.strictEqual(ask, Stock.shotCeiling(D_SS), `the crafter's ask ${ask} is the anchor, above its cost ${cost}`);
    // The ask each would choose for the stack (MarketPricing.priceForSale, before the
    // crafter's [cost, ceiling] bounds).
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const chosen = state => Pricing.priceForSale(D_SS, Listing.traderContext(state, { now, demandFor: demand(3000) }),
        { town: 'Gludin', units: 20000, rollKey: ['shot-ask'] }).ask;
    const loot = chosen({ ...crafter, stats: { ...crafter.stats, gnomeStock: {} } });
    assert(loot.known && !loot.npc && loot.price < chosen(crafter).price,
        `a hunter's loot asks less (${loot.price} vs ${chosen(crafter).price})`);

    // 4. Its listing in Gludin: a shop there, the D soulshots in it, the gear after them.
    const listed = await Market.listOnBoard(crafter, { decided, now });
    assert.strictEqual(listed.shopTown, null, `it opens its shop where it stands (${listed.reason || ''})`);
    const shop = Afk.findOwnerProjection(id)?.shop;
    assert(shop && Number(shop.storeType) === Afk.SELL && shop.town === 'Gludin', `a sell shop in Gludin (${shop?.town})`);
    assert(invoke('GameServer/Bot/Economy/ShopPlaces').isStallArea('Gludin', shop), 'on the Gludin square');
    const shots = shop.lines.filter(line => Number(line.selfId) === D_SS);
    assert.strictEqual(shots.length, 1, `one D soulshot line in the shop (${shop.lines.map(line => line.selfId)})`);
    assert.strictEqual(Number(shots[0].count), 20000, 'the whole stack');
    assert.strictEqual(Number(shots[0].price), Stock.shotCeiling(D_SS), `ask ${shots[0].price} at the anchor`);
    assert.strictEqual(shop.lines.length, 4, 'the shop is full');
    const ads = Afk.ownerRecords(id).filter(record => record.kind === 'sell_ad');
    const gear = [...shop.lines, ...ads.flatMap(record => record.lines)].map(line => Number(line.selfId)).filter(sid => sid !== D_SS);
    assert.deepStrictEqual(gear.sort((a, b) => a - b), SWORDS, 'the four swords in the three shop lines left and an ad');

    // 5. Deals at 40 in its town pass the crafter's line: at its next look (a town arrival)
    // it still asks its ceiling, the anchor (a graded shot keeps one price).
    const line = Afk.boardIndex().ownerLines(id).find(row => Number(row.selfId) === D_SS);
    const ceiling = Stock.shotCeiling(D_SS), later = now + 600000;
    assert.strictEqual(Number(line.price), ceiling, `the crafter lists its stack at its ceiling (${line.price})`);
    for (let n = 0; n < 6; n++) Counters.deal(D_SS, 40, 1000, later + n, id + 9000, 'Gludin', id + 5000 + n);
    const looked = invoke('GameServer/Bot/Economy/MarketPricing').lookOwn(crafter, Afk.boardIndex().ownerLines(id),
        Listing.traderContext(crafter, { now: later + 100 }));
    assert(!looked?.reprices.some(move => Number(move.selfId) === D_SS), 'the D soulshot line keeps the anchor');
    assert(!looked?.withdrawals.some(move => Number(move.selfId) === D_SS), 'the D soulshot line stays listed');

    console.log('crafter shot lines: ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
});

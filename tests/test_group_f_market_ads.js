const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
process.env.L2NODE_PROGRESSION_RATE = 'x1';
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const World = invoke('GameServer/World/World');
const scratch = path.join(process.cwd(), 'tmp', 'test-group-f-ads');
fs.mkdirSync(scratch, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratch, 'world-'));
const original = { roll: PriceDecision.chooseByWeight, trip: ColdMarket.tripFrom };
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`PASS ${name}`); } catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.message}`); }
}

async function run() {
    DataCache.init();
    await check('low-grade market does not depend on rate name', () => {
        const item = DataCache.items.find(row => /^(Weapon|Armor)\./.test(row.template?.kind)
            && Disposition.gradeIndex(row.etc?.rank) < Disposition.gradeIndex('c')
            && !ListingPolicy.starterItemIds().has(Number(row.selfId)));
        assert(item);
        for (const rate of ['x1', 'x10', 'x50']) {
            process.env.L2NODE_PROGRESSION_RATE = rate;
            assert.equal(ListingPolicy.classify({ stats: {} }, { selfId: Number(item.selfId),
                kind: item.template.kind, rank: item.etc?.rank, count: 1,
                basePrice: item.template.price, enchant: 0 }).action, 'market', rate);
        }
        process.env.L2NODE_PROGRESSION_RATE = 'x1';
    });
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    await check('new town ad coordinates belong to the named town', () => {
        for (const name of ["Hunter's Village", 'Aden', 'Rune', 'Goddard', 'Floran Village']) {
            const town = Object.values(TownRespawn.towns).find(row => row.name === name);
            const center = ListingService.townCenter(name);
            assert(center && Math.hypot(center.locX - town.locX, center.locY - town.locY) < 2500,
                `${name} must not use Giran coordinates`);
        }
    });
    await check('five captured squares allow bot shops', () => {
        for (const town of ['Oren', "Hunter's Village", 'Aden', 'Rune', 'Goddard']) {
            assert(ShopPlaces.SHOP_TOWNS.includes(town), `${town} belongs to shop town choices`);
            const loc = ShopPlaces.take(town, `test:group-f:${town}`);
            assert(loc && ShopPlaces.isStallArea(town, loc), `${town} uses its captured polygon`);
        }
        ShopPlaces._resetForTests();
    });
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    const create = async (name) => {
        const account = `bot_group_f_${name}`;
        await Database.createAccount(account, 'pw');
        const id = Number((await Database.createCharacter(account, { name, race: 0, classId: 0,
            maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 83396, locY: 147904, locZ: -3400 })).insertId);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000000,
            enchant: 0, equipped: false, slot: 0 });
        return id;
    };
    const stateFor = async (id, name) => LifeState.upsertState({ characterId: id,
        accountName: `bot_group_f_${name}`, name, phase: 'cold', activity: 'shopping', level: 45,
        adena: 10000000, loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, shopTown: { town: 'Giran', at: 1 } }, timing: {} }, 'test-group-f-ads');
    let demandTown = 'Oren';
    ColdMarket.tripFrom = () => () => 0;
    // Pin only the existing random chooser. The real town values come from
    // actual counter deals and the real opening path persists/escrows the ad.
    PriceDecision.chooseByWeight = (choices) => choices.reduce((best, next) => next.value > best.value ? next : best);
    const seedDemand = (selfId) => {
        Counters.reset();
        Counters.deal(selfId, 1000, 20, Date.now(), 999999, demandTown, 999998);
    };
    await check('buy ad opening uses shop town demand and keeps its town', async () => {
        const id = await create('Buyer');
        let state = await stateFor(id, 'Buyer');
        const goal = { type: 'upgrade_gear', status: 'active', target: { itemId: 45, itemName: 'Bone Helmet', adena: 1000000 },
            plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran', priceSource: 'offer' } };
        seedDemand(45);
        const opened = await Market.openBuyAd(state, goal, 'Giran');
        assert.equal(opened.store?.town, demandTown, 'caller town/grade fallback cannot replace weighted opening');
        const recordId = opened.store.id;
        demandTown = 'Aden'; seedDemand(45);
        state = LifeState.snapshot(id);
        await Market.reconcile(state, goal);
        assert.equal(AfkTrade.ownerRecords(id).find(record => record.kind === 'buy_ad')?.town, 'Oren');
        assert.equal(AfkTrade.ownerRecords(id).find(record => record.kind === 'buy_ad')?.id, recordId,
            'a demand change alone does not replace a standing ad');
        seedDemand(46);
        const nextGoal = { ...goal, target: { ...goal.target, itemId: 46,
            itemName: DataCache.items.find(row => Number(row.selfId) === 46).template.name } };
        const next = await Market.reconcile(LifeState.snapshot(id), nextGoal);
        assert.equal(next.shop?.town, 'Aden', 'a different wanted item chooses a new ad town');
        assert(Math.hypot(next.shop.locX - 147453, next.shop.locY - 26951) < 10,
            'the persisted Aden ad uses its captured square coordinates');
        const pk = await Market.openBuyAd({ ...LifeState.snapshot(id), stats: { ...LifeState.snapshot(id).stats, karma: 100 } }, nextGoal);
        assert.equal(pk.store?.town, 'Floran Village', 'a continuing ad in a closed town moves to Floran for a PK');
        await Market.withdraw(id);
    });
    await check('sell ad uses weighted opening and keeps its town', async () => {
        const id = await create('Seller');
        const listings = [];
        for (const selfId of [1864, 1865, 1866, 1867]) {
            const template = DataCache.items.find(row => Number(row.selfId) === selfId);
            await Database.setItem(id, { selfId, name: template.template.name, amount: 100,
                enchant: 0, equipped: false, slot: 0 });
            listings.push({ selfId, name: template.template.name, count: 100, price: 10000 });
        }
        const state = await stateFor(id, 'Seller');
        demandTown = 'Oren'; seedDemand(1867);
        const result = await Market.listOnBoard(state, { decided: { listings }, now: Date.now() });
        assert.equal(result.listed, 4, 'three shop lines and one sell ad');
        const ad = AfkTrade.ownerRecords(id).find(record => record.kind === 'sell_ad');
        assert.equal(ad?.town, demandTown, 'the excess line uses the shop opening algorithm');
        demandTown = 'Aden'; seedDemand(1867);
        await Market.listOnBoard(LifeState.snapshot(id), { decided: { listings }, now: Date.now() });
        const retained = AfkTrade.ownerRecords(id).find(record => record.kind === 'sell_ad');
        assert.equal(retained?.id, ad.id); assert.equal(retained?.town, 'Oren');
        await Market.withdraw(id);
    });
    await check('karma ad opening stays in Floran', async () => {
        const id = await create('KarmaBuyer');
        const state = await stateFor(id, 'KarmaBuyer');
        const result = await Market.openBuyAd({ ...state, stats: { ...state.stats, karma: 100 } },
            { type: 'upgrade_gear', target: { itemId: 45, itemName: 'Bone Helmet', adena: 1000000 },
                plan: { expectedBenefit: 'market_search_for_gear', priceSource: 'offer', marketTown: 'Giran' } }, 'Giran');
        assert.equal(result.store?.town, 'Floran Village'); await Market.withdraw(id);
    });
    assert.equal(failures.length, 0, `${failures.length} group F contracts failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    PriceDecision.chooseByWeight = original.roll; ColdMarket.tripFrom = original.trip;
    Counters.reset(); ShopPlaces._resetForTests(); await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('group-f-market-ads');
useRate('x1');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const World = invoke('GameServer/World/World');
const NativeChoice = require('./helpers/nativeMarketChoice');
const directory = isolated.directory;
const original = { roll: PriceDecision.chooseByWeight };
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`PASS ${name}`); } catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.message}`); }
}

async function run() {
    DataCache.init();
    await check('low-grade market does not depend on rate name', () => {
        const starterIds = new Set((DataCache.newbieItems || []).flatMap((row) => (row.items || []).map((item) => Number(item.selfId))));
        const item = DataCache.items.find(row => /^(Weapon|Armor)\./.test(row.template?.kind)
            && Disposition.gradeIndex(row.etc?.rank) < Disposition.gradeIndex('c')
            && !starterIds.has(Number(row.selfId)));
        assert(item);
        for (const rate of ['x1', 'x10', 'x50']) {
            useRate(rate);
            assert.equal(ListingPolicy.classify({ stats: {} }, { selfId: Number(item.selfId),
                kind: item.template.kind, rank: item.etc?.rank, count: 1,
                basePrice: item.template.price, enchant: 0 }).action, 'market', rate);
        }
        useRate('x1');
    });
    useRate('x1');
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
    const capture = async (state, label) => NativeChoice.capture(state, { nativeRoutes: true }, label);
    const captureCurrent = async (state, label) => {
        const native = await capture(state, `${label}_packet`);
        const published = await LifeState.upsertState(native.state, 'test-group-f-native-packet');
        const current = await capture(published, label);
        assert.deepEqual(published.stats.money, current.captured.statsPacket.money,
            'the current native budget is physically published for reconciliation');
        return current;
    };
    const stateFor = async (id, name, { loc = { locX: 83396, locY: 147904, locZ: -3400 },
        currentRegion = 'Giran', karma = 0, level = 30 } = {}) => {
        const previous = LifeState.snapshot(id);
        const kit = require('./fixtures/profitable_stock_state').kitFor(0, level);
        const missing = kit.entries.find(item => Number(item.slot) === 6);
        assert(missing, 'the native kit has a helmet slot');
        for (const item of await Database.fetchItems(id)) {
            if (item.equipped && /^(Weapon|Armor)\./.test(DataCache.items.find(row => Number(row.selfId) === Number(item.selfId))?.template?.kind)) {
                await Database.deleteItem(id, item.id);
            }
        }
        for (const item of kit.entries.filter(item => Number(item.selfId) !== Number(missing.selfId))) {
            const template = DataCache.items.find(row => Number(row.selfId) === Number(item.selfId));
            await Database.setItem(id, { selfId: item.selfId, name: template.template.name,
                amount: 1, equipped: true, slot: item.slot, enchant: 0 });
        }
        const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
        const state = await LifeState.upsertState({ characterId: id,
            accountName: `bot_group_f_${name}`, name, phase: 'cold', activity: 'shopping', level,
            exp: Number(DataCache.experience[level - 1]), adena: Number(inventory[57]?.amount || 0), loc: { ...loc }, currentRegion,
            inventory,
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { ...previous?.stats, classId: 0, karma, generatedCold: true, shopTown: { town: 'Giran', at: 1 } }, timing: {} }, 'test-group-f-ads');
        const native = await capture(state, `group_f_${name}_budget`);
        for (const wish of native.captured.queue.filter(row => row.key.startsWith('stock:'))) {
            const amount = Number(wish.object?.amount), selfId = Number(wish.object?.itemId);
            assert(Number.isSafeInteger(amount) && amount > 0 && selfId > 0, 'native stock preparation supplies actual demanded units');
            const template = DataCache.items.find(item => Number(item.selfId) === selfId);
            await Database.setItem(id, { selfId, name: template.template.name, amount,
                equipped: false, slot: 0, enchant: 0 });
        }
        const published = await LifeState.upsertState({ ...native.state,
            inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)) }, 'test-group-f-native-budget');
        return { ...await captureCurrent(published, `group_f_${name}_current`), missing };
    };
    // Category deals in Oren: since 8c589920 they are not an item forecast and
    // must not move an opening to Oren.
    const demandTown = 'Oren';
    // Pin only the existing random chooser. The real town values come from
    // actual counter deals and the real opening path persists/escrows the ad.
    PriceDecision.chooseByWeight = (choices) => choices.reduce((best, next) => next.value > best.value ? next : best);
    const seedDemand = (selfId) => {
        Counters.reset();
        Counters.deal(selfId, 1000, 20, Date.now(), 999999, demandTown, 999998);
    };
    // 8c589920: category counter deals are no longer item demand. A new buy
    // ad opens in the grade/location table town (buyAdTown ->
    // targetTownForItems); a sell ad opens by MarketTownPolicy.shopTown, whose
    // supported-forecast branch needs an item demand context the main thread
    // does not pass, so it takes the same table. Standing records keep their
    // towns when the table answer later changes (the bot moved).
    const TI = { locX: -84700, locY: 244200, locZ: -3730 };
    const moveTo = async (id, loc, region) => (await captureCurrent(await LifeState.upsertState({ ...LifeState.snapshot(id),
        loc: { ...loc }, currentRegion: region }, 'test-group-f-ads-move'), `group_f_move_${id}`)).state;
    const gearGoal = native => {
        const wanted = native.captured.queue.find(row => row.key === native.read.activity?.rootKey);
        const advice = native.goals.find(row => row.type === 'upgrade_gear'
            && Number(row.target?.itemId) === Number(wanted?.object?.itemId));
        assert(wanted?.funded && !native.read.activity?.funding && advice,
            'a direct ad requires a genuinely funded native gear purchase');
        assert(Number(advice.target.adena) > 0 && advice.target.adena === native.read.activity.unitPrice
            && Number(advice.plan.valueRate) > 0, 'the exact native purchase supplies its unit quote and value rate');
        // Preserve this test's explicit direct-ad input. The independently
        // selected source executor remains advice, never an ad instruction.
        return { type: 'upgrade_gear', status: 'active', target: { ...advice.target },
            plan: { expectedBenefit: 'market_search_for_gear', priceSource: 'offer',
                estimatedCost: advice.target.adena, marketTown: advice.plan.marketTown,
                valueRate: advice.plan.valueRate } };
    };
    const floranSource = async (native, name) => {
        const goal = gearGoal(native), sourceId = await create(name);
        const town = 'Floran Village', loc = ListingService.townCenter(town);
        const item = DataCache.items.find(row => Number(row.selfId) === goal.target.itemId);
        const stockId = Number((await Database.setItem(sourceId, { selfId: item.selfId,
            name: item.template.name, amount: 1, equipped: false, slot: item.etc.slot, enchant: 0 })).insertId);
        const sale = await Database.createAfkTradeShop(sourceId, { storeType: AfkTrade.SELL, town, ...loc,
            lines: [{ objectId: stockId, selfId: item.selfId, name: item.template.name, count: 1,
                price: Number(item.template.price), enchant: 0, slot: item.etc.slot, stackable: false }] });
        assert(!sale.ownerInventory.some(row => Number(row.selfId) === goal.target.itemId),
            'the real seller places the selected helmet in native shop custody');
        AfkTrade.refreshRecord(sale.shop);
        console.log('Physical Floran source:', JSON.stringify({ buyer: native.state.characterId, sourceId,
            recordId: sale.shop.id, line: sale.shop.lines[0] }));
        return sourceId;
    };
    const moveToKarma = async (native, label) => {
        const current = LifeState.snapshot(native.state.characterId);
        assert.equal(current.characterId, native.state.characterId, 'the prior native focus belongs to this same owner');
        assert.equal(native.captured.statsPacket.wishFocus?.[0], native.read.activity.rootKey,
            'the retained focus is the same actor\'s actual previously selected native root');
        const stats = { ...current.stats, wishFocus: native.captured.statsPacket.wishFocus, karma: 100 };
        if (native.state.stats.equipmentPlan) stats.equipmentPlan = native.state.stats.equipmentPlan;
        const state = await LifeState.upsertState({ ...current, loc: ListingService.townCenter('Floran Village'),
            currentRegion: 'Floran Village', stats }, 'test-group-f-karma-move');
        return captureCurrent(state, label);
    };
    await check('buy ad opening uses the shop town table and keeps its town', async () => {
        const id = await create('Buyer');
        const native = await stateFor(id, 'Buyer');
        let state = native.state;
        const wanted = native.captured.queue.find(row => row.key === native.read.activity?.rootKey);
        const goal = gearGoal(native);
        assert(wanted?.object?.slot === native.missing.slot && wanted.funded && !native.read.activity?.funding,
            'the advertised item is genuinely useful and funded by the native gear review');
        const advice = native.goals.find(row => row.target?.itemId === goal.target.itemId && row.plan?.sourceType === 'npc');
        assert(advice, 'the selected canonical purchase has a native executor');
        assert.equal((await Market.openBuyAd(native.state, advice)).opened, false,
            'a selected NPC purchase never becomes an executing advertisement');
        state = native.state;
        await Market.reconcile(state, null);
        assert.equal(AfkTrade.ownerRecords(id).filter(record => record.kind === 'buy_ad').length, 0,
            'watching native gear advice alone does not execute an advertisement');
        seedDemand(goal.target.itemId);
        const opened = await Market.openBuyAd(state, goal, 'Giran');
        assert.equal(opened.opened, true, `the useful native bid opens: ${JSON.stringify({ reason: opened.reason, goal })}`);
        const tableTown = MarketTownPolicy.targetTownForItems(state, [{ selfId: goal.target.itemId }]);
        assert.notEqual(tableTown, 'Giran', 'D-grade stock has its own market town');
        assert.equal(opened.store?.town, tableTown, 'caller town cannot replace the opening town');
        const recordId = opened.store.id;
        // A goal's bid as its build's plan row, posted by main (executePlan).
        const postBid = (bidder, wanted) => Market.executePlan(bidder, { buyShop: AfkTrade.BUY,
            buyAds: invoke('GameServer/Bot/Economy/BuyAdPolicy').linesFor(bidder, wanted, { watchList: [], board: AfkTrade.boardIndex() })
                .map(line => [line.selfId, line.count, line.price]) }, { reviewGoal: false });
        state = await moveTo(id, TI, 'Talking Island');
        await postBid(state, goal);
        assert.equal(AfkTrade.ownerRecords(id).find(record => record.kind === 'buy_ad')?.town, tableTown);
        assert.equal(AfkTrade.ownerRecords(id).find(record => record.kind === 'buy_ad')?.id, recordId,
            'a move alone does not replace a standing ad');
        // The same owner now has a real NG helmet gap; its existing ad and
        // escrow stay present while the native worker reviews the new kit.
        const nextNative = await stateFor(id, 'Buyer', { level: 10, loc: TI, currentRegion: 'Talking Island' });
        state = nextNative.state;
        const nextWanted = nextNative.captured.queue.find(row => row.key === nextNative.read.activity?.rootKey);
        assert(nextWanted?.object?.slot === nextNative.missing.slot && nextWanted.funded && !nextNative.read.activity?.funding,
            'the changed target is a genuinely useful and funded native NG helmet');
        const nextGoal = gearGoal(nextNative);
        assert.notEqual(nextGoal.target.itemId, goal.target.itemId, 'the authored NG kit wants a different helmet');
        await postBid(state, nextGoal);
        const nextShop = AfkTrade.ownerRecords(id).find(record => record.storeType === AfkTrade.BUY);
        assert.equal(nextShop?.town, 'Talking Island', 'a different wanted item chooses a new ad town');
        const center = ListingService.townCenter('Talking Island');
        assert(Math.hypot(nextShop.locX - center.locX, nextShop.locY - center.locY) < 2500,
            'the persisted Talking Island ad uses its own town coordinates');
        const sourceId = await floranSource(nextNative, 'StandingKarmaSource');
        const pkNative = await moveToKarma(nextNative, 'group_f_karma_standing');
        const pkGoal = gearGoal(pkNative);
        assert.equal(pkGoal.target.itemId, nextGoal.target.itemId, 'the current funded PK quote serves its own retained target');
        const pkAdvice = pkNative.goals.find(row => row.target?.itemId === pkGoal.target.itemId);
        assert.equal(pkAdvice.plan.sourceType, 'afk');
        assert.equal(Market.canTradeRemotely(pkNative.state, pkAdvice), false,
            'the selected local player executor is not an ad instruction');
        const pk = await Market.openBuyAd(pkNative.state, pkGoal);
        assert.equal(pk.store?.town, 'Floran Village', 'a continuing ad in a closed town moves to Floran for a PK');
        await Market.withdraw(id); await Market.withdraw(sourceId);
    });
    await check('sell ad uses the shop opening algorithm and keeps its town', async () => {
        const id = await create('Seller');
        const listings = [];
        for (const selfId of [1864, 1865, 1866, 1867]) {
            const template = DataCache.items.find(row => Number(row.selfId) === selfId);
            await Database.setItem(id, { selfId, name: template.template.name, amount: 100,
                enchant: 0, equipped: false, slot: 0 });
            listings.push({ selfId, name: template.template.name, count: 100, price: 10000 });
        }
        const { state } = await stateFor(id, 'Seller');
        seedDemand(1867);
        const result = await Market.listOnBoard(state, { decided: { listings }, now: Date.now() });
        assert.equal(result.listed, 4, 'three shop lines and one sell ad');
        const ad = AfkTrade.ownerRecords(id).find(record => record.kind === 'sell_ad');
        const line = ad?.lines?.[0];
        assert(line, 'the excess line is advertised');
        assert.equal(ad.town, MarketTownPolicy.shopTown(state, [{ selfId: line.selfId, count: line.count, price: line.price }]),
            'the excess line uses the shop opening algorithm');
        const moved = await moveTo(id, TI, 'Talking Island');
        assert.notEqual(MarketTownPolicy.shopTown(moved, [{ selfId: line.selfId, count: line.count, price: line.price }]), ad.town,
            'the moved bot would open a new ad elsewhere');
        await Market.listOnBoard(moved, { decided: { listings }, now: Date.now() });
        const retained = AfkTrade.ownerRecords(id).find(record => record.kind === 'sell_ad');
        assert.equal(retained?.id, ad.id); assert.equal(retained?.town, ad.town);
        await Market.withdraw(id);
    });
    await check('karma ad opening stays in Floran', async () => {
        const id = await create('KarmaBuyer');
        const initial = await stateFor(id, 'KarmaBuyer');
        const initialGoal = gearGoal(initial);
        assert.equal(initialGoal.target.itemId, 45, 'this actor first selects its own funded D helmet');
        const sourceId = await floranSource(initial, 'KarmaSource');
        const native = await moveToKarma(initial, 'group_f_KarmaBuyer_floran');
        const goal = gearGoal(native);
        assert.equal(goal.target.itemId, initialGoal.target.itemId, 'the current funded PK quote serves its own retained target');
        const advice = native.goals.find(row => row.target?.itemId === goal.target.itemId);
        assert.equal(advice.plan.sourceType, 'afk', 'the worker consumes the physically registered external source');
        assert.equal(Market.canTradeRemotely(native.state, advice), false,
            'selected executable player advice remains a purchase, not an executing ad');
        const result = await Market.openBuyAd(native.state, goal, 'Giran');
        assert.equal(result.opened, true, `the native karma bid opens: ${JSON.stringify({ reason: result.reason, goal })}`);
        assert.equal(result.store?.town, 'Floran Village'); await Market.withdraw(id); await Market.withdraw(sourceId);
    });
    assert.equal(failures.length, 0, `${failures.length} group F contracts failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    PriceDecision.chooseByWeight = original.roll;
    Counters.reset(); ShopPlaces._resetForTests(); await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

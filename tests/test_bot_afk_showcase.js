'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
const owner = 730181, buyer = 730182;
const partsOwner = 730183, partsBuyer = 730184;
const listings = [
    { selfId: 1835, count: 100000, price: 10, kind: 'Other.Shot' },
    { selfId: 1869, count: 10000, price: 100 },
    { selfId: 1786, count: 2, price: 50000 },
    { selfId: 1101, count: 1, price: 80000 },
    { selfId: 79, count: 2, price: 900000 }
];

async function groupedReplacement() {
    await Database.createAccount('bot_showcase_parts', 'fixture');
    await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_showcase_parts', partsOwner]]);
    const metadata = { selfId: 11, name: 'Bone Dagger', enchant: 1, slot: 7,
        stackable: false, petData: JSON.stringify({ name: 'Twin', level: 1 }) };
    const config = { storeType: Afk.SELL, town: 'Giran', title: 'Two daggers' };
    const item = async (amount, extra = {}, characterId = partsOwner) => Number((await Database.setItem(characterId,
        { ...metadata, amount, ...extra })).insertId);
    const publish = (lines, extra = {}) => Database.createAfkTradeShop(partsOwner, { ...config, lines, ...extra });
    const line = (objectId, count, extra = {}) => ({ ...metadata, objectId, count, price: 17, ...extra });
    const bag = () => Database.fetchItems(partsOwner);
    const total = (rows) => rows.filter(row => row.selfId === 11).reduce((sum, row) => sum + row.amount, 0);
    const replace = (shop, lines = shop.lines.map(row => ({ ...row, objectId: row.sourceObjectId }))) =>
        publish(lines, { replace: true, expectedRevision: shop.revision });
    const rejectedReplacement = async (shop, lines) => {
        const beforeBag = await bag(), beforeShop = await Database.fetchAfkTradeShops(partsOwner);
        await assert.rejects(replace(shop, lines), /invalid_afk_trade_source/);
        assert.deepEqual(await bag(), beforeBag, 'failure restores every physical source, including earlier lines');
        assert.deepEqual(await Database.fetchAfkTradeShops(partsOwner), beforeShop, 'failure retains the original shop');
    };

    let shop = (await publish([line(await item(2), 2)])).shop;
    for (let attempt = 0; attempt < 3; attempt++) {
        shop = (await replace(shop)).shop;
        assert.equal(shop.lines.length, 1, 'two physical units remain one public slot');
        assert.equal(shop.lines[0].count, 2);
        assert.equal(shop.lines[0].price, 17);
        assert.equal(shop.lines[0].petData, metadata.petData);
        assert.equal(shop.lines[0].slot, 7);
        assert.equal(total(await bag()), 0, 'all units are held by the replacement');
    }
    await Database.setItem(partsBuyer, { selfId: 57, amount: 100 });
    await Database.buyFromAfkTradeShop(partsBuyer, { shopId: shop.id, ownerId: partsOwner,
        lineId: shop.lines[0].id, amount: 1, expectedPrice: 17, expectedRevision: shop.revision });
    shop = (await Database.fetchAfkTradeShops(partsOwner))[0];
    assert.equal(shop.lines[0].count, 1, 'a partial fill leaves only the unsold unit');
    shop = (await replace(shop)).shop;
    assert.equal(shop.lines[0].count, 1);
    assert.equal(shop.lines[0].fills, 1, 'replacement retains the fill history');
    await Database.closeAfkTradeShop(partsOwner);
    assert.equal((await Database.closeAfkTradeShop(partsOwner)).closed, false, 'repeat cancellation returns nothing twice');
    const returned = (await bag()).find(row => row.selfId === 11);
    const bought = (await Database.fetchItems(partsBuyer)).find(row => row.selfId === 11);
    assert.equal(returned.amount + bought.amount, 2, 'partial fill and cancellation conserve both daggers');
    for (const row of [returned, bought]) {
        assert.equal(row.enchant, metadata.enchant);
        assert.equal(row.slot, metadata.slot);
        assert.equal(row.petData, metadata.petData);
    }
    await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);

    shop = (await publish([line(await item(3), 3)])).shop;
    shop = (await replace(shop, [line(shop.lines[0].sourceObjectId, 2),
        line(shop.lines[0].sourceObjectId, 1, { price: 19 })])).shop;
    assert.deepEqual(shop.lines.map(row => row.count), [2, 1]);
    assert.equal(new Set(shop.lines.map(row => row.sourceObjectId)).size, 2, 'public lines use distinct physical sources');
    await rejectedReplacement(shop, [line(shop.lines[0].sourceObjectId, 2), line(shop.lines[1].sourceObjectId, 2)]);
    await Database.closeAfkTradeShop(partsOwner);
    const fragments = await bag();
    assert.equal(total(fragments), 3, 'failed multi-line reservation neither creates nor loses stock');
    await assert.rejects(publish([line(fragments.find(row => row.selfId === 11).id, 2)]), /inventory_item_changed/,
        'a new shop still requires one physical source per line');
    await assert.rejects(publish([line(fragments.find(row => row.selfId === 11).id, 2)], { kind: 'sell_ad' }),
        /invalid_afk_trade_source/, 'conditional ads retain their single-source validation');
    assert.deepEqual(await bag(), fragments);
    await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);

    // In its own town the shop keeps its record: the first line keeps its
    // row and gives a unit back, the second takes two; totals as a reopen.
    const sameTownUsed = await item(2);
    shop = (await publish([line(await item(2), 2)])).shop;
    shop = (await replace(shop, [line(sameTownUsed, 1), line(shop.lines[0].sourceObjectId, 2)])).shop;
    assert.deepEqual(shop.lines.map(row => row.count), [1, 2]);
    assert.equal(total(await bag()), 1, 'three of the four units are listed, one is in the bag');
    await Database.closeAfkTradeShop(partsOwner);
    assert.equal(total(await bag()), 4);
    await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);

    const partiallyUsed = await item(2);
    shop = (await publish([line(await item(2), 2)])).shop;
    // A shop moved to another town is closed and opened again (in its own
    // town the first line would keep the old row): every line takes anew.
    shop = (await publish([line(partiallyUsed, 1), line(shop.lines[0].sourceObjectId, 2)],
        { replace: true, expectedRevision: shop.revision, town: 'Dion' })).shop;
    assert.deepEqual(shop.lines.map(row => row.count), [1, 2]);
    assert.deepEqual((await bag()).map(row => [row.id, row.amount]), [[partiallyUsed, 1]],
        'bounded selection skips a previously consumed ID with stock before taking both returned pieces');
    await Database.closeAfkTradeShop(partsOwner);
    assert.equal(total(await bag()), 4, 'skipping the used source preserves its remainder');
    await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);

    // A whole but incompatible row must not win the fast path over the
    // compatible one-unit pieces returned by the old shop.
    const otherSlot = await item(2, { slot: 8 });
    const otherPet = await item(2, { petData: JSON.stringify({ name: 'Other', level: 1 }) });
    shop = (await publish([line(await item(2), 2)])).shop;
    shop = (await replace(shop)).shop;
    assert.equal(shop.lines[0].slot, metadata.slot);
    assert.equal(shop.lines[0].petData, metadata.petData);
    assert.deepEqual((await bag()).filter(row => row.selfId === 11).map(row => row.id), [otherSlot, otherPet]);
    await Database.closeAfkTradeShop(partsOwner);
    await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);

    for (const mismatch of [{ slot: 8 }, { petData: JSON.stringify({ name: 'Other', level: 1 }) },
        { enchant: 2 }, { equipped: true }, { selfId: 12 }, { characterId: partsBuyer }]) {
        const { characterId = partsOwner, ...extra } = mismatch;
        await item(1, extra, characterId);
        shop = (await publish([line(await item(1), 1)])).shop;
        const otherBag = await Database.fetchItems(partsBuyer);
        await rejectedReplacement(shop, [line(shop.lines[0].sourceObjectId, 2)]);
        assert.deepEqual(await Database.fetchItems(partsBuyer), otherBag, 'another owner never supplies the missing unit');
        await Database.closeAfkTradeShop(partsOwner);
        await Database.execute(['DELETE FROM items WHERE characterId=?', [partsOwner]]);
    }
    console.log('PASS grouped replacement: repeated custody, partial fill/cancel, source reuse, rollback, metadata and strict paths');
}

(async () => {
    const world = await createWorld([{ id: owner, classId: 0, level: 30 }, { id: buyer, level: 30 },
        { id: partsOwner, level: 30 }, { id: partsBuyer, level: 30 }], 'afk-showcase');
    const saved = { evaluate: Listing.evaluate };
    try {
        await Life.init();
        await groupedReplacement();
        if (process.argv.includes('--e114-regression-only')) return;
        await Database.createAccount('bot_showcase', 'fixture');
        await Database.createAccount('bot_showcase_buyer', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_showcase', owner]]);
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_showcase_buyer', buyer]]);
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        await Database.setItem(buyer, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        for (const row of listings) await Database.setItem(owner, { selfId: row.selfId, amount: row.count, slot: 0 });
        let state = await Life.upsertState({ characterId: owner, accountName: 'bot_showcase',
            name: 'ShowcaseSeller', phase: 'cold', activity: 'hunting', level: 30, adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 0, generatedCold: true, money: [1000, .001, 0, 0], shopTown: { town: 'Giran', at: 1 } }
        }, 'showcase_fixture');
        // Fix only the already selected sale prices. The worker plan, native
        // writers, index, projections, custody and purchase remain real.
        Listing.evaluate = () => ({ listings, decisions: [], answers: [] });
        const prepare = () => Plan.decide(state, { ...Decision.economyFor(state), network: { activity: null } },
            { board: Afk.boardIndex(), now: Date.now(), npcOffersFor: () => [], findSpot: () => null });
        const originalBag = await Database.fetchItems(owner);
        const field = prepare();
        assert.equal(field.shop, undefined);
        await Market.executePlan(state, field);
        assert.equal(Afk.ownerRecords(owner).filter(row => row.kind === 'sell_ad').length, 5);
        assert.equal(Afk.findOwnerProjection(owner), null, 'field quoting opens no physical shop');
        assert.deepEqual(await Database.fetchItems(owner), originalBag);
        // A build taken in the field posts its bids and starts its leaf only: what to sell and a
        // craft are its town visit's, so its plan keeps the standing ads and lists nothing new.
        const built = Plan.decide(state, { ...Decision.economyFor(state), network: { activity: null } },
            { board: Afk.boardIndex(), now: Date.now(), npcOffersFor: () => [], findSpot: () => null, build: true });
        assert.deepEqual([built.sell, built.withdraw, built.shot, built.take], [[], [], undefined, undefined],
            'a build in the field lists, withdraws, sells and crafts nothing');
        state = await Life.upsertState({ ...Life.cachedState(owner), activity: 'shopping' }, 'showcase_visit');
        const visit = prepare();
        assert.equal(visit.shop, 'Giran');
        assert.deepEqual(visit.sell.slice(0, 3).map(row => row[0]), [79, 1101, 1786],
            'unit value beats the much larger material and shot stack totals');
        assert(Buffer.byteLength(JSON.stringify(visit)) <= Plan.MAX_PLAN_PAYLOAD_BYTES);
        // A visit's showcase carries the craft step its held decision prepared: the crafter crafts in town.
        assert.equal(Plan.decide(state, { ...Decision.economyFor(state), network: { activity: null } }, { board: Afk.boardIndex(),
            now: Date.now(), npcOffersFor: () => [], findSpot: () => null, visit: true }).shot, undefined);
        const heldCraft = { wealth: [90001, 2] };
        assert.deepEqual(Plan.decide(state, { ...Decision.economyFor(state), network: { activity: null }, shot: heldCraft },
            { board: Afk.boardIndex(), now: Date.now(), npcOffersFor: () => [], findSpot: () => null, visit: true }).shot, heldCraft);
        const adsBefore = await Database.fetchAfkTradeShops(owner);
        const ad = adsBefore.find(row => row.lines.some(line => line.selfId === 79));
        const weapon = originalBag.find(row => row.selfId === 79);
        const config = { storeType: 1, town: 'Giran', locX: 83396, locY: 147904, locZ: -3400,
            promoteAds: [{ id: ad.id, revision: ad.revision }],
            lines: [{ selfId: 79, objectId: weapon.id, count: 3, price: 900000 }] };
        await assert.rejects(Database.createAfkTradeShop(owner, config));
        assert.deepEqual(await Database.fetchAfkTradeShops(owner), adsBefore,
            'failed custody rolls the withdrawn ad back in the same transaction');
        await assert.rejects(Database.createAfkTradeShop(owner, { ...config,
            promoteAds: [{ id: ad.id, revision: ad.revision + 1 }],
            lines: [{ ...config.lines[0], count: 1 }] }), /afk_trade_shop_changed/);
        assert.deepEqual(await Database.fetchItems(owner), originalBag);
        const stale = await Life.upsertState({ ...state, activity: 'hunting',
            loc: { locX: 100000, locY: 200000, locZ: -3400 } }, 'showcase_left_town');
        await Market.executePlan(stale, visit);
        assert.equal(Afk.findOwnerProjection(owner), null, 'a stale visit cannot open a shop in the field');
        state = await Life.upsertState(state, 'showcase_returned_town');
        await Market.executePlan(state, visit);
        const shop = Afk.findOwnerProjection(owner)?.shop;
        assert(shop);
        assert.deepEqual(shop.lines.map(row => row.selfId), [79, 1101, 1786]);
        assert.deepEqual(Afk.ownerRecords(owner).filter(row => row.kind === 'sell_ad')
            .flatMap(row => row.lines.map(line => line.selfId)).sort((a, b) => a - b), [1835, 1869]);
        assert.equal(Afk.boardIndex().ownerLines(owner).filter(line => line.selfId === 79).length, 1,
            'promoted stock is indexed once, without its old conditional quote');
        state = Life.cachedState(owner);
        const unchanged = prepare();
        assert.equal(unchanged.shop, undefined);
        assert.equal(unchanged.sell.length, 0, 'an unchanged showcase schedules no repeated native publication');
        await Database.setItem(owner, { selfId: 78, amount: 1, slot: 0 });
        state = await Life.syncExternalInventory(owner, 'showcase_new_loot', state);
        state = await Life.upsertState({ ...state, activity: 'hunting', currentRegion: 'field',
            loc: { locX: 100000, locY: 200000, locZ: -3400 } }, 'showcase_remote_review');
        listings.push({ selfId: 78, count: 1, price: 950000 });
        const replacement = prepare();
        assert.equal(replacement.shop, 'Giran', 'an existing shop can receive more valuable loot from afar');
        await Market.executePlan(state, replacement);
        assert.deepEqual(Afk.findOwnerProjection(owner).shop.lines.map(row => row.selfId), [78, 79, 1101]);
        assert.equal(Afk.findOwnerProjection(owner).shop.lines.find(row => row.selfId === 79).count, 2,
            'the real worker plan retains a grouped nonstackable lot through replacement');
        assert.equal(Afk.ownerRecords(owner).find(row => row.kind === 'sell_ad'
            && row.lines.some(line => line.selfId === 1786)).lines[0].count, 2,
            'displaced showcase stock returns to the bag and becomes an ad in the same review');
        const remainingBag = await Database.fetchItems(owner);
        assert(!remainingBag.some(row => [78, 79, 1101].includes(row.selfId)), 'showcase custody is physical');
        assert.equal(remainingBag.find(row => row.selfId === 1786).amount, 2, 'the displaced conditional ad keeps physical stock');
        const offer = Offers.bestOffer(79, { town: 'Giran', buyerCharacterId: buyer, budget: 10000000 });
        assert.equal(offer.recordKind, 'shop', 'ordinary bot browsing discovers the seated shop');
        assert.equal(offer.conditional, false);
        const buyerState = await Life.upsertState({ characterId: buyer, accountName: 'bot_showcase_buyer',
            name: 'ShowcaseBuyer', phase: 'cold', activity: 'shopping', level: 30, adena: 10000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(buyer)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 0, generatedCold: true, money: [1000000, .001, 0, 0, .01, 1000000, 79] }
        }, 'showcase_buyer');
        const bought = await ColdMarket.buyOffer(buyerState, offer);
        assert.equal(bought.purchased, true, bought.reason);
        assert.equal(bought.units, 1);
        assert.equal(bought.spent, 900000);
        assert.equal(Life.cachedState(buyer).adena, 9100000, 'the real cold bot pays the shop ask');
        assert.equal((await Database.fetchItems(buyer)).find(row => row.selfId === 79).amount, 1,
            'native AFK purchase delivers the promoted item');
        Afk._resetForTests();
        await Afk.init();
        assert(Afk.findOwnerProjection(owner), 'the remaining showcase restores after restart');
        assert.equal(Afk.offers(1101, 1).find(row => row.sourceId === owner).recordKind, 'shop');
        for (const enchant of [0, 1, 2]) await Database.setItem(owner, {
            selfId: 626, amount: 1, enchant, equipped: enchant === 2 ? 1 : 0, slot: enchant === 2 ? 8 : 0
        });
        const shields = (await Database.fetchItems(owner)).filter(row => row.selfId === 626);
        state = await Life.syncExternalInventory(owner, 'mixed_enchant_loot', Life.cachedState(owner));
        state = await Life.upsertState({ ...state, activity: 'shopping', currentRegion: 'Giran',
            loc: { locX: 83396, locY: 147904, locZ: -3400 } }, 'mixed_enchant_visit');
        listings.splice(0, listings.length, { selfId: 626, enchant: 0, count: 1, price: 93905 });
        await Market.executePlan(state, prepare());
        assert.equal(Afk.findOwnerProjection(owner).shop.lines[0].enchant, 0);
        state = Life.cachedState(owner);
        listings[0].enchant = 1;
        const enchanted = prepare();
        assert.equal(enchanted.shop, 'Giran', 'a different enchant requires replacement even at the same item, count and price');
        assert.deepEqual(enchanted.sell.map(row => row.slice(0, 5)), [[626, 1, 93905, 'Giran', 1]]);
        assert(enchanted.sell[0][5] > 0, 'the row carries the belief width read on the worker');
        await Market.executePlan(state, enchanted);
        const enchantedLine = Afk.findOwnerProjection(owner).shop.lines[0];
        assert.equal(enchantedLine.enchant, 1);
        assert.equal(enchantedLine.pricing.sigma, enchanted.sell[0][5] / 1e4, 'main publishes the worker belief width');
        assert.equal(enchantedLine.sourceObjectId, shields.find(row => row.enchant === 1).id);
        const remaining = await Database.fetchItems(owner);
        assert.equal(remaining.filter(row => row.selfId === 626 && row.enchant === 0)
            .reduce((sum, row) => sum + row.amount, 0), 1, 'the displaced +0 returns physically');
        assert.equal(remaining.find(row => row.enchant === 2 && row.selfId === 626).equipped, 1);
        await Afk.closeBotRecord(owner, Afk.findOwnerProjection(owner).shop.id);
        state = Life.cachedState(owner);
        const inventoryBefore = await Database.fetchItems(owner);
        await assert.rejects(Market.executePlan(state, { sell: [[626, 1, 93905, 'Giran', -1]], withdraw: [], travel: null },
            { reviewGoal: false }), /economy_plan_invalid_enchant/);
        await assert.rejects(Market.executePlan(state, { sell: [[626, 1, 93905, 'Giran']], withdraw: [], travel: null },
            { reviewGoal: false }), /economy_plan_ambiguous_copies/, 'legacy tuples cannot guess among mixed copies');
        await Market.executePlan(state, { sell: [[626, 1, 93905, 'Giran', 5]], withdraw: [], travel: null }, { reviewGoal: false });
        assert.deepEqual(await Database.fetchItems(owner), inventoryBefore, 'a missing planned enchant cannot take another copy');
        await Market.executePlan(state, { sell: [[626, 1, 93905, 'Dion', 0], [626, 1, 93905, 'Elven Village', 1]],
            withdraw: [], travel: null }, { reviewGoal: false });
        const shieldAds = Afk.ownerRecords(owner).filter(row => row.kind === 'sell_ad')
            .flatMap(record => record.lines.filter(line => line.selfId === 626).map(line => ({ enchant: line.enchant, town: record.town })));
        assert.deepEqual(shieldAds.sort((a, b) => a.enchant - b.enchant),
            [{ enchant: 0, town: 'Dion' }, { enchant: 1, town: 'Elven Village' }], 'each enchant retains its own planned town');
        console.log('PASS town showcase: promotion/rollback, purchase/restore, mixed-enchant replacement, exact custody and ad towns');
    } finally { Listing.evaluate = saved.evaluate; await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('item-source-market');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Native = require('./helpers/nativeMarketFixture');
const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
const Buy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const owner = 9321;
const amount = async id => Native.amount(await Database.fetchItems(owner), id);
async function run() {
    Database.init(); Data.init();
    assert.equal(Sources.hasSource(1305), false, 'GM knife has no ordinary source');
    for (const id of [97, 1864, 1865, 2298]) assert.equal(Sources.hasSource(id), true, `native source for ${id}`);
    const stock = id => ({ selfId: id, name: `Item ${id}`, amount: 2, count: 2, price: 100,
        kind: 'Weapon.Sword', rank: 'none', equipped: false });
    const bad = stock(1305);
    const state = { characterId: owner, level: 40, phase: 'cold', accountName: 'bot_source_market',
        adena: 10000, inventory: { 1305: bad, 1865: { ...stock(1865), kind: 'Other.Material' } }, stats: {}, timing: {} };
    const before = JSON.stringify(state.inventory);
    const options = { keptAmounts: {}, unlimited: true };
    assert.deepEqual(Disposition.saleCandidates(state, options).map(row => row.selfId), [1865]);
    assert.equal(Disposition.npcLiquidationCandidates(state).some(row => row.selfId === 1305), false);
    assert.equal(JSON.stringify(state.inventory), before, 'source admission preserves held stock');
    assert.deepEqual(Listing.classify(state, bad), { action: 'ignore', reason: 'no_acquisition_source' });
    assert.equal(Market.viableSellLine(bad), false);
    const goal = { type: 'upgrade_gear', target: { itemId: 1305, adena: 1000 }, plan: { estimatedCost: 1000 } };
    assert.equal(Buy.bidFor(state, goal), null, 'saved goals cannot buy a GM item');
    assert.deepEqual(Buy.linesFor(state, goal, { watchList: [{ itemId: 1305, amount: 1, worth: 1000 }] }), []);
    assert.equal(Market.canTradeRemotely(state, goal), false);
    const quest = Data.items.find(item => item.template.kind === 'Other.Quest');
    assert(quest);
    assert.equal(Listing.classify(state, { ...bad, selfId: quest.selfId }).reason, 'quest_item', 'saved kind cannot override canonical quest kind');

    // Legacy saved rows are created through the native writer, deliberately before
    // bot policy admission. A human/GM listing does not create an ordinary source.
    await Native.character(Database, owner, 'SourceTrader', 'bot_source_market');
    await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Database.setItem(owner, { selfId: 1305, name: 'Knife', amount: 1, stackable: false });
    await Database.setItem(owner, { selfId: 1865, name: 'Varnish', amount: 5, stackable: true });
    const rows = await Database.fetchItems(owner);
    const lines = [1305, 1865].map(id => ({ selfId: id, objectId: rows.find(row => row.selfId === id).id,
        name: `Item ${id}`, count: id === 1305 ? 1 : 5, price: 100, stackable: id === 1865,
        pricing: { price: 100, seenCounter: Number.MAX_SAFE_INTEGER, sigma: 0.5, seenItem: 0, rival: 0, worth: 0, seenFills: 0 } }));
    await Afk.publishBot(owner, { storeType: Afk.SELL, title: 'Legacy stock', town: 'Dion',
        locX: 19000, locY: 145000, locZ: -3100, lines });
    const saved = Afk.findOwnerProjection(owner).shop;
    const validLine = saved.lines.find(line => line.selfId === 1865);
    const lookLines = Afk.boardIndex().ownerLines(owner);
    const review = Pricing.lookOwn(state, lookLines, { characterId: owner, timestamp: Date.now(),
        canSell: () => true, canBuy: () => true }, new Map());
    assert.equal(review.withdrawals.length, 1, 'unsupported retained SELL leaves even without fresh price observations');
    assert.equal(review.withdrawals[0].selfId, 1305);
    assert.equal((await Market.applyReview(owner, review)).changed, 1);
    assert.equal(await amount(1305), 1, 'native withdrawal returns owned knife, not its nominal price');
    const kept = Afk.findOwnerProjection(owner).shop;
    assert.equal(kept.id, saved.id, 'valid same-record stock remains');
    assert.equal(kept.lines[0].id, validLine.id);
    const wallet = await amount(57);
    await Market.applyReview(owner, review);
    assert.equal(await amount(1305), 1, 'replay cannot return stock twice');
    assert.equal(await amount(57), wallet);

    // A legacy backed BUY shop can hold several item roots. Withdrawing one
    // impossible root refunds only its remaining escrow and preserves its sibling.
    await Afk.stop(owner);
    const priceState = { price: 10, seenCounter: Number.MAX_SAFE_INTEGER, sigma: 0.5,
        seenItem: 0, rival: 0, worth: 100, seenFills: 0 };
    await Afk.publishBot(owner, { storeType: Afk.BUY, title: 'Legacy multi-buy', town: 'Dion',
        lines: [1305, 1864].map(selfId => ({ selfId, name: `Item ${selfId}`, count: 2, price: 10,
            stackable: true, pricing: priceState })) });
    const grouped = Afk.findOwnerProjection(owner).shop;
    const validBuy = grouped.lines.find(line => line.selfId === 1864);
    const heldWallet = await amount(57);
    const groupedReview = Pricing.lookOwn(state, Afk.boardIndex().ownerLines(owner),
        { characterId: owner, timestamp: Date.now(), canSell: () => true, canBuy: () => true }, new Map());
    assert.equal(groupedReview.withdrawals.length, 1);
    assert.equal((await Market.applyReview(owner, groupedReview)).changed, 1);
    assert.equal(await amount(57), heldWallet + 20, 'only invalid BUY remainder is refunded');
    const groupedKept = Afk.findOwnerProjection(owner).shop;
    assert.equal(groupedKept.id, grouped.id);
    assert.equal(groupedKept.lines[0].id, validBuy.id, 'valid same-record BUY root retains identity');
    assert.equal(groupedKept.escrowAdena, 20);
    await Market.applyReview(owner, groupedReview);
    assert.equal(await amount(57), heldWallet + 20, 'BUY refund replay is fenced');
    await Afk.stop(owner);
    const ad = id => ({ storeType: Afk.BUY, title: 'Legacy wish', town: 'Dion', lines: [{ selfId: id,
        name: `Item ${id}`, count: 1, price: 10, stackable: true,
        pricing: { price: 10, seenCounter: Number.MAX_SAFE_INTEGER, sigma: 0.5, seenItem: 0, rival: 0, worth: 0, seenFills: 0 } }] });
    await Afk.openBotRecords(owner, 'buy_ad', [ad(1305), ad(1864)]);
    const validAd = Afk.ownerRecords(owner).find(row => row.kind === 'buy_ad' && row.lines[0].selfId === 1864);
    const restState = { ...state, inventory: {}, vitals: { hp: 1, maxHp: 100, mp: 1, maxMp: 100 } };
    const rested = await Market.reconcileBuyAds(restState, { type: 'recover', plan: { kind: 'rest' } },
        [{ type: 'recover', plan: { kind: 'rest' } }]);
    assert.equal(rested.changed, true, 'source cancellation is reported to the existing review caller');
    const ads = Afk.ownerRecords(owner).filter(row => row.kind === 'buy_ad');
    assert.deepEqual(ads.map(row => row.id), [validAd.id], 'rest keeps independent valid wish but closes unsupported one');
    assert.equal(await amount(57), wallet, 'conditional quote close does not manufacture income');
    const buyReview = Pricing.look(state, [{ ...lookLines[0], selfId: 1305, storeType: Afk.BUY }],
        { characterId: owner, timestamp: Date.now() });
    assert.equal(buyReview.withdrawals.length, 1, 'BUY review uses the same source admission');
    console.log('item source market admission: PASS');
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });

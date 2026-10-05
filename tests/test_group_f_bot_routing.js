const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
const Supply = invoke('GameServer/Bot/AI/BotSupplyErrand');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Trade = invoke('GameServer/Bot/TradeService');
const Shopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const OfferQuery = require('../src/GameServer/Bot/Economy/OfferQuery');
const ColdCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');

const STEM = 1864;
const SHOT = 1463;
let nextRecord = 987000;
const buyer = { characterId: 987100, level: 20, adena: 100000, inventory: {}, stats: {},
    phase: 'cold', activity: 'shopping', currentRegion: 'Giran' };
const failures = [];
async function check(name, test) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
    finally { AfkTrade._resetForTests(); }
}
function record(ownerId, selfId, price, count, town = 'Giran') {
    const id = ++nextRecord;
    return AfkTrade.refreshRecord({ id, ownerId, ownerName: `Seller${ownerId}`, ownerAccount: `bot_${ownerId}`,
        kind: 'sell_ad', storeType: 1, status: 'active', town, title: '', revision: 1, expiresAt: 0,
        locX: 83000, locY: 148000, locZ: -3400,
        lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count, price, enchant: 0 }] });
}
function privateSession(name, id, selfId) {
    const store = { storeType: 1, town: 'Giran', items: [{ selfId, count: 10, price: 1 }] };
    return { accountId: `bot_${id}`, actor: {
        fetchId: () => id, fetchName: () => name, fetchPrivateStore: () => store,
        fetchLocX: () => 83000, fetchLocY: () => 148000, fetchLocZ: () => -3400
    } };
}

(async () => {
    const originalUser = World.user;
    try {
        World.user = { sessions: [] };
        await check('cold plans exclude configured material/gear stock and keep shots/NPC', () => {
            assert.strictEqual(ColdMarket.planPurchase(buyer, STEM, 1, { cost: () => 0 }), null);
            const shot = ColdMarket.planPurchase(buyer, SHOT, 100, { cost: () => 0 });
            assert(shot && shot.units === 100 && shot.npc > 0);
            const npc = ColdMarket.planPurchase(buyer, 1, 1, { towns: ['Talking Island'], cost: () => 0 });
            assert(npc && npc.npc > 0, 'ordinary C4 weapon shop remains available');
        });
        await check('fixed table and cold/supply queries do not inspect world sessions', () => {
            World.user = { get sessions() { throw new Error('world session scan'); } };
            const fixed = Market.fixedStoreOffers();
            assert(fixed.length > 0 && fixed.every((offer) => [1835, 1463, 1464, 1465, 1466, 1467,
                2509, 2510, 2511, 2512, 2513, 2514, 3947, 3948, 3949, 3950, 3951, 3952].includes(offer.selfId)));
            assert(fixed.every((offer) => offer.sourceName && offer.sellerKind === 'fixed'));
            assert.strictEqual(Market.fixedStoreOffers(), fixed, 'reuse the static table');
            record(987101, STEM, 10, 3);
            assert.strictEqual(Market.bestOffer(STEM, { town: 'Giran' }).sourceId, 987101);
            assert.strictEqual(Market.bestSupplyOffer(STEM, { amount: 3 }).sourceId, 987101);
            assert(Market.supplyCatalog(10000).some((entry) => entry.selfId === STEM && entry.price === 10));
            World.user = { sessions: [] };
        });
        World.user = { sessions: [] };
        await check('supply uses board query, quantity, budget, owner and trip', () => {
            record(buyer.characterId, STEM, 1, 99);
            record(987102, STEM, 2, 1);
            record(987103, STEM, 5, 4, 'Aden');
            record(987104, STEM, 7, 4);
            const options = { amount: 3, buyerCharacterId: buyer.characterId, cost: (town) => town === 'Aden' ? 30 : 0 };
            assert.strictEqual(Market.bestSupplyOffer(STEM, options)?.sourceId, 987104);
            assert.strictEqual(Market.bestSupplyOffer(STEM, { ...options, budget: 4 }), null);
            assert.strictEqual(Market.bestSupplyOffer(STEM, { ...options, amount: 5 }), null);
            assert.strictEqual(Market.bestSupplyOffer(STEM, { amount: 4, buyerCharacterId: buyer.characterId })?.sourceId, 987103);
            assert(Market.bestSupplyOffer(SHOT, { amount: 5000 }), 'shot supply survives without live fixed actor');
        });
        await check('hot private offers exclude configured non-shots and keep ordinary physical shops', () => {
            World.user = { sessions: [privateSession('GiranMats', 987201, STEM),
                privateSession('PrivateCrafter', 987202, STEM), privateSession('DionSS', 987203, SHOT)] };
            // Pick actual names from the configured catalogue, independent of fixture aliases.
            const configs = invoke('GameServer/Bot/MerchantStoreConfigs');
            const nonShotName = Object.entries(configs).find(([, store]) => store.storeType === 1
                && store.items.some((line) => line.selfId === STEM))[0];
            const shotName = Object.entries(configs).find(([, store]) => store.storeType === 1
                && store.items.some((line) => line.selfId === SHOT))[0];
            World.user.sessions[0] = privateSession(nonShotName, 987201, STEM);
            World.user.sessions[2] = privateSession(shotName, 987203, SHOT);
            assert(!Market.hotOffers(STEM, { town: 'Giran' }).some((offer) => offer.sourceId === 987201));
            assert(Market.hotOffers(STEM, { town: 'Giran' }).some((offer) => offer.sourceId === 987202));
            assert(Market.hotOffers(SHOT, { town: 'Giran' }).some((offer) => offer.sourceId === 987203));
            World.user = { sessions: [] };
        });
        await check('stale configured non-shot direct purchases are rejected before paying', async () => {
            const originalBlocker = LifeState.marketPurchaseBlocker;
            const originalApply = LifeState.applyMarketPurchase;
            const originalBuy = Trade.buyFromStore;
            let paid = 0;
            LifeState.marketPurchaseBlocker = () => null;
            LifeState.applyMarketPurchase = async () => { paid++; return buyer; };
            Trade.buyFromStore = async () => { paid++; return { qty: 1, totalAdena: 1 }; };
            try {
                const stale = { sourceType: 'private_store', sellerKind: 'fixed', sourceName: 'IslandMats', selfId: STEM,
                    price: 1, count: 10, available: true, storeItem: { count: 10, price: 1 } };
                assert.strictEqual((await ColdMarket.buyOffer(buyer, stale)).purchased, false);
                assert.strictEqual(stale.storeItem.count, 10);
                const result = await Supply.purchaseAtDestination({ fetchId: () => buyer.characterId }, {
                    sourceType: 'configured_store', sourceName: 'IslandMats', itemId: STEM, amount: 1, unitPrice: 1
                });
                assert.strictEqual(result.ok, false);
                const savedPlan = await ColdMarket.buyHere(buyer, { selfId: STEM, amount: 1, town: 'Talking Island',
                    npcPrice: 1, money: 1000, lines: [] });
                assert.strictEqual(savedPlan.units, 0, 'an old configured-material plan cannot synthesize NPC stock');
                assert.strictEqual(paid, 0);
            } finally {
                LifeState.marketPurchaseBlocker = originalBlocker;
                LifeState.applyMarketPurchase = originalApply;
                Trade.buyFromStore = originalBuy;
            }
        });
        await check('board supply arrival binds the record, line and price', async () => {
            record(987301, STEM, 10, 3);
            const selected = Market.bestSupplyOffer(STEM, { amount: 2 });
            assert(selected, 'board source selected');
            const originalBuy = AfkTrade.buyFromShop;
            let paid = 0;
            const item = { fetchAmount: () => 2 };
            const bot = { fetchId: () => buyer.characterId, backpack: { fetchItemFromSelfId: () => item } };
            AfkTrade.buyFromShop = async (id, store, selfId, amount, options) => {
                paid++;
                assert.strictEqual(id, buyer.characterId);
                assert.strictEqual(store.shopId, selected.recordId);
                assert.strictEqual(selfId, STEM);
                assert.strictEqual(amount, 2);
                assert.strictEqual(options.lineId, selected.lineId);
                assert.strictEqual(options.expectedPrice, 10);
                return { amount: 2, totalPrice: 20 };
            };
            try {
                const errand = { sourceType: selected.sourceType, sourceId: selected.sourceId, recordId: selected.recordId,
                    lineId: selected.lineId, itemId: STEM, amount: 2, unitPrice: 10, target: { town: 'Giran' } };
                const bought = await Supply.purchaseAtDestination(bot, errand);
                assert.strictEqual(bought.ok, true);
                assert.strictEqual(bought.cost, 20);
                assert.strictEqual(paid, 1);
                AfkTrade._resetForTests();
                record(987302, STEM, 9, 3);
                const changed = await Supply.purchaseAtDestination(bot, errand);
                assert.strictEqual(changed.ok, false, 'vanished record is never replaced by another seller');
                assert.strictEqual(paid, 1);
            } finally { AfkTrade.buyFromShop = originalBuy; }
        });
        await check('companion equipment asks the shared query', () => {
            const originalBest = Market.bestOffer;
            const originalHot = Market.hotOffers;
            let queried = 0;
            Market.hotOffers = () => { throw new Error('legacy companion offer scan'); };
            Market.bestOffer = (selfId, options) => {
                queried++;
                assert.strictEqual(options.town, 'Giran');
                return selfId === 1 ? { sourceType: 'npc', sourceId: 7001, selfId: 1, price: 883,
                    count: Infinity, available: true, town: 'Giran' } : null;
            };
            const bot = { fetchId: () => 987401, fetchLevel: () => 14, fetchClassId: () => 0,
                fetchLocX: () => 83000, fetchLocY: () => 148000, fetchLocZ: () => -3400,
                backpack: { fetchItems: () => [], fetchItemFromSelfId: () => ({ fetchAmount: () => 100000 }) } };
            try {
                const errand = Shopping.planErrand({ actor: bot, coldLifeState: { stats: {} } }, bot, { name: 'Giran' });
                assert(queried > 0 && errand?.itemId === 1);
            } finally { Market.bestOffer = originalBest; Market.hotOffers = originalHot; }
        });
        await check('worker NPC and board lookups use OfferQuery with immutable rows', () => {
            const originalQuery = OfferQuery.bestSellOffer;
            let queried = 0;
            OfferQuery.bestSellOffer = (...args) => { queried++; return originalQuery(...args); };
            try {
                const lookup = ColdCatalog.createLookup([{ sourceType: 'npc', selfId: 1, sourceId: 7001, town: 'Giran', price: 883 }]);
                assert.strictEqual(lookup.bestOffer(1, buyer)?.price, 883);
                assert.strictEqual(lookup.findMarketOffer(1, buyer)?.price, 883);
                assert.strictEqual(queried, 2);
            } finally { OfferQuery.bestSellOffer = originalQuery; }
        });
    } finally { World.user = originalUser; AfkTrade._resetForTests(); }
    assert.strictEqual(failures.length, 0, `routing failures: ${failures.join(', ')}`);
    console.log('Group F bot routing checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

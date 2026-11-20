const assert = require('assert');
const crypto = require('crypto');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const TradeService = invoke('GameServer/Bot/TradeService');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const PurchaseItems = invoke('GameServer/World/Generics/PurchaseItems');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const NpcShopPriceScale = invoke('GameServer/World/Generics/NpcShopPriceScale');
const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
const Query = invoke('GameServer/Bot/Economy/OfferQuery');

DataCache.init();
const originals = {
    profile: ProgressionRates.profile,
    update: Database.updateItemAmount,
    delete: Database.deleteItem
};
const templates = new Map(DataCache.items.map((item) => [item.selfId, item]));
const normalize = (store) => TradeService.normalizeStoreItems(store, { staticStore: true });
const botLines = store => store.items.map(line => ({ selfId: line.selfId, count: line.count ?? 1,
    price: Pricing.botPriceFor(store, line) })).filter(line => line.price > 0);
// The 189 sell lines (shots, resources, gear; the bot-only reserve gear lines
// are left out and pinned below): moving the buy line price must not change
// any sell price a bot or a player pays on an empty board. A store sells at
// priceRate x the datapack price, rounded, at every preset: one baseline.
const sellBaseline = '3d81dcf7bec480cb4011b45369ce33f5ef411fc3cd8e442ec7e122914e3d16c0';
const baselineSellPrices = { 1: sellBaseline, 10: sellBaseline, 50: sellBaseline };
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function inventoryItem(selfId, amount) {
    return {
        fetchSelfId: () => selfId,
        fetchId: () => selfId,
        fetchAmount: () => amount,
        fetchStackable: () => templates.get(selfId)?.etc?.stackable === true,
        setAmount: (value) => { amount = value; },
        fetchEquipped: () => false
    };
}

async function run() {
    for (const rate of [1, 10, 50]) {
        ProgressionRates.profile = () => ({ adena: rate, multiplier: rate });
        const sellStores = Object.entries(Configs).filter(([, store]) => store.storeType !== 3);
        assert.strictEqual(sha(sellStores.flatMap(([name, store]) => (
            store.items.filter(line => line.reserve !== true).map(line => [name, line.selfId, Pricing.botPriceFor(store, line)])))),
        baselineSellPrices[rate], `every bot sell price matches the baseline at x${rate}`);
        assert.strictEqual(sha(sellStores.flatMap(([name, store]) => (
            normalize(store).filter(line => line.reserve !== true).map(line => [name, line.selfId, line.price])))),
        baselineSellPrices[rate], `every player sell price on an empty board matches the baseline at x${rate}`);
        const cheapest = new Map();
        const addOffer = (id, price) => cheapest.set(id, Math.min(cheapest.get(id) ?? Infinity, price));
        // Enumerate actual NPC lists independently of the policy's NPC price table.
        for (const id of Shops.npcIds()) {
            for (const line of Shops.fetchForNpc(id)) {
                addOffer(line.selfId, line.price ?? templates.get(line.selfId).template.price);
            }
        }
        // The buy lines take gear from a player only (a bot sells them materials,
        // ProductionPolicy.sellsToFixedBuyer), so the margin is against what a
        // player can buy: the bot-only reserve rows are left out.
        for (const store of Object.values(Configs).filter((entry) => entry.storeType === 1)) {
            for (const line of normalize(store)) if (line.reserve !== true) addOffer(line.selfId, line.price);
        }
        for (const offer of Pricing.sellersOf(1835)) {
            const line = Configs[offer.sourceName].items.find(item => item.selfId === 1835);
            assert.strictEqual(offer.price, Math.round(templates.get(1835).template.price * line.priceRate),
                `shot trip supply stays authored at x${rate}: priceRate x the datapack price`);
        }
        const snapshot = MarketSnapshot.fixedStores();
        for (const [name, store] of Object.entries(Configs)) {
            const actual = normalize(store);
            const shown = snapshot.find((row) => row.ownerName === name).items;
            assert.deepStrictEqual(shown.map(({ selfId, price }) => ({ selfId, price })),
                actual.map(({ selfId, price }) => ({ selfId, price })), `${name}: observer/live parity at x${rate}`);
            if (store.storeType !== 3) continue;
            for (const line of botLines(store)) {
                const purchase = cheapest.get(line.selfId);
                assert(Number.isSafeInteger(line.price) && line.price > 0);
                if (purchase !== undefined) {
                    assert(line.price < purchase, `${name} item ${line.selfId} arbitrage at x${rate}: ${purchase} -> ${line.price}`);
                    assert(line.price <= Math.floor(purchase * 0.9), `${name}: missing buyback margin`);
                }
            }
            assert.deepStrictEqual(actual.map(({ selfId, price }) => ({ selfId, price })),
                botLines(store).map(({ selfId, price }) => ({ selfId, price })),
                `${name}: on an empty board a player and a bot are paid one line price at x${rate}`);
        }
        const base = templates.get(1864).template.price;
        assert.strictEqual(botLines(Configs['4manda']).find((line) => line.selfId === 1864).price,
            Math.max(Math.floor(NpcSellRules.npcBuyPrice(base) * 1.5), Math.floor(base * 0.25)),
            `a raw material no NPC sells pays 1.5x the NPC buy-back or 0.25x its price, x1 at every preset (x${rate})`);
        // The gear reserve: an ordinary bot pays the valve row, 1.5x the NPC price
        // scale of the template price, for a C weapon (Flamberge 71); each of the
        // Giran, Oren and Aden reserve stores also lists the crafter row at 0.6x
        // (Artisan/Warsmith only). A C armour piece a limited player lot lists
        // (Haldise) is bot-buyable only at its reserve rows.
        const reserveC = NpcShopPriceScale.price(templates.get(71).template.price * 1.5, rate);
        const crafterC = NpcShopPriceScale.price(templates.get(71).template.price * 0.6, rate);
        assert.strictEqual(Pricing.cheapestPurchase(71, { forBot: true }), reserveC, `C weapon reserve price at x${rate}`);
        const reserveStores = [['Squeesh', 'Giran'], ['M3tLa', 'Oren'], ['Lowfiles', 'Aden']];
        const flamberge = Fixed.offers(71);
        assert.deepStrictEqual(flamberge.map(row => [row.sourceName, row.town, row.price]),
            reserveStores.flatMap(([name, town]) => [[name, town, crafterC], [name, town, reserveC]]));
        const haldiseIds = Configs.Haldise.items.map(line => line.selfId).filter(id => templates.get(id)?.etc?.rank === 'c');
        assert(haldiseIds.length > 0);
        for (const id of haldiseIds) {
            const reserve = Configs.Squeesh.items.find(line => line.selfId === id && line.reserve === true);
            assert.deepStrictEqual(Fixed.offers(id).map(row => row.sourceName),
                reserve ? reserveStores.flatMap(([name]) => [name, name]) : [],
                `Haldise's limited lot of ${id} is not a bot's reserve at x${rate}`);
            const artisan = { characterId: 1, stats: { classId: 56 } };
            assert.strictEqual(Fixed.offers(id).every(row => Query.sourceAllowed(row, true, artisan)), true,
                'an Artisan may buy each reserve row');
            assert.strictEqual(Fixed.offers(id).every(row => Query.sourceAllowed(row) === !row.buyerClasses), true,
                'any other bot only the valve row');
            assert.strictEqual(Query.sourceAllowed({ sourceType: 'configured_store', selfId: id, sourceName: 'Haldise' }), false,
                'a limited player lot is refused to bots');
        }
    }
    // Each reserve store (Giran, Oren, Aden) lists exactly the gear a bot's
    // planner can target of every grade C, B and A (each weapon or armour piece
    // with a named template, a price and a source) and the reference kits' pieces
    // without a source, each in two rows: the crafter row (Artisan/Warsmith, 0.6x)
    // and the valve row (anyone, 1.5x, counted against its grade); and its own
    // grade's weapon enchant scroll. A grand boss's jewel (Queen Ant, Orfen, Core)
    // is never a reserve piece: C4 drops it from its boss alone.
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const kitOnly = { c: [499, 1120], b: [104, 106, 117, 209, 404, 421, 610, 860, 891, 922], a: [304, 868, 899, 930] };
    const scroll = { c: 951, b: 947, a: 729 };
    const grandBossJewels = [6660, 6661, 6662];
    const gearOf = rank => DataCache.items.filter(item => item.etc?.rank === rank && /^(Weapon|Armor)\./.test(String(item.template?.kind || ''))
        && item.template?.name && Number(item.template?.price) > 0 && Sources.hasSource(item.selfId)
        && !grandBossJewels.includes(item.selfId)).map(item => item.selfId)
        .concat(kitOnly[rank]).map(selfId => [selfId, rank.toUpperCase()]);
    const gear = ['c', 'b', 'a'].flatMap(gearOf).sort(([a], [b]) => a - b);
    for (const [name, rank] of [['Squeesh', 'c'], ['M3tLa', 'b'], ['Lowfiles', 'a']]) {
        const reserve = Configs[name].items.filter(line => line.reserve === true);
        const row = line => [line.selfId, line.npcRate, line.buyerClasses ? [...line.buyerClasses] : null, line.valve ?? null];
        assert.deepStrictEqual(reserve.filter(line => line.selfId !== scroll[rank]).map(row).sort(([a, ra], [b, rb]) => a - b || ra - rb),
            gear.flatMap(([selfId, grade]) => [[selfId, 0.6, [56, 57], null], [selfId, 1.5, null, grade]]),
            `${name} reserve gear rows follow the rule`);
        assert.deepStrictEqual(reserve.filter(line => line.selfId === scroll[rank]).length, 1, `${name} sells its grade's scroll`);
    }
    // The player's window leaves the reserve lines out: he keeps C4's stores.
    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });
    const squeesh = { storeType: 1, items: normalize(Configs.Squeesh) };
    assert.deepStrictEqual(TradeService.nativeStoreItems(squeesh).map(line => line.selfId), [1464, 2511, 3949],
        'the player sees only the C shots at Squeesh');
    // One switch: staticShotsDisabled removes the shot and the gear reserve.
    const Population = invoke('GameServer/Bot/Population/PopulationConfig');
    Population.staticShotsDisabled = true;
    try {
        assert.strictEqual(Pricing.cheapestPurchase(71, { forBot: true }), Infinity, 'the switch closes the gear reserve');
        assert.strictEqual(Pricing.cheapestPurchase(1464, { forBot: true }), Infinity, 'the switch closes the shot reserve');
        assert.strictEqual(Fixed.offers(71).length, 0);
    } finally {
        Population.staticShotsDisabled = false;
    }

    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });
    // Explicit static prices and future inverted coefficients must also be capped.
    const inflated = { selfId: 2006, price: 99999999, count: 10 };
    const cap = Math.floor(normalize(Configs.TomRiddle).find((line) => line.selfId === 2006).price * 0.9);
    assert.strictEqual(Pricing.botPriceFor(Configs.Addicted, inflated), cap);
    assert.strictEqual(normalize({ storeType: 3, items: [inflated] })[0].price, cap,
        'an explicit buy line price is the player\'s line price too, under the same ceiling');
    assert.strictEqual(TradeService.normalizeStoreItems({ storeType: 3, items: [inflated] })[0].price,
        inflated.price, 'dynamic stores retain their negotiated prices');
    ProgressionRates.profile = () => ({ adena: 10, multiplier: 10 });
    assert.strictEqual(Pricing.botPriceFor(Configs.Veteranas, { selfId: 219 }), 138348,
        'at x10 the buy line pays as at x1: 0.9 of the cheapest NPC row of Sword Breaker, NPC prices x1 at every preset');
    ProgressionRates.profile = () => ({ adena: 1, multiplier: 1 });

    // Reproduce purchase -> inventory delivery -> static buyback with real
    // trade functions and an isolated in-memory database boundary.
    Database.updateItemAmount = async () => {};
    Database.deleteItem = async () => {};
    const adena = inventoryItem(57, 1000000);
    const backpack = {
        items: [adena],
        fetchItems() { return this.items; },
        fetchItemFromSelfId(id) { return this.items.find((item) => item.fetchSelfId() === id); },
        fetchTotalAdena: () => adena.fetchAmount(),
        deleteItem(session, id, amount, done) { adena.setAmount(adena.fetchAmount() - amount); done(); }
    };
    const actor = { backpack, fetchId: () => 991 };
    const price = Shops.fetchForNpc(7084).find((line) => line.selfId === 219).price;
    await new Promise((resolve) => {
        PurchaseItems.call({ purchaseItem(session, id, amount) {
            backpack.items.push(inventoryItem(id, amount));
            resolve();
        } }, { actor }, [{ selfId: 219, amount: 1 }], { prices: new Map([[219, price]]) });
    });
    assert.strictEqual(adena.fetchAmount(), 731600);
    const store = { storeType: 3, items: normalize(Configs.Veteranas) };
    const sale = await TradeService.sellToStore(actor, store, 219, 1);
    // 0.9 of the cheapest NPC row of Sword Breaker (153720), under the 268400 paid here.
    const buyback = 138348;
    assert.strictEqual(sale.totalAdena, buyback);
    assert.strictEqual(adena.fetchAmount(), 731600 + buyback, 'the player round trip is paid the line price under the purchase');
    assert.strictEqual(backpack.fetchItemFromSelfId(219), undefined);
    assert.strictEqual(store.items.find((line) => line.selfId === 219).count, 999998);
    console.log('Static merchant pricing: sell prices, one capped buy line price for bots and players, observer parity at x1/x10/x50 and Sword Breaker round trip passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    ProgressionRates.profile = originals.profile;
    Database.updateItemAmount = originals.update;
    Database.deleteItem = originals.delete;
});

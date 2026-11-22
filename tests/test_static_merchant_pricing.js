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
const Anchor = invoke('GameServer/Bot/Economy/PriceAnchor');
const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
const Production = invoke('GameServer/Bot/Economy/ProductionPolicy');
const Query = invoke('GameServer/Bot/Economy/OfferQuery');
const Crafters = invoke('GameServer/Bot/Economy/CrafterStock');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');

DataCache.init();
const originals = {
    update: Database.updateItemAmount,
    delete: Database.deleteItem
};
// The server rates as server.ini sets them (the x1 preset with these rates; spoil
// follows drop, SP the exp rate): every reader, the spot table's rewards among them,
// takes the one profile.
const { useRate, useGeneral } = require('./helpers/progressionRate');
const general = { ...options.default.General }, preset = process.env.L2NODE_PROGRESSION_RATE;
function useRates(adena, exp = adena) {
    useRate('x1');
    useGeneral({ adenaRate: adena, expRate: exp, dropChanceRate: adena });
}
const templates = new Map(DataCache.items.map((item) => [item.selfId, item]));
const normalize = (store) => TradeService.normalizeStoreItems(store, { staticStore: true });
const botLines = store => store.items.map(line => ({ selfId: line.selfId, count: line.count ?? 1,
    price: Pricing.botPriceFor(store, line) })).filter(line => line.price > 0);
// The 189 sell lines (shots, resources, gear; the bot-only reserve gear lines
// are left out and pinned below): moving the buy line price must not change
// any sell price a bot or a player pays on an empty board. A store sells at
// priceRate x the datapack price, rounded, x the server's Adena rate: the x1
// baseline, each price x the rate at x10 and x50.
const sellBaseline = '3d81dcf7bec480cb4011b45369ce33f5ef411fc3cd8e442ec7e122914e3d16c0';
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
    let x1SellRows = null;
    for (const rate of [1, 10, 50]) {
        useRates(rate);
        const sellStores = Object.entries(Configs).filter(([, store]) => store.storeType !== 3);
        const botRows = sellStores.flatMap(([name, store]) => (
            store.items.filter(line => line.reserve !== true).map(line => [name, line.selfId, Pricing.botPriceFor(store, line)])));
        const playerRows = sellStores.flatMap(([name, store]) => (
            normalize(store).filter(line => line.reserve !== true).map(line => [name, line.selfId, line.price])));
        if (rate === 1) {
            assert.strictEqual(sha(botRows), sellBaseline, 'every bot sell price matches the baseline at x1');
            x1SellRows = botRows;
        }
        const expected = x1SellRows.map(([name, selfId, price]) => [name, selfId, price * rate]);
        assert.deepStrictEqual(botRows, expected, `every bot sell price is the x1 price x${rate}`);
        assert.deepStrictEqual(playerRows, expected, `every player sell price on an empty board is the x1 price x${rate}`);
        // The Heine B/A materials store: Tallum Blade at 0.6 x 18,300,000 x the rate.
        const heine = Object.values(Configs).find(store => store.town === 'Heine' && store.title === 'B/A materials');
        const tallum = heine.items.find(line => line.selfId === 80);
        assert.strictEqual(Pricing.botPriceFor(heine, tallum), 10980000 * rate, `Heine Tallum Blade at x${rate}`);
        assert.strictEqual(normalize(heine).find(line => line.selfId === 80).price, 10980000 * rate,
            `a player pays Heine's Tallum Blade at 0.6 x the datapack price x${rate}`);
        const cheapest = new Map();
        const addOffer = (id, price) => cheapest.set(id, Math.min(cheapest.get(id) ?? Infinity, price));
        // Enumerate actual NPC lists independently of the policy's NPC price table.
        for (const id of Shops.npcIds()) {
            for (const line of Shops.fetchForNpc(id)) {
                addOffer(line.selfId, line.price ?? templates.get(line.selfId).template.price);
            }
        }
        // The buy lines take from a player only (a bot sells them nothing,
        // TradeService.acceptsSellerItem), so the margin is against what a
        // player can buy: the bot-only reserve rows are left out.
        for (const store of Object.values(Configs).filter((entry) => entry.storeType === 1)) {
            for (const line of normalize(store)) if (line.reserve !== true) addOffer(line.selfId, line.price);
        }
        for (const offer of Pricing.sellersOf(1835)) {
            const line = Configs[offer.sourceName].items.find(item => item.selfId === 1835);
            assert.strictEqual(offer.price, Math.round(templates.get(1835).template.price * line.priceRate) * rate,
                `the player's no-grade shot rows at x${rate}: priceRate x the datapack price x the rate`);
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
            Math.floor(NpcSellRules.npcBuyPrice(base) * 1.5) * rate,
            `a raw material no NPC sells pays 1.5x the NPC buy-back x the rate (x${rate})`);
        // The gear reserve: no row sells a C weapon (Flamberge 71) to an ordinary bot;
        // each of the Giran, Oren and Aden reserve stores lists the crafter row at 0.6 x
        // its price anchor (crafters and spoilers only), and the Giran trader row is
        // absent (Giran's traders stock B and A). Equal Adena and exp rates keep the anchor
        // near half the datapack price (a D hunter's income over twice its band's hours).
        const anchorC = Anchor.anchor(71), crafterC = Math.round(0.6 * anchorC), ceilingC = anchorC;
        const shareC = anchorC / templates.get(71).template.price;
        assert(shareC > 0.35 && shareC < 0.7, `the C anchor is about half the datapack price at x${rate}: ${shareC}`);
        assert.strictEqual(Fixed.offers(71, { stats: { classId: 1 } }).length, 0, `no store sells an ordinary bot a C weapon at x${rate}`);
        // A crafter starts its ask at its cost (the crafter row) and asks at most the anchor.
        const crafter = { characterId: 1, currentRegion: 'Giran', stats: { classId: 56 } };
        const consigned = Crafters.townOffers(crafter).find(offer => offer.selfId === 71);
        assert.deepStrictEqual([consigned.price, consigned.ceiling], [crafterC, ceilingC], `a crafter's Flamberge cost and ceiling at x${rate}`);
        const stocked = { ...crafter, stats: { ...crafter.stats, gnomeStock: { 71: { cost: consigned.price, ceiling: consigned.ceiling, owed: 0 } } } };
        assert.deepStrictEqual([1, ceilingC * 10].map(ask => Disposition.gnomeAsk(stocked, 71, ask)), [crafterC, ceilingC],
            `a crafter's Flamberge ask lies between its cost and the anchor at x${rate}`);
        const reserveStores = [['Squeesh', 'Giran'], ['M3tLa', 'Oren'], ['Lowfiles', 'Aden']];
        const traderStores = [['J3dSanta', 'Gludin'], ['Musa', 'Gludio'], ['Reanimator', 'Dion']];
        const flamberge = Fixed.offers(71);
        assert.deepStrictEqual(flamberge.map(row => [row.sourceName, row.town, row.price, row.buyerRole || 'crafter']).sort(),
            [...reserveStores.map(([name, town]) => [name, town, crafterC, 'crafter']),
                ...traderStores.map(([name, town]) => [name, town, crafterC, 'trader'])].sort());
        const haldiseIds = Configs.Haldise.items.map(line => line.selfId).filter(id => templates.get(id)?.etc?.rank === 'c');
        assert(haldiseIds.length > 0);
        for (const id of haldiseIds) {
            const reserve = Configs.Squeesh.items.find(line => line.selfId === id && line.reserve === true);
            assert.deepStrictEqual(Fixed.offers(id).map(row => row.sourceName).sort(),
                reserve ? [...reserveStores, ...traderStores].map(([name]) => name).sort() : [],
                `Haldise's limited lot of ${id} is not a bot's reserve at x${rate}`);
            const artisan = { characterId: 1, stats: { classId: 56 } };
            assert.strictEqual(Fixed.offers(id).every(row => Production.allowsFixed(row, artisan, { consignment: true }) === !row.buyerRole), true,
                'an Artisan stocks each crafter row on consignment, no trader row');
            assert.strictEqual(Fixed.offers(id).some(row => Query.sourceAllowed(row, true, artisan)), false,
                'an Artisan buys no reserve row for itself');
            assert.strictEqual(Fixed.offers(id).some(row => Query.sourceAllowed(row)), false,
                'any other bot no reserve row');
            assert.strictEqual(Query.sourceAllowed({ sourceType: 'configured_store', selfId: id, sourceName: 'Haldise' }), false,
                'a limited player lot is refused to bots');
        }
    }
    // The reserve rows are priced on the anchor: a crafter row is 0.6 x the piece's anchor.
    // An Exp rate a fifth of the Adena rate makes a band's hours 5 x, and the anchor with
    // them. The spoiler's C scroll sells at 3.4 x its datapack price before the board has
    // deals, at any rate.
    // C4 carries Adena as a 32-bit count: at x60 every row a bot or a player meets
    // stops at 2,147,483,647.
    const MAX_ADENA = 2147483647;
    const anchorShare = id => Anchor.anchor(id) / templates.get(id).template.price;
    useRates(50);
    const crafterRow = id => Fixed.offers(id).find(row => row.sourceName === 'Squeesh' && row.buyerClasses)?.price;
    const dragonSlayer = Anchor.anchor(81);
    assert.strictEqual(crafterRow(81), Math.round(0.6 * dragonSlayer), 'the Squeesh Dragon Slayer crafter row at x50');
    assert.strictEqual(crafterRow(60), Math.round(0.6 * Anchor.anchor(60)), 'a reserve C piece (Composite Armor) at 0.6 x its anchor at x50');
    assert(Math.abs(Anchor.anchor(60) / templates.get(60).template.price - anchorShare(71)) < 0.001,
        'every C piece is its datapack share of the one C kit price');
    assert.deepStrictEqual([...new Set(Fixed.offers(951).map(row => row.price))], [Math.round(3.4 * templates.get(951).template.price)],
        'the spoiler scroll row at 3.4 x the datapack price at x50, no Adena rate');
    useRates(50, 10);
    assert(Math.abs(Anchor.anchor(81) / dragonSlayer - 5) < 0.01, 'an Adena rate 5 x the Exp rate prices the anchor 5 x');
    useRates(60);
    for (const [name, store] of Object.entries(Configs)) {
        const prices = [...store.items.map(line => Pricing.botPriceFor(store, line)), ...normalize(store).map(line => line.price),
            ...store.items.flatMap(line => Fixed.offers(line.selfId).map(row => row.price))];
        assert(prices.every(price => price <= MAX_ADENA), `${name}: every row at x60 at or under the Adena maximum`);
    }
    useRates(50);
    // Each reserve store (Giran, Oren, Aden) lists exactly the gear a bot's
    // planner can target of every grade C, B and A (each weapon or armour piece
    // with a named template, a price and a source) and the reference kits' pieces
    // without a source, in the crafter row (crafters and spoilers, 0.6 x the anchor) and,
    // for the grades its station traders stock, the trader row; and its own
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
        const row = line => [line.selfId, line.npcRate, line.buyerClasses ? [...line.buyerClasses] : line.buyerRole];
        const traderGrades = { Squeesh: ['B', 'A'], M3tLa: ['B'], Lowfiles: ['A'] }[name];
        assert.deepStrictEqual(reserve.filter(line => line.selfId !== scroll[rank]).map(row).sort((a, b) => a[0] - b[0] || String(a[2]).localeCompare(String(b[2]))),
            gear.flatMap(([selfId, grade]) => [[selfId, 0.6, [54, 55, 56, 57]],
                ...(traderGrades.includes(grade) ? [[selfId, 0.6, 'trader']] : [])]),
            `${name} reserve gear rows follow the rule`);
        assert.deepStrictEqual(reserve.filter(line => line.selfId === scroll[rank]).length, 1, `${name} sells its grade's scroll`);
    }
    // The player's window leaves the reserve lines out: he keeps C4's stores.
    useRates(1);
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

    useRates(1);
    // Explicit static prices and future inverted coefficients must also be capped.
    const inflated = { selfId: 2006, price: 99999999, count: 10 };
    const cap = Math.floor(normalize(Configs.TomRiddle).find((line) => line.selfId === 2006).price * 0.9);
    assert.strictEqual(Pricing.botPriceFor(Configs.Addicted, inflated), cap);
    assert.strictEqual(normalize({ storeType: 3, items: [inflated] })[0].price, cap,
        'an explicit buy line price is the player\'s line price too, under the same ceiling');
    assert.strictEqual(TradeService.normalizeStoreItems({ storeType: 3, items: [inflated] })[0].price,
        inflated.price, 'dynamic stores retain their negotiated prices');
    useRates(10);
    assert.strictEqual(Pricing.botPriceFor(Configs.Veteranas, { selfId: 219 }), 241560,
        'at x10 the buy line pays 0.9 of the NPC row of Sword Breaker (268400, x1 at every preset), its cheapest supply once CraftStash sells at x10');
    useRates(1);

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
    useRate(preset);
    useGeneral({ adenaRate: general.adenaRate, expRate: general.expRate, dropChanceRate: general.dropChanceRate });
    Database.updateItemAmount = originals.update;
    Database.deleteItem = originals.delete;
});

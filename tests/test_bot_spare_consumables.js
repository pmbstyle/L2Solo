const assert = require('assert');
const world = require('./fixtures/native_stock_world')();

require('../src/Global');

// H12 with H3: a bot keeps the consumables its class uses and the NPC buys the
// rest, on the cold visit as on the hot one. No bot spends arrows, reads a
// scroll of resurrection, opens a chest with a key or drinks an antidote; it
// drinks healing potions and reads Scrolls of Escape for town trips (step 3.2,
// H12 narrowed 2026-10-05), so it keeps them up to their restock targets.
// Enchant scrolls, crystals and Adena are not spare.
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');

DataCache.init();

async function run() {
    invoke('Database').init();
    assert(invoke('Database').isReady());
    // A level-30 fighter with shots drinks ~4.5 potions an hour at -9_31 in the
    // one combat core's table (-10_30 fell to 1.4), so the two-hour stock
    // exceeds the three-potion mixed stock below.
    world.usePotionSpot('-9_31');

    const line = (selfId, amount) => ({ selfId, amount, name: DataCache.items.find((entry) => entry.selfId === selfId)?.template?.name });
    const state = {
        // The one available canonical spot consumes potions without changing its values.
        characterId: 9500001, level: 30, spotId: '-9_31', adena: 1000, phase: 'cold', activity: 'shopping',
        currentRegion: 'Giran', loc: world.town(),
        stats: { classId: 0, role: 'dps' },
        inventory: Object.fromEntries([
            // One Scroll of Escape above the carried target (ten since 71ff0f77) is surplus.
            line(57, 1000), line(17, 500), line(736, invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT + 1), line(1661, 2), line(1831, 4),
            line(1060, 10), line(1061, 30), line(956, 1), line(1458, 40)
        ].map((entry) => [String(entry.selfId), entry]))
    };

    const target = HealingPotionStock.targetAmountFor(state);
    const potionStock = invoke('GameServer/Bot/Economy/EconomyContext').basics(state).stock('potions');
    // ARCH-NOTE: bag space only bounds an outing (1a1a2adc); with no town visit
    // history the stock horizon is the initial town-visit estimate. Keep a real
    // full stock plus 20 surplus, then check both sales.
    assert.strictEqual(potionStock.targetHours, invoke('GameServer/Bot/Economy/TownVisitInterval').targetHours(state.stats));
    assert.strictEqual(target, Math.ceil(potionStock.usePerHour * potionStock.targetHours));
    assert(target > 3);
    state.inventory[1061].amount = target + 20;
    assert.deepStrictEqual(HealingPotionStock.stockAmounts(state), { 1061: target },
        'the healing stock is kept strongest first up to the restock target');
    // One stock for the sale and the restock: potions at least as strong as the
    // one the bot buys at its level (Healing Potion at 30); weaker ones are junk.
    const weakStock = { ...state, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, target) } };
    assert.deepStrictEqual(HealingPotionStock.stockAmounts(weakStock), {}, 'a weaker potion is no stock at level 30');
    assert.strictEqual(HealingPotionStock.restockPlan(weakStock).amount, target, 'the restock buys a full stock of its potion');
    const mixed = { ...state, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, 2), 1061: line(1061, 1), 1539: line(1539, 2) } };
    assert.deepStrictEqual(HealingPotionStock.stockAmounts(mixed), { 1539: 2, 1061: 1 }, 'stronger potions from loot count, strongest first');
    const mixedPlan = HealingPotionStock.restockPlan(mixed);
    assert.strictEqual(mixedPlan.amount, target - 3, 'the restock buys what is missing from the stock');
    assert.strictEqual(mixedPlan.currentAmount, 1, 'the purchased potion\'s own row is what the purchase writes');
    const quick = { ...state, inventory: { 57: line(57, 100000), 1540: line(1540, 20) } };
    assert.deepStrictEqual(HealingPotionStock.stockAmounts(quick), {}, 'Quick Healing Potions (drunk only near death) are no restock stock');
    assert.strictEqual(new Map(MarketListingPolicy.evaluate(quick, { unlimited: true, states: [] }).npc
        .map((entry) => [entry.selfId, entry.count])).get(1540), undefined, 'but the bot keeps them: it drinks them when nearly dead');
    const young = { ...state, level: 15, adena: 100000, inventory: { 57: line(57, 100000), 1060: line(1060, 3) } };
    assert.deepStrictEqual(HealingPotionStock.stockAmounts(young, { targetAmount: 3 }), { 1060: 3 }, 'below 20 the Lesser Healing Potion is the stock');
    for (const selfId of [17, 736, 1661, 1831, 1060]) {
        assert(ItemDisposition.isSpareConsumable({ selfId }), `${selfId} is a consumable no bot keeps`);
    }
    // A recipe material (Rope of Magic, a compressed-shot input) and an item the NPC
    // pays nothing for (Ancient Adena, a soul crystal) are not spare consumables.
    // Grade crystals remain market stock rather than NPC cleanup.
    for (const selfId of [57, 956, 1458, 1463, 5192, 5575, 4629]) {
        assert(!ItemDisposition.isSpareConsumable({ selfId }), `${selfId} is not a spare consumable`);
    }

    // A current own quote keeps the enchant scroll out of spare cleanup.
    // A new market draw may still choose the NPC despite a funded buyer.
    const dealsAt = Date.now();
    await world.buyer([[956, 1]], state.characterId);
    const database = invoke('Database'), afk = invoke('GameServer/AfkTrade/AfkTradeService');
    let [seller] = await database.execute(['SELECT id,classId,level FROM characters WHERE id=?', [state.characterId]]);
    if (!seller) {
        const account = `bot_stock_seller_${state.characterId}`;
        await database.createAccount(account, 'fixture');
        const inserted = await database.createCharacter(account, { name: 'StockSeller', race: 0, classId: state.stats.classId,
            maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...world.town() });
        await database.execute(['UPDATE characters SET id=?,level=? WHERE id=?',
            [state.characterId, state.level, Number(inserted.insertId)]]);
        [seller] = await database.execute(['SELECT id,classId,level FROM characters WHERE id=?', [state.characterId]]);
    }
    assert.strictEqual(seller.id, state.characterId);
    assert.strictEqual(seller.classId, state.stats.classId);
    assert.strictEqual(seller.level, state.level);
    const scroll = DataCache.items.find(entry => entry.selfId === 956);
    if (!(await database.fetchItems(state.characterId)).some(item => Number(item.selfId) === 956)) {
        await database.setItem(state.characterId, { selfId: 956, name: scroll.template.name,
            amount: state.inventory[956].amount, enchant: 0, equipped: false, slot: 0 });
    }
    const beforeQuote = await database.fetchItems(state.characterId);
    const physicalScroll = beforeQuote.find(item => Number(item.selfId) === 956);
    assert.strictEqual(Number(physicalScroll.amount), 1);
    assert.strictEqual(Number(physicalScroll.enchant), 0);
    const quote = await database.createAfkTradeShop(state.characterId, { kind: 'sell_ad', storeType: 1,
        town: 'Giran', ...world.town(), lines: [{ objectId: physicalScroll.id, selfId: 956, count: 1,
            price: Number(scroll.template.price), enchant: 0, stackable: false }] });
    assert.strictEqual(quote.shop.ownerId, state.characterId);
    assert.strictEqual(quote.shop.custodyPolicy, 1);
    assert.strictEqual(Number(quote.shop.lines[0].sourceObjectId), Number(physicalScroll.id));
    assert.deepStrictEqual(await database.fetchItems(state.characterId), beforeQuote,
        'the actual conditional quote keeps the same physical scroll in the seller bag');
    afk.refreshRecord(quote.shop);
    const ownerLine = afk.boardIndex().ownerLines(state.characterId).find(entry => entry.selfId === 956);
    assert.strictEqual(ownerLine.ownerId, state.characterId);
    assert.strictEqual(ownerLine.recordId, quote.shop.id);
    assert.strictEqual(ownerLine.custodyPolicy, 1);
    assert.strictEqual(ownerLine.count, 1);
    assert.strictEqual(ownerLine.enchant, 0);
    assert.strictEqual(ownerLine.price, Number(scroll.template.price));
    const economy = world.economyFor(state);
    const visit = MarketListingPolicy.evaluate(state, { unlimited: true, states: [], now: dealsAt,
        economy, board: afk.boardIndex() });
    assert(visit.listings.some(entry => entry.selfId === 956 && entry.count === 1 && entry.marketReason === 'kept_line'),
        'the native visit respects the actual current own quote, without fixing a new market draw');
    const npc = new Map(visit.npc
        .map((entry) => [entry.selfId, entry.count]));
    assert.deepStrictEqual([...npc.entries()].sort((a, b) => a[0] - b[0]),
        [[17, 500], [736, 1], [1060, 10], [1061, 20], [1661, 2], [1831, 4]],
        'the cold visit sells spare consumables to the NPC while retaining grade crystals for the market');
    assert(visit.listings.some(entry => entry.selfId === 1458 && entry.count === 40),
        'the unreserved crystal surplus earns a market quote without a current buyer');
    // The hot visit sells first, as the cold one: what it sells to the NPC is not
    // stored at the warehouse stop before the sale.
    const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
    const armour = DataCache.items.find((entry) => String(entry.template?.kind || '').startsWith('Armor.')
        && String(entry.etc?.rank || 'none') === 'none' && Number(entry.template?.price) > 1000 && Number(entry.template?.price) < 50000);
    const actorItem = (selfId, amount) => ({ fetchId: () => selfId, fetchSelfId: () => selfId, fetchAmount: () => amount,
        fetchEquipped: () => false, fetchName: () => 'Item', fetchKind: () => armour.template.kind, fetchRank: () => 'none' });
    const hotActor = { fetchId: () => 9500002, backpack: { fetchItems: () => [actorItem(Number(armour.selfId), 1)] } };
    assert.strictEqual(BotWarehouse.hasActorDepositCandidates(hotActor, null), true, 'fixture: the armour is a warehouse candidate');
    assert.strictEqual(BotWarehouse.hasActorDepositCandidates(hotActor, null, new Map([[Number(armour.selfId), 1]])), false,
        'a piece the visit sells to the NPC is not stored first');
    console.log('Bot spare consumables checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => world.close());

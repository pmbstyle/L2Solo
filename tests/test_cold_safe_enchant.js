const assert = require('assert');
const fs = require('fs');

// Pins the x50 scroll stock.
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-safe-enchant');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const BotWarehouseService = invoke('GameServer/Bot/Economy/BotWarehouseService');

DataCache.init();
Database.init();

function fixture(predicate, description) {
    const item = DataCache.items.find(predicate);
    assert(item, `missing ${description} fixture`);
    return item;
}

function restockOf(state) {
    return ColdSafeEnchantService.scrollRestock(state, (id) => id !== 729, (id) => ({ 951: 100000, 947: 500000, 729: 2000000 })[id] || 0);
}

(async () => {
    // The reserve sells the weapon enchant scrolls to the spoiler line only (Scavenger 54,
    // Bounty Hunter 55), at most 20 C scrolls a game hour.
    const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
    const OfferQuery = invoke('GameServer/Bot/Economy/OfferQuery');
    const FixedStock = invoke('GameServer/Bot/Economy/FixedShotOffers');
    const fighter = { level: 45, stats: { classId: 1 } }, spoiler = { level: 45, stats: { classId: 55 } };
    for (const id of [951, 947, 729]) {
        assert.deepStrictEqual([...Market.fixedStoreOffers(id, fighter), ...Market.npcOffersAll(id)], [],
            `no store row sells scroll ${id} to a non-spoiler`);
        assert.strictEqual(Market.fixedStoreOffers(id, spoiler).length, 1, `the reserve sells scroll ${id} to a spoiler`);
    }
    const cRow = Market.fixedStoreOffers(951, spoiler)[0];
    assert.strictEqual(OfferQuery.admits(cRow, fighter), false, 'the offer admission refuses a non-spoiler the 951 row');
    assert.strictEqual(OfferQuery.admits(cRow, spoiler), true, 'the offer admission takes a spoiler');
    // The spoiler pays 1.2x the board's median deal price (3.4x the datapack price before
    // the board has deals, at any Adena rate): always more than the board pays it back.
    const datapack = Number(invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, 951).template.price);
    assert.strictEqual(Number(cRow.price), Math.round(3.4 * datapack), 'without deals a C scroll costs 3.4x its datapack price, no Adena rate');
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    const boardPrice = Math.round(2.8 * datapack);
    Counters.deal(951, boardPrice, 1, Date.now() - 2000, 11, 'Giran', 12);
    Counters.deal(951, boardPrice, 1, Date.now() - 1000, 13, 'Giran', 14);
    assert.strictEqual(Number(Market.fixedStoreOffers(951, spoiler)[0].price), Math.round(boardPrice * 1.2),
        'after board deals at 2.8x it costs 1.2x the board price');
    assert.strictEqual(FixedStock.lowestPrice(951), Math.round(boardPrice * 1.2), 'the quote follows the board too');
    const hour = Date.now();
    assert.strictEqual(FixedStock.take(951, 20, hour), 20, 'an hour holds 20 C scrolls');
    assert.strictEqual(FixedStock.take(951, 1, hour + 1000), 0, 'the 21st C scroll in the hour is refused');
    assert.strictEqual(FixedStock.refused(951), 1);
    assert.strictEqual(FixedStock.take(951, 50, hour + 3 * 3600000), 40, 'the stock refills hourly and holds two hours at most');
    const restocker = { level: 53, adena: 4500000, stats: { classId: 55 }, inventory: {
        100: { selfId: 100, amount: 1, equipped: true }, 951: { selfId: 951, amount: 1 } } };
    assert.deepStrictEqual(restockOf(restocker), [{ selfId: 951, amount: 2, money: 200000 }, { selfId: 947, amount: 3, money: 1500000 }],
        'a level 53 spoiler stocks C and B scrolls up to three each, keeping 2x each purchase after it');
    assert.deepStrictEqual(restockOf({ ...restocker, adena: 4499999 }), [{ selfId: 951, amount: 2, money: 200000 }, { selfId: 947, amount: 2, money: 1000000 }],
        'below 3x the three B scrolls\' cost it buys the two its money covers');
    assert.deepStrictEqual(restockOf({ ...restocker, adena: 299999 }), [], 'money below 3x one scroll stocks nothing');

    // A cold bot at a C level wearing a C weapon uses the C weapon scrolls it dropped
    // (951) to the safe +3, and buys the ones it lacks only from the money that keeps
    // it above 3x the weapon's price.
    const cWeapon = fixture((item) => item?.etc?.rank === 'c'
        && String(item?.template?.kind || '').startsWith('Weapon.')
        && Number(item?.etc?.slot || 0) > 0, 'C-grade weapon');
    const weaponPrice = 3000000, floor = 3 * weaponPrice;
    const cBot = (adena, scrolls = 1) => ({ level: 45, adena, inventory: {
        [cWeapon.selfId]: { selfId: Number(cWeapon.selfId), amount: 1, enchant: 0, equipped: true, slot: Number(cWeapon.etc.slot) },
        951: { selfId: 951, amount: scrolls }
    } });
    assert.strictEqual(ColdSafeEnchantService.hasPotential(cBot(0, 5)), true, 'a dropped C scroll and a worn C weapon start the batch');
    const cOperations = ColdSafeEnchantService.plan([
        { id: 1, selfId: Number(cWeapon.selfId), amount: 1, enchant: 0, equipped: 1, slot: Number(cWeapon.etc.slot) },
        { id: 2, selfId: 951, amount: 5, enchant: 0, equipped: 0, slot: 0 }
    ]);
    assert.deepStrictEqual(cOperations.map((row) => [row.targetId, row.scrollSelfId, row.enchantLevel]),
        [[1, 951, 1], [1, 951, 2], [1, 951, 3]], 'a worn C weapon takes the dropped C scrolls to the safe +3');
    const price = (id) => (id === Number(cWeapon.selfId) ? weaponPrice : 0);
    assert.deepStrictEqual(ColdSafeEnchantService.scrollPurchase(cBot(floor + 500000), price),
        { selfId: 951, amount: 2, money: 499999, weaponSelfId: Number(cWeapon.selfId) },
        'the two tries its held scroll does not cover, paid only from money above the floor');
    assert.strictEqual(ColdSafeEnchantService.scrollPurchase(cBot(floor + 1), price), null,
        'no money above 3x the weapon price buys no scroll');
    assert.strictEqual(ColdSafeEnchantService.scrollPurchase(cBot(floor * 10, 3), price), null,
        'held scrolls covering the safe level buy none');
    assert.strictEqual(ColdSafeEnchantService.scrollPurchase({ ...cBot(floor * 10), level: 55 }, price), null,
        'a C weapon below its level kit grade (B) buys no scroll');

    await Database.createAccount('cold_safe_enchant', 'secret');
    await Database.createCharacter('cold_safe_enchant', {
        name: 'SafeEnchantProbe', race: 0, classId: 0,
        maxHp: 300, maxMp: 120, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 81500, locY: 148500, locZ: -3470
    });
    const [character] = await Database.fetchCharacters('cold_safe_enchant');
    assert(character?.id);
    assert.strictEqual(await LifeState.init(), true);

    const weapon = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Weapon.')
        && Number(item?.etc?.slot || 0) > 0, 'D-grade weapon');
    const armor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && !String(item?.template?.kind || '').includes('Jewel')
        && Number(item?.etc?.slot || 0) > 0
        && Number(item.etc.slot) !== 15, 'D-grade armor');
    const fullArmor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && Number(item?.etc?.slot || 0) === 15, 'D-grade full armor');
    const jewel = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').includes('Jewel')
        && Number(item?.etc?.slot || 0) > 0, 'D-grade jewelry');
    const spareArmor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && Number(item.selfId) !== Number(armor.selfId)
        && Number(item.selfId) !== Number(fullArmor.selfId), 'unequipped D-grade armor');

    const rows = [];
    async function insert(item, { enchant = 0, equipped = true, slot = item.etc.slot } = {}) {
        const result = await Database.setItem(character.id, {
            selfId: item.selfId,
            name: item.template.name,
            amount: 1,
            enchant,
            equipped,
            slot: equipped ? Number(slot || item.etc.slot || 0) : 0
        });
        rows.push({ selfId: Number(item.selfId), id: Number(result.insertId) });
    }
    await insert(weapon, { enchant: 0 });
    await insert(armor, { enchant: 2 });
    await insert(fullArmor, { enchant: 3 });
    await insert(jewel, { enchant: 0 });
    await insert(spareArmor, { enchant: 0, equipped: false });
    await Database.setItem(character.id, {
        selfId: 955, name: 'Scroll: Enchant Weapon (Grade D)', amount: 5,
        enchant: 0, equipped: false, slot: 0
    });
    await Database.setItem(character.id, {
        selfId: 956, name: 'Scroll: Enchant Armor (Grade D)', amount: 8,
        enchant: 0, equipped: false, slot: 0
    });

    const base = await LifeState.upsertState({
        characterId: Number(character.id),
        accountName: 'cold_safe_enchant',
        name: 'SafeEnchantProbe',
        level: 30,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        loc: { locX: 81500, locY: 148500, locZ: -3470 },
        vitals: { hp: 300, maxHp: 300, mp: 120, maxMp: 120 },
        timing: { activityStartedAt: Date.now(), nextResolveAt: Date.now() },
        stats: {},
        inventory: {}
    }, 'cold_safe_enchant_fixture');
    const hydrated = await LifeState.refreshInventory(base);
    const persistedBase = await LifeState.upsertState(hydrated, 'cold_safe_enchant_inventory');

    // ARCH-NOTE: FX-F1 retains the original guaranteed safe-batch contract.
    const result = await ColdSafeEnchantService.enchantSafe(persistedBase);
    assert.strictEqual(result.enchanted, true);
    assert.strictEqual(result.operations.length, 8,
        'safe enchanting should consume only the scrolls needed to reach guaranteed levels');

    const physical = await Database.fetchItems(character.id);
    const enchantOf = (item) => Number(physical.find((row) => Number(row.selfId) === Number(item.selfId))?.enchant || 0);
    assert.strictEqual(enchantOf(weapon), 3, 'D weapon must stop at +3');
    assert.strictEqual(enchantOf(armor), 3, 'ordinary D armor must stop at +3');
    assert.strictEqual(enchantOf(fullArmor), 4, 'full-body D armor may use the C4 +4 safe point');
    assert.strictEqual(enchantOf(jewel), 3, 'D jewelry must stop at +3');
    assert.strictEqual(enchantOf(spareArmor), 0, 'unequipped gear must not consume scrolls');
    assert.strictEqual(Number(physical.find((row) => Number(row.selfId) === 955)?.amount || 0), 2);
    assert.strictEqual(Number(physical.find((row) => Number(row.selfId) === 956)?.amount || 0), 3);

    const second = await ColdSafeEnchantService.enchantSafe(result.state);
    assert.strictEqual(second.enchanted, false, 'already safe equipment must not consume more scrolls');
    assert.strictEqual(second.operations.length, 0);
    assert.strictEqual(result.state.stats.lastSafeEnchant.operations, 8);

    const weaponRow = physical.find((row) => Number(row.selfId) === Number(weapon.selfId));
    assert.deepStrictEqual(invoke('GameServer/Bot/Economy/ItemDisposition').warehouseCandidates(second.state), [],
        'ordinary safe-enchanted stock is not a warehouse deposit');
    const station = invoke('GameServer/Bot/Economy/CraftShopService').stationForSlot(0);
    const warehouseOwner = await LifeState.upsertState({ ...second.state,
        stats: { ...second.state.stats, craftStationId: station.id }
    }, 'cold_safe_enchant_infrastructure_owner');
    assert.strictEqual(warehouseOwner.characterId, character.id,
        'the warehouse lifecycle keeps the same physical inventory owner');
    assert.strictEqual(LifeState.cachedState(character.id).stats.craftStationId, station.id,
        'the native persisted owner, including its current revision, carries the infrastructure role');
    const deposited = await BotWarehouseService.depositCold(warehouseOwner);
    assert(deposited.items.some((item) => item.selfId === 955 && item.amount === 2),
        'unused D weapon scrolls should enter the normal warehouse lifecycle');
    await Database.execute(['UPDATE items SET enchant = 0 WHERE id = ? AND characterId = ?', [weaponRow.id, character.id]]);
    const resetState = await LifeState.refreshInventory(deposited.state);
    const huntingState = await LifeState.upsertState({
        ...resetState,
        activity: 'hunting',
        timing: { ...(resetState.timing || {}), nextResolveAt: Date.now() }
    }, 'cold_safe_enchant_warehouse_fixture');
    // ARCH-NOTE: C1 withdraws only the worker's exact decided materials.
    // This unfunded fixture has no decided scroll need; the common E market
    // choice may keep or release its stock. Preserve physical conservation
    // and the guaranteed batch instead of pinning the retired forced choice.
    const native = await require('./helpers/workerEconomyDecision')(huntingState);
    assert.deepStrictEqual(native.materials, []);
    const decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
    decisions.accept(character.id, native.decision);
    const beforeWarehouse = await Database.fetchWarehouseItems(character.id);
    assert.deepStrictEqual(ColdSafeEnchantService.warehouseRequests(huntingState, beforeWarehouse), []);
    // C2a requires explicit town access before a physical withdrawal.
    const released = await BotWarehouseService.releaseCold(huntingState, { inTown: true });
    decisions.forget(character.id);
    assert.strictEqual(released.released, released.items.length > 0);
    assert.deepStrictEqual(released.items.filter(item => item.reason !== 'market'), [],
        'no missing worker material may be replaced by a main-thread enchant request');
    assert(released.items.every(item => [955, 956].includes(item.selfId) && item.amount > 0));
    assert.strictEqual(released.state.adena, huntingState.adena, 'warehouse release must not create a direct NPC payout');
    const afterRelease = await Database.fetchItems(character.id);
    const remainingWarehouse = await Database.fetchWarehouseItems(character.id);
    const count = (items, selfId) => items.filter(row => Number(row.selfId) === selfId)
        .reduce((total, row) => total + Number(row.amount), 0);
    assert.strictEqual(count([...afterRelease, ...remainingWarehouse], 955), 2);
    assert.strictEqual(count([...afterRelease, ...remainingWarehouse], 956), 3);
    assert.strictEqual(Number(afterRelease.find(row => Number(row.selfId) === Number(weapon.selfId))?.enchant || 0), 0,
        'a deferred worker wish cannot silently become an enchant operation');
    for (const selfId of [955, 956]) {
        const moved = released.items.filter(item => item.selfId === selfId).reduce((total, item) => total + item.amount, 0);
        assert.strictEqual(count(afterRelease, selfId), moved);
        assert.strictEqual(count(remainingWarehouse, selfId), count(beforeWarehouse, selfId) - moved);
    }
    const [savedAfterRelease] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [character.id]]);
    assert.strictEqual(savedAfterRelease.adena, huntingState.adena);
    for (const selfId of [955, 956]) assert.strictEqual(Number(JSON.parse(savedAfterRelease.inventorySummary)[selfId]?.amount || 0),
        count(afterRelease, selfId), 'the saved summary matches the exact native physical withdrawal');
    assert.strictEqual(released.state.stats.lastSafeEnchant.operations, 8);
    // The guaranteed batch uses only scrolls physically delivered to the bag.
    // Native decided withdrawal/immediate enchant is covered separately.
    const ownWeaponScrolls = count(afterRelease, 955);
    const resumed = await ColdSafeEnchantService.enchantSafe(released.state);
    assert.strictEqual(resumed.operations.length, ownWeaponScrolls);
    const afterBatch = await Database.fetchItems(character.id);
    assert.strictEqual(Number(afterBatch.find(row => Number(row.selfId) === Number(weapon.selfId))?.enchant || 0), ownWeaponScrolls);
    assert.strictEqual(count(afterBatch, 955), 0);
    assert.strictEqual(count([...afterBatch, ...await Database.fetchWarehouseItems(character.id)], 956), 3);
    assert.strictEqual(resumed.state.adena, huntingState.adena);

    // A Bounty Hunter on a town visit in Oren with 16M, wearing a B weapon the reserve
    // sells to its line: the visit's errands buy its three B scrolls (5.1M at 3.4x the
    // datapack price, no board deals yet; 2x left after) at the reserve (M3tLa) and the purchase is a fixed_wts trade.
    const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
    const spoilerWeapon = 91;
    const spoilerWeaponPrice = Math.min(...MarketOpportunity.fixedStoreOffers(spoilerWeapon, { stats: { classId: 55 } }, { consignment: true })
        .map(offer => Number(offer.price)));
    assert(Number.isFinite(spoilerWeaponPrice), 'the reserve stocks the worn weapon on the spoiler line (consignment)');
    const oren = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Oren').center;
    await Database.createAccount('bot_s1c_spoiler', 'secret');
    await Database.createCharacter('bot_s1c_spoiler', {
        name: 'SpoilerRestock', race: 4, classId: 55,
        maxHp: 3000, maxMp: 1200, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: oren.locX, locY: oren.locY, locZ: oren.locZ
    });
    const bountyHunter = (await Database.fetchCharacters('bot_s1c_spoiler')).find(row => row.name === 'SpoilerRestock');
    assert(bountyHunter?.id);
    // Three B scrolls at 3.4x the datapack price x the x50 Adena rate, with 2x each purchase kept after it.
    const adena = 16000000 * 50;
    await Database.setItem(bountyHunter.id, { selfId: 57, name: 'Adena', amount: adena, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(bountyHunter.id, { selfId: spoilerWeapon, name: 'Heavy War Axe', amount: 1, enchant: 0, equipped: true,
        slot: Number(DataCache.items.find(item => Number(item?.selfId) === spoilerWeapon).etc.slot) });
    const shopping = await LifeState.upsertState({
        characterId: bountyHunter.id, accountName: 'bot_s1c_spoiler', name: 'SpoilerRestock', level: 55,
        phase: 'cold', activity: 'shopping', currentRegion: 'Oren', spotId: null, adena, loc: oren,
        vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(bountyHunter.id)),
        stats: { classId: 55, generatedCold: true,
            money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000, moneyPrice: 0.00001, refillReserve: 0, firstUnfundedPrice: 0 }),
            townVisit: { town: 'Oren', startedAt: Date.now() - 60000, reason: 'shopping' } },
        timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
    }, 'cold_safe_enchant_spoiler');
    assert(shopping, 'the spoiler is cold and shopping in Oren');
    await invoke('GameServer/Bot/Economy/ColdMarketService').finishTownErrands(shopping);
    assert.strictEqual(count(await Database.fetchItems(bountyHunter.id), 947), 3, 'the spoiler holds three B scrolls after the visit');
    await Database.flushJournals(); await Database.flushHistory();
    const scrollTrades = await Database.readHistory([`SELECT channel, quantity FROM market_trades WHERE selfId = 947 AND buyerCharacterId = ?`, [bountyHunter.id]]);
    assert.deepStrictEqual(scrollTrades.map(row => [row.channel, Number(row.quantity)]), [['fixed_wts', 3]], 'the reserve purchase is one fixed_wts trade of three');

    console.log('Cold safe enchant checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});

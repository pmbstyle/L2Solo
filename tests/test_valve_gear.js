// The gear valve: a reserve valve row sells a bot one C+ piece per grade over its
// life (stats.valveGear counts them, written with the purchase); the crafter rows
// sell to the Artisan/Warsmith line without that limit; each grade's shot store
// (Giran, Oren, Aden) sells every C, B and A reserve row.
const assert = require('assert');
const fs = require('fs');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('valve-gear');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
Database.init();
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };

const Production = invoke('GameServer/Bot/Economy/ProductionPolicy');
const Fixed = invoke('GameServer/Bot/Economy/FixedShotOffers');
const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Stores = invoke('GameServer/Bot/MerchantStoreConfigs');

(async () => {
    const offers = Stock.townOffers({ level: 75, currentRegion: 'Giran', adena: 1e9, inventory: {},
        stats: { classId: 57 } });
    const piece = (grade, weapon) => offers.find(offer => offer.grade === grade && offer.group.startsWith('Weapon.') === weapon);
    const cWeapon = piece('c', true), cArmour = piece('c', false), bWeapon = piece('b', true);
    const cWeapon2 = offers.find(offer => offer.grade === 'c' && offer.group.startsWith('Weapon.') && offer.selfId !== cWeapon?.selfId);
    assert(cWeapon && cWeapon2 && cArmour && bWeapon, 'Giran sells C weapons, C armour and B weapons');
    const row = (id, valve) => Fixed.offers(id.selfId).find(entry => entry.town === 'Giran' && !!entry.valve === valve);

    // 1. Admission: one valve weapon per grade, armour open; the crafter row ignores the count.
    const fresh = { level: 50, stats: { classId: 1 } };
    const usedC = { level: 50, stats: { classId: 1, valveGear: { C: 1 } } };
    assert.strictEqual(Production.allowsFixed(row(cWeapon, true), fresh), true, 'a fighter buys its first C piece at the valve');
    assert.strictEqual(Production.allowsFixed(row(cWeapon2, true), usedC), false, 'its second C weapon is refused');
    assert.strictEqual(Production.allowsFixed(row(cArmour, true), usedC), true, 'C armour stays open at the valve');
    assert.strictEqual(Production.allowsFixed(row(bWeapon, true), usedC), true, 'its first B piece is admitted');
    assert.strictEqual(Production.valveAllowance(row(bWeapon, true), usedC), 1, 'one B piece left to it (two wanted rings buy one)');
    assert.deepStrictEqual(Market.fixedStoreOffers(cWeapon2.selfId, usedC), [], 'no store row sells it a second C weapon');
    const smith = { level: 50, stats: { classId: 57, valveGear: { C: 1, B: 1, A: 1 } } };
    assert.strictEqual(Production.allowsFixed(row(cArmour, false), smith), true, 'a Warsmith buys at its crafter row regardless');

    // 2. Coverage: each reserve store sells the C, B and A rows, crafter and valve.
    for (const name of ['Squeesh', 'M3tLa', 'Lowfiles']) {
        const items = Stores[name].items;
        for (const grade of ['C', 'B', 'A']) {
            assert(items.some(line => line.valve === grade), `${name} has a ${grade} valve row`);
        }
        assert.strictEqual(items.filter(line => Array.isArray(line.buyerClasses) && line.buyerClasses.includes(57)).length,
            items.filter(line => line.valve).length, `${name}: a crafter row for every valve row`);
    }

    // 3. The purchase counts the piece: a cold fighter in Giran buys a C weapon at the
    // valve, is refused a second C weapon, and buys a B weapon.
    const giran = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Giran').center;
    await Database.createAccount('bot_valve', 'secret');
    await Database.createCharacter('bot_valve', { name: 'ValveFighter', race: 0, classId: 1,
        maxHp: 3000, maxMp: 1200, sex: 0, face: 0, hair: 0, hairColor: 0, locX: giran.locX, locY: giran.locY, locZ: giran.locZ });
    const character = (await Database.fetchCharacters('bot_valve')).find(entry => entry.name === 'ValveFighter');
    const adena = 500000000;
    await Database.setItem(character.id, { selfId: 57, name: 'Adena', amount: adena, enchant: 0, equipped: false, slot: 0 });
    let state = await LifeState.upsertState({
        characterId: character.id, accountName: 'bot_valve', name: 'ValveFighter', level: 50,
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', spotId: null, adena, loc: giran,
        vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(character.id)),
        stats: { classId: 1, generatedCold: true,
            money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000, moneyPrice: 0.00001, refillReserve: 0, firstUnfundedPrice: 0 }) },
        timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
    }, 'valve_gear_fixture');
    const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
    const first = await Cold.buyOffer(state, row(cWeapon, true), { autoEquip: false, free: true });
    assert.strictEqual(first.purchased, true, `the first C piece is bought (${first.reason})`);
    state = first.state;
    assert.deepStrictEqual(state.stats.valveGear, { C: 1 }, 'the purchase counts one C piece');
    const [saved] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [character.id]]);
    assert.deepStrictEqual(JSON.parse(saved.statsJson).valveGear, { C: 1 }, 'the count is saved with the purchase');
    const second = await Cold.buyOffer(state, row(cWeapon2, true), { autoEquip: false, free: true });
    assert.strictEqual(second.purchased, false, 'a second C weapon at the valve is refused');
    const third = await Cold.buyOffer(second.state || state, row(bWeapon, true), { autoEquip: false, free: true });
    assert.strictEqual(third.purchased, true, `the first B piece is bought (${third.reason})`);
    assert.deepStrictEqual(third.state.stats.valveGear, { C: 1, B: 1 });
    const bag = await Database.fetchItems(character.id);
    assert.strictEqual(bag.filter(item => [cWeapon.selfId, bWeapon.selfId].includes(Number(item.selfId))).length, 2);
    assert(!bag.some(item => Number(item.selfId) === cWeapon2.selfId), 'no second C weapon in the bag');

    console.log('valve gear: ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
});

// A crafter's restock on consignment: a Warsmith takes a B weapon from its crafter
// row in Oren without paying (its 1M adena would not buy it), owes the unit, and
// once the unit has left its holdings pays the store its cost at its next town
// visit, journalled as the fixed_wts purchase it replaces.
const assert = require('assert');
const fs = require('fs');

// Pins the x50 restock pace.
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('crafter-consignment');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
Database.init();
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };

const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');

(async () => {
    const oren = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Oren').center;
    await Database.createAccount('bot_consign', 'secret');
    await Database.createCharacter('bot_consign', { name: 'ConsignSmith', race: 4, classId: 57,
        maxHp: 3000, maxMp: 1200, sex: 0, face: 0, hair: 0, hairColor: 0, locX: oren.locX, locY: oren.locY, locZ: oren.locZ });
    const character = (await Database.fetchCharacters('bot_consign')).find(entry => entry.name === 'ConsignSmith');
    const adena = 1000000;
    await Database.setItem(character.id, { selfId: 57, name: 'Adena', amount: adena, enchant: 0, equipped: false, slot: 0 });
    const now = Date.now();
    // One B piece of allowance and none of the other grades: the visit stocks one B weapon.
    const allowance = { c: { pieces: 0, at: now }, b: { pieces: 1, at: now }, a: { pieces: 0, at: now } };
    let state = await LifeState.upsertState({
        characterId: character.id, accountName: 'bot_consign', name: 'ConsignSmith', level: 55,
        phase: 'cold', activity: 'shopping', currentRegion: 'Oren', spotId: null, adena, loc: oren,
        vitals: { hp: 3000, maxHp: 3000, mp: 1200, maxMp: 1200 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(character.id)),
        stats: { classId: 57, generatedCold: true, gnomeAllowance: allowance,
            money: invoke('GameServer/Bot/Economy/StatsPacket').money({ hourAdena: 100000, moneyPrice: 0.00001, refillReserve: 0, firstUnfundedPrice: 0 }) },
        timing: { activityStartedAt: now - 60000, lastResolvedAt: now - 1000, nextResolveAt: now }
    }, 'crafter_consignment_fixture');

    // 1. The restock: one B weapon in the bag, no adena paid, one unit owed.
    state = await Cold.crafterStock(state);
    const offers = Stock.townOffers(state);
    const bagIds = (await Database.fetchItems(character.id)).map(item => Number(item.selfId));
    const bought = offers.filter(offer => offer.grade === 'b' && offer.group.startsWith('Weapon.') && bagIds.includes(offer.selfId));
    assert.strictEqual(bought.length, 1, `one B weapon restocked (bag ${bagIds})`);
    const weapon = bought[0];
    assert(weapon.price > adena, `the B weapon's cost ${weapon.price} is above the crafter's adena ${adena}`);
    assert.strictEqual(state.adena, adena, 'the consigned restock costs no adena');
    const wallet = async () => (await Database.fetchItems(character.id)).filter(item => Number(item.selfId) === 57)
        .reduce((sum, item) => sum + Number(item.amount), 0);
    assert.strictEqual(await wallet(), adena, 'the saved wallet is unchanged');
    assert.deepStrictEqual(state.stats.gnomeStock[weapon.selfId], { cost: weapon.price, ceiling: weapon.ceiling, owed: 1 },
        'the crafter owes one unit at its cost');
    const [saved] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [character.id]]);
    assert.strictEqual(JSON.parse(saved.statsJson).gnomeStock[weapon.selfId].owed, 1, 'the debt is saved with the purchase');

    // 2. The unit leaves its holdings (sold) and the crafter has the money it was sold for.
    const sale = weapon.price + 500000;
    const item = (await Database.fetchItems(character.id)).find(entry => Number(entry.selfId) === weapon.selfId);
    await Database.execute(['DELETE FROM items WHERE id = ?', [item.id]]);
    await Database.execute(['UPDATE items SET amount = ? WHERE characterId = ? AND selfId = 57', [adena + sale, character.id]]);
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(character.id));
    state = await LifeState.upsertState({ ...state, adena: adena + sale, inventory }, 'crafter_consignment_sale') || state;

    // 3. The next visit pays the store its cost: adena down by the cost, nothing owed,
    // one fixed_wts trade journalled at the cost.
    state = await Cold.crafterStock(state);
    assert.strictEqual(state.adena, adena + sale - weapon.price, 'the visit pays the cost of the sold unit');
    assert.strictEqual(await wallet(), adena + sale - weapon.price, 'the saved wallet paid it');
    assert.strictEqual(state.stats.gnomeStock[weapon.selfId].owed, 0, 'nothing is owed');
    const [after] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [character.id]]);
    assert.strictEqual(JSON.parse(after.statsJson).gnomeStock[weapon.selfId].owed, 0, 'the payment is saved with the debt');
    let trades = [];
    for (let attempt = 0; attempt < 50 && !trades.length; attempt++) {
        trades = await Database.readHistory(['SELECT * FROM market_trades WHERE channel = ? AND buyerCharacterId = ?', ['fixed_wts', character.id]]);
        if (!trades.length) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(trades.map(trade => [Number(trade.selfId), Number(trade.quantity), Number(trade.unitPrice)]),
        [[weapon.selfId, 1, weapon.price]], 'one fixed_wts purchase journalled at the cost, at the payment');

    // 4. The owed limit: a crafter owing OWED_PIECES units stocks nothing more.
    const full = { ...state, stats: { ...state.stats, gnomeAllowance: undefined,
        gnomeStock: { [weapon.selfId]: { cost: 1, ceiling: 2, owed: Stock.OWED_PIECES } } } };
    assert.strictEqual(Stock.restock(full, { offers, now: Date.now(), demandFor: () => 5 }).rows.length, 0, 'at the owed limit nothing is stocked');

    console.log('crafter consignment: ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
});

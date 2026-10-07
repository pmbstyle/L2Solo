'use strict';

// A stock decision and a durable paid inventory are separate boundaries.
// The original level-one wallet must not imply a fixed 10% reserve or a buy.
const assert = require('node:assert/strict');
const fs = require('node:fs');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('native-shot-restart');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const Shared = invoke('GameServer/Network/Shared');
const Data = invoke('GameServer/DataCache');
Data.init();
const Actor = invoke('GameServer/Actor/Actor');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Stock = invoke('GameServer/Inventory/ShotStock');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const nativeDecision = require('./helpers/workerEconomyDecision');
const { compact } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => spots);

const INITIAL_SHOTS = 500;
const INITIAL_ADENA = 7000;
const ORIGINAL_PAID_STOCK = 1400;
const QUOTED_UNIT_PRICE = 7;
const plan = { kind: 'soulshot', rank: 'none', selfId: 1835,
    name: 'Soulshot: No Grade', price: QUOTED_UNIT_PRICE };

function hold(reason, facts) {
    const error = new Error(`HOLD native shot-restart prerequisite: ${reason}`);
    error.code = 'NATIVE_FIXTURE_HOLD';
    error.facts = facts;
    throw error;
}

// Independent E5/E9 arithmetic over the native table, the physical bag and
// first prices. No stock(), returned target, supplied money or visit history.
function expectedStock(state, timestamp) {
    const role = Roles.inferRole(state.stats.classId);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage'
        : role === 'crafter' ? 'spoiler' : role;
    const hunt = Hunt.huntIncome(state, timestamp);
    const spotId = hunt.spotId || state.spotId;
    const current = spotId ? Table.value(spotId, tableRole, state.level, true) : null;
    const withShots = current || Table.best(tableRole, state.level, true);
    const withoutShots = spotId ? Table.value(spotId, tableRole, state.level, false) : null;
    if (!withShots || !withoutShots) hold('authored shot/no-shot table rows unavailable', { spotId, tableRole });
    const shotPlan = Stock.planForState(state);
    const persona = invoke('GameServer/Bot/AI/BotPersona').of(state);
    const priceContext = { characterId: state.characterId, understanding: persona?.understanding ?? 0.3,
        marketTrades: state.marketTrades, board: invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(), timestamp };
    const price = id => {
        const belief = Belief.prior(id, priceContext);
        return belief ? Math.exp(belief.mu) : 0;
    };
    const rawUse = shotPlan.perAction > 0 ? Math.max(0, Number(withShots.shots) || 0) : 0;
    const benefit = Math.max(0, 1 - Math.max(0, Number(withoutShots.exp) || 0)
        / Math.max(1, Number(withShots.exp) || 0));
    const hourAdena = Hunt.huntHour(hunt, state);
    const costHours = rawUse * price(shotPlan.selfId) / hourAdena;
    const use = benefit >= costHours ? rawUse : 0;
    const potionId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const potionUse = Math.max(0, Number(withShots.potions) || 0);
    assert.equal(state.stats.visitEvery, undefined, 'no visit history is invented for the original restart case');
    const plannedSlots = Number(use > 0 && !(state.inventory[shotPlan.selfId]?.amount > 0))
        + Number(potionUse > 0 && !(state.inventory[potionId]?.amount > 0));
    const freeSlots = Math.max(0, Floor.inventoryLimit(state.stats.race)
        - Floor.stateInventory(state, Data.items).slots - plannedSlots);
    const bagHours = current?.stacks === null || current?.stacks === undefined ? 2
        : current.stacks > 0 ? freeSlots / current.stacks : 24;
    const hours = Math.max(0.5, Math.min(24, bagHours));
    return { itemId: shotPlan.selfId, perAction: shotPlan.perAction, use, hours,
        target: Math.ceil(use * hours), benefit, costHours, hourAdena, spotId,
        nativeUnitPrice: price(shotPlan.selfId), freeSlots, stacks: current?.stacks };
}

async function main() {
    Database.init();
    await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)',
        ['shot_restart', 'test']], 'test:account');
    const character = await Database.execute([
        `INSERT INTO characters(username, name, classId, race, level, exp, sp,
         hp, maxHp, mp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
         VALUES (?, ?, 0, 0, 1, 0, 0, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0)`,
        ['shot_restart', 'ShotRestartProbe']
    ], 'test:character');
    const characterId = Number(character.insertId);
    const weaponTemplate = Data.items.find(item => Number(item.selfId) === 1);
    assert(weaponTemplate, 'Short Sword is an authored Human Fighter NG weapon');
    assert.equal(weaponTemplate.etc.rank, 'none');
    assert.equal(weaponTemplate.etc.slot, 7);
    assert.equal(weaponTemplate.etc.soulshot, 1);
    await Database.setItem(characterId, { selfId: 1, name: weaponTemplate.template.name,
        amount: 1, equipped: true, slot: 7 });
    await Database.setItem(characterId, { selfId: plan.selfId, name: plan.name, amount: INITIAL_SHOTS });
    await Database.setItem(characterId, { selfId: 57, name: 'Adena', amount: INITIAL_ADENA });
    const loaded = (await Shared.fetchCharacters('shot_restart'))[0];
    const classInfo = await Shared.fetchClassInformation(loaded.classId);
    const session = { accountId: 'shot_restart', questStates: new Map(), plan: 'hunting' };
    const actor = new Actor(session, { ...loaded, ...utils.crushOb(classInfo) });
    session.actor = actor;
    invoke('GameServer/Actor/Generics/CalculateStats')(session, actor);
    assert.equal(actor.backpack.fetchEquippedWeapon().fetchSelfId(), 1);
    assert.equal(actor.backpack.fetchItems().length, 3, 'all three physical SQL stacks feed the actual Backpack');
    assert.equal(actor.fetchLevel(), 1);
    assert.equal(actor.fetchClassId(), 0);
    assert.equal(actor.fetchExp(), 0);
    assert.equal(actor.fetchSp(), 0);
    const timestamp = Date.now();
    // Strip the main-only Item aliases; the native inventory summary remains
    // derived exclusively from this real Backpack, including SQL object ids.
    const { physicalInventory, ...physical } = Economy.stateForActor(actor);
    const nativeState = { ...physical, phase: 'cold', exp: actor.fetchExp(),
        loc: { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() },
        vitals: { hp: actor.fetchHp(), maxHp: actor.fetchMaxHp(), mp: actor.fetchMp(), maxMp: actor.fetchMaxMp() },
        stats: { ...physical.stats, race: actor.fetchRace() } };
    const beforePlanning = structuredClone(nativeState);
    const producer = await nativeDecision(nativeState, { timestamp });
    assert.deepEqual(nativeState, beforePlanning, 'native planning spends no physical materials or money');
    assert(Array.isArray(producer.statsPacket.money), 'actual worker produces the E3 wallet packet');
    const leaf = compact(producer.decision).activity;
    const expected = expectedStock(nativeState, timestamp);
    assert.equal(expected.itemId, plan.selfId);
    assert.equal(expected.perAction, 1);
    assert(expected.costHours > expected.benefit, 'the authored level-one shot cost exceeds its hunt benefit');
    assert.equal(expected.use, 0, 'expensive shots have no ordinary economic use for this original input');
    assert.equal(expected.target, 0);
    assert(!(leaf?.activity === 'shopping' && Number(leaf.itemId) === plan.selfId),
        'the native ordinary decision must not buy an uneconomic shot stock');
    session.coldLifeState = { ...nativeState, phase: 'hot',
        stats: { ...nativeState.stats, ...producer.statsPacket } };
    const beforeOrdinary = await Database.fetchItems(characterId);
    const ordinary = await Stock.purchaseActorRestock(actor, { plan, unitPrice: QUOTED_UNIT_PRICE });
    assert.equal(ordinary.changed, false);
    assert.equal(ordinary.amount, INITIAL_SHOTS);
    assert.equal(ordinary.cost, 0);
    assert.deepEqual(await Database.fetchItems(characterId), beforeOrdinary,
        'the ordinary no-buy must preserve every physical stack and the wallet');

    // Submit a paid NPC inventory request to exercise persistence. This is
    // an explicit transaction input, not an injected autonomous wish/budget.
    // Keep the original 500 + 900 shots, 7000 - 900*7 Adena boundary.
    const requestedDelta = ORIGINAL_PAID_STOCK - INITIAL_SHOTS;
    const purchased = await Database.purchaseNpcInventoryItem(characterId, {
        selfId: plan.selfId, name: plan.name, amount: requestedDelta, unitPrice: QUOTED_UNIT_PRICE });
    assert.equal(purchased.ok, true);
    assert.equal(purchased.amount, 900);
    assert.equal(purchased.spent, 6300);
    const afterPaid = await Database.fetchItems(characterId);
    assert.equal(Number(afterPaid.find(row => Number(row.selfId) === 57).amount), 700);
    assert.equal(Number(afterPaid.find(row => Number(row.selfId) === plan.selfId).amount), 1400,
        'the persisted test bot should retain paid stock before restart');
    assert.equal(Number(afterPaid.find(row => Number(row.selfId) === 1).amount), 1);
    assert.equal(Number(afterPaid.find(row => Number(row.selfId) === 57).amount) + purchased.spent, INITIAL_ADENA);
    assert.equal(Number(afterPaid.find(row => Number(row.selfId) === plan.selfId).amount) - purchased.amount, INITIAL_SHOTS);
    assert.equal(afterPaid.length, beforeOrdinary.length, 'buying shots cannot mint another physical stack');
    await Database.close();
    Database.init();
    const initiallyLoaded = await Shared.fetchCharacters('shot_restart');
    const loadedShots = initiallyLoaded[0].items.find(row => Number(row.selfId) === plan.selfId);
    assert.equal(Number(loadedShots.amount), 1400, 'the paid shot amount must load unchanged from SQLite after database restart');
    const reconciled = await Stock.ensureCharacterStock(characterId, { plan, targetAmount: Stock.DEFAULT_TARGET_AMOUNT });
    assert.equal(reconciled.changed, false, 'bot startup reconciliation must treat 1000 as a minimum and preserve extra paid shots');
    const readyCharacters = await Shared.fetchCharacters('shot_restart');
    const readyShots = readyCharacters[0].items.find(row => Number(row.selfId) === plan.selfId);
    assert.equal(Number(readyShots.amount), 1400, 'the final bot actor input must retain the extra shots after startup reconciliation');
    const adenaId = Number(afterPaid.find(row => Number(row.selfId) === 57).id);
    await Database.updateItemAmount(characterId, adenaId, 5000);
    const orePurchase = await Database.purchaseNpcInventoryItem(characterId, {
        selfId: 1785, name: 'Soul Ore', amount: 3, unitPrice: 500 });
    assert.equal(orePurchase.ok, true);
    const rejected = await Database.purchaseNpcInventoryItem(characterId, {
        selfId: 1785, name: 'Soul Ore', amount: 8, unitPrice: 500 });
    assert.deepEqual(rejected, { ok: false, reason: 'insufficient_adena' });
    const purchasedRows = await Database.fetchItems(characterId);
    assert.equal(Number(purchasedRows.find(row => Number(row.selfId) === 57)?.amount), 3500);
    assert.equal(Number(purchasedRows.find(row => Number(row.selfId) === 1785)?.amount), 3,
        'the rejected purchase must neither spend Adena nor mint ore');
    console.log('Native shot stock restart persistence checks passed');
}

main().catch(error => {
    console.error(error);
    if (error.facts) console.error(JSON.stringify(error.facts));
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});

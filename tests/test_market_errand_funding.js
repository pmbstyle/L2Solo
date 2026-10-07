'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('market-errand-funding');
require('../src/Global');
fixture.assertConfigured(options.default);
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const DION = { locX: 17000, locY: 145000, locZ: -3000 };
const WALLET = 1000000, RATE = 2e-5;
const OLD = [77000, 1.3e-5, 15000, 0], CHANGED = [77000, 3e-5, 15000, 1200000];
let nextId = 719120;

async function stateFor(packet = OLD, extra = {}) {
    const id = nextId++;
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: WALLET, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: 'bot_errand_funding', name: `Funding${id}`,
        phase: 'cold', activity: 'hunting', level: 30, exp: Number(Data.experience[29]),
        adena: WALLET, currentRegion: 'Dion', loc: DION,
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 0, money: [...packet], ...extra } }, 'errand_funding_fixture');
}

async function arrive(state, packet = state.stats.money) {
    return Life.upsertState({ ...state, activity: 'shopping', currentRegion: 'Giran', loc: GIRAN,
        stats: { ...state.stats, travel: null, money: [...packet] } }, 'errand_funding_arrival');
}

async function wallet(id) {
    return (await Database.fetchItems(id)).filter(row => Number(row.selfId) === 57)
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

async function stock(id, itemId) {
    return (await Database.fetchItems(id)).filter(row => Number(row.selfId) === Number(itemId))
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

async function errand(state, itemId, amount, settings = {}) {
    const result = await Market.acquire(state, itemId, amount, { towns: ['Giran'], cost: () => 0,
        money: Funding.spendable(state, 0, { r: RATE }), r: RATE, purpose: 'craft_input', ...settings });
    assert.equal(result.bought, false);
    assert.equal(result.state.stats.marketErrand.town, 'Giran', 'a real acquisition leaves its trip to the seller');
    return result.state;
}

async function noSpend(state, itemId, message) {
    const items = await Database.fetchItems(state.characterId);
    const result = await Market.tryPurchase(state, { type: 'market_errand', status: 'active' });
    assert.equal(result.purchased, false, message);
    assert.equal(result.units, 0);
    assert.deepEqual(await Database.fetchItems(state.characterId), items, 'refusal preserves every physical item and Adena');
    assert.equal(await stock(state.characterId, itemId), 0);
    assert.equal(Errands.pending(result.state).length, 0, 'a refused stale errand returns to its originating job');
    return result;
}

(async () => {
    Data.init();
    const npc = [1, 2, 3, 4, 5, 6, 7, 10, 14, 34, 40, 110, 2508]
        .flatMap(itemId => Offers.npcOffers(itemId, 'Giran'))
        .filter(row => row.price > 0 && row.price < WALLET).sort((left, right) => left.price - right.price)[0];
    assert(npc, 'the fixture uses an actual C4 Giran NPC quote');
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('bot_errand_funding','fixture')");
    const character = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'bot_errand_funding',?,0,0,30,?,0,187,74,187,74,0,0,0,0,17000,145000,-3000,-1,0)`);
    for (let id = nextId; id < nextId + 30; id++) character.run(id, `Funding${id}`, Number(Data.experience[29]));
    seed.close();
    await Database.init();
    try {
        await Life.init();
        invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
        const stale = await errand(await stateFor(), npc.selfId, 1, { maxPrice: npc.price });
        const storedRate = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [stale.characterId]]))[0];
        const changed = await arrive(stale, CHANGED);
        assert.equal(Funding.spendable(changed, 0, { r: RATE }), 0);
        await noSpend(changed, npc.selfId, 'a changed money packet cancels the former NPC purchasing cap');
        assert.equal(JSON.parse(storedRate.statsJson).marketErrand.r, RATE, 'SQLite retains the exact original numeric rate');
        assert.equal(stale.stats.marketErrand.r, RATE, 'the original income rate survives native save and arrival');

        const admissible = await arrive(await errand(await stateFor(), npc.selfId, 1, { maxPrice: npc.price }));
        const arrivedWallet = await wallet(admissible.characterId);
        assert(arrivedWallet < WALLET, 'the native journey has already paid its actual teleport cost');
        const bought = await Market.tryPurchase(admissible, { type: 'market_errand' });
        assert.equal(bought.purchased, true, 'the same original income rate still admits an affordable NPC purchase');
        assert.equal(bought.units, 1);
        assert.equal(await wallet(admissible.characterId), arrivedWallet - npc.price);
        assert.equal(await stock(admissible.characterId, npc.selfId), 1);
        assert.equal(bought.state.adena, arrivedWallet - npc.price);
        assert.equal(Number.isInteger(bought.state.adena), true);

        // Explicit zero is not permission to look up a better item rate.
        const zero = await stateFor([77000, 1.3e-5, 15000, 0, RATE, 30000, npc.selfId], {
            marketErrand: { selfId: npc.selfId, amount: 1, town: 'Giran', money: 985000,
                maxPrice: npc.price, r: 0, purpose: 'craft_input', at: Date.now() } });
        await noSpend(await arrive(zero), npc.selfId, 'r=0 cannot fall back to a funded item rate');
        const legacy = await stateFor(CHANGED, { marketErrand: { selfId: npc.selfId, amount: 1, town: 'Giran',
            money: 985000, maxPrice: npc.price, purpose: 'craft_input', at: Date.now() } });
        await noSpend(await arrive(legacy), npc.selfId, 'a legacy errand without its rate uses the current conservative item gate');

        const clanZero = await stateFor(CHANGED, { marketErrand: { selfId: npc.selfId, amount: 1, town: 'Giran',
            money: npc.price, maxPrice: npc.price, purpose: 'clan', tag: { clanId: 42, clanPart: 0 }, at: Date.now() } });
        await noSpend(await arrive(clanZero), npc.selfId, 'a clan errand with no treasury part cannot spend newly reserved personal money');
        const clanPart = 10000;
        const reserved = WALLET - 15000 - npc.price + 1000;
        const clanDouble = await stateFor([77000, 1.3e-5, 15000, 0, 4e-5, reserved, 999999], {
            marketErrand: { selfId: npc.selfId, amount: 1, town: 'Giran', money: npc.price, maxPrice: npc.price,
                purpose: 'clan', tag: { clanId: 42, clanPart }, at: Date.now() } });
        assert.equal(Funding.spendable({ ...clanDouble, adena: WALLET - clanPart }, 0, { free: true }) + clanPart, npc.price - 1000);
        await noSpend(await arrive(clanDouble), npc.selfId, 'the treasury credit cannot also be counted as personal free money');
        const clanFunded = await stateFor(CHANGED, { marketErrand: { selfId: npc.selfId, amount: 1, town: 'Giran',
            money: npc.price, maxPrice: npc.price, purpose: 'clan', tag: { clanId: 42, clanPart: npc.price }, at: Date.now() } });
        const clanBought = await Market.tryPurchase(await arrive(clanFunded), { type: 'market_errand' });
        assert.equal(clanBought.purchased, true, 'the existing treasury credit still pays when personal free money is zero');
        assert.equal(await wallet(clanFunded.characterId), WALLET - npc.price);

        // A real seller reserves stock on the board; no mocked transaction or wallet.
        const seller = await arrive(await stateFor());
        await Database.setItem(seller.characterId, { selfId: 1864, name: 'Stem', amount: 20, slot: 0 });
        await Afk.openBotRecords(seller.characterId, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'Native inputs',
            lines: [{ selfId: 1864, name: 'Stem', count: 20, price: 40000, enchant: 0, stackable: true }] }]);
        const sellerLine = Afk.boardIndex().ownerLines(seller.characterId)[0];
        assert(sellerLine && sellerLine.count === 20);
        const boardStale = await arrive(await errand(await stateFor(), 1864, 2, { npc: false }), CHANGED);
        await noSpend(boardStale, 1864, 'a changed money packet also rejects a board transaction');
        assert.equal(Afk.boardIndex().ownerLines(seller.characterId)[0].count, 20);

        await Database.setItem(seller.characterId, { selfId: 736, name: 'Scroll of Escape', amount: 1, slot: 0 });
        await Afk.openBotRecords(seller.characterId, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'One genuine escape scroll',
            lines: [{ selfId: 736, name: 'Scroll of Escape', count: 1, price: 10, enchant: 0, stackable: true }] }]);
        const legacySurvival = await arrive(await stateFor(CHANGED, { marketErrand: {
            selfId: 736, amount: 2, town: 'Giran', purpose: 'scrolls', money: 985000, at: Date.now() } }));
        assert(invoke('GameServer/Bot/Economy/EconomyContext').basics(legacySurvival).kitCost(736) >= 10);
        const survival = await Market.tryPurchase(legacySurvival, { type: 'market_errand' });
        assert.equal(survival.units, 1, 'a legacy errand may buy its one missing survival scroll');
        assert.equal(await stock(legacySurvival.characterId, 736), 1);
        assert.equal(await wallet(legacySurvival.characterId), WALLET - 10);
        assert.equal(invoke('GameServer/Bot/Economy/EconomyContext').basics(survival.state).kitCost(736), 0,
            'after the debit the filled kit permits no extra NPC remainder');

        const valueState = await stateFor();
        const valueTrip = await errand(valueState, 1864, 1, { npc: false, purpose: 'recipe', r: undefined, valueHours: 1 });
        assert.equal(valueTrip.stats.marketErrand.valueHours, 1, 'value hours, rather than a truthy-rate fallback, survive the trip');
        const valueSaved = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [valueTrip.characterId]]))[0];
        assert.equal(JSON.parse(valueSaved.statsJson).marketErrand.valueHours, 1);
        await noSpend(await arrive(valueTrip, [77000, .0001, 15000, 0]), 1864,
            'the original one-hour value cannot pay a now overpriced recipe');

        const partialPacket = [77000, 1.3e-5, 15000, 0, 4e-5, 890000, 999999];
        const partial = await arrive(await errand(await stateFor(partialPacket), 1864, 3, { npc: false }));
        const partialWallet = await wallet(partial.characterId);
        const partialBudget = Funding.spendable(partial, 0, { r: RATE });
        assert(partialBudget >= 80000 && partialBudget < 120000);
        const partialBought = await Market.tryPurchase(partial, { type: 'market_errand' });
        assert.equal(partialBought.units, 2, 'an incomplete stack still buys the affordable physical part');
        assert.equal(await wallet(partial.characterId), partialWallet - 80000);
        assert.equal(await stock(partial.characterId, 1864), 2);
        assert.equal(Funding.spendable(partialBought.state, 0, { r: RATE }), partialBudget - 80000,
            'higher-valued wishes remain reserved after a partial acquisition');

        const otherTown = await errand(await stateFor(), 1864, 1, { npc: false });
        const rerouted = await Life.upsertState({ ...otherTown, activity: 'shopping', currentRegion: 'Dion', loc: DION,
            stats: { ...otherTown.stats, travel: null, townVisit: { completed: true } } }, 'errand_other_town_fixture');
        const replanned = await Market.tryPurchase(rerouted, { type: 'market_errand' });
        assert.equal(replanned.state.stats.marketErrand.r, RATE, 'replanning the remaining trip keeps the same original value rate');
        assert.equal(replanned.state.stats.marketErrand.purpose, 'craft_input');
        assert.equal(await stock(rerouted.characterId, 1864), 0, 'replanning buys nothing from another town');

        const secondSeller = await arrive(await stateFor());
        await Database.setItem(secondSeller.characterId, { selfId: 1864, name: 'Stem', amount: 1, slot: 0 });
        await Afk.openBotRecords(secondSeller.characterId, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'Cheaper first line',
            lines: [{ selfId: 1864, name: 'Stem', count: 1, price: 30000, enchant: 0, stackable: true }] }]);
        const changing = await arrive(await errand(await stateFor(), 1864, 2, { npc: false }));
        const changingWallet = await wallet(changing.characterId);
        const originalBuy = Afk.buyFromShop;
        let committed = 0;
        Afk.buyFromShop = async (...args) => {
            const trade = await originalBuy.apply(Afk, args);
            if (Number(args[0]) !== changing.characterId) return trade;
            committed++;
            const current = await Life.upsertState({ ...trade.coldState,
                stats: { ...trade.coldState.stats, money: [...CHANGED] } }, 'errand_funding_changed_after_native_debit');
            return { ...trade, coldState: current };
        };
        let afterFirst;
        try { afterFirst = await Market.tryPurchase(changing, { type: 'market_errand' }); }
        finally { Afk.buyFromShop = originalBuy; }
        assert.equal(committed, 1, 'the next board line checks funding again after the first native debit');
        assert.equal(afterFirst.units, 1);
        assert.equal(await wallet(changing.characterId), changingWallet - 30000);
        assert.equal(await stock(changing.characterId, 1864), 1);

        const sizes = [];
        let batch = await stateFor();
        for (let i = 0; i < 12; i++) {
            batch = await errand({ ...batch, activity: 'hunting', stats: { ...batch.stats, travel: null } }, npc.selfId, 1,
                { purpose: `craft_input_${i}`, maxPrice: npc.price, r: RATE });
            const row = batch.stats.marketErrand;
            const { r, valueHours, ...withoutFunding } = row;
            sizes.push(Buffer.byteLength(JSON.stringify(row)) - Buffer.byteLength(JSON.stringify(withoutFunding)));
        }
        assert.equal(batch.stats.marketErrands.length, 8, 'funding metadata does not lift the existing eight-errand cap');
        const saved = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [batch.characterId]]))[0];
        assert.equal(JSON.parse(saved.statsJson).marketErrands.length, 8);
        const stripped = JSON.parse(saved.statsJson);
        for (const row of [...stripped.marketErrands, stripped.marketErrand]) { delete row.r; delete row.valueHours; }
        const savedBatchDelta = Buffer.byteLength(saved.statsJson) - Buffer.byteLength(JSON.stringify(stripped));
        assert.equal(savedBatchDelta, 9 * Math.max(...sizes), 'the eight errands and primary alias have a bounded numeric delta');
        const valuedPlan = Market.planPurchase(admissible, npc.selfId, 1, { money: 100000, towns: ['Giran'],
            r: RATE, purpose: 'craft_input' });
        const { r: planRate, purpose: planPurpose, ...oldPlan } = valuedPlan;
        const planByteDelta = Buffer.byteLength(JSON.stringify(valuedPlan)) - Buffer.byteLength(JSON.stringify(oldPlan));
        const valueByteDelta = Buffer.byteLength(JSON.stringify(valueTrip.stats.marketErrand))
            - Buffer.byteLength(JSON.stringify(Object.fromEntries(Object.entries(valueTrip.stats.marketErrand).filter(([key]) => key !== 'valueHours'))));
        console.log(JSON.stringify({ native: true, npcPrice: npc.price, rejected: ['changed NPC', 'changed board', 'zero rate',
            'legacy rate', 'clan personal', 'clan double count', 'recipe value'], partialUnits: partialBought.units, afterDebitUnits: afterFirst.units,
            savedRateByteDelta: Math.max(...sizes), valueByteDelta, planByteDelta, savedBatchDelta,
            maxErrands: batch.stats.marketErrands.length }));
    } finally {
        Afk._resetForTests();
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

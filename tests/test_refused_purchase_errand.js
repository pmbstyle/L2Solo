'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
// A refused or missed purchase raises its failure on the row (DecisionEvents.raiseOn).
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const buyer = 744011, seller = 744012, itemId = 2145;
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
(async () => {
    const world = await createWorld([{ id: buyer, classId: 57, level: 55 }, { id: seller, classId: 0, level: 55 }], 'refused-purchase-errand');
    const prepare = Coordinator.requestMeetingPreparation, refresh = Events.raiseOn;
    try {
        await Database.createAccount('bot_refused_errand', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?)', ['bot_refused_errand', buyer, seller]]);
        const place = invoke('GameServer/Bot/Economy/MarketTownPolicy').marketTown('Giran').center;
        await Life.init();
        for (const id of [buyer, seller]) {
            await Database.setItem(id, { selfId: 57, amount: 1000000, slot: 0 });
            if (id === seller) await Database.setItem(id, { selfId: itemId, amount: 3, slot: 0 });
            await Life.upsertState({ characterId: id, accountName: 'bot_refused_errand', name: `Trader${id}`,
                phase: 'cold', activity: 'shopping', level: 55, adena: 1000000, currentRegion: 'Giran', loc: place,
                vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, timing: {},
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats: { classId: id === buyer ? 57 : 0 } }, 'fixture');
        }
        await Database.replaceBoardRecords(seller, 'sell_ad', [{ storeType: 1, town: 'Giran', title: 'Recipe', ...place,
            lines: [{ selfId: itemId, count: 3, price: 3500, stackable: true }] }], { expected: {} });
        await Afk.init();
        const ad = Afk.ownerRecords(seller).find(row => row.kind === 'sell_ad');
        let rejects = [], refreshes = 0;
        Coordinator.requestMeetingPreparation = () => new Promise((_resolve, reject) => rejects.push(reject));
        Events.raiseOn = id => { assert.equal(id, buyer); refreshes++; };
        const install = async (amount, at) => {
            const errand = { selfId: itemId, amount, town: 'Giran', money: 1000000, maxPrice: 3500, purpose: 'recipe', at };
            await Life.upsertState(Errands.withPending(Life.cachedState(buyer), [errand]), 'fixture_errand');
            return errand;
        };
        const start = () => { rejects = []; return Meetings.prepareTrade(buyer, { shopId: ad.id }, itemId, 1); };
        const refuse = async () => {
            const expectedRefresh = refreshes + 1;
            rejects.forEach(reject => reject(Error('trade_meeting_need_changed')));
            for (let pass = 0; pass < 50; pass++) { await pause(); if (!Meetings.hasPreparation(buyer) && refreshes >= expectedRefresh) break; }
        };
        await install(1, Date.now());
        const wallet = await Database.fetchItems(buyer), stock = await Database.fetchItems(seller);
        await start(); await refuse();
        assert.equal(Errands.pending(Life.cachedState(buyer)).length, 0, 'a rejected purchase cannot retry its obsolete errand for thirty minutes');
        assert.deepEqual(await Database.fetchItems(buyer), wallet);
        assert.deepEqual(await Database.fetchItems(seller), stock);
        await install(1, Date.now()); await start();
        const newer = await install(2, Date.now() + 1);
        await refuse();
        assert.equal(Errands.pending(Life.cachedState(buyer))[0].at, newer.at, 'late refusal preserves the replacement errand');
        let callerCurrent = true;
        await Database.withMutationAdmission(() => { if (!callerCurrent) throw Error('cold_postcommit_source_retired'); }, start);
        callerCurrent = false; await refuse();
        assert.equal(Errands.pending(Life.cachedState(buyer)).length, 0, 'the payer refusal has its own native admission after the initiating command ends');
        console.log('PASS refused purchase clears only its accepted errand, preserves replacements and physical assets');
    } finally {
        Coordinator.requestMeetingPreparation = prepare; Events.raiseOn = refresh;
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Intent = invoke('GameServer/Bot/Economy/TradeIntent');
const ids = [744321, 744322], point = { locX: 83396, locY: 147904, locZ: -3400 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const adopt = result => Object.values(result.coldLifeRows || {}).forEach(row => Life.acceptLifecycleRow(row));

(async () => {
    const world = await createWorld(ids.map(id => ({ id, level: 30 })), 'meeting-arrival-admission');
    const warn = utils.infoWarn, warnings = [];
    try {
        utils.infoWarn = (...args) => warnings.push(args.map(String).join(' '));
        await Database.createAccount('bot_arrival_admission', 'fixture');
        await Database.execute(["UPDATE characters SET username='bot_arrival_admission' WHERE id IN (?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000 });
            if (id === ids[1]) await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 10 });
            await Life.upsertState({ characterId: id, name: `Arrival${id}`, phase: 'cold', activity: 'traveling',
                level: 30, adena: 120000, currentRegion: 'Giran', loc: point,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 0, 0], travel: { reason: 'market_visit', to: point } }, timing: {} }, 'fixture');
        }
        await Database.replaceBoardRecords(ids[0], 'buy_ad', [{ storeType: 3, town: 'Giran', ...point,
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 1, price: 100, stackable: true,
                intent: { itemId: 1867, amount: 1, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 } }] }],
        { expected: {} });
        const ad = (await Database.fetchAfkTradeShops(ids[0])).find(row => row.kind === 'buy_ad');
        const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
        const source = parties[1].inventory.find(item => item.selfId === 1867);
        const token = 'arrival-after-command-release';
        const accepted = await Database.acceptTradeMeeting({ token, actorA: ids[0], actorB: ids[1],
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
            lines: [{ payer: 0, itemId: source.id, selfId: 1867, count: 1, price: 100,
                needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
            parties: parties.map(party => ({ ...party, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
        adopt(accepted);
        await Meetings.init();
        for (let pass = 0; pass < 10; pass++) await tick();
        const arrivedRow = async id => {
            await Database.execute([`UPDATE bot_life_state SET activity='shopping',
                statsJson=json_remove(statsJson,'$.travel'),simulationRevision=simulationRevision+1 WHERE characterId=?`, [id]]);
            return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
        };
        Life.acceptLifecycleRow(await arrivedRow(ids[0]));
        for (let pass = 0; pass < 100; pass++) {
            if ((await Database.fetchTradeMeeting(accepted.meeting.id)).arrivalMask === 1 && !Meetings.counters().queued) break;
            await tick();
        }
        assert.equal((await Database.fetchTradeMeeting(accepted.meeting.id)).arrivalMask, 1);
        const second = await arrivedRow(ids[1]);
        let commandCurrent = true;
        await Database.withMutationAdmission(() => {
            if (!commandCurrent) throw Error('cold_postcommit_source_retired');
        }, () => {
            Life.acceptLifecycleRow(second);
            // The queued meeting event runs after the worker command's ACK.
            commandCurrent = false;
        });
        let receipt;
        for (let pass = 0; pass < 100; pass++) {
            await tick(); receipt = await Database.fetchTradeMeetingReceipt(token, ids[0]);
            if (receipt || warnings.some(line => line.includes('cold_postcommit_source_retired'))) break;
        }
        assert.equal(receipt?.outcome, 'completed', `accepted arrival outlives the notifying command: ${warnings.join('; ')}`);
        assert(!await Database.fetchTradeMeeting(accepted.meeting.id), 'both receipts are acknowledged');
        for (const id of ids) assert(!Life.cachedState(id).stats.tradeMeeting, 'the durable meeting releases both bots');
        assert.equal(await world.amount(ids[0], 1867), 1);
        assert.equal(await world.amount(ids[1], 1867), 9);
        assert.equal(await world.amount(ids[0], 57), 119900);
        assert.equal(await world.amount(ids[1], 57), 120100);
        await assert.rejects(Database.withMutationAdmission(() => { throw Error('caller_admission_still_active'); },
            () => Database.setItem(ids[0], { selfId: 57, amount: 1 })), /caller_admission_still_active/,
        'detaching the meeting pump must not disable admission on unrelated callers');
        console.log('PASS native second arrival completes and releases both participants after the notifying command retires');
    } finally { Meetings.reset(); utils.infoWarn = warn; await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

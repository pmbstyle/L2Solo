'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const ids = [730301, 730302], point = { locX: 83396, locY: 147904, locZ: -3400 };
const flush = async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'meeting-arrival-events');
    const originalArrive = Database.arriveTradeMeeting;
    let arrivals = 0;
    Database.arriveTradeMeeting = (...args) => { arrivals++; return originalArrive(...args); };
    try {
        await Database.createAccount('bot_arrival_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_arrival_fixture' WHERE id IN (?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
            await Life.upsertState({ characterId: id, name: `Arrival${id}`, phase: 'cold', activity: 'shopping',
                level: 30, adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: point, currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'arrival_fixture');
        }
        const prepare = async token => {
            Service.reset();
            // A committed traveling participant is unavailable even near the destination.
            await Life.upsertState({ ...Life.cachedState(ids[0]), activity: 'traveling',
                loc: { ...point, locX: point.locX + 1000 },
                stats: { ...Life.cachedState(ids[0]).stats, travel: { to: point, arrivalActivity: 'shopping' } } }, 'fixture_departure');
            const held = (await Database.fetchAfkTradeShops(ids[0])).filter(row => row.kind === 'buy_ad');
            await Database.replaceBoardRecords(ids[0], 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Fixture need', ...point,
                lines: [{ selfId: 1867, name: 'Animal Skin', count: 6, price: 10, stackable: true,
                    intent: { itemId: 1867, amount: 6, price: 10, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 } }] }],
            { expected: Object.fromEntries(held.map(row => [row.id, row.revision])) });
            const ad = (await Database.fetchAfkTradeShops(ids[0])).find(row => row.kind === 'buy_ad');
            const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
            const source = parties[1].inventory.find(row => row.selfId === 1867);
            const request = { token, actorA: ids[0], actorB: ids[1], seqA: parties[0].sequence, seqB: parties[1].sequence,
                town: 'Giran', point,
                lines: [{ payer: 0, itemId: source.id, selfId: 1867, count: 6, price: 10,
                    needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
                parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 1000 } })) };
            const accepted = await Database.acceptTradeMeeting(request);
            Object.values(accepted.coldLifeRows).forEach(row => Life.acceptLifecycleRow(row));
            await Service.init(); await flush();
            assert.equal((await Database.fetchTradeMeeting(accepted.meeting.id)).state, 'accepted');
            return accepted.meeting.id;
        };
        const commitArrival = async dead => {
            const prior = Life.cachedState(ids[0]);
            const token = await Owner.claim(prior, { allowLifecycle: true });
            assert.equal(token.ok, true);
            const owned = Life.cachedState(ids[0]);
            const next = { ...owned, activity: dead ? 'dead' : 'shopping', loc: point,
                vitals: { ...owned.vitals, hp: dead ? 0 : 100 }, stats: { ...owned.stats, travel: null } };
            const results = await Owner.commitAndReleaseBatch([{ token, nextState: next, options: { allowLifecycle: true } }]);
            assert.equal(results[0].ok, true);
            await flush();
        };
        await prepare('arrival-event-success');
        await commitArrival(false);
        const receipt = await Database.fetchTradeMeetingReceipt('arrival-event-success', ids[0]);
        assert.equal(receipt?.outcome, 'completed', 'native cold commit must wake meeting settlement without an explicit wake or general upsert');
        assert.equal(await world.amount(ids[0], 1867), 26);
        assert.equal(await world.amount(ids[1], 1867), 14);
        assert.equal(await world.amount(ids[0], 57), 119940);
        assert.equal(await world.amount(ids[1], 57), 120060);
        const settledArrivals = arrivals;
        const current = Life.cachedState(ids[0]);
        Life.acceptSimulationOwnership(ids[0], current.simulation, current);
        Service.wake(ids[0]); Service.wake(ids[0]); await flush();
        assert.equal(arrivals, settledArrivals, 'released participants and identical publication schedule no second settlement');
        assert.equal(Service.counters().participants, 0);
        await Service.init(); await Service.init(); await flush();
        assert.equal(arrivals, settledArrivals, 'reset/re-init does not revive a completed receipt');
        await prepare('arrival-event-death');
        await commitArrival(true);
        assert.equal((await Database.fetchTradeMeetingReceipt('arrival-event-death', ids[0]))?.outcome, 'cancelled');
        assert.equal(await world.amount(ids[0], 1867), 26);
        assert.equal(await world.amount(ids[1], 1867), 14);
        assert.equal(await world.amount(ids[0], 57), 119940, 'death returns only the second reservation');
        assert.equal(await world.amount(ids[1], 57), 120060);
        console.log('PASS native cold arrival event settles once; unchanged/nonparticipants, recovery, death and asset conservation');
    } finally { Service.reset(); Database.arriveTradeMeeting = originalArrive; await world.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

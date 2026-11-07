'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Routes = require('../src/GameServer/Bot/Travel/TravelRoutes');
const Towns = require('../src/GameServer/World/TownRespawn');
const ids = [731511, 731512], point = { ...Towns.towns.giran_town };
const flush = async () => { for (let n = 0; n < 60; n++) await new Promise(resolve => setImmediate(resolve)); };
const adopt = result => Object.values(result.coldLifeRows || {}).forEach(row => Life.acceptLifecycleRow(row));

(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'meeting-route-funding');
    try {
        await Database.createAccount('bot_route_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_route_fixture' WHERE id IN (?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20 });
            await Life.upsertState({ characterId: id, name: `Route${id}`, level: 30,
                phase: 'cold', activity: 'shopping', currentRegion: 'Giran', adena: 120000, loc: point,
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'route_fixture');
        }
        for (const persistedWalk of [false, true]) {
            Service.reset();
            const token = `route-unfunded-${persistedWalk}`;
            const old = (await Database.fetchAfkTradeShops(ids[0])).filter(row => row.kind === 'buy_ad');
            await Database.replaceBoardRecords(ids[0], 'buy_ad', [{ storeType: 3, town: 'Giran', ...point,
                lines: [{ selfId: 1867, name: 'Animal Skin', count: 6, price: 10, stackable: true,
                    intent: { itemId: 1867, amount: 6, price: 10, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 } }] }],
            { expected: Object.fromEntries(old.map(row => [row.id, row.revision])) });
            const ad = (await Database.fetchAfkTradeShops(ids[0])).find(row => row.kind === 'buy_ad');
            const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
            const source = parties[1].inventory.find(row => row.selfId === 1867);
            const accepted = await Database.acceptTradeMeeting({ token, actorA: ids[0], actorB: ids[1],
                seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
                lines: [{ payer: 0, itemId: source.id, selfId: 1867, count: 6, price: 10,
                    needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
                parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'soe_gatekeeper', durationMs: 25000 } })) });
            adopt(accepted);
            const origin = { ...Towns.towns.ti_village };
            assert(Routes.between(origin, point).route.fee > 0);
            await Life.upsertState({ ...Life.cachedState(ids[1]), loc: origin, currentRegion: 'Talking Island',
                activity: 'shopping', stats: { ...Life.cachedState(ids[1]).stats, travel: null } }, 'changed_departure');
            if (persistedWalk) {
                adopt(await Database.payTradeMeetingLeg(accepted.meeting.id, 1, 1,
                    `walk:${point.locX}:${point.locY}:${point.locZ}`, 0, false));
                assert.equal(Life.cachedState(ids[1]).stats.travel.method, 'walk');
            }
            await Service.init(); await flush();
            const receipt = await Service.receipt(token, ids[0]);
            assert.equal(receipt?.outcome, 'cancelled', 'an unfunded native route is cancelled instead of walking between towns');
            for (const id of ids) {
                assert.equal(await world.amount(id, 57), 120000, 'unspent fare and trade escrow return exactly');
                assert.equal(await world.amount(id, 1867), 20, 'reserved goods return to their original owner');
                assert(!Life.cachedState(id).stats.tradeMeeting, 'cancellation releases every participant');
            }
            assert(!Life.cachedState(ids[1]).stats.travel, 'restart recovery stops a persisted unfunded walk');
        }
        console.log('Meeting route funding: changed departure and persisted walk cancel through native custody with exact refunds');
    } finally { Service.reset(); await world.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

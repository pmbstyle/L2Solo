'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const owner = 730161, restore = [];
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
(async () => {
    const world = await createWorld([{ id: owner, classId: 0, level: 30 }], 'ready-trade-execution');
    try {
        await Life.init();
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(owner, { selfId: 1869, name: 'Iron Ore', amount: 5, slot: 0 });
        const state = await Life.upsertState({ characterId: owner, phase: 'cold', activity: 'hunting',
            level: 30, adena: 100000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
            loc: { locX: 0, locY: 0, locZ: 0 }, currentRegion: 'Giran', stats: {} }, 'fixture');
        const rows = await Database.openBoardRecords(owner, 'sell_ad', [{ storeType: 1,
            town: 'Giran', locX: 0, locY: 0, locZ: 0, lines: [{ selfId: 1869, count: 1, price: 237,
                objectId: (await Database.fetchItems(owner)).find(row => row.selfId === 1869).id, stackable: true }] }]);
        const beforeRecords = await Database.fetchAfkTradeShops(owner);
        const beforeItems = await Database.fetchItems(owner);
        const current = Life.cachedState(owner) || state;
        const board = new BoardIndex();
        const quote = side => ({ id: 77, ownerId: 99, kind: side === 1 ? 'sell_ad' : 'buy_ad',
            custodyPolicy: 1, revision: 4, storeType: side, town: 'Giran',
            lines: [{ lineId: 78, selfId: 1869, count: 2, price: 237 }] });
        stub(Afk, 'boardIndex', () => board);
        stub(Afk, 'offerOf', line => ({ store: { afkTrade: true, conditional: true, storeType: line.storeType,
            shopId: line.recordId, items: [{ selfId: 1869, count: 2, price: 237, afkTradeLineId: 78 }] } }));
        let calls = 0, fail = false;
        const trade = async (actor, store, id, count, options) => {
            calls++; assert.equal(actor, owner); assert.equal(id, 1869); assert.equal(count, 2);
            assert.equal(options.expectedRevision, 4); assert.equal(options.expectedPrice, 237);
            assert.equal(options.lineId, 78); assert.equal(options.coldState.characterId, owner);
            if (fail) throw Error('trade_meeting_need_changed');
            return { pending: true, meetingId: 123 };
        };
        stub(Afk, 'buyFromShop', trade); stub(Afk, 'sellToShop', trade);
        for (const side of [1, 3]) {
            board.put(quote(side));
            const plan = { take: [side, 1869, 2, 77, 78, 4, 237], buyAds: [],
                withdraw: [rows.opened[0].lines[0].id], sell: [[1869, 5, 999, 'Giran']] };
            const accepted = await Market.executePlan(current, plan);
            assert.equal(accepted.pending, true);
            assert.equal(accepted.meetingId, 123);
            fail = true;
            const refused = await Market.executePlan(current, plan);
            assert.equal(refused.tradeDeferred, true);
            assert.equal(refused.reason, 'trade_meeting_need_changed');
            fail = false;
            const stale = await Market.executePlan(current, { ...plan, take: [side, 1869, 2, 77, 78, 5, 237] });
            assert.equal(stale.tradeDeferred, true);
            assert.deepEqual(await Database.fetchAfkTradeShops(owner), beforeRecords,
                'neither pending, refused nor stale trade executes subsequent withdrawal/publication');
            assert.deepEqual(await Database.fetchItems(owner), beforeItems,
                'rejection never moves physical items or money');
        }
        assert.equal(calls, 4, 'stale quotes never call the bilateral executor');
        const older = { ...current, simulation: { ...current.simulation, revision: -1 } };
        assert.equal((await Market.executePlan(current, { take: [3, 1869, 2, 77, 78, 4, 237] },
            { preparedState: older })).tradeDeferred, true);
        assert.equal(calls, 4);
        console.log('PASS exact native owner/board guards, both side executors, pending/refused preserve records/items');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Intent = invoke('GameServer/Bot/Economy/TradeIntent');

const ids = [744301, 744302];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

(async () => {
    const world = await createWorld(ids.map(id => ({ id, level: 30 })), 'meeting-detached-admission');
    const original = { prepare: Coordinator.requestMeetingPreparation, current: Coordinator.meetingPreparationCurrent,
        refresh: Coordinator.requestEconomyRefresh,
        cancel: Coordinator.cancelMeetingPreparation, warn: utils.infoWarn };
    try {
        await Database.createAccount('bot_detached_admission', 'test');
        await Database.execute(["UPDATE characters SET username='bot_detached_admission' WHERE id IN (?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            if (id === ids[1]) await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 10, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: point, currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, id === ids[0] ? 120000 : 1000, 0] }, timing: {} }, 'fixture');
        }
        const source = (await Database.fetchItems(ids[1])).find(row => row.selfId === 1867);
        await Database.replaceBoardRecords(ids[1], 'sell_ad', [{ storeType: Afk.SELL, title: 'Fixture sale', town: 'Giran', ...point,
            lines: [{ objectId: source.id, selfId: 1867, name: 'Animal Skin', count: 10, price: 100, stackable: true }] }], { expected: {} });
        const ad = (await Database.fetchAfkTradeShops(ids[1]))[0];
        Afk.refreshRecord(ad);
        let release, proofCurrent = true;
        let gate = new Promise(resolve => { release = resolve; });
        Coordinator.requestMeetingPreparation = async (id, request) => {
            await gate;
            const side = request.actorA === id ? 0 : 1;
            return { approved: true, token: request.token, characterId: id, sequence: request.parties[side].sequence,
                route: request.parties[side].route, survivalCost: id === ids[0] ? 400 : 0,
                certificates: request.lines.map(line => line.payer === side
                    ? Intent.encode({ itemId: line.selfId, amount: line.count, price: line.price,
                        key: 'production:28', recipeId: 28, valueHours: 2, valueRate: 100 }) : null) };
        };
        Coordinator.meetingPreparationCurrent = () => proofCurrent;
        Coordinator.cancelMeetingPreparation = () => {};
        const warnings = [];
        utils.infoWarn = (...args) => warnings.push(args.map(String).join(' '));

        let originalCommandCurrent = true;
        proofCurrent = false;
        const refused = await Database.withMutationAdmission(() => {
            if (!originalCommandCurrent) throw Error('cold_postcommit_source_retired');
        }, () => Meetings.trade(ids[0], { shopId: ad.id }, 1867, 4));
        originalCommandCurrent = false;
        release();
        for (let pass = 0; pass < 100 && !warnings.length; pass++) await tick();
        assert(warnings.some(line => line.includes('trade_meeting_authority_changed')),
            'expired bilateral proof still refuses acceptance');
        assert(!await Database.fetchTradeMeetingByToken(refused.token));
        assert.equal((await Database.fetchAfkTradeShop(ad.id)).lines[0].availableCount, 10,
            'a refused proof reserves no goods');

        warnings.length = 0;
        proofCurrent = true;
        gate = new Promise(resolve => { release = resolve; });
        originalCommandCurrent = true;
        const result = await Database.withMutationAdmission(() => {
            if (!originalCommandCurrent) throw Error('cold_postcommit_source_retired');
        }, () => Meetings.trade(ids[0], { shopId: ad.id }, 1867, 4));
        assert(result.pending, 'the original command returns before the two preparations');
        originalCommandCurrent = false;
        release();
        let row, receipt;
        for (let pass = 0; pass < 100; pass++) {
            await tick();
            row = await Database.fetchTradeMeetingByToken(result.token);
            receipt = await Database.fetchTradeMeetingReceipt(result.token, ids[0]);
            if (row || receipt || warnings.length) break;
        }
        assert(row || receipt?.outcome === 'completed', `fresh bilateral consent should commit after the original command ends: ${warnings.join('; ')}`);
        if (row) assert.equal(Intent.decode(JSON.parse(row.terms).lines[0].certificate).key, 'production:28',
            'native acceptance persists the fresh production certificate');
        assert.equal((await Database.fetchAfkTradeShop(ad.id)).lines[0].availableCount, 6);
        if (row?.state === 'accepted') await Meetings.cancel(ids[0]);
        const buyerState = Life.cachedState(ids[0]);
        await Life.upsertState({ ...buyerState, stats: { ...buyerState.stats, money: [100, 0, 1000, 0] } }, 'price_refusal_fixture');
        Afk.boardIndex().put({ id: 999103, ownerId: 999101, revision: 1, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999104, selfId: 1867, count: 1, price: 90 }] });
        const sellAd = await Database.fetchAfkTradeShop(ad.id);
        Afk.refreshRecord(sellAd);
        const sellChoice = [Afk.SELL, 1867, 1, sellAd.id, sellAd.lines[0].id, sellAd.revision, 100];
        const Choice = invoke('GameServer/Bot/Economy/ReadyTradeChoice');
        assert(Choice.resolve(sellChoice, Afk.boardIndex(), ids[0]), 'the buyer can initially choose the seller ad');
        let sellRefresh = null;
        Coordinator.requestEconomyRefresh = id => { sellRefresh = id; return true; };
        Coordinator.requestMeetingPreparation = async (id, request) => {
            if (id === ids[0]) {
                const current = Life.cachedState(id), error = Error('trade_meeting_purchase_price_changed');
                error.priceEvidence = { purchase: { selfId: 1867, enchant: 0, units: 1, cost: 100 },
                    authority: invoke('GameServer/Bot/Economy/EconomyCommit').authority(current),
                    updatedAt: Number(current.updatedAt || 0), scopes: [], offers: [[999103, 999104, 1, 1, 90]],
                    npcAllowed: true, fundingDominance: true };
                throw error;
            }
            return { approved: true, token: request.token, characterId: id,
                sequence: request.parties[request.actorA === id ? 0 : 1].sequence };
        };
        const rejectedSell = await Meetings.trade(ids[0], { shopId: sellAd.id }, 1867, 1);
        for (let pass = 0; pass < 100 && sellRefresh === null; pass++) await tick();
        assert.equal(sellRefresh, ids[0]);
        assert(!await Database.fetchTradeMeetingByToken(rejectedSell.token));
        assert.equal(Choice.resolve(sellChoice, Afk.boardIndex(), ids[0]), null,
            'the detached payer refusal blocks the same seller ad before another preparation');
        const offered = Afk.offerOf(Afk.boardIndex().records.get(sellAd.id)[0]);
        const repeated = await invoke('GameServer/Bot/Economy/ColdMarketService')
            .buyOffer(Life.cachedState(ids[0]), offered, { qty: 1 });
        assert.equal(repeated.reason, 'trade_meeting_purchase_price_changed',
            'the ordinary cold-market path also rejects the unchanged expensive quote locally');
        assert.equal(Meetings.hasPreparation(ids[0]), false, 'no second meeting is staged');
        Afk.boardIndex().put({ id: 999103, ownerId: 999101, revision: 2, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999104, selfId: 1867, count: 1, price: 110 }] });
        assert(Choice.resolve(sellChoice, Afk.boardIndex(), ids[0]),
            'a changed backed alternative restores selection of the seller ad');
        await Database.replaceBoardRecords(ids[0], 'buy_ad', [{ storeType: Afk.BUY, town: 'Giran', ...point,
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 2, price: 100, stackable: true,
                intent: { itemId: 1867, amount: 2, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 } }] }],
        { expected: {} });
        const buyAd = (await Database.fetchAfkTradeShops(ids[0])).find(shop => shop.kind === 'buy_ad');
        Afk.refreshRecord(buyAd);
        Afk.boardIndex().put({ id: 999103, ownerId: 999101, revision: 1, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999104, selfId: 1867, count: 1, price: 90 }] });
        const prepared = [Afk.BUY, 1867, 1, buyAd.id, buyAd.lines[0].id, buyAd.revision, 100];
        assert(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]),
            'the seller has an executable pre-refusal plan');
        let refreshed = null;
        Coordinator.requestEconomyRefresh = id => { refreshed = id; return true; };
        Coordinator.requestMeetingPreparation = async (id, request) => {
            if (id === ids[0]) {
                const current = Life.cachedState(id), error = Error('trade_meeting_purchase_price_changed');
                error.priceEvidence = { purchase: { selfId: 1867, enchant: 0, units: 1, cost: 100 },
                    authority: invoke('GameServer/Bot/Economy/EconomyCommit').authority(current),
                    updatedAt: Number(current.updatedAt || 0), scopes: [], offers: [[999103, 999104, 1, 1, 90]],
                    npcAllowed: true, fundingDominance: true };
                throw error;
            }
            return { approved: true, token: request.token, characterId: id,
                sequence: request.parties[request.actorA === id ? 0 : 1].sequence };
        };
        const priceRefusal = await Meetings.trade(ids[1], { shopId: buyAd.id }, 1867, 1);
        for (let pass = 0; pass < 100 && refreshed === null; pass++) await tick();
        assert.equal(refreshed, ids[0], 'a buyer price refusal schedules a fresh review of its standing bid');
        assert(!await Database.fetchTradeMeetingByToken(priceRefusal.token));
        assert.equal((await Database.fetchAfkTradeShop(buyAd.id)).lines[0].count, 2,
            'a partial refusal does not withdraw the whole valid bid');
        assert.equal(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]), null,
            'a seller plan prepared before the refusal cannot restart the same meeting');
        const afterRefusal = Life.cachedState(ids[0]);
        await Life.upsertState({ ...afterRefusal, stats: { ...afterRefusal.stats, money: [100, 0, 1000, 500] } },
            'price_refusal_funding_changed');
        assert.equal(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]), null,
            'a dominating alternative survives an unrelated buyer update even when free money is committed');
        Afk.boardIndex().put({ id: 999100, ownerId: 999101, revision: 1, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999102, selfId: 1868, count: 1, price: 100 }] });
        assert.equal(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]), null,
            'an unrelated item change does not erase the exact proof');
        Afk.boardIndex().put({ id: 999105, ownerId: 999106, revision: 1, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999107, selfId: 1867, count: 1, price: 80 }] });
        assert.equal(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]), null,
            'another offer of the same item does not change the witnessed purchase');
        Afk.boardIndex().put({ id: 999103, ownerId: 999101, revision: 2, storeType: 1, town: 'Giran',
            lines: [{ lineId: 999104, selfId: 1867, count: 1, price: 110 }] });
        assert(invoke('GameServer/Bot/Economy/ReadyTradeChoice').resolve(prepared, Afk.boardIndex(), ids[1]),
            'a changed quote for the item requests fresh buyer consent');
        console.log('PASS detached trade meeting accepts fresh consent and refuses expired proof after original command ends');
    } finally {
        Meetings.reset(); Afk._resetForTests();
        Coordinator.requestMeetingPreparation = original.prepare;
        Coordinator.meetingPreparationCurrent = original.current;
        Coordinator.cancelMeetingPreparation = original.cancel;
        Coordinator.requestEconomyRefresh = original.refresh;
        utils.infoWarn = original.warn;
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

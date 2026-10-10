'use strict';
// Task 4 B5 N10: pins TODAY's numbers of the known K26 gaps of the author's clan
// errand code (docs/problems.md K26; task4-map-execution.md section 7), gaps 1, 3, 4, 5.
// Not a fix: a Task 4 change that makes a gap worse goes red here. A change that
// FIXES a gap also goes red; then update the pin together with problems.md K26.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
const Credit = invoke('GameServer/Clan/ClanPurchaseCredit');
const member = 730311, seller = 730312, SKIN = 1867, SOE = 736, CLAN = 3, restore = [];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
(async () => {
    const world = await createWorld([member, seller].map(id => ({ id, classId: 0, level: 30 })), 'task4-b5-k26');
    try {
        await Database.createAccount('bot_b5_k26', 'test');
        await Database.execute(["UPDATE characters SET username='bot_b5_k26' WHERE id IN (?,?)", [member, seller]]);
        await Life.init();
        invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
        for (const id of [member, seller]) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
            if (id === seller) await Database.setItem(id, { selfId: SKIN, name: 'Animal Skin', amount: 20, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30, adena: 100000,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point, currentRegion: 'Giran',
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const source = (await Database.fetchItems(seller)).find(row => row.selfId === SKIN);
        const ad = (await Database.createAfkTradeShop(seller, { kind: 'sell_ad', storeType: 1, town: 'Giran', title: 'Skins', ...point,
            lines: [{ objectId: source.id, selfId: SKIN, name: 'Animal Skin', count: 20, price: 100 }] })).shop;
        Afk.refreshRecord(await Database.fetchAfkTradeShop(ad.id));
        assert.equal(ad.custodyPolicy, 1, 'fixture: a bot sell ad is conditional (meeting path)');
        const funded = [], prepared = [], returned = [], payments = [];
        const realBuy = Afk.buyFromShop;
        stub(Afk, 'buyFromShop', (...args) => { funded.push(args[4]?.funding); return realBuy.apply(Afk, args); });
        stub(Coordinator, 'requestMeetingPreparation', async (id, request) => { prepared.push(JSON.parse(JSON.stringify(request))); throw Error('fixture_preparation_stop'); });
        stub(Coordinator, 'requestEconomyRefresh', () => {});
        stub(Credit, 'returnUnspent', async (...args) => { returned.push(args.slice(1)); return null; });
        stub(Database, 'payClanMember', async payment => { payments.push(payment); return { ok: true, row: { characterId: payment.characterId } }; });
        const errand = (selfId, amount) => ({ selfId, amount, town: 'Giran', purpose: 'clan', at: Date.now(), money: 2000, maxPrice: 1000,
            tag: { clanId: CLAN, clanPart: 2000 } });
        const withErrand = async e => { const s = Life.cachedState(member);
            return Life.upsertState({ ...s, activity: 'shopping', stats: { ...s.stats, marketErrands: [e], marketErrand: e } }, 'fixture_errand'); };
        const arrive = () => Cold.tryPurchase(Life.cachedState(member), { type: 'market_errand', status: 'active' });

        // A clan errand whose only seller is a conditional ad: the purchase becomes a board meeting.
        const skinErrand = errand(SKIN, 2);
        await withErrand(skinErrand);
        const meeting = await arrive();
        await new Promise(resolve => setTimeout(resolve, 50)); // the worker preparation request runs after the return
        // Gap 1: the native writer is handed the clan terms, the meeting request drops them (paid as a personal buy).
        assert.deepEqual(funded, [{ itemId: SKIN, free: true, clanPart: 2000 }], 'gap 1: clan terms reach buyFromShop');
        assert.equal(prepared.length, 2, 'both bots are asked to prepare the meeting');
        for (const request of prepared) {
            assert.deepEqual(Object.keys(request).sort(), ['actorA', 'actorB', 'incoming', 'lines', 'parties', 'point', 'seqA', 'seqB', 'token', 'town'],
                'gap 1: the meeting request has no funding field');
            assert(!/clanPart|"free"|funding/.test(JSON.stringify(request)), 'gap 1: no clan terms anywhere in the meeting request');
        }
        // Gap 3: a pending meeting under a clan errand returns early: the errand and its whole credit stay,
        // nothing is returned and no lastErrand is left for the clan job; settle answers 'kept'.
        assert.equal(meeting.pending, true);
        assert.equal(meeting.purchased, false);
        const pendingState = Life.cachedState(member);
        assert.deepEqual(pendingState.stats.marketErrands, [skinErrand], 'gap 3: errand kept unchanged with its full clanPart');
        assert.equal(pendingState.stats.lastErrand, undefined, 'gap 3: no lastErrand while the meeting is pending');
        assert.deepEqual(returned, [], 'gap 3: no returnUnspent');
        assert.equal((await Credit.settle(CLAN, member, 2000, { ...meeting, bought: false, state: pendingState }, 'clan_level_purchase_refund')).code,
            'kept', 'gap 3: settle keeps the credit for a pending meeting');
        assert.deepEqual(payments, [], 'gap 3: nothing refunded to the clan');

        // Gap 5: a clan errand bought from an NPC. The native NPC writer completes the errand and writes
        // lastErrand itself, so buyErrand sees 'errand_changed' and skips returnUnspent: the clan credit the
        // purchase did not spend (2000 - 2 x 440 = 1120) stays with the member.
        const adena = async () => (await Database.fetchItems(member)).find(row => row.selfId === 57).amount;
        const walletBefore = await adena();
        await withErrand(errand(SOE, 2));
        const npc = await arrive();
        const npcState = Life.cachedState(member);
        assert.equal(npc.reason, 'errand_changed', 'gap 5: the NPC errand ends as errand_changed');
        assert.equal(npc.units, 2);
        assert.equal(walletBefore - await adena(), 880, 'two scrolls at the Giran NPC price');
        assert.deepEqual(npcState.stats.marketErrands, [], 'the native writer completed the errand');
        assert.equal(npcState.stats.lastErrand?.tag?.clanPart, 2000, 'lastErrand carries the old credit, not the unspent part');
        assert.deepEqual(returned, [], 'gap 5: returnUnspent is skipped (1120 of clan credit not returned)');
        assert.deepEqual(payments, [], 'gap 5: no clan refund payment');

        // Gap 4: stats.lastErrand is never cleared (ClanMarketService.js:76-79). Clan services stubbed as in
        // test_clan_market_trip.js; the member is back from one clan errand holding the item.
        for (const fn of restore.splice(0).reverse()) fn();
        const ClanOrderService = invoke('GameServer/Clan/ClanOrderService'), ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
        const ClanMarketService = invoke('GameServer/Clan/ClanMarketService'), ClanEconomy = require('../src/GameServer/Clan/ClanEconomyContext');
        const Market = invoke('GameServer/Bot/Economy/MarketOpportunity'), GoalService = invoke('GameServer/Clan/ClanGoalService');
        const MARK = 1419, clan = { id: 77, level: 2, state: { goal: { type: 'item', plan: { kind: 'market' }, progress: 0, required: 1,
            target: { itemId: MARK, itemName: 'Blood Mark' }, assignedMemberIds: [501], updatedAt: 5 } } };
        let buyer = { characterId: 501, name: 'Buyer', phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 900000,
            inventory: { [MARK]: { selfId: MARK, amount: 1 } }, simulation: { revision: 3 },
            stats: { money: [77000, 2e-5, 15000, 1200000, 4e-5, 20000, 1463],
                lastErrand: { purpose: 'clan', selfId: MARK, units: 1, tag: { clanId: 77, clanPart: 50000, offer: { price: 50000, sourceType: 'afk_bot_store', sourceId: 900, town: 'Giran' } }, at: 9 } } };
        const acquired = [], deposits = [];
        stub(GoalService, 'clanProjectionById', async () => clan);
        stub(Life, 'cachedState', id => Number(id) === 501 ? buyer : null);
        stub(ClanOrderService, 'marketMembers', () => [{ characterId: 501 }]);
        stub(Database, 'fetchClanWarehouseItems', async () => []); stub(Database, 'fetchClanHallAuctions', async () => []);
        stub(ClanEconomy, 'forClan', () => ({ budgetFor: () => 50000 }));
        stub(invoke('GameServer/ClanHall/Policy'), 'freeAdena', () => 50000);
        stub(Market, 'bestOffer', (_id, o = {}) => o.budget >= 50000 ? { price: 50000, sourceType: 'afk_bot_store', sourceId: 900, town: 'Giran' } : null);
        stub(Database, 'payClanMember', async ({ amount }) => { buyer = { ...buyer, adena: buyer.adena + amount }; return { ok: true, row: buyer }; });
        stub(Life, 'acceptNewerLifecycleRow', row => row);
        stub(Cold, 'acquire', async (state, selfId) => { acquired.push(selfId); return { state, bought: false, traveling: true }; });
        stub(Database, 'fetchItems', async () => [{ id: 1, selfId: MARK, amount: 1 }]);
        stub(Database, 'transferInventoryToClanWarehouse', async request => { deposits.push(request.resolveKey); return { ok: true }; });
        for (const name of ['upsertClanMarketDemand', 'syncClanMarketDemandSignal', 'recordClanGoalEvent']) stub(Database, name, async () => null);
        stub(Database, 'advanceAutonomousClanLevel', async () => ({ ok: false }));
        stub(ClanCrestService, 'ensureAutonomousCrest', async () => null);
        for (let round = 0; round < 2; round += 1) assert.equal((await ClanMarketService.resolveClan(clan)).purchased, true);
        // Same goal twice: the second deposit is stopped only by the native resolveKey replay refusal (stubbed here).
        assert.deepEqual(deposits, ['77:market:5:501:1419', '77:market:5:501:1419'], 'gap 4: the same errand deposits on every resolve');
        // A new clan goal for the same item: the stale lastErrand deposits the member's held copy, no errand, no purchase.
        clan.state.goal = { ...clan.state.goal, updatedAt: 6 };
        assert.equal((await ClanMarketService.resolveClan(clan)).purchased, true);
        assert.deepEqual(deposits.slice(2), ['77:market:6:501:1419'], 'gap 4: a later goal takes a copy the clan did not buy');
        assert.deepEqual(acquired, [], 'gap 4: no new errand was sent');
        assert.equal(buyer.stats.lastErrand.at, 9, 'gap 4: lastErrand is still set');
        console.log('PASS task4 b5 N10 K26 pins: gap 1 meeting drops clan terms, gap 3 pending keeps errand+credit, gap 4 lastErrand reused (3 deposits), gap 5 errand_changed returns nothing');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

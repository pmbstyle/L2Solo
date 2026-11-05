'use strict';
// E311: a cold bot on a sale visit answers a buy ad in town. The deal goes
// through a trade meeting: the sale returns `pending` while the payer's
// worker prepares it, and the visit waits. Live, the payer's worker refuses
// (trade_meeting_need_changed: 608 in 75 min of the 2026-10-14 log); the ad stays on the board and
// every later visit pass answers it again, so the bot never leaves town.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const sellerId = 730311, buyerId = 730312, errandSellerId = 730313;
const SKIN = 1867;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
    const world = await createWorld([{ id: sellerId, classId: 0, level: 20 }, { id: buyerId, classId: 0, level: 20 }, { id: errandSellerId, classId: 0, level: 20 }], 'e311-stuck-shopping');
    const prepare = Coordinator.requestMeetingPreparation, chooseByValue = PriceDecision.chooseByValue;
    try {
        await Database.createAccount('bot_e311_fixture', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?,?)', ['bot_e311_fixture', sellerId, buyerId, errandSellerId]]);
        await Life.init();
        const place = Town.marketTown('Giran').center;
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        await Database.setItem(buyerId, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(sellerId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(sellerId, { selfId: SKIN, amount: 20, slot: 0 });
        await Database.setItem(errandSellerId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(errandSellerId, { selfId: SKIN, amount: 20, slot: 0 });
        for (const [id, name, activity, stats] of [
            [buyerId, 'E311Buyer', 'hunting', { classId: 0, generatedCold: true, money: [100, 0, 1000, 0] }],
            [sellerId, 'E311Seller', 'shopping', { classId: 0, generatedCold: true,
                townVisit: { town: 'Giran', startedAt: Date.now() - 60000, reason: 'sell_inventory' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } }],
            // A second seller whose town errands are not done on the refused pass.
            [errandSellerId, 'E311ErrandSeller', 'shopping', { classId: 0, generatedCold: true,
                townVisit: { town: 'Giran', startedAt: Date.now() - 60000, reason: 'sell_inventory' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } }]
        ]) {
            await Life.upsertState({ characterId: id, accountName: 'bot_e311_fixture', name, level: 20,
                phase: 'cold', activity, currentRegion: 'Giran', spotId: activity === 'hunting' ? String(spot.id) : null,
                adena: id === buyerId ? 1000000 : 1000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats,
                timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
            }, 'e311_fixture');
        }
        // The buyer's standing need on the board: a conditional buy ad, paid
        // through a trade meeting, at a price the seller wants to answer.
        await Database.replaceBoardRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Skins', ...place,
            lines: [{ selfId: SKIN, name: 'Animal Skin', count: 20, price: 5000, stackable: true,
                intent: { itemId: SKIN, amount: 20, price: 5000, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 } }] }], { expected: {} });
        await Afk.init();
        const ad = Afk.ownerRecords(buyerId).find(row => row.kind === 'buy_ad');
        assert(ad, 'the buy ad is on the board');

        // The seller's own worker consents to the answer again (ColdSimulationWorker
        // 'meeting' mode). The sale retry saved with the pending deal is in that
        // snapshot: it must not take the answer away (it turns off
        // ItemDisposition.soloSaleSlotLimit inside EconomyContext). Same economy
        // build and the same MarketListingPolicy.evaluate as the worker consent.
        const consentAnswer = (state, retry, now) => {
            const probe = { ...state, stats: { ...state.stats,
                marketSellSeen: retry ? invoke('GameServer/Bot/Economy/ItemDisposition').saleSeen(state) : null } };
            const trip = invoke('GameServer/Bot/Economy/EconomicTrip').prepare(probe);
            let step; do step = trip.next(); while (!step.done);
            const board = Afk.boardIndex();
            const npcOffersFor = invoke('GameServer/Bot/Population/ColdOccupationSources').npcOffersFor;
            const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(probe, { board, routeRows: step.value,
                timestamp: now, npcOffersFor, workshop: { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 },
                caller: 'meeting_prepare', trigger: 'e311-probe' });
            const decision = invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(probe, { economy, board, npcOffersFor,
                findSpot: id => invoke('GameServer/Bot/Population/SpotProfiles').findById(id),
                now, decisionPoint: 'meeting:e311-probe', slots: 5 });
            return decision.answers.some(row => row.item.selfId === SKIN && Number(row.line.recordId) === ad.id && row.count >= 20);
        };
        const fixture = Life.cachedState(sellerId);
        const kitBag = { ...fixture, spotId: String(spot.id), inventory: { ...fixture.inventory, ...Life.inventorySummaryFromItems([
            { selfId: 1835, amount: 1500 }, { selfId: 1060, amount: 40 }, { selfId: 736, amount: 2 },
            ...[1864, 1865, 1866, 1868, 1869, 1870, 1871, 1872, 1873, 1874, 1875, 1876, 1877, 1878, 1879, 1880, 1881, 1882, 1883, 1884]
                .map(selfId => ({ selfId, amount: 3 }))]) } };
        // Near the half-full sale limit the limit shortens the outing, so the
        // kit targets differ with and without the retry.
        const fullBag = { ...kitBag, inventory: { ...kitBag.inventory, ...Life.inventorySummaryFromItems(
            [...Array(14).keys()].map(index => ({ selfId: 1885 + index, amount: 2 }))) } };
        for (const [label, bag] of [['fixture bag', fixture], ['bag with loot and kit', kitBag], ['bag near the half-full limit', fullBag]]) {
            const now = Date.now();
            const before = consentAnswer(bag, false, now), held = consentAnswer(bag, true, now);
            console.log(`E311 consent probe (${label}): answer without retry=${before}, with the saved retry=${held}`);
            assert.equal(held, before, `${label}: the saved sale retry changes the seller's own consent to the answer`);
        }

        // The visit's sale decision rolls among its options keyed on the pass's
        // millisecond (MarketListingPolicy.evaluate: rollKey 'dispose' at the
        // decision point `now`; PriceDecision.chooseByValue keeps every other
        // option a floor chance), so about 6% of passes list, keep or sell the
        // skins to the NPC instead of answering the ad (CI: the errand seller
        // listed them, no meeting). This test is about what follows an answer:
        // each seller answers the ad whenever the decision offers it.
        PriceDecision.chooseByValue = (options, rollKey) => options.find(option => option.action === 'ad' && Number.isFinite(option.value))
            || chooseByValue(options, rollKey);

        // The payer's worker answers later; it refuses the deal, as live (the ad's need changed).
        const meetings = new Set();
        let refuse = null;
        Coordinator.requestMeetingPreparation = (id, request) => {
            meetings.add(request.token);
            return new Promise((resolve, reject) => { refuse = () => reject(Error('trade_meeting_need_changed')); });
        };

        const first = await Population.resolveColdState(Life.cachedState(sellerId));
        assert(first.ok, 'the first visit pass runs');
        await settle();
        assert.equal(meetings.size, 1, 'the first pass answered the buy ad through a trade meeting');
        assert.equal(Meetings.hasPreparation(sellerId), true, 'the deal is still being prepared');
        assert.equal(Life.cachedState(sellerId).activity, 'shopping', 'a deal in preparation keeps the visit');
        const retryWhilePreparing = Life.cachedState(sellerId).stats.marketSellSeen;
        await Population.resolveColdState(Life.cachedState(sellerId));
        await settle();
        assert.equal(Life.cachedState(sellerId).activity, 'shopping', 'a pass during the preparation does not end the visit');

        // The refusal is known. The next pass must not wait on the same
        // refused deal again: it finishes the visit and leaves town.
        refuse();
        await settle();
        assert.equal(Meetings.hasPreparation(sellerId), false, 'the refused preparation is discarded');
        // The ended visit runs the town errands, whose NPC basket needs the
        // money packet every live cold bot carries (left out above: with it
        // this fixture's sale decision does not answer the ad).
        const held = Life.cachedState(sellerId);
        await Life.upsertState({ ...held, stats: { ...held.stats, money: [100, 0, 1000, 0] } }, 'e311_fixture');
        for (let pass = 0; pass < 2 && Life.cachedState(sellerId).activity === 'shopping'; pass++) {
            await Population.resolveColdState(Life.cachedState(sellerId));
            await settle();
        }
        const after = Life.cachedState(sellerId);
        assert.notEqual(after.activity, 'shopping', `E311: the visit never ends after a refused deal: ${JSON.stringify({
            meetings: meetings.size, activity: after.activity, townVisit: after.stats.townVisit,
            marketSellSeen: after.stats.marketSellSeen, lastReason: after.stats.lastReason })}`);
        assert.equal(meetings.size, 1, 'no later pass answers the refused ad again');

        assert.equal(Afk.ownerRecords(buyerId).some(row => row.kind === 'buy_ad'), false,
            'the payer refuses and retires the stale public quote for every later seller');
        assert.equal((await Database.fetchItems(buyerId)).find(row => row.selfId === 57).amount, 1000000,
            'retiring an unfunded intention never moves the physical wallet');
        // A later independently prepared quote can be answered again.
        await Afk.replaceBotRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Skins', ...place,
            lines: [{ selfId: SKIN, name: 'Animal Skin', count: 20, price: 5000, stackable: true,
                intent: { itemId: SKIN, amount: 20, price: 5000, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 } }] }], { expected: {} });

        // A refused deal while the town errands stop early (a purchase that
        // waits on its own meeting, ColdMarketService.finishTownErrands): the
        // visit cannot end on that pass (GoalExecutor.finishVisit), so the retry
        // is saved before it; the next pass does not answer the ad again.
        const errandMeetings = new Set();
        Coordinator.requestMeetingPreparation = async (id, request) => {
            errandMeetings.add(request.token);
            throw Error('trade_meeting_need_changed');
        };
        const Errands = invoke('GameServer/Bot/Economy/ColdMarketService'), finishErrands = Errands.finishTownErrands;
        Errands.finishTownErrands = async (state) => state;
        for (let pass = 0; pass < 3; pass++) {
            await Population.resolveColdState(Life.cachedState(errandSellerId));
            await settle();
        }
        Errands.finishTownErrands = finishErrands;
        const errandAfter = Life.cachedState(errandSellerId);
        assert.equal(errandAfter.activity, 'shopping', 'the errands keep this visit open');
        assert.equal(errandMeetings.size, 1, 'a visit held by its errands does not answer the refused ad again');
        // The mechanism last: the sale retry saved with the pending deal.
        assert(retryWhilePreparing?.items.includes(SKIN), 'the sale retry is saved with the pending deal');
        // The ended visit's retry stands on what it could not place.
        const leftKinds = state => invoke('GameServer/Bot/Economy/ItemDisposition').saleSeen(state)?.items || [];
        assert.deepEqual(after.stats.marketSellSeen?.items || [], leftKinds(after), 'the ended visit keeps its sale retry');
        assert.deepEqual(errandAfter.stats.marketSellSeen?.items || [], leftKinds(errandAfter), 'the errand seller keeps its sale retry');
        await Afk.replaceBotRecords(buyerId, 'buy_ad', [{ storeType: 3, town: 'Giran', title: 'Skins', ...place,
            lines: [{ selfId: SKIN, name: 'Animal Skin', count: 20, price: 5000, stackable: true,
                intent: { itemId: SKIN, amount: 20, price: 5000, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 } }] }], { expected: {} });
        const liveQuote = (await Database.fetchAfkTradeShops(buyerId)).find(row => row.kind === 'buy_ad');
        const nativeReprice = Afk.repriceBotLines;
        let raced = false;
        Afk.repriceBotLines = async (id, reprices, options) => {
            if (!raced && id === buyerId && options.withdrawals?.length) {
                raced = true;
                await nativeReprice(id, [{ recordId: liveQuote.id, lineId: liveQuote.lines[0].id,
                    expectedRevision: liveQuote.revision, previousPricing: liveQuote.lines[0].pricing,
                    price: 5100 }]);
            }
            return nativeReprice(id, reprices, options);
        };
        try {
            await Meetings.prepareTrade(errandSellerId, { shopId: liveQuote.id }, SKIN, 1);
            for (let pass = 0; pass < 10 && (!raced || Meetings.hasPreparation(errandSellerId)); pass++) await settle();
            assert(raced, 'a newer quote was published before stale cleanup reached the native transaction');
            const freshQuote = (await Database.fetchAfkTradeShops(buyerId)).find(row => row.id === liveQuote.id);
            assert.equal(freshQuote.lines[0].price, 5100);
            assert.equal(freshQuote.status, 'active', 'a refused older revision cannot withdraw a newer buy quote');
        } finally { Afk.repriceBotLines = nativeReprice; }
        const refused = [];
        Coordinator.requestMeetingPreparation = () => new Promise((_resolve, reject) => {
            refused.push(() => reject(Error('trade_meeting_need_changed')));
        });
        let sellerCommandCurrent = true;
        await Database.withMutationAdmission(() => {
            if (!sellerCommandCurrent) throw Error('cold_postcommit_source_retired');
        }, () => Meetings.prepareTrade(errandSellerId, { shopId: liveQuote.id }, SKIN, 1));
        sellerCommandCurrent = false;
        refused.forEach(reject => reject());
        for (let pass = 0; pass < 10 && Afk.ownerRecords(buyerId).some(row => row.id === liveQuote.id); pass++) await settle();
        assert.equal(Afk.ownerRecords(buyerId).some(row => row.id === liveQuote.id), false,
            'the payer refusal retires its own quote after the initiating seller command has ended');
        console.log('E311 refused trade meeting does not hold the town visit: passed');
    } finally {
        Coordinator.requestMeetingPreparation = prepare;
        PriceDecision.chooseByValue = chooseByValue;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

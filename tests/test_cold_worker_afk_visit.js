'use strict';
// Keep these market fixtures independent of optional reserve shot merchants.
process.env.BOT_STATIC_SHOTS_DISABLED = 'true';
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const nativeDecision = require('./helpers/workerEconomyDecision');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const id = 730183;
const sellerId = 730184;
const doneSellerId = 730185;
const cleanerId = 730186;
const archerId = 730187;
const STATIC_BOUGHT = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871];

(async () => {
    const world = await createWorld([{ id, classId: 0, level: 20 }, { id: sellerId, classId: 0, level: 20 },
        { id: doneSellerId, classId: 0, level: 20 }, { id: cleanerId, classId: 0, level: 20 },
        { id: archerId, classId: 9, level: 20 }], 'native-afk-visit');
    try {
        await Life.init();
        await Database.createAccount('bot_native_afk_visit', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_native_afk_visit', id]]);
        await Database.setItem(id, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(id, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
        for (const enchant of [0, 1, 3]) await Database.setItem(id, {
            selfId: 626, amount: 1, enchant, equipped: enchant === 3 ? 1 : 0, slot: enchant === 3 ? 8 : 0
        });
        const shieldsBefore = (await Database.fetchItems(id)).filter(row => row.selfId === 626);
        for (const selfId of [1786, 1792, 1793, 1800, 1803, 2143, 2151, 2173, 2174, 2175, 1867, 1869, 1870, 1871, 1872, 1873, 1880, 1897])
            await Database.setItem(id, { selfId, amount: 1000, slot: 0 });
        const place = Town.marketTown('Elven Village').center;
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        const state = await Life.upsertState({ characterId: id, accountName: 'bot_native_afk_visit',
            name: 'NativeTownSeller', level: 20, exp: Number(DataCache.experience[19]),
            phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
            adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } },
            timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'ordinary_town_visit_fixture');
        assert.equal(Population.marketListingIntent(state, { type: 'restock' }).shouldOpen, true);
        assert.equal(Population.marketListingIntent(state, { type: 'restock' }).saleVisit, false);
        // Real worker pricing and native lifecycle planning; no supplied sale,
        // price, demand or sell_inventory goal. Its usual purchase leaf must
        // not prevent the town's independent showcase publication.
        const native = await nativeDecision(state, { townVisit: true });
        const plan = native.plan.economyPlan;
        assert(plan, 'an ordinary shopping command carries its market publication');
        assert.equal(plan.shop, 'Elven Village', 'open in the town actually visited');
        assert(plan.sell.length >= 4, `an adventurer quotes surplus without an existing buyer: ${JSON.stringify(plan)}`);
        assert.equal(plan.take, undefined, 'town errands retain their own purchase executor');
        // The visit posts its bids too (a C4 player opens a buy store in town, not from the
        // field): the build's want, beside the showcase; no trip of its own.
        assert(plan.buyAds?.length > 0 && plan.buyAds.every(row => row[0] > 0 && row[1] > 0 && row[2] > 0),
            `the visit carries its bids: ${JSON.stringify(plan.buyAds)}`);
        assert.equal(plan.travel, null);
        const shieldPlans = plan.sell.filter(row => row[0] === 626);
        assert(shieldPlans.some(row => row[4] === 1),
            'the native worker quotes the +1 spare despite a +0 copy in the bag');
        assert(!shieldPlans.some(row => row[4] === 3), 'the worn shield stays reserved');
        const prices = plan.sell.map(row => row[2]);
        assert.deepEqual(prices.slice(0, 3), prices.slice().sort((a, b) => b - a).slice(0, 3));
        assert(plan.sell.every(row => Number.isSafeInteger(row[5]) && row[5] > 0),
            'every quoted row carries the width of the belief its price was decided with');
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), saved = Economy.forState;
        let outcome;
        try {
            Economy.forState = () => { throw Error('the town handoff must not rebuild worker pricing on main'); };
            outcome = await Population.resolveColdState(state, { precomputedPlan: native.plan,
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} } });
        } finally { Economy.forState = saved; }
        assert(outcome.ok);
        const shop = Afk.findOwnerProjection(id)?.shop;
        assert(shop, `the real town lifecycle executes the prepared showcase before departure: ${JSON.stringify({ plan,
            activity: outcome.state.activity, debug: outcome.debug, lastReason: outcome.state.stats.lastReason,
            records: Afk.ownerRecords(id).map(row => ({ kind: row.kind, town: row.town, items: row.lines.map(line => line.selfId) })) })}`);
        assert.equal(shop.town, 'Elven Village');
        assert.deepEqual(shop.lines.map(row => row.selfId), plan.sell.slice(0, 3).map(row => row[0]));
        const ads = Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad');
        assert(ads.length > 0 && ads.length <= 5, 'overflow becomes conditional board ads');
        const own = Afk.boardIndex().ownerLines(id);
        assert.equal(new Set(own.map(line => `${line.selfId}:${line.enchant}`)).size, own.length);
        assert(!own.some(line => line.selfId === 1), 'the worn weapon cannot be offered');
        for (const row of plan.sell) {
            const line = own.find(line => line.selfId === row[0] && line.enchant === row[4]);
            if (line) assert.equal(line.pricing.sigma, row[5] / 1e4, 'the published line keeps the worker belief width');
        }
        for (const row of shieldPlans) {
            const line = own.find(line => line.selfId === 626 && line.enchant === row[4]);
            assert(line, 'the town lifecycle publishes the worker selected enchant without an ambiguous-copy failure');
            assert.equal(line.price, row[2]);
            const source = shieldsBefore.find(item => item.enchant === row[4]);
            const recordLine = Afk.ownerRecords(id).flatMap(record => record.lines).find(row => row.id === line.lineId);
            assert.equal(recordLine.sourceObjectId, source.id, 'native custody selects the exact physical enchant');
        }
        const worn = (await Database.fetchItems(id)).find(row => row.selfId === 626 && row.enchant === 3);
        assert.equal(worn.id, shieldsBefore.find(row => row.enchant === 3).id);
        assert.equal(worn.equipped, 1);
        assert(!own.some(line => line.selfId === 626 && line.enchant === 3));
        assert(Buffer.byteLength(JSON.stringify(plan)) <= require('../src/GameServer/Bot/Population/ColdEconomyPlan').MAX_PLAN_PAYLOAD_BYTES);
        console.log('PASS native ordinary town visit: real worker prices, mixed enchants, physical custody, reserved equipment, main handoff');

        // E304: the same visit on a sale trip (the departure marker says it came to
        // sell). The worker showcase must not skip open: the static buyers, the
        // junk sale and the 30-min sale retry exist only there.
        await Database.createAccount('bot_native_sale_visit', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_native_sale_visit', sellerId]]);
        await Database.setItem(sellerId, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(sellerId, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
        for (const enchant of [0, 1, 3]) await Database.setItem(sellerId, {
            selfId: 626, amount: 1, enchant, equipped: enchant === 3 ? 1 : 0, slot: enchant === 3 ? 8 : 0
        });
        for (const selfId of [1786, 1792, 1793, 1800, 1803, 2143, 2151, 2173, 2174, 2175, 1867, 1869, 1870, 1871, 1872, 1873, 1880, 1897])
            await Database.setItem(sellerId, { selfId, amount: 1000, slot: 0 });
        const bagOf = async () => (await Database.fetchItems(sellerId)).reduce((sum, row) => {
            sum[row.selfId] = (sum[row.selfId] || 0) + Number(row.amount || 0);
            return sum;
        }, {});
        const startedAt = Date.now() - 60000;
        const saleState = await Life.upsertState({ characterId: sellerId, accountName: 'bot_native_sale_visit',
            name: 'NativeTripSeller', level: 20, exp: Number(DataCache.experience[19]),
            phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
            adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(sellerId)),
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } },
            timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'sale_town_visit_fixture');
        const saleIntent = Population.marketListingIntent(saleState, { type: 'restock' });
        assert.equal(saleIntent.shouldOpen, true);
        assert.equal(saleIntent.saleVisit, true, 'the departure marker, not the re-reviewed goal, marks a sale trip');
        const saleNative = await nativeDecision(saleState, { townVisit: true });
        const salePlan = saleNative.plan.economyPlan;
        assert(salePlan && salePlan.sell.length >= 3, `a sale trip still carries the worker showcase: ${JSON.stringify(salePlan)}`);
        const bagBefore = await bagOf();
        const Static = invoke('GameServer/Bot/Economy/StaticBuyerService'), staticSell = Static.sell;
        const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService'), executePlan = Market.executePlan;
        const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService'), open = Listing.open;
        const staticSales = [], opens = [];
        let showcaseRuns = 0, saleOutcome;
        try {
            Market.executePlan = (...args) => { showcaseRuns++; return executePlan.apply(Market, args); };
            Static.sell = (...args) => staticSell.apply(Static, args).then((result) => {
                staticSales.push(result);
                return result;
            });
            Listing.open = (...args) => open.apply(Listing, args).then((result) => {
                opens.push(result);
                return result;
            });
            saleOutcome = await Population.resolveColdState(saleState, { precomputedPlan: saleNative.plan,
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} } });
        } finally { Static.sell = staticSell; Market.executePlan = executePlan; Listing.open = open; }
        assert(saleOutcome.ok);
        assert.notEqual(saleOutcome.state.stats.lastReason, 'market_batch_continue',
            'the fixture must reach the listing gate, not the purchase batch return');
        assert.equal(showcaseRuns, 0, 'a sale trip skips the worker showcase: open alone decides the bag');
        const bagAfter = await bagOf();
        assert(staticSales.some(row => row.sold), `open reached the static buyers: ${JSON.stringify({
            sales: staticSales.map(row => ({ sold: row.sold, itemCount: row.itemCount, adena: row.adena })),
            lastReason: saleOutcome.state.stats.lastReason })}`);
        assert(STATIC_BOUGHT.some(selfId => (bagAfter[selfId] || 0) < (bagBefore[selfId] || 0)),
            'the static-bought materials left the bag');
        assert((bagAfter[57] || 0) > (bagBefore[57] || 0), 'the static sale paid adena');
        const savedSeller = await Life.findByCharacterId(sellerId);
        const seen = saleOutcome.state.stats.marketSellSeen ?? savedSeller?.stats?.marketSellSeen ?? null;
        assert.deepEqual(seen?.items || [], invoke('GameServer/Bot/Economy/ItemDisposition').saleSeen(saleOutcome.state)?.items || [],
            'the sale trip wrote its retry on what it could not place, so the next trip waits for new goods or a buyer');
        assert.equal(opens.length, 1);
        assert.equal(opens[0].listed, true, `open listed the rest: ${opens[0].reason}`);
        const saleShop = Afk.findOwnerProjection(sellerId)?.shop;
        assert(saleShop && Number(saleShop.storeType) === Afk.SELL && saleShop.town === 'Elven Village', 'open opened the sell shop');
        const variant = item => `${Number(item.selfId)}:${Number(item.enchant || 0)}`;
        const sold = new Set([
            ...staticSales.flatMap(row => (row.candidates || []).map(variant)),
            ...(opens[0].market?.npc || []).map(variant)
        ]);
        assert(sold.size > 0);
        const offered = Afk.ownerRecords(sellerId).filter(row => row.kind === 'sell_ad').flatMap(row => row.lines)
            .concat(saleShop.lines);
        const unbacked = offered.filter(line => sold.has(variant(line)));
        assert.deepEqual(unbacked.map(variant), [], 'sold variants are gone; another enchant of the same item can remain offered');
        console.log('PASS native sale town visit: worker showcase skipped, static buyers paid, sale retry written, open listed the rest');

        assert.equal(Population.marketListingIntent({ ...saleState, stats: { ...saleState.stats,
            townVisit: { ...saleState.stats.townVisit, town: 'Gludin Village' } } }, { type: 'restock' }).saleVisit, false,
        'a sale marker for another town does not make this visit a sale trip');
        // Controls on the same bag: the worker showcase still runs on a finished
        // sale visit and on a forced cleanup (the author's path, E306).
        const showcaseRunsFor = async (characterId, label, stats, classId = 0, extraItems = []) => {
            const account = `bot_native_${label}`;
            await Database.createAccount(account, 'fixture');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [account, characterId]]);
            await Database.setItem(characterId, { selfId: 57, amount: 1000000, slot: 0 });
            const weaponId = classId === 9 ? DataCache.items.find(item =>
                item.template?.kind === 'Weapon.Bow' && item.etc?.rank === 'd').selfId : 1;
            await Database.setItem(characterId, { selfId: weaponId, amount: 1, equipped: 1, slot: 7 });
            for (const item of extraItems) await Database.setItem(characterId, item);
            for (const selfId of [1786, 1792, 1793, 1800, 1803, 2143, 2151, 2173, 2174, 2175, 1867, 1869, 1870, 1871, 1872, 1873, 1880, 1897])
                await Database.setItem(characterId, { selfId, amount: classId === 9 ? 10 : 1000, slot: 0 });
            const visitState = await Life.upsertState({ characterId, accountName: account,
                name: `Native${label}`, level: 20, exp: Number(DataCache.experience[19]),
                phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
                adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
                stats: { classId, generatedCold: true, classProgressionClassId: classId, classProgressionLevel: 20,
                    marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center }, ...stats },
                timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
            }, `${label}_fixture`);
            const decided = await nativeDecision(visitState, { townVisit: true });
            assert(decided.plan.economyPlan, `${label}: the worker plan carries a showcase`);
            let runs = 0;
            try {
                Market.executePlan = (...args) => { runs++; return executePlan.apply(Market, args); };
                const result = await Population.resolveColdState(visitState, { precomputedPlan: decided.plan,
                    precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                        nextResolveAt: Date.now() + 30000, debug: {} } });
                assert(result.ok);
            } finally { Market.executePlan = executePlan; }
            return { visitState, runs };
        };
        const done = await showcaseRunsFor(doneSellerId, 'done_sale_visit',
            { townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory', completed: true } });
        assert.equal(Population.marketListingIntent(done.visitState, { type: 'restock' }).saleVisit, false);
        assert.equal(done.runs, 1, 'a finished sale visit reaches the worker showcase, so the sale case skip is the predicate');
        const cleanup = await showcaseRunsFor(cleanerId, 'cleanup_visit', {
            townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory' },
            forcedMarketCleanup: { cleanupReason: 'inventory_capacity', itemCount: 18, npcOnlySlots: 0, startedAt } });
        assert.equal(cleanup.runs, 1, 'a forced cleanup keeps the worker showcase (the author path)');
        console.log('PASS sale visit controls: finished and other-town sale markers, forced cleanup keeps the showcase');
        const arrows = await showcaseRunsFor(archerId, 'arrow_cleanup_visit', {}, 9,
            [{ selfId: 1341, amount: 5000 }, { selfId: 1343, amount: 100 }]);
        assert.equal(invoke('GameServer/Inventory/ArrowStock').keptAmounts(arrows.visitState)[1341], 2000);
        assert.equal(arrows.runs, 1, 'unused arrows do not cost the visit its worker showcase');
        const arrowBag = await Database.fetchItems(archerId);
        assert.equal(arrowBag.filter(item => item.selfId === 1341).reduce((sum, item) => sum + item.amount, 0), 2000);
        assert(!arrowBag.some(item => item.selfId === 1343), 'wrong-grade arrows go to the NPC on an ordinary town errand');
        console.log('PASS ordinary archer town visit: the showcase runs and the NPC takes surplus and wrong-grade arrows');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

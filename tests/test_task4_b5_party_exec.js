'use strict';
// Task 4 B5 N11 (E169 on the Task 4 execution paths): the cold arrival buy
// (ColdMarketService.tryPurchase: gear bestOffer and material buyHere) and
// BotAfkMarketService.executePlan take never trade a conditional line with a party
// bot (seller or buyer); a backed line is still bought; a party bot's own ad stays.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const buyer = 730301, partySeller = 730302, plainSeller = 730303, backedSeller = 730304, ORE = 1869, GLOVES = 48, restore = [];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
const setParty = async (id, partyId) => {
    await Database.execute(['UPDATE bot_life_state SET partyId=? WHERE characterId=?', [partyId, id]]);
    assert(Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]));
    assert.equal(Life.cachedState(id).party?.partyId ?? null, partyId, 'fixture: cached party membership');
};
let nextId = 991400;
const ad = (ownerId, selfId, price, custodyPolicy) => {
    const id = ++nextId;
    Afk.refreshRecord({ id, ownerId, ownerName: `Seller${ownerId}`, ownerAccount: `bot_${ownerId}`, kind: 'sell_ad', storeType: Afk.SELL,
        status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0, custodyPolicy, ...point, appearance: {},
        lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count: 5, price, enchant: 0 }] });
    return id;
};
(async () => {
    const world = await createWorld([buyer, partySeller, plainSeller, backedSeller].map(id => ({ id, classId: 0, level: 30 })), 'task4-b5-party-exec');
    try {
        await Database.createAccount('bot_b5_party_exec', 'test');
        await Database.execute([`UPDATE characters SET username='bot_b5_party_exec' WHERE id IN (?,?,?,?)`, [buyer, partySeller, plainSeller, backedSeller]]);
        await Life.init();
        invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
        for (const id of [buyer, partySeller, plainSeller, backedSeller]) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30, adena: 100000,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point, currentRegion: 'Giran',
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const bought = [], refreshes = [];
        stub(Afk, 'buyFromShop', async (id, store, selfId, qty) => { bought.push([id, store.shopId ?? store.id, selfId, qty]); return { pending: true, meetingId: 5 }; });
        stub(Coordinator, 'requestEconomyRefresh', id => refreshes.push(id));
        const partyOre = ad(partySeller, ORE, 200, 1), backedOre = ad(backedSeller, ORE, 250, 0);
        const partyGloves = ad(partySeller, GLOVES, 100, 1), backedGloves = ad(backedSeller, GLOVES, 150, 0);
        const lineOf = id => Afk.boardIndex().records.get(id)[0];
        assert.equal(lineOf(partyOre).custodyPolicy, 1); assert.equal(lineOf(backedOre).custodyPolicy, 0);
        const take = id => { const l = lineOf(id); return { take: [Afk.SELL, l.selfId, 2, l.recordId, l.lineId, l.revision, l.price] }; };
        const gear = adena => ({ type: 'upgrade_gear', status: 'active', target: { itemId: GLOVES, itemName: 'Short Gloves', adena }, plan: { marketTown: 'Giran' } });
        const material = adena => ({ type: 'buy_craft_material', status: 'active', target: { itemId: ORE, amount: 2, adena },
            plan: { marketTown: 'Giran', purpose: 'supply' } });
        // An existing buy ad of the buyer, published before it joins a party.
        const ownAd = (await Database.createAfkTradeShop(buyer, { kind: 'buy_ad', storeType: 3, town: 'Giran', title: 'Own need', ...point,
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 2, price: 100 }] })).shop;
        Afk.refreshRecord(await Database.fetchAfkTradeShop(ownAd.id));
        const snapshot = async () => JSON.stringify(await Promise.all([buyer, partySeller, plainSeller, backedSeller].map(async id =>
            [await Database.fetchItems(id), (await Database.fetchAfkTradeShops(id)).map(row => [row.id, row.revision, row.status, row.lines.map(l => l.count)])])));
        // Each step: what it bought (stub calls), whether it asked the worker, and that no money, stock or ad moved.
        const run = async work => { const before = await snapshot(), n = bought.length; refreshes.length = 0;
            const result = await work();
            assert.equal(await snapshot(), before, 'no money, stock or ad change');
            return { result, calls: bought.slice(n).map(call => call[1]), refreshed: refreshes.includes(buyer) }; };
        const state = () => Life.cachedState(buyer);
        const partyLines = [partyOre, partyGloves];

        // Party seller: the executePlan take and both arrival buys never reach it.
        await setParty(partySeller, 'b5-seller-party');
        let step = await run(() => Market.executePlan(state(), take(partyOre)));
        assert.equal(step.result.tradeDeferred, true, 'take with a party seller is deferred');
        assert.deepEqual(step.calls, [], 'take: no buyFromShop with a party seller');
        step = await run(() => Cold.tryPurchase(state(), gear(300)));
        assert.deepEqual(step.calls, [backedGloves], 'gear arrival skips the cheaper party line and buys the backed one');
        step = await run(() => Cold.tryPurchase(state(), gear(120)));
        assert.deepEqual(step.calls, [], 'gear arrival: only a party line under the cap -> nothing bought');
        assert(step.refreshed, 'gear arrival miss asks the worker for a new card');
        step = await run(() => Cold.tryPurchase(state(), material(300)));
        assert.deepEqual(step.calls, [backedOre], 'material arrival (buyHere) skips the party line, buys the backed one');
        step = await run(() => Cold.tryPurchase(state(), material(220)));
        assert.deepEqual(step.calls, [], 'material arrival: only a party line under the cap -> nothing bought');
        assert(step.refreshed, 'material arrival miss asks the worker');

        // Party buyer: the same conditional lines are refused from its side; backed lines are still bought.
        await setParty(partySeller, null); await setParty(buyer, 'b5-buyer-party');
        const plainOre = ad(plainSeller, ORE, 200, 1);
        step = await run(() => Market.executePlan(state(), take(plainOre)));
        assert.equal(step.result.tradeDeferred, true);
        assert.deepEqual(step.calls, [], 'take: a party buyer trades with no conditional seller');
        step = await run(() => Cold.tryPurchase(state(), gear(120)));
        assert.deepEqual(step.calls, [], 'gear arrival: a party buyer skips a conditional line');
        assert(step.refreshed);
        step = await run(() => Cold.tryPurchase(state(), gear(300)));
        assert.deepEqual(step.calls, [backedGloves], 'a party buyer still buys a backed line');
        step = await run(() => Cold.tryPurchase(state(), material(220)));
        assert.deepEqual(step.calls, [], 'material arrival: a party buyer skips a conditional line');
        assert(step.refreshed);
        assert(!bought.some(call => partyLines.includes(call[1]) || call[1] === plainOre), 'no conditional line was ever bought across a party');

        // The party bot's own existing ad stayed listed through all of the above.
        assert.deepEqual((await Database.fetchAfkTradeShops(buyer)).map(row => [row.id, row.revision, row.status]), [[ownAd.id, ownAd.revision, 'active']],
            'a party bot keeps its existing ad');
        // executePlan buyAds has no owner party check (known gap, task4-map-execution.md section 5): the
        // party buyer's new ad is listed today, but no seller can fill an ad of a party bot.
        await Market.executePlan(state(), { buyAds: [[1867, 2, 100], [ORE, 2, 237]] });
        const fillable = () => Opportunity.findBuyOffers(ORE, { town: 'Giran', sellerCharacterId: plainSeller }).filter(offer => offer.sourceId === buyer || Number(offer.ownerId) === buyer);
        const published = (await Database.fetchAfkTradeShops(buyer)).some(row => row.lines.some(line => line.selfId === ORE));
        if (published) assert.deepEqual(fillable(), [], 'a seller cannot fill a party bot\'s buy ad');
        // Controls: with no party on either side the same lines are traded, so the refusals above are the party's.
        await setParty(buyer, null);
        if (published) assert.equal(fillable().length, 1, 'control: the same ad is fillable once the owner leaves the party');
        assert.deepEqual((await run(() => Market.executePlan(state(), take(plainOre)))).calls, [plainOre], 'control: take buys');
        assert.deepEqual((await run(() => Cold.tryPurchase(state(), gear(120)))).calls, [partyGloves], 'control: gear arrival buys');
        const control = (await run(() => Cold.tryPurchase(state(), material(220)))).calls;
        assert(control.length === 1 && [partyOre, plainOre].includes(control[0]), 'control: material arrival buys a conditional line');
        console.log(`PASS task4 b5 N11: executePlan take and arrival (gear, material) skip party sellers and party buyers, backed lines bought, own ad kept; party buy ad published=${published}, unfillable`);
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

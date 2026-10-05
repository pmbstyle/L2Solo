// Trading on the board by trips (market-sim step 3.3 group C): what a trip
// costs, where a bot with karma may go, and the decisions built on them.
const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const Karma = invoke('GameServer/Karma');
const OfferOrder = invoke('GameServer/Bot/Economy/OfferOrder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');

const HOUR_MS = 3600000;
const town = (name) => Object.values(TownRespawn.towns).find((candidate) => candidate.name === name);
const SPOT = { locX: 20000, locY: 140000, locZ: -3000 };

function hunter(extra = {}) {
    return { characterId: 990001, level: 40, adena: 500000, loc: { ...SPOT },
        inventory: { 736: { selfId: 736, amount: 5 } }, stats: {}, ...extra };
}

// 1. A trip costs the way there and back (item 8): the town leg the trip
// builder plans plus the return to the spot, at the bot's hour, and the fee.
for (const honest of [false, true]) {
    Config.coldHonestTravel = honest;
    const state = hunter();
    const hour = Efficiency.hourValue(state, Date.now()).perHour;
    const giran = town('Giran');
    const plan = ColdTrip.townPlan(state, giran);
    const back = ColdTrip.spotTripMs({ ...state, loc: ColdTrip.point(giran) }, SPOT);
    assert(back > 0);
    const expected = Math.round((plan.durationMs + back) / HOUR_MS * hour) + plan.route.fee;
    assert.strictEqual(OfferOrder.tripCost(state)('Giran'), expected, `round trip, honest travel ${honest}`);
}
Config.coldHonestTravel = false;

// 2. A bot with karma enters no town but Floran, on foot (E48).
{
    const red = hunter({ stats: { karma: 720 } });
    assert.strictEqual(ColdTrip.townPlan(red, town('Giran')), null, 'Giran is closed to a PK');
    const floran = ColdTrip.townPlan(red, town(Karma.TOWN_NAME));
    assert.strictEqual(floran.method, 'walk');
    assert.strictEqual(floran.scroll, false);
    assert.strictEqual(floran.route.fee, 0);
    const cost = OfferOrder.tripCost(red);
    assert.strictEqual(cost('Dion'), Infinity);
    assert(Number.isFinite(cost(Karma.TOWN_NAME)) && cost(Karma.TOWN_NAME) > 0, 'Floran is priced');
    const trip = ColdTrip.toTown(red, { to: { ...ColdTrip.point(town(Karma.TOWN_NAME)) }, townName: Karma.TOWN_NAME,
        arrivalActivity: 'shopping' }, 1000);
    assert.strictEqual(trip.stats.travel.method, 'walk');
    assert.strictEqual(trip.inventory[736].amount, 5, 'no scroll is read');
    assert.strictEqual(Karma.townFor(720, 'Giran'), Karma.TOWN_NAME);
    assert.strictEqual(Karma.townFor(0, 'Giran'), 'Giran');
}

// 3. The shop town (б7, Q6): one weighted roll over the towns with shop
// places, by the item's buyers there less the trip; the author's grade table
// seeds it while its counter has no deals.
{
    const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
    const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
    const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
    const SABER = 123;
    const flatTrip = () => 1000;
    const tally = (items, state = hunter(), runs = 400) => {
        const counts = new Map();
        for (let run = 0; run < runs; run++) {
            const town = MarketTownPolicy.shopTown(state, items, { tripCost: flatTrip, timestamp: 5000, rollKey: ['t', run] });
            counts.set(town, (counts.get(town) || 0) + 1);
        }
        return counts;
    };
    MarketCounters.reset();
    const seed = MarketTownPolicy.targetTownForItems(hunter(), [{ selfId: SABER }]);
    const seeded = tally([{ selfId: SABER, price: 50000, count: 1 }]);
    assert(seeded.get(seed) >= 380, `the seed town takes the roll (${seed}: ${seeded.get(seed)})`);
    // Buyers of 'gear d': three in Giran for each one in Gludio.
    for (let deal = 0; deal < 40; deal++) MarketCounters.deal(SABER, 50000, 1, 1000 + deal, 7, deal % 4 ? 'Giran' : 'Gludio');
    const rolled = tally([{ selfId: SABER, price: 50000, count: 1 }]);
    const giran = rolled.get('Giran') || 0;
    const gludio = rolled.get('Gludio') || 0;
    assert(giran > 2 * gludio && gludio > 50, `in proportion to the buyers: Giran ${giran}, Gludio ${gludio}`);
    assert(400 - giran - gludio < 30, 'a town without buyers keeps only a small chance');
    // A trip that costs more than the shop would see there leaves it nothing.
    const farGiran = MarketTownPolicy.shopTown(hunter(), [{ selfId: SABER, price: 50000, count: 1 }],
        { tripCost: (name) => (name === 'Giran' ? 1e9 : 0), timestamp: 5000, rollKey: ['far'] });
    assert.notStrictEqual(farGiran, 'Giran');
    assert.strictEqual(MarketTownPolicy.shopTown(hunter({ stats: { karma: 1 } }), [{ selfId: SABER, price: 1, count: 1 }]),
        Karma.TOWN_NAME, 'a PK opens in Floran');
    // The decision is made once: a bot that chose keeps its town.
    const chose = hunter({ stats: { shopTown: { town: 'Dion', at: 1 } } });
    assert.deepStrictEqual(MarketTownPolicy.openingTown(chose, [{ selfId: SABER, price: 50000, count: 1 }]),
        { town: 'Dion', shopTown: null });
    const fresh = MarketTownPolicy.openingTown(hunter(), [{ selfId: SABER, price: 50000, count: 1 }], 7000);
    assert.deepStrictEqual(fresh.shopTown, { town: fresh.town, at: 7000 }, 'a new decision is returned to keep');
    // The weighted roll: zero-valued options together keep TendencyRoll.MIN.
    const options = [{ action: 'a', value: 100 }, { action: 'b', value: 0 }, { action: 'c', value: -5 }];
    let others = 0;
    for (let run = 0; run < 2000; run++) if (PriceDecision.chooseByWeight(options, ['w', run]).action !== 'a') others += 1;
    assert(others > 10 && others < 90, `the floor is small and never zero (${others} of 2000)`);
    MarketCounters.reset();
}

// 4. A buy ad is answered by the side that acts (E45, user Q3 C): a seller
// chooses it in its sale decision when the ad's price less its trip there
// beats listing, the NPC and keeping; it sells only in the ad's town.
{
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const World = invoke('GameServer/World/World');
    World.user = { sessions: [], revision: 0 };
    const STEM = 1864;
    AfkTrade.refreshRecord({ id: 995001, ownerId: 995000, ownerName: 'Wanted', ownerAccount: 'bot_995000', kind: 'buy_ad',
        storeType: AfkTrade.BUY, status: 'active', town: 'Dion', title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0,
        appearance: {}, lines: [{ id: 9950011, selfId: STEM, name: 'Stem', count: 40, price: 900, enchant: 0 }] });
    const seller = (activity, loc, region) => ({ characterId: 995100, accountName: 'bot_995100', name: 'Stems', level: 30,
        phase: 'cold', activity, currentRegion: region, adena: 20000, loc: { ...loc },
        inventory: { [STEM]: { selfId: STEM, name: 'Stem', amount: 30, kind: 'Other.Material', rank: 'none' } },
        stats: { generatedCold: true }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } });
    const inDion = seller('shopping', town('Dion'), 'Dion');
    const ctx = ListingPolicy.traderContext(inDion, {});
    const answer = MarketPricing.bestAnswer(STEM, ctx, { units: 30 });
    assert.strictEqual(answer.line.town, 'Dion');
    assert.strictEqual(answer.count, 30);
    assert.strictEqual(answer.net, 900 * 30, 'no trip to the town the bot stands in');
    let chosen = 0;
    for (let run = 0; run < 20; run++) {
        const market = ListingPolicy.evaluate(inDion, { now: 1000 + run, ...{} });
        if (market.answers.some((entry) => entry.line.town === 'Dion' && entry.count === 30)) chosen += 1;
    }
    assert(chosen >= 18, `a generous ad in the bot's own town is answered (${chosen} of 20)`);
    // Far away the trip is part of the price: a long trip at a high hour
    // leaves nothing to answer it for.
    const far = seller('hunting', { locX: -80000, locY: 240000, locZ: -3000 }, 'Talking Island');
    const farCtx = { ...ListingPolicy.traderContext(far, {}), travel: () => 900 * 30 };
    assert.strictEqual(MarketPricing.bestAnswer(STEM, farCtx, { units: 30 }).net, 0);
    AfkTrade._resetForTests();
}

// 5. The cheapest town for a stack (user Q1 A): the board's lines of each
// town, then its NPC as one more offer, plus the trip; the whole amount first.
{
    const OfferQuery = invoke('GameServer/Bot/Economy/OfferQuery');
    const { BoardIndex, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');
    const SHOT = 1463;
    const index = new BoardIndex();
    const put = (id, town, count, price, ownerId = 7) => index.put({ id, kind: 'sell_ad', storeType: SELL, ownerId, town,
        botOwned: true, lines: [{ lineId: id * 10, selfId: SHOT, count, price }] });
    put(1, 'Giran', 100, 80);
    put(2, 'Dion', 2000, 90);
    put(3, 'Dion', 500, 95, 99);
    const npcOffers = ['Giran', 'Dion', 'Talking Island'].map((name) => ({ town: name, price: 100 }));
    const trips = { Giran: 50000, Dion: 10000, 'Talking Island': 0 };
    const cost = (name) => trips[name] ?? Infinity;
    const best = OfferQuery.cheapestTown(index, SHOT, { amount: 3000, npcOffers, cost, excludeOwner: 99 });
    assert.strictEqual(best.town, 'Dion', 'Dion: 2,000 at 90 + 1,000 from the NPC + its trip');
    assert.deepStrictEqual(best.lines.map((entry) => [entry.line.recordId, entry.count]), [[2, 2000]], 'not its own line');
    assert.strictEqual(best.npc, 1000);
    assert.strictEqual(best.landed, 2000 * 90 + 1000 * 100 + 10000);
    trips.Dion = 30000;
    assert.strictEqual(OfferQuery.cheapestTown(index, SHOT, { amount: 3000, npcOffers, cost }).town, 'Talking Island',
        'a dearer trip sends the bot to its own village\'s NPC');
    // A short wallet fills no town: the least landed price a unit wins.
    const poor = OfferQuery.cheapestTown(index, SHOT, { amount: 3000, npcOffers, cost, money: 9000 });
    assert.strictEqual(poor.whole, false);
    assert.strictEqual(poor.town, 'Talking Island');
    assert.strictEqual(OfferQuery.cheapestTown(index, SHOT, { amount: 10, npcOffers: [], cost: () => Infinity }), null);
    const filled = OfferQuery.fill([{ price: 5, count: 10, sourceId: 1 }, { price: 9, count: 10, sourceId: 2 }], 15,
        { npcPrice: 8, maxPrice: 8, money: 100 });
    assert.deepStrictEqual([filled.lines.length, filled.npc, filled.units, filled.cost], [1, 5, 15, 90]);
}

// 6. An errand (ColdMarketService.acquire) is a market goal: the author's
// market trip takes the bot to its town (a party member by its party's
// market break), where the purchase is made on arrival.
{
    const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
    const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
    const errand = { selfId: 1463, amount: 2000, town: 'Dion', money: 50000, maxPrice: null, purpose: 'shots', at: 1 };
    const state = { ...hunter({ stats: { marketErrand: errand } }), phase: 'cold', activity: 'hunting', accountName: 'bot_990001',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } };
    const goal = NeedsEvaluator.evaluate(state, { now: 1000 }).find((candidate) => candidate.type === 'market_errand');
    assert(goal, 'the errand is a goal');
    assert.strictEqual(goal.plan.marketTown, 'Dion');
    assert.strictEqual(goal.target.itemId, 1463);
    const travel = GoalExecutor.beginMarketTravel(state, { ...goal, status: 'active' }, 1000);
    assert.strictEqual(travel.stats.travel.townName, 'Dion');
    assert.strictEqual(travel.stats.travel.arrivalActivity, 'shopping');
    assert.deepStrictEqual(ColdMarketService.errandGoal(errand).plan.marketTown, 'Dion');
}

// 7. A crafter's material purchase weighs the landed price (item 7): an
// offer a little cheaper in a far town loses to one in the town it stands in.
{
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const STEM = 1864;
    const ad = (id, town, price) => AfkTrade.refreshRecord({ id, ownerId: 996000 + id % 10, ownerName: 'S', ownerAccount: 'bot_996',
        kind: 'sell_ad', storeType: AfkTrade.SELL, status: 'active', town, title: '', revision: 1, expiresAt: 0,
        locX: 0, locY: 0, locZ: 0, appearance: {}, lines: [{ id: id * 10, selfId: STEM, name: 'Stem', count: 10, price, enchant: 0 }] });
    ad(996001, 'Giran', 95);
    ad(996002, 'Dion', 100);
    const crafter = { characterId: 996100, accountName: 'bot_996100', name: 'Crafter', level: 40, phase: 'cold',
        activity: 'shopping', currentRegion: 'Dion', loc: { ...town('Dion') }, adena: 5000000,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, inventory: {},
        stats: { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: 1,
            materials: [{ selfId: STEM, amount: 10, missing: 10, farmEffort: 1e6 }] } } };
    const goal = NeedsEvaluator.evaluate(crafter, { now: 1000 }).find((candidate) => candidate.type === 'buy_craft_material');
    assert.strictEqual(goal?.plan?.marketTown, 'Dion', `the near offer wins by its landed price (${goal?.plan?.marketTown})`);
    AfkTrade._resetForTests();
}

console.log('Board trips: trip cost, karma towns, the shop town, buy-ad answers, the cheapest town, errands and landed material prices passed');

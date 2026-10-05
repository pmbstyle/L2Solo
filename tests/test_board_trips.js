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

console.log('Board trips: trip cost, karma towns and the shop town passed');

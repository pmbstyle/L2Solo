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

console.log('Board trips: trip cost and karma towns passed');

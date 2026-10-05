const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const { ColdTableChannel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');

// Group E: the counters of board purchases by sub-kind and grade (24 per
// world, +1 per deal) and each item's last deal prices; the same numbers in
// the cold worker through the 'market' table.
const HOUR = 60 * 60 * 1000;
assert.strictEqual(MarketCounters.COUNTER_KEYS.length, 24);
assert.strictEqual(MarketCounters.counterOf(123), 'gear d', 'Saber');
assert.strictEqual(MarketCounters.counterOf(1463), 'shot d', 'Soulshot: D-grade');
assert.strictEqual(MarketCounters.counterOf(1835), 'shot none');
assert.strictEqual(MarketCounters.counterOf(1804), 'recipe d', 'Recipe: Soulshot: D-Grade makes a D shot');
assert.strictEqual(MarketCounters.counterOf(1864), 'material none', 'Stem');
assert.strictEqual(MarketCounters.counterOf(1458), 'material d', 'Crystal: D-Grade');
// A part used only by products of one grade has that grade (the author's
// MarketTownPolicy rule, one classifier since E47); a shared one has none.
const part = invoke('GameServer/DataCache').items.find((item) => item.template?.name === 'Moonstone Earring Wire');
assert.strictEqual(MarketCounters.counterOf(part.selfId), 'material c', 'a C-grade earring part');
assert.strictEqual(MarketCounters.gradeOf(1463), 'd');

const channel = new ColdTableChannel();
const mirror = new TableMirror();
channel.attach('worker', 'e1', (payload) => { mirror.apply(payload.tables); return true; });
MarketCounters.reset();
MarketCounters.publish(channel);
const t0 = 1800000000000;
const stem = FirstPrice.cachedFirstPrice(1864, { timestamp: t0 });
assert(stem > 0, 'Stem has a first price');
// 30 deals of Stem in one hour at twice its first price, then 60 in two hours at three times.
for (let i = 0; i < 30; i++) MarketCounters.deal(1864, stem * 2, 5, t0 + i * 2 * 60 * 1000, 7, 'Dion');
for (let i = 0; i < 60; i++) MarketCounters.deal(1864, stem * 3, 5, t0 + HOUR + i * 2 * 60 * 1000, 0, i % 3 ? 'Giran' : 'Dion');
const end = t0 + 2 * HOUR + 58 * 60 * 1000;
const counter = MarketCounters.counter('material none', end);
assert.strictEqual(counter.deals, 90, '+1 per deal, whatever the quantity');
assert(counter.perHour > 20 && counter.perHour < 35, `about 30 buyers in the last hour (${counter.perHour})`);
assert(counter.index > Math.log(2) && counter.index < Math.log(3), 'the index follows the deals over the first price');
assert(counter.move > 0.05 && counter.move < Math.log(3), `the index moved by the hour (${counter.move})`);
assert(MarketCounters.counter('material none', end + 3 * HOUR).perHour < counter.perHour / 15, 'the rate fades without deals');
const stems = MarketCounters.itemDeals(1864);
assert.strictEqual(stems.deals, 90);
assert.strictEqual(stems.prices.length, 21, 'the last 21 prices');
assert.strictEqual(stems.prices[20], stem * 3);
assert.strictEqual(stems.units, 5, 'units a deal takes');
assert.deepStrictEqual([stems.sellers[0], stems.sellers.length], [0, 21], 'who sold at each kept price');
assert.strictEqual(MarketCounters.moveOf('gear s', end), counter.move, 'a counter with no move takes the measured ones');
// Its buyers per town (the shop town, б7): Giran took two of three deals of the last hour.
const byTown = new Map(MarketCounters.townDemand('material none', end).map((entry) => [entry.town, entry.perHour]));
assert.deepStrictEqual([...byTown.keys()].sort(), ['Dion', 'Giran']);
assert(Math.abs(byTown.get('Giran') + byTown.get('Dion') - counter.perHour) < 0.01, 'the towns share the counter\'s rate');
assert(byTown.get('Giran') > 1.6 * byTown.get('Dion'), `Giran ${byTown.get('Giran')} vs Dion ${byTown.get('Dion')}`);
assert.deepStrictEqual(MarketCounters.townDemand('gear s', end), []);

// The worker reads the same numbers from its table.
channel.flush();
const worker = { counter: MarketCounters.counter('material none', end), item: MarketCounters.itemDeals(1864),
    towns: MarketCounters.townDemand('material none', end) };
MarketCounters.useTable(() => mirror.rows('market'));
const mirrored = MarketCounters.counter('material none', end);
assert.strictEqual(mirrored.deals, worker.counter.deals);
assert(Math.abs(mirrored.perHour - worker.counter.perHour) < 0.01);
assert(Math.abs(mirrored.index - worker.counter.index) < 0.001);
assert.deepStrictEqual(MarketCounters.itemDeals(1864), worker.item);
const mirroredTowns = MarketCounters.townDemand('material none', end);
assert.deepStrictEqual(mirroredTowns.map((entry) => entry.town), worker.towns.map((entry) => entry.town));
mirroredTowns.forEach((entry, at) => assert(Math.abs(entry.perHour - worker.towns[at].perHour) < 0.01));
assert.deepStrictEqual(MarketCounters.itemDeals(1), { deals: 0, units: 1, prices: [], sellers: [] });

// The journal replayed at start gives the same counters.
MarketCounters.reset();
MarketCounters.load([{ selfId: 1864, unitPrice: 100, quantity: 1, occurredAt: t0, sellerCharacterId: 5, town: 'Gludio' },
    { selfId: 123, unitPrice: 9, quantity: 1, occurredAt: t0 + 1 }]);
assert.deepStrictEqual(MarketCounters.itemDeals(1864).sellers, [5]);
assert.strictEqual(MarketCounters.counter('material none', t0 + 1).deals, 1);
assert.strictEqual(MarketCounters.counter('gear d', t0 + 1).deals, 1);
assert.deepStrictEqual(MarketCounters.townDemand('material none', t0).map((entry) => entry.town), ['Gludio']);
console.log('Market counters: per sub-kind and grade, rates, index, move, prices and the worker table passed');

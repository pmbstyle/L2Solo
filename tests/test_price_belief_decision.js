const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const { BoardIndex, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');

// Group E (user, 2026-10-05): a belief per (bot, item) and one decision for
// asks and bids; traits only as parameters; memory that fades by events.
const HOUR = 60 * 60 * 1000;
const now = 1800000000000;
const STEM = 1864;
MarketCounters.reset();
for (let deal = 0; deal < 40; deal++) MarketCounters.deal(STEM, 1000, 10, now - (40 - deal) * 90000, 7);
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const ctx = (extra = {}) => ({ characterId: 1, understanding: 0.5, timestamp: now, board, ...extra });

// Prior: the item's deals dominate (weight 10 of ~11); read once with the
// bot's error, 3% for an analyst, 20% for a novice.
assert.strictEqual(PriceBelief.errorOf(1), 0.03);
assert.strictEqual(PriceBelief.errorOf(0), 0.2);
assert.strictEqual(PriceBelief.errorOf(0, 3), 0.1, 'halved every 3 own deals');
const prior = PriceBelief.prior(STEM, ctx());
assert(Math.abs(Math.exp(prior.mu - prior.bias) / 1000 - 1) < 0.35, 'centred near the deals');
assert(Math.abs(prior.bias) <= PriceBelief.errorOf(0.5) + 1e-12, 'one error read in');
const novices = [];
for (let id = 1; id <= 400; id++) novices.push(Math.abs(PriceBelief.prior(STEM, ctx({ characterId: id, understanding: 0 })).bias));
assert(Math.max(...novices) > 0.15 && Math.max(...novices) <= 0.2, 'a novice errs by up to 20%');

// Learning: sales say buyers pay at least the ask; passed buyers say less;
// new deals are prices; the rival's ask counts only when it changed.
const fresh = () => ({ selfId: STEM, mu: Math.log(1000), K: 10, c: 1, tick: 0, index: null, bias: 0.1, deals: 0,
    ask: 1000, rival: 0, seenItem: MarketCounters.itemDeals(STEM).deals, seenCounter: MarketCounters.counter('material none', now).deals });
let belief = fresh();
PriceBelief.learn(belief, [[Math.log(1000) + 0.5 * PriceBelief.sigma(belief), 3]]);
assert(Math.exp(belief.mu) > 1000, 'a sale raises the belief');
belief = fresh();
PriceBelief.learn(belief, [[Math.log(1000) - 0.5 * PriceBelief.sigma(belief), 3]]);
assert(Math.exp(belief.mu) < 1000, 'buyers that passed lower it');
assert(belief.K === 13 && !PriceBelief.learn(belief, []), 'weight grows; no evidence, no change');
belief = fresh();
MarketCounters.deal(STEM, 900, 10, now, 1);      // the bot's own sale (seller 1)
MarketCounters.deal(STEM, 800, 10, now, 2);      // another seller's deal
const book = { tick: 0, lookAt: 0, looks: 0, beliefs: new Map([[STEM, belief]]) };
board.put({ id: 1, ownerId: 9, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: STEM, count: 5, price: 950 }] });
const looked = PriceBelief.lookObservations(book, belief, ctx(), { ask: 1000, lines: 2 });
assert.strictEqual(looked.sales, 1, 'its own sale is found in the item\'s deals');
assert(looked.observations.some(([value, weight]) => value === Math.log(800) && weight === 1), 'another deal is a price');
assert(looked.observations.some(([value, weight]) => value === Math.log(950) && weight === 0.25), 'the rival by understanding x 0.5');
const again = PriceBelief.lookObservations(book, belief, ctx(), { ask: 1000, lines: 2 });
assert(!again.observations.some(([value]) => value === Math.log(950)), 'an unchanged rival is no new evidence');
assert.strictEqual(again.sales, 0);
PriceBelief.ownDeals(belief, 3);
assert(Math.abs(belief.bias - 0.05) < 1e-12 && belief.deals === 3, 'understanding of the item: the error halves every 3 deals');

// Memory: own touches of other items and the index drift fade a belief;
// read lazily, it is dropped at the public prior; 48 at most.
const memory = { tick: 0, lookAt: 0, looks: 0, beliefs: new Map() };
const kept = PriceBelief.ensure(memory, STEM, ctx());
assert(kept && kept.c === 1);
memory.tick += 60;
assert(PriceBelief.confidence(memory, kept, ctx()) < 1 && PriceBelief.lookup(memory, STEM, ctx()), 'faded, still held');
memory.tick += 2000;
assert.strictEqual(PriceBelief.lookup(memory, STEM, ctx()), null, 'dropped once it falls to the prior');
assert(!memory.beliefs.has(STEM));
const bounded = { tick: 0, lookAt: 0, looks: 0, beliefs: new Map() };
const materials = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872, 1873, 1874, 1875, 1876, 1877, 1878, 1879, 1880,
    1881, 1882, 1883, 1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893, 1894, 1895, 1896, 1897, 1898, 1899,
    1900, 1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909, 1910, 1911, 1912, 1913];
for (const selfId of materials) PriceBelief.ensure(bounded, selfId, ctx({ understanding: 1 }));
assert.strictEqual(bounded.beliefs.size, PriceBelief.BOUND, 'a safety bound of 48, the faintest goes');
const stored = PriceBelief.writeBook(bounded);
assert.deepStrictEqual(PriceBelief.readBook({ priceBeliefs: stored }).beliefs.size, PriceBelief.BOUND);
assert(JSON.stringify(stored).length / PriceBelief.BOUND < 90, `compact: ${JSON.stringify(stored).length / PriceBelief.BOUND} bytes a belief`);

// The ask. Value of money: a base rate plus the bot's need.
assert.strictEqual(PriceDecision.valueOfMoney(1000, 0), 0.07);
assert(Math.abs(PriceDecision.valueOfMoney(1000, 1e9) - 0.02) < 1e-6);
const market = (rival = null, buyersPerHour = 4) => ({ buyback: 50, buyersPerHour, lot: 1, units: 1,
    rivals: rival ? [{ landed: rival, units: 1 }] : [], npcLanded: Infinity, ownTrip: 0 });
const believed = { mu: Math.log(1000), K: 10 };
const needy = { wait: PriceDecision.valueOfMoney(50000, 1000), assertiveness: 0.5, caution: 0.5 };
const richBold = { wait: PriceDecision.valueOfMoney(50000, 1e8) * 0.5, assertiveness: 0.95, caution: 0.5 };
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
// Where buyers are few (one an hour) the wait costs: a needy seller undercuts.
const asks = (trader, rival) => Array.from({ length: 21 }, (_, at) => PriceDecision.chooseAsk(believed, market(rival, 1), trader, ['t', at]).price);
assert(median(asks(needy, 950)) < 950, 'a needy seller undercuts the rival');
assert(median(asks(richBold, 950)) >= 950, 'a rich assertive one does not');
assert(median(asks(richBold)) > median(asks(needy)), 'assertiveness and money: a higher ask');
// Loss aversion: a sale under the bot's own value weighs 1 + caution.
assert.strictEqual(PriceDecision.saleUtility(1200, 1000, 0.5), 1200);
assert.strictEqual(PriceDecision.saleUtility(800, 1000, 0.5), 700);
const timid = { ...needy, caution: 0 };
const careful = { ...needy, caution: 1 };
const lowBelief = { mu: Math.log(1000), K: 2 };
const slow = market(null, 0.05);
const timidAsk = median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseAsk(lowBelief, slow, timid, ['c', at]).price));
const carefulAsk = median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseAsk(lowBelief, slow, careful, ['c', at]).price));
assert(carefulAsk >= timidAsk, `a cautious seller does not sell under its value to sell sooner (${carefulAsk} vs ${timidAsk})`);
// The NPC buy-back is the outside option, the NPC shop one more offer.
assert.strictEqual(PriceDecision.chooseAsk(believed, market(null, 0), needy, ['n']).npc, true, 'no buyers: the NPC');
const npcShop = { ...market(null), npcLanded: 600 };
assert(PriceDecision.chooseAsk(believed, npcShop, needy, ['s']).price < PriceDecision.chooseAsk(believed, market(null), needy, ['s']).price,
    'the NPC shop draws buyers away from a dearer ask; it is not a clamp');
// One roll among asks within 2% of the best.
const rolled = new Set(Array.from({ length: 40 }, (_, at) => PriceDecision.chooseAsk(believed, market(), needy, ['r', at]).price));
assert(rolled.size >= 2 && rolled.size <= 4, `a few near-best asks (${[...rolled]})`);

// A standing ask stays while it is among the near-best; a far one is replaced.
const fresh1 = PriceDecision.chooseAsk(believed, market(), needy, ['r', 1]);
assert.strictEqual(PriceDecision.chooseAsk(believed, market(), needy, ['r', 2], fresh1.price).price, fresh1.price);
assert.notStrictEqual(PriceDecision.chooseAsk(believed, market(), needy, ['r', 2], 5000).price, 5000);

// Disposition and slots: one roll, never 0 or 1; slots by gain, no repeats.
const picks = { npc: 0, list: 0 };
for (let at = 0; at < 2000; at++) picks[PriceDecision.chooseByValue([{ action: 'npc', value: 10 }, { action: 'list', value: 100 }], ['d', at]).action] += 1;
assert(picks.npc > 0 && picks.npc < 100, `the far option keeps a small chance (${picks.npc} of 2000)`);
const slotsTaken = { big: 0, small: 0 };
for (let at = 0; at < 500; at++) {
    for (const chosen of PriceDecision.chooseSlots([{ id: 'big', gain: 90 }, { id: 'small', gain: 10 }, { id: 'none', gain: 0 }], 1, at)) slotsTaken[chosen.id] += 1;
}
assert(slotsTaken.big > 400 && slotsTaken.small > 20 && !slotsTaken.none, 'a weighted roll by gain; no gain, no slot');
assert.strictEqual(PriceDecision.chooseSlots([{ gain: 1 }, { gain: 2 }], 5, 'x').length, 2);

// The bid mirrors the ask: under the bot's value, never over its cap.
const bids = Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, market(), needy, { worth: 1000, cap: 2000 }, ['b', at]));
assert(bids.every((bid) => bid.price < 1000), 'a bid under what the item is worth');
assert.strictEqual(PriceDecision.chooseBid(believed, market(), needy, { worth: 1000, cap: 100 }, ['b']), null, 'nothing gains under the cap');
const patient = { ...needy, wait: 0.001 };
assert(median(Array.from({ length: 20 }, (_, at) => PriceDecision.chooseBid(believed, market(), patient, { worth: 1000, cap: 2000 }, ['p', at]).price))
    <= median(bids.map((bid) => bid.price)), 'a patient buyer bids lower');

// Attention: worth / (worth + cost) at each resolve.
const lines = [{ selfId: STEM, price: 1000, count: 100 }];
const trader = { characterId: 1, understanding: 0.5, timestamp: now, hour: 60000, adena: 100000 };
const resting = MarketPricing.lookChance({ activity: 'resting' }, lines, trader, now - HOUR);
const hunting = MarketPricing.lookChance({ activity: 'hunting' }, lines, trader, now - HOUR);
assert.strictEqual(resting, TendencyRoll.MAX, 'a bot that earns nothing now looks (never surely)');
assert(hunting < resting, 'a hunting bot looks less');
assert(MarketPricing.lookChance({ activity: 'hunting' }, lines, trader, now - 5 * 60000) < hunting, 'soon after its last look, less');
assert(MarketPricing.lookChance({ activity: 'hunting' }, [{ ...lines[0], count: 10000 }], trader, now - HOUR) > hunting,
    'a larger stake, more');
assert(MarketPricing.lookChance({ activity: 'hunting' }, lines, { ...trader, understanding: 0.9 }, now - HOUR) > hunting,
    'an analyst, more');

MarketCounters.reset();
console.log('Price beliefs and decisions: prior, learning, memory, asks, competition, loss aversion, bids, rolls, attention passed');

const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
// Public-price/decision pins use knowledge OFF, independently of learning pace.
const originalInvoke = global.invoke;
global.invoke = (name) => name === 'GameServer/Bot/Economy/PriceLearning'
    ? { knowledgeEnabled: () => true, errorOf: () => { throw new Error('public pins must not request personal error'); } }
    : originalInvoke(name);
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
global.invoke = originalInvoke;
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

// N79 keeps all public sources and the expected-value decision; personal
// item memory, fading and attention chance are deliberately removed.
const now = 1800000000000;
const STEM = 1864;
MarketCounters.reset();
for (let deal = 0; deal < 40; deal++) MarketCounters.deal(STEM, 1000, 10, now - (40 - deal) * 90000, 7);
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
const ctx = (extra = {}) => ({ characterId: 1, understanding: 0.5, timestamp: now, board,
    knowledgeEnabled: false, marketTrades: {}, ...extra });
const prior = PriceBelief.prior(STEM, ctx());
assert(Math.abs(Math.exp(prior.mu) / 1000 - 1) < 0.35, 'recent item deals still dominate public price');
assert.strictEqual(prior.bias, 0, 'knowledge OFF has no personal error');
board.put({ id: 1, ownerId: 9, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: STEM, count: 5, price: 950 }] });
board.put({ id: 2, ownerId: 8, storeType: BUY, town: 'Giran', lines: [{ lineId: 2, selfId: STEM, count: 5, price: 900 }] });
const withOffers = PriceBelief.prior(STEM, ctx());
assert.strictEqual(withOffers.K, prior.K + 2, 'best ask and best buy each retain weight one');
assert(Math.abs(withOffers.mu - (prior.mu * prior.K + Math.log(950) + Math.log(900)) / (prior.K + 2)) < 1e-12,
    'prior weights/sources unchanged');
const belief = { mu: Math.log(1000), K: 10 };
PriceBelief.learn(belief, [[Math.log(1000) - 0.5 * PriceBelief.sigma(belief), 3]]);
assert(Math.exp(belief.mu) < 1000 && belief.K === 13, 'passed buyers still add downward evidence weight');
assert(!PriceBelief.learn(belief, []), 'no evidence adds no weight');
assert.strictEqual(PriceBelief.readBook, undefined);
assert.strictEqual(PriceBelief.writeBook, undefined);
assert.strictEqual(PriceBelief.lookup, undefined);
assert.strictEqual(MarketPricing.lookChance, undefined);
assert.strictEqual(MarketPricing.learnDeal, undefined);

// The ask. Value of money: a base rate plus the bot's need.
assert.strictEqual(PriceDecision.waitRate({ hourAdena: 76797, moneyPrice: 0, gapHorizonHours: 0 }), 0);
assert(Math.abs(PriceDecision.waitRate({ hourAdena: 76797, moneyPrice: 3.235e-5, gapHorizonHours: 59.1 }) - .042) < .002);
const market = (rival = null, buyersPerHour = 4) => ({ buyback: 50, buyersPerHour, lot: 1, units: 1,
    rivals: rival ? [{ landed: rival, units: 1 }] : [], npcLanded: Infinity, ownTrip: 0 });
const believed = { mu: Math.log(1000), K: 10 };
const needy = { wait: PriceDecision.waitRate({ hourAdena: 123854, moneyPrice: 7.304e-5, gapHorizonHours: 21.9 }), assertiveness: 0.5, caution: 0.5 };
const richBold = { wait: 0, assertiveness: 0.95, caution: 0.5 };
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

// New listings always start at the board and keep only line cursors.
const marketContext = ctx({ trader: needy, adena: 100000, npcOffersFor: () => [], travel: () => 0, tripCost: null });
const firstChoice = MarketPricing.priceForSale(STEM, marketContext, { town: 'Giran', units: 1, rollKey: ['public', 1] });
assert(firstChoice && firstChoice.ask.price > 0);
const line = MarketPricing.lineState(STEM, marketContext, { price: firstChoice.ask.price });
assert.deepStrictEqual(Object.keys(line), ['price', 'seenCounter', 'seenAt', 'seenItem', 'rival', 'worth', 'seenFills']);
assert.strictEqual(line.rival, 950);
assert.strictEqual(line.worth, 0);
assert.strictEqual(line.seenFills, 0);
board.put({ id: 1, ownerId: 9, storeType: SELL, town: 'Giran', lines: [{ lineId: 1, selfId: STEM, count: 5, price: 1900 }] });
const nextChoice = MarketPricing.priceForSale(STEM, marketContext, { town: 'Giran', units: 1, rollKey: ['public', 2] });
assert(nextChoice.belief.mu > firstChoice.belief.mu, 'a new quote reads the changed board, no saved belief fallback');

MarketCounters.reset();
console.log('N79 public prior and unchanged decisions: sources, width, asks, competition, loss aversion, bids, caps, standing prices passed');

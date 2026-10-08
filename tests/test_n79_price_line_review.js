const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
// This fixture isolates board/line evidence from the shared learning curve.
const originalInvoke = global.invoke;
global.invoke = (name) => name === 'GameServer/Bot/Economy/PriceLearning'
    ? { knowledgeEnabled: () => true, errorOf: () => { throw new Error('knowledge disabled: no personal error requested'); } }
    : originalInvoke(name);
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
global.invoke = originalInvoke;
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

const ITEM = 999999;
const OTHER = 999998;
const now = 1800000000000;
const original = {
    itemDeals: MarketCounters.itemDeals, counter: MarketCounters.counter,
    counterOf: MarketCounters.counterOf, firstPrice: MarketCounters.firstPrice,
    chooseAsk: PriceDecision.chooseAsk, chooseBid: PriceDecision.chooseBid, roll: TendencyRoll.roll
};
let counterDeals = 100;
let counterPerHour = 4;
let otherCounterDeals = 500;
let seenBeliefs = [];
MarketCounters.counterOf = (selfId) => Number(selfId) === OTHER ? 'gear d' : 'material none';
MarketCounters.counter = (key) => ({ deals: key === 'gear d' ? otherCounterDeals : counterDeals,
    index: 0, perHour: counterPerHour });
// The recent tail contains no own fill: exact evidence must come from the line.
MarketCounters.itemDeals = () => ({ deals: counterDeals, prices: [], sellers: [], buyers: [] });
MarketCounters.firstPrice = () => 1000;
PriceDecision.chooseAsk = (belief, market, trader, rollKey, current) => {
    seenBeliefs.push({ ...belief });
    return { price: current || 1000, npc: false };
};
PriceDecision.chooseBid = (belief, market, trader, options, rollKey, current) => {
    seenBeliefs.push({ ...belief, worth: options.worth });
    return { price: current || 1000 };
};
TendencyRoll.roll = (key, ...parts) => {
    assert.notStrictEqual(key, 'look', 'counter events must replace the old attention roll');
    return original.roll(key, ...parts);
};
function fixture(side = SELL, rows = [{ fills: 0 }]) {
    seenBeliefs = [];
    counterDeals = 100;
    counterPerHour = 4;
    otherCounterDeals = 500;
    const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
    const lines = rows.map((row, index) => ({
        recordId: index + 1, lineId: index + 1, revision: 7, ownerId: 43,
        storeType: side, selfId: ITEM, count: 100, price: 1000, town: 'Giran', fills: row.fills || 0,
        pricing: { price: 1000, seenCounter: 100, seenItem: 100, rival: 0, worth: side === BUY ? 5000.375 : 0, seenFills: 0 },
        ...row
    }));
    for (const line of lines) board.put({ id: line.recordId, ownerId: 43, storeType: side, town: 'Giran',
        lines: [{ ...line, lineId: line.lineId }] });
    const ctx = { characterId: 43, understanding: 0.5, timestamp: now, hour: 60000, adena: 100000,
        knowledgeEnabled: false, marketTrades: {}, board, npcOffersFor: () => [], travel: () => 0, tripCost: null,
        trader: { wait: 0.03, assertiveness: 0.5, caution: 0.5, understanding: 0.5 } };
    const stats = {};
    Object.defineProperty(stats, 'priceBeliefs', { get: () => { throw new Error('removed personal price book was read'); } });
    return { lines, ctx, state: { characterId: 43, activity: 'hunting', stats } };
}
const failures = [];
function contract(name, check) {
    try { check(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
    contract('no counter event means no price evaluation or attention roll', () => {
        const { state, lines, ctx } = fixture();
        assert.strictEqual(MarketPricing.look(state, lines, ctx), null);
        assert.strictEqual(seenBeliefs.length, 0);
    });
    contract('unchanged price writes no cursor or line metadata', () => {
        const { state, lines, ctx } = fixture();
        counterDeals += 4;
        const reviewed = MarketPricing.look(state, lines, ctx);
        assert.strictEqual(reviewed, null);
        assert(seenBeliefs[0].mu < Math.log(1000), 'passed buyers lower this review centre');
        assert.strictEqual(lines[0].pricing.seenCounter, 100, 'choice never mutates the durable line');
    });
    contract('more than 21 own fills belong to their exact same-item line', () => {
        const { state, lines, ctx } = fixture(SELL, [{ fills: 41 }, { fills: 0 }]);
        counterDeals += 42;
        const reviewed = MarketPricing.look(state, lines, ctx);
        assert.strictEqual(reviewed, null);
        assert(seenBeliefs[0].mu > Math.log(1000), 'the filled line sees sales not below its price');
        assert(seenBeliefs[1].mu < Math.log(1000), 'the other own same-item line sees only passed buyers');
        assert(Math.abs(seenBeliefs[0].K - 42.8) < 1e-9, 'all 41 own fills and one other trade counted beyond the public tail');
        assert.deepStrictEqual(lines[0].pricing.seenFills, 0, 'evaluator never mutates caller line state');
    });
    contract('all other counter deals are passed evidence despite many open lines', () => {
        for (const side of [SELL, BUY]) {
            const { state, lines, ctx } = fixture(side, [{ fills: 1 }]);
            for (let index = 0; index < 9; index++) ctx.board.put({ id: 100 + index, ownerId: 100 + index,
                storeType: side, town: 'Giran', lines: [{ lineId: 100 + index, selfId: ITEM, count: 100, price: 1000 }] });
            assert.strictEqual(ctx.board.list(ITEM, side).length, 10, 'ten competing lines');
            counterDeals += 10;
            const reviewed = MarketPricing.look(state, lines, ctx);
            assert.strictEqual(reviewed, null);
            assert(Math.abs(seenBeliefs[0].K - 11.8) < 1e-9,
                `side ${side}: weight must include nine passed trades plus one own fill, got ${seenBeliefs[0].K}`);
            assert(side === BUY ? seenBeliefs[0].mu > Math.log(1000) : seenBeliefs[0].mu < Math.log(1000),
                'nine passed trades outweigh the opposite observation from one own fill');
        }
    });
    contract('other counter trades create no evidence for this line', () => {
        const { state, lines, ctx } = fixture();
        ctx.board.put({ id: 99, ownerId: 99, storeType: SELL, town: 'Giran',
            lines: [{ lineId: 99, selfId: OTHER, count: 100, price: 1000 }] });
        otherCounterDeals += 250;
        assert.strictEqual(MarketCounters.counter('gear d').deals, 750);
        assert.strictEqual(MarketPricing.look(state, lines, ctx), null);
        assert.strictEqual(seenBeliefs.length, 0);
        assert.strictEqual(lines[0].pricing.seenCounter, 100, 'own counter cursor unchanged');
    });
    contract('BUY mirrors line evidence and keeps authored buyer worth', () => {
        const { state, lines, ctx } = fixture(BUY, [{ fills: 4 }, { fills: 0 }]);
        counterDeals += 8;
        const reviewed = MarketPricing.look(state, lines, ctx);
        assert.strictEqual(reviewed, null);
        assert(seenBeliefs[0].mu < Math.log(1000), 'fills tell this buyer sellers accept no more than its bid');
        assert(seenBeliefs[1].mu > Math.log(1000), 'sellers passing the other buyer raise its estimate');
        assert(seenBeliefs.every((belief) => belief.worth === 5000.375));
        assert(lines.every(line => line.pricing.worth === 5000.375));
    });
    contract('unknown SELL forecast retains its standing quote despite passed buyers', () => {
        const stubAsk = PriceDecision.chooseAsk;
        PriceDecision.chooseAsk = original.chooseAsk;
        try {
            const { state, lines, ctx } = fixture(SELL, [{ count: 1 }]);
            const before = structuredClone(lines[0]);
            const fresh = MarketPricing.priceForSale(ITEM, ctx, { town: 'Giran', units: 1, rollKey: ['unknown'] });
            assert.strictEqual(fresh.market.known, false, 'kind deals do not supply finite demand/exposure');
            assert.strictEqual(fresh.ask.known, false);
            counterDeals += 20;
            assert.strictEqual(MarketPricing.look(state, lines, ctx), null);
            assert.deepStrictEqual(lines[0], before, 'unknown review cannot replace the accepted commitment');
        }
        finally { PriceDecision.chooseAsk = stubAsk; }
    });
    contract('declared finite demand evaluates passed buyers through the actual decision', () => {
        const stubAsk = PriceDecision.chooseAsk;
        PriceDecision.chooseAsk = original.chooseAsk;
        try {
            const { state, lines, ctx } = fixture(SELL, [{ count: 1 }]);
            // Pure conditional forecast contract, not a native item-arrival or
            // lifetime producer. The original owner, stock and quote stay fixed.
            ctx.demandFor = selfId => ({ known: true, origin: 'fixture_finite_demand',
                authority: { fixture: 'line_review' }, selfId, applicableUnits: 100,
                availability: { from: now, until: now }, delayHours: 0 });
            counterPerHour = 1;
            ctx.trader.wait = 0.105;
            ctx.board.put({ id: 99, ownerId: 44, storeType: SELL, town: 'Giran',
                lines: [{ lineId: 99, selfId: ITEM, count: 1, price: 1000 }] });
            const first = MarketPricing.priceForSale(ITEM, ctx, { town: 'Giran', units: 1, rollKey: ['initial'] });
            assert.strictEqual(first.ask.known, true, 'only the explicit conditional fixture supplies this forecast');
            lines[0].price = first.ask.price;
            lines[0].pricing = MarketPricing.lineState(ITEM, ctx, { price: first.ask.price });
            counterDeals += 20;
            const prior = PriceBelief.prior(ITEM, ctx);
            const observations = PriceBelief.lineObservations(lines[0], prior, ctx);
            assert(observations.every(row => row[0] < Math.log(first.ask.price)),
                'passed buyers are below the standing ask; the fresh public centre can still be lower');
            PriceBelief.learn(prior, observations);
            const expected = original.chooseAsk(prior, first.market, ctx.trader,
                ['ask', ctx.characterId, lines[0].lineId, ITEM, counterDeals, 0], first.ask.price);
            const reviewed = MarketPricing.look(state, lines, ctx);
            if (expected.npc) assert.strictEqual(reviewed.withdrawals.length, 1);
            else if (expected.price === first.ask.price) assert.strictEqual(reviewed, null);
            else assert.strictEqual(reviewed.reprices[0].price, expected.price,
                'review feeds the actual finite outcome grid and deterministic roll');
            assert.strictEqual(lines[0].price, first.ask.price, 'proposal never mutates the accepted quote');
        }
        finally { PriceDecision.chooseAsk = stubAsk; }
    });
    contract('passed sellers raise a standing bid through the actual decision', () => {
        const stubBid = PriceDecision.chooseBid;
        PriceDecision.chooseBid = original.chooseBid;
        try {
            const { state, lines, ctx } = fixture(BUY, [{ count: 1 }]);
            counterPerHour = 1;
            ctx.trader.wait = 0.105;
            const first = MarketPricing.bid(ITEM, ctx,
                { units: 1, worth: 5000.375, cap: 5000, rollKey: ['initial-bid'] });
            assert.strictEqual(first.pricing.worth, 5000.375, 'publication keeps exact authored worth');
            lines[0].price = first.price;
            lines[0].pricing = first.pricing;
            counterDeals += 20;
            const reviewed = MarketPricing.look(state, lines, ctx);
            assert.strictEqual(reviewed.reprices.length, 1, JSON.stringify({ first, reviewed }));
            assert(reviewed.reprices[0].price > first.price,
                `twenty passed sellers raise ${first.price} to ${reviewed.reprices[0].price}`);
            assert.strictEqual(reviewed.reprices[0].pricing.worth, 5000.375);
        }
        finally { PriceDecision.chooseBid = stubBid; }
    });
    contract('closed lines leave no retained state or evaluation', () => {
        const { state, lines, ctx } = fixture(SELL, [{ count: 0 }]);
        counterDeals += 20;
        assert.strictEqual(MarketPricing.look(state, lines, ctx), null);
        assert.strictEqual(seenBeliefs.length, 0);
        assert.strictEqual(PriceBelief.readBook, undefined, 'removed book API is not a compatibility fallback');
        assert.strictEqual(MarketPricing.learnDeal, undefined, 'actual trade owns experience, evaluator never learns postcommit');
    });
}
finally {
    for (const key of ['itemDeals', 'counter', 'counterOf', 'firstPrice']) MarketCounters[key] = original[key];
    PriceDecision.chooseAsk = original.chooseAsk;
    PriceDecision.chooseBid = original.chooseBid;
    TendencyRoll.roll = original.roll;
    PriceBelief.resetCaches();
}
if (failures.length) {
    console.error(`N79 line review contracts: ${failures.length} failed (${failures.join('; ')})`);
    process.exitCode = 1;
}
else console.log('N79 line review contracts passed');

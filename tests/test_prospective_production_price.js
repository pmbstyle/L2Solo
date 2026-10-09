'use strict';
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, BUY, offerFields } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1800000000000, id = 1864;
Counters.reset();
const board = new BoardIndex({ groupOf: Counters.counterOf });
board.put({ id: 71, revision: 3, custodyPolicy: 1, ownerId: 9, storeType: BUY, town: 'Giran',
    lines: [{ lineId: 72, selfId: id, count: 4, price: 1000 }] });
const line = board.records.get(71)[0];
const state = { characterId: 1, marketTrades: {}, stats: {} };
const persona = { understanding: 0.5, traits: { assertiveness: 0.7, caution: 0.5 } };
const options = { board, persona, timestamp };
const exit = { offer: line, conditional: true, count: line.count, price: line.price, town: line.town, repeatable: true };
const prior = Belief.prior(id, { board, characterId: 1, understanding: persona.understanding, marketTrades: {}, timestamp });
const trial = Price.prospectiveExit(state, exit, options);
assert(trial.prospective.known);
assert.strictEqual(trial.conditional, true);
assert.strictEqual(trial.trial, true);
assert.strictEqual(trial.repeatable, false, 'finite public interest is never recurring income');
assert.strictEqual(trial.prospective.applicableUnits, 4);
assert(trial.prospective.willingUnits > 0 && trial.prospective.willingUnits < 4, 'interest is not guaranteed receipts');
assert.strictEqual(trial.prospective.willingUnits, Price.willingUnitsAt(prior, Price.traderOf(persona), { price: 1000, applicableUnits: 4 }));
assert.deepStrictEqual(trial.prospective.authority, { recordId: 71, lineId: 72, revision: 3 });
assert.strictEqual(trial.prospective.observedAt, timestamp);
const Policy = invoke('GameServer/Bot/Economy/WealthCraftPolicy');
const recipe = { type: 'dwarven', productId: id, productCount: 1, successRate: 100, mpCost: 1, materials: [] };
const craftState = { ...state, adena: 1000, vitals: { mp: 10 } };
const context = { hourAdena: 100, moneyPrice: 0.01, mpPerHour: 100, existingOutput: 0 };
const basket = { cashCost: 0, ownedValue: 0, actualCashFees: 0, travelHours: 0,
    processingHours: 0, extraMp: 0, residualValue: 0, cost: 0, purchases: [], tripTowns: new Set() };
const evaluate = (exit, extra = {}) => Policy.drain(Policy.evaluatePrepared({ state: craftState,
    recipe, basket, exit, context, ...extra }));
assert(evaluate(trial).expectedSold > 0, 'a proven finite public bid can value one physical trial');
assert.strictEqual(evaluate(trial, { batches: 2 }), null, 'native recheck cannot enlarge the first trial');
assert.strictEqual(evaluate({ ...trial, offer: { ...line, revision: 2 } }), null,
    'an inconsistent authority cannot turn a conditional bid into receipts');
assert.strictEqual(evaluate({ ...trial, applicableUnits: NaN }), null, 'an unknown competitive tail stays unknown');
assert.strictEqual(evaluate(trial, { context: { ...context, existingOutput: 4 } }), null,
    'existing output occupies the finite market before another batch');
assert.strictEqual(Policy.chooseQuantity({ state: craftState, recipe, planFor: () => null,
    exits: [trial], context, mode: 'occupation' }), null, 'a finite trial never supplies recurring craft income');
assert.strictEqual(exit.trial, undefined, 'source metadata is not mutated');
assert(Price.prospectiveExit(state, { ...exit, offer: offerFields(line) }, options).prospective,
    'main native offerFields sourceId/expectedRevision identity is supported');

// The extracted model retains exactly the existing ask willingness, including
// the infinite NPC alternative's perception, instead of inventing a craft rate.
const belief = { mu: Math.log(1000), K: 10 }, trader = Price.traderOf(persona);
for (const price of [500, 1000, 2000]) for (const npcLanded of [Infinity, 600]) {
    const width = Belief.sigma(belief), centre = belief.mu + (trader.assertiveness - 0.5) * width;
    const wants = 1 - Price.phi((Math.log(price) - centre) / width);
    const chosen = Number.isFinite(npcLanded) ? 1 - Price.phi(Math.log((price + 10) / npcLanded) / Price.PERCEPTION) : 1;
    assert.strictEqual(Price.willingUnitsAt(belief, trader, { price, applicableUnits: 4, landed: price + 10, npcLanded }), 4 * wants * chosen);
}
const outcome = Price.saleOutcome({ units: 100, applicableUnits: trial.prospective.applicableUnits,
    willingUnits: trial.prospective.willingUnits, cheaperUnits: 1, price: 1000, residualUnitValue: trial.residualUnitValue,
    delayHours: 0, discountRate: 0 });
assert(outcome.sold <= 4 && outcome.residual >= 96, 'finite interest and competition keep unfilled physical output');
assert.strictEqual(Price.prospectiveExit({ ...state, characterId: 9 }, exit, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, exit, { board, timestamp }).prospective, undefined,
    'missing native persona remains unsupported instead of crashing the worker');
assert.strictEqual(Price.prospectiveExit(state, null, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, count: 5 }, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, offer: { ...line, revision: 2 } }, options).prospective, undefined);
assert.strictEqual(Price.prospectiveExit(state, { ...exit, offer: { ...line, enchant: 1 } }, options).prospective, undefined);
board.remove(71);
assert.strictEqual(Price.prospectiveExit(state, trial, options).prospective, undefined, 'withdrawal clears a saved prospective snapshot');
// No public prices yields no native belief and cannot bootstrap a trial.
assert.strictEqual(Belief.prior(999999, { board, characterId: 1, understanding: 0.5, timestamp }), null);
assert.strictEqual(Price.prospectiveExit(state, { conditional: true, count: 1, price: 1,
    offer: { recordId: 71, lineId: 72, ownerId: 9, selfId: 999999, count: 1, price: 1 } }, options).prospective, undefined);
console.log('prospective production pricing tests passed');

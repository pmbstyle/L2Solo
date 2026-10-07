'use strict';
const assert = require('node:assert/strict');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const state = { characterId: 7, updatedAt: 100, level: 30, phase: 'cold', activity: 'hunting',
    stats: { clanId: 9, equipmentPlan: { target: { selfId: 391 } } } };
const economy = { horizonHours: 40, hunt: { perHour: 60000 }, itemUsefulness: id => id === 391 ? 6 : 0,
    network: { activity: { activity: 'hunting', npcId: 20101, spotId: 'ground' } } };
const decision = Decision.capture(economy, state);
assert.deepEqual(decision.clan, { horizonHours: 40, huntPerHour: 60000, plan: { itemId: 391, valueHours: 6 } });
const without = Decision.capture(economy, { ...state, stats: { ...state.stats, clanId: 0 } });
assert.equal(decision.data.byteLength - without.data.byteLength, 32, 'four exact doubles, no retained object headers');
const transport = Decision.compact(structuredClone(decision));
assert.deepEqual(transport.clan, decision.clan); assert.deepEqual(transport.activity, decision.activity);
const decisions = new Decision.ColdEconomyDecisions();
decisions.accept(7, transport); assert.deepEqual(decisions.clanNumbers(7), { ...decision.clan, updatedAt: decision.updatedAt });
assert.equal(decisions.decided({ ...state, updatedAt: 200 }), null);
assert.deepEqual(decisions.clanNumbers(7), { ...decision.clan, updatedAt: decision.updatedAt }, 'miss keeps slow clan numbers');
decisions.accept(7, transport, { settled: [{}] }); assert.equal(decisions.decided(state), null);
assert.deepEqual(decisions.clanNumbers(7), { ...decision.clan, updatedAt: decision.updatedAt }, 'merged purchases keep stale clan numbers');
decisions.forget(7); assert.equal(decisions.clanNumbers(7), null);
assert.equal(Decision.capture(economy, { ...state, stats: { clanId: 9 } }).clan.plan, null);
console.log('test_cold_clan_numbers: ok');

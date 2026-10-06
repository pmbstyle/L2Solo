// L25: main reads a cold bot's activity decided by the worker on exactly the
// committed state, and builds the wish network itself only when there is no
// such decision (a restart, or main changed the state since).
const assert = require('node:assert/strict');
const { capture, ColdEconomyDecisions } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const economy = { network: { activity: { activity: 'hunting', spotId: '22_18', npcId: 20120, rootKey: 'power', price: 5 } } };
const decision = capture(economy, { characterId: 7, updatedAt: 1000 });
assert.deepEqual(decision, { updatedAt: 1000, riskWeight: 0, activity: { activity: 'hunting', spotId: '22_18', npcId: 20120 } },
    'only what main reads travels: activity, spot, mob');
assert.deepEqual(capture({ network: {} }, { updatedAt: 5 }), { updatedAt: 5, riskWeight: 0, activity: null });

const decisions = new ColdEconomyDecisions();
let builds = 0;
const build = () => { builds += 1; return { network: { activity: { activity: 'resting' } } }; };

decisions.accept(7, decision);
assert.deepEqual(decisions.activity({ characterId: 7, updatedAt: 1000 }, build),
    { activity: 'hunting', spotId: '22_18', npcId: 20120 });
assert.equal(builds, 0, 'the decided state builds no network on main');

assert.deepEqual(decisions.activity({ characterId: 7, updatedAt: 1001 }, build), { activity: 'resting' });
assert.equal(builds, 1, 'a state changed after the decision builds the network');
assert.equal(decisions.byId.has(7), false, 'an outdated decision is dropped');

decisions.accept(10, decision, { settled: [{ itemId: 57 }] });
assert.equal(decisions.byId.has(10), false, 'board deals merged at commit: the decision saw the old bag');
decisions.accept(11, decision, { pkDrops: [{ selfId: 1 }] });
assert.equal(decisions.byId.has(11), false, 'PK drops merged at commit: the decision saw the old bag');
decisions.accept(12, decision, { pkDrops: [] });
assert.equal(decisions.byId.has(12), true);

decisions.accept(8, decision);
decisions.accept(8, undefined);
assert.equal(decisions.byId.has(8), false, 'a commit without a decision clears the old one');
decisions.activity({ characterId: 9, updatedAt: 1 }, build);
assert.equal(builds, 2, 'no decision yet (after a restart) builds the network');
assert.equal(decisions.hits, 1);
assert.equal(decisions.misses, 2);
console.log('test_cold_economy_decision: ok');

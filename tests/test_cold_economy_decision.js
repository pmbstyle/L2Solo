// L25: main reads a cold bot's activity decided by the worker on exactly the
// committed state, and builds the wish network itself only when there is no
// such decision (a restart, or main changed the state since).
const assert = require('node:assert/strict');
const { capture, stateKey, ColdEconomyDecisions } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const economy = { network: { activity: { activity: 'hunting', spotId: '22_18', npcId: 20120, rootKey: 'power', price: 5 } } };
const decision = capture(economy, { characterId: 7, updatedAt: 1000 });
assert.deepEqual(decision, { updatedAt: 1000, key: stateKey({ characterId: 7, updatedAt: 1000 }), riskWeight: 0, activity: { activity: 'hunting', spotId: '22_18', npcId: 20120 } },
    'only what main reads travels: activity, spot, mob');
assert.deepEqual(capture({ network: {} }, { updatedAt: 5 }), { updatedAt: 5, key: stateKey({}), riskWeight: 0, activity: null });

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
// A commit or a projection can change these keeping updatedAt: not used then.
const base = { characterId: 20, updatedAt: 70, level: 30, activity: 'hunting', stats: { classId: 1, clanId: 5, equipmentPlan: { status: 'active', target: { selfId: 9 } } } };
for (const [label, changed] of [
    ['clan left', { ...base, stats: { ...base.stats, clanId: 0 } }],
    ['class changed', { ...base, stats: { ...base.stats, classId: 2 } }],
    ['activity repaired', { ...base, activity: 'resting' }],
    ['goal dropped', { ...base, stats: { ...base.stats, equipmentPlan: null } }],
    ['workshop crafter', { ...base, stats: { ...base.stats, workshop: { entries: [{}] } } }]]) {
    decisions.accept(20, capture(economy, base));
    assert.equal(decisions.decided(changed), null, label);
}
decisions.accept(20, capture(economy, base));
assert.notEqual(decisions.decided(base), null, 'the same state is decided');
decisions.accept(21, capture(economy, base, { ...base, stats: { ...base.stats, classId: 2 } }));
assert.equal(decisions.decided({ ...base, characterId: 21 }), null, 'built before a class change in the projection');
console.log('test_cold_economy_decision: ok');

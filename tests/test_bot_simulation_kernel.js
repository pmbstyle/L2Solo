const assert = require('assert');

require('../src/Global');

const Kernel = invoke('GameServer/Bot/Simulation/SimulationKernel');

Kernel.reset();
Kernel.init({ test: true });

const observed = [];
Kernel.register({
    id: 'base',
    register(registry) {
        registry.eventHandler('goal_updated', (event) => observed.push(event.payload.reason));
        registry.statusProvider(() => ({ ready: true }));
    }
});
Kernel.register({ id: 'dependent', requires: ['base'] });
Kernel.start();

const accepted = Kernel.propose({
    source: 'base',
    kind: 'goal',
    action: 'review',
    subjectId: 42,
    priority: 200,
    snapshotRevision: 7
}, { characterId: 42, phase: 'cold', revision: 7 });
assert.strictEqual(accepted.accepted, true);
assert.strictEqual(accepted.proposal.priority, 100);

const stale = Kernel.propose({
    source: 'base',
    kind: 'goal',
    action: 'review',
    subjectId: 42,
    snapshotRevision: 6
}, { characterId: 42, phase: 'cold', revision: 7 });
assert.strictEqual(stale.accepted, false);
assert.strictEqual(stale.reason, 'stale_snapshot');

Kernel.emit({ type: 'goal_updated', source: 'base', subjectId: 42, payload: { reason: 'upgrade' } });
assert.strictEqual(Kernel.dispatchEvents(5).length, 1);
assert.deepStrictEqual(observed, ['upgrade']);

const snapshot = Kernel.snapshot();
assert.strictEqual(snapshot.modules.length, 2);
assert.deepStrictEqual(snapshot.moduleStatus.base, { ready: true });
assert.strictEqual(snapshot.metrics.proposalsAccepted, 1);
assert.strictEqual(snapshot.metrics.proposalsRejected, 1);

Kernel.reset();
console.log('Bot simulation kernel checks passed');

const assert = require('assert');
require('../src/Global');

const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

const originalNow = Date.now;
const session = { actor: { fetchId: () => 901, fetchName: () => 'PolicyBot' } };

try {
    HotBotPolicyOverlay.clear(session, 'test_reset');
    Date.now = () => 100000;
    const created = HotBotPolicyOverlay.set(session, {
        combatStance: 'aggressive',
        skillPriorities: { 10: 80, 11: -70 },
        ttlMs: 5000
    }, { ownerId: 77, ownerName: 'Leader', reason: 'test' });

    assert.strictEqual(created.combatStance, 'aggressive');
    assert.deepStrictEqual(created.skillPriorities, { 10: 50, 11: -50 }, 'skill weights must be bounded');
    assert.strictEqual(created.ownerId, 77);
    assert.strictEqual(created.expiresAt, 105000);

    Date.now = () => 104999;
    assert(HotBotPolicyOverlay.get(session), 'overlay should remain active before expiry');
    Date.now = () => 105001;
    assert.strictEqual(HotBotPolicyOverlay.get(session), null, 'expired overlay must be removed');

    HotBotPolicyOverlay.set(session, { combatStance: 'defensive' }, { ownerId: 77 });
    assert(HotBotPolicyOverlay.clearForDeath(session));
    assert.strictEqual(HotBotPolicyOverlay.status(session), null, 'death must clear hot policy');
    console.log('Hot bot policy overlay checks passed');
} finally {
    Date.now = originalNow;
}

const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');

function botAt(loc) {
    return {
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchPrivateStore: () => false
    };
}

const huntingSpot = { locX: 45000, locY: 45000, locZ: -3000 };
const huntingSession = {
    plan: 'hunting',
    initialSpawnCoord: huntingSpot,
    currentSpot: { id: 'hunting_spot' }
};

assert.deepStrictEqual(
    BotAI.getDeathRespawnTarget(huntingSession, botAt(huntingSpot), false),
    { locX: 45475, locY: 48359, locZ: -3060 },
    'solo hunting death should restart at the nearest town instead of the active hunting spot'
);

const merchantSession = {
    plan: 'merchant',
    initialSpawnCoord: { locX: 83396, locY: 147904, locZ: -3404 }
};

assert.deepStrictEqual(
    BotAI.getDeathRespawnTarget(merchantSession, botAt({ locX: 90000, locY: 148000, locZ: -3400 }), false),
    merchantSession.initialSpawnCoord,
    'merchant death should preserve the fixed store respawn location'
);

const deadSession = {
    currentTargetId: 1001,
    targetTrackId: 1001,
    targetAcquiredAt: Date.now(),
    targetLastDistance: 80,
    targetStallTicks: 3,
    incomingThreatId: 1002,
    incomingThreatAt: Date.now(),
    roleDecision: { action: 'defend_self' },
    lastDecision: { action: 'abandon_target' },
    lastTargetEvaluation: { targetId: 1001, score: 500 },
    lastCombatDecision: { action: 'basic_attack' },
    lastPvpDecision: { action: 'fight' }
};
BotAI.clearTacticalState(deadSession);
assert.strictEqual(deadSession.currentTargetId, undefined, 'death should release the active target immediately');
assert.strictEqual(deadSession.incomingThreatId, undefined, 'death should clear incoming threat state');
assert.strictEqual(deadSession.roleDecision, undefined, 'death should clear stale role decisions');
assert.strictEqual(deadSession.lastDecision, undefined, 'death should clear stale hunting decisions');
assert.strictEqual(deadSession.lastTargetEvaluation, undefined, 'death should clear stale target scoring');
assert.strictEqual(deadSession.lastCombatDecision, undefined, 'death should clear stale combat choices');
assert.strictEqual(deadSession.lastPvpDecision, undefined, 'death should clear stale PvP choices');

console.log('Bot death respawn checks passed');

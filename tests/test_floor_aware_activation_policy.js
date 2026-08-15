const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

function state(characterId, loc) {
    return { characterId, name: `FloorBot${characterId}`, loc };
}

function geodata({ visible = true, loaded = true } = {}) {
    return {
        hasGeo: () => loaded,
        hasLineOfSight: () => visible
    };
}

Policy.resetCache();

const playerLoc = { locX: 23874, locY: 110337, locZ: -12096 };
const otherCrumaFloor = state(1, { locX: 23882, locY: 110310, locZ: -9056 });
const floorDecision = Policy.evaluateCandidate(otherCrumaFloor, {
    playerLoc,
    reason: 'near_player',
    geodata: geodata({ visible: false }),
    cache: new Map(),
    geoCheckLimit: 4
}, {});
assert.strictEqual(floorDecision.accepted, false, 'a Cruma-like overlapping floor must not ambient-activate');
assert.strictEqual(floorDecision.reason, 'blocked_or_floor');

const sameHeight = Policy.evaluateCandidate(state(2, {
    locX: playerLoc.locX + 700,
    locY: playerLoc.locY,
    locZ: playerLoc.locZ + 600
}), {
    playerLoc,
    reason: 'near_player',
    geodata: geodata({ visible: false })
}, {});
assert.strictEqual(sameHeight.accepted, true, 'ordinary height variation must bypass geodata work');
assert.strictEqual(sameHeight.reason, 'near_height');

const visibleSlope = Policy.evaluateCandidate(state(3, {
    locX: playerLoc.locX + 6000,
    locY: playerLoc.locY,
    locZ: playerLoc.locZ + 2400
}), {
    playerLoc,
    reason: 'near_player',
    geodata: geodata({ visible: true }),
    cache: new Map(),
    geoCheckLimit: 4
}, {});
assert.strictEqual(visibleSlope.accepted, true, 'a geodata-visible slope must remain eligible despite its absolute Z delta');
assert.strictEqual(visibleSlope.reason, 'visible_slope');

for (const context of [
    { reason: 'remote_invite', companion: true },
    { reason: 'combat_activation', combat: true }
]) {
    const exception = Policy.evaluateCandidate(otherCrumaFloor, {
        ...context,
        playerLoc,
        geodata: geodata({ visible: false })
    }, {});
    assert.strictEqual(exception.accepted, true, 'companion and combat activation must bypass ambient floor policy');
    assert.strictEqual(exception.reason, 'gameplay_exception');
}

const missingGeo = Policy.evaluateCandidate(otherCrumaFloor, {
    playerLoc,
    reason: 'near_player',
    geodata: geodata({ loaded: false, visible: false })
}, {});
assert.strictEqual(missingGeo.accepted, true, 'missing geodata must preserve the deterministic permissive fixture fallback');
assert.strictEqual(missingGeo.reason, 'missing_geodata');

let losCalls = 0;
const cachedGeo = {
    hasGeo: () => true,
    hasLineOfSight: () => {
        losCalls++;
        return false;
    }
};
const cache = new Map();
const scan = {};
const cacheContext = {
    playerLoc,
    reason: 'near_player',
    geodata: cachedGeo,
    cache,
    cacheMs: 30000,
    geoCheckLimit: 1,
    now: 1000
};
Policy.evaluateCandidate(otherCrumaFloor, cacheContext, scan);
const cachedDecision = Policy.evaluateCandidate(otherCrumaFloor, cacheContext, scan);
assert.strictEqual(losCalls, 1, 'repeated floor checks must reuse the bounded cell cache');
assert.strictEqual(cachedDecision.cached, true);

const budgeted = Policy.filterCandidates([
    otherCrumaFloor,
    state(4, { locX: 24000, locY: 110500, locZ: -8500 })
], {
    playerLoc,
    reason: 'near_player',
    geodata: geodata({ visible: false }),
    cache: new Map(),
    geoCheckLimit: 1
});
assert.strictEqual(budgeted.scan.geoChecks, 1, 'one scan must never exceed its geodata check budget');
assert.strictEqual(budgeted.scan.budgetDeferred, 1, 'unchecked suspicious candidates must defer rather than materialize blindly');
const telemetry = Metrics.snapshot();
assert.strictEqual(telemetry.delta.activationFloorCandidates, 2);
assert.strictEqual(telemetry.delta.activationFloorAccepted, 0);
assert.strictEqual(telemetry.delta.activationFloorRejected, 2);
assert.strictEqual(telemetry.activationFloor.reasons.blocked_or_floor, 1);
assert.strictEqual(telemetry.activationFloor.reasons.geodata_budget, 1);

console.log('Floor-aware activation policy checks passed');

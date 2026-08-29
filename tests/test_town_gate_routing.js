const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownGateCatalog = invoke('GameServer/Bot/AI/TownGateCatalog');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');

GeodataEngine.init();

function routeUntilTarget(from, to, maxSteps = 10) {
    const steps = [];
    let current = { ...from };
    for (let index = 0; index < maxSteps; index++) {
        const next = TownPathfinder.route(null, current, to);
        steps.push(next);
        if (next.locX === to.locX && next.locY === to.locY && next.locZ === to.locZ) return steps;
        current = { ...next };
    }
    return steps;
}

let checkedGates = 0;
for (const town of TownPathfinder.towns) {
    const gates = TownGateCatalog.gatesFor(town.name);
    assert(gates.length > 0, `${town.name} should have measured physical gates`);

    for (const gate of gates) {
        const outward = GeodataEngine.findPath(
            gate.inside.locX, gate.inside.locY, gate.inside.locZ,
            gate.outside.locX, gate.outside.locY, gate.outside.locZ,
            12000,
            { debug: false, goalRadius: 32, goalZTolerance: 64 }
        );
        const inward = GeodataEngine.findPath(
            gate.outside.locX, gate.outside.locY, gate.outside.locZ,
            gate.inside.locX, gate.inside.locY, gate.inside.locZ,
            12000,
            { debug: false, goalRadius: 32, goalZTolerance: 64 }
        );
        assert(outward?.length > 1, `${town.name}/${gate.id} should be walkable outward`);
        assert(inward?.length > 1, `${town.name}/${gate.id} should be walkable inward`);

        const dx = gate.outside.locX - gate.inside.locX;
        const dy = gate.outside.locY - gate.inside.locY;
        const length = Math.hypot(dx, dy) || 1;
        const fieldBeyondGate = {
            locX: Math.round(gate.outside.locX + (dx / length) * 2200),
            locY: Math.round(gate.outside.locY + (dy / length) * 2200),
            locZ: gate.outside.locZ
        };
        assert.deepStrictEqual(
            TownPathfinder.route(null, gate.inside, fieldBeyondGate),
            gate.passage,
            `${town.name}/${gate.id} should cross its passage after reaching the inside staging point`
        );
        assert.deepStrictEqual(
            TownPathfinder.route(null, gate.outside, town.center),
            gate.passage,
            `${town.name}/${gate.id} should cross the same passage when entering town`
        );
        checkedGates++;
    }

    const probe = gates[0];
    const dx = probe.outside.locX - probe.inside.locX;
    const dy = probe.outside.locY - probe.inside.locY;
    const length = Math.hypot(dx, dy) || 1;
    const field = {
        locX: Math.round(probe.outside.locX + (dx / length) * 2200),
        locY: Math.round(probe.outside.locY + (dy / length) * 2200),
        locZ: probe.outside.locZ
    };
    const outwardSteps = routeUntilTarget(town.center, field);
    assert.deepStrictEqual(
        outwardSteps[outwardSteps.length - 1],
        field,
        `${town.name} should finish an outward route without bouncing at its gate`
    );
    const inwardSteps = routeUntilTarget(field, town.center);
    assert.deepStrictEqual(
        inwardSteps[inwardSteps.length - 1],
        town.center,
        `${town.name} should finish an inward route without bouncing at its gate`
    );
}

const giran = TownPathfinder.towns.find((town) => town.name === 'Giran');
const westernField = { locX: 70000, locY: 148700, locZ: -3600 };
const westernGate = TownGateCatalog.bestExit('Giran', giran.center, westernField);
assert.strictEqual(westernGate.id, 'west', 'Giran should choose its west gate for a western destination');
assert.deepStrictEqual(
    TownPathfinder.route(null, giran.center, westernField),
    westernGate.inside,
    'the first town-exit waypoint should be the measured inside staging point'
);
const westRoute = TownPathfinder.routeWithSession({}, null, giran.center, westernField);
assert.strictEqual(
    westRoute.arrivalRadius,
    TownPathfinder.GATE_WAYPOINT_ARRIVAL_RADIUS,
    'physical gate waypoints must use a tight radius so movement reaches the next gate phase'
);
assert.deepStrictEqual(
    TownPathfinder.route(null, westernGate.inside, westernField),
    westernGate.passage,
    'the second town-exit waypoint should cross the measured gate passage'
);
assert.deepStrictEqual(
    TownPathfinder.route(null, westernGate.passage, westernField),
    westernField,
    'after crossing the gate passage the route may continue directly into the field'
);

const inwardTarget = { locX: 83396, locY: 147904, locZ: -3404 };
assert.deepStrictEqual(
    TownPathfinder.route(null, westernField, inwardTarget),
    westernGate.outside,
    'entering Giran should first approach the outside of a measured gate'
);
assert.deepStrictEqual(
    TownPathfinder.route(null, westernGate.outside, inwardTarget),
    westernGate.passage,
    'entering Giran should cross the same passage in reverse'
);
assert.deepStrictEqual(
    TownPathfinder.route(null, westernGate.passage, inwardTarget),
    westernGate.inside,
    'after crossing inward the route should clear the wall on the city side'
);

console.log(`Town physical gate routing checks passed (${checkedGates} gates)`);

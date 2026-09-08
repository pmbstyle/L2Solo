const assert = require('assert');
require('../src/Global');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

const original = {
    random: Math.random, findCurrentSpot: Spots.findCurrentSpot,
    getCellData: Geo.getCellData, getHeight: Geo.getHeight,
    hasGeo: Geo.hasGeo, hasLineOfSight: Geo.hasLineOfSight
};
const anchor = { locX: 83396, locY: 147904, locZ: -3404 };
const roof = { locX: 82840, locY: 147257, locZ: -3032 };
function samplePoint(from, to) {
    const angle = (Math.atan2(to.locY - from.locY, to.locX - from.locX) + Math.PI * 2) % (Math.PI * 2);
    const radius = Math.hypot(to.locX - from.locX, to.locY - from.locY);
    let count = 0;
    Math.random = () => count++ % 2 === 0 ? angle / (Math.PI * 2) : radius / Config.activationPlacementRadius;
}

try {
    Spots.findCurrentSpot = () => null;
    invoke('GameServer/Geodata/VirtualObstacles/index').init();
    // Real Giran geodata and the exact coordinates from EloraMoss's activation.
    assert.strictEqual(Geo.getHeight(roof.locX, roof.locY, anchor.locZ), roof.locZ);
    assert.strictEqual(Geo.hasLineOfSight(anchor.locX, anchor.locY, anchor.locZ,
        roof.locX, roof.locY, roof.locZ), false);
    samplePoint(anchor, roof);
    const result = Placement.resolve({ loc: anchor });
    assert.deepStrictEqual(result.loc, { ...anchor, locZ: -3400 },
        'roof samples must be rejected and fall back to the verified original street');
    const nearPlayer = { ...anchor, locX: anchor.locX + 50 };
    assert.strictEqual(Placement.resolve({ loc: anchor }, { playerLoc: nearPlayer }), null,
        'exhaustion must not push the bot into an unchecked point to satisfy player distance');

    // Deterministic sample coverage on real geometry, without starting a server.
    let seed = 12345;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 100; i++) {
        const selected = Placement.resolve({ loc: anchor });
        assert(selected);
        const p = selected.loc;
        assert(Geo.hasLineOfSight(anchor.locX, anchor.locY, anchor.locZ, p.locX, p.locY, p.locZ));
        assert(Geo.getCellData(p.locX, p.locY, p.locZ).nswe);
    }

    const flat = { locX: 0, locY: 0, locZ: 0 };
    Geo.hasGeo = () => true;
    Geo.getHeight = () => 0;
    Geo.getCellData = () => ({ z: 0, nswe: 15 });
    Geo.hasLineOfSight = () => true;
    samplePoint(flat, { locX: 100, locY: 0 });
    assert.strictEqual(Placement.resolve({ loc: flat }).loc.locX, 100);
    Geo.getCellData = (x) => ({ z: 0, nswe: x >= 96 ? 0 : 15 });
    assert.deepStrictEqual(Placement.resolve({ loc: flat }).loc, flat,
        'a wall cell must be rejected even if a height exists');
    Geo.getCellData = (x) => ({ z: 0, nswe: x === 116 ? 0 : 15 });
    assert.deepStrictEqual(Placement.resolve({ loc: flat }).loc, flat,
        'the actor must have clearance from an adjacent wall');
    Geo.getCellData = () => ({ z: 0, nswe: 15 });
    Geo.hasLineOfSight = (x, y, z, toX) => Math.abs(toX - x) <= 16;
    assert.deepStrictEqual(Placement.resolve({ loc: flat }).loc, flat,
        'a clear endpoint behind a wall must still be rejected');
    Geo.hasLineOfSight = () => true;
    Geo.getCellData = (x) => ({ z: x, nswe: 15 });
    Geo.getHeight = (x) => x;
    assert.strictEqual(Placement.resolve({ loc: flat }).loc.locZ, 100,
        'a connected slope must remain usable despite a large total elevation gain');
    Geo.getCellData = () => ({ z: 0, nswe: 15 });
    Geo.getHeight = () => 0;
    Geo.hasGeo = () => false;
    assert.strictEqual(Placement.resolve({ loc: flat }), null, 'missing geodata must defer activation');
    Geo.hasGeo = () => true;
    Geo.getCellData = () => ({ z: 400, nswe: 15 });
    assert.strictEqual(Placement.resolve({ loc: flat }), null, 'an anchor must not snap onto a roof');
    Geo.getCellData = () => ({ z: 0, nswe: 0 });
    assert.strictEqual(Placement.resolve({ loc: flat }, { keepStoreLocation: true }), null,
        'fixed stores must not bypass collision validation');
    assert.strictEqual(Placement.resolve({ loc: { ...flat, locZ: null } }), null);
    assert.strictEqual(Placement.resolve({}), null);
    console.log('Bot activation placement tests passed');
} finally {
    Math.random = original.random;
    Spots.findCurrentSpot = original.findCurrentSpot;
    for (const key of ['getCellData', 'getHeight', 'hasGeo', 'hasLineOfSight']) Geo[key] = original[key];
}

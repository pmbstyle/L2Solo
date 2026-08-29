require('../src/Global');
const assert = require('assert');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const VirtualObstacles = invoke('GameServer/Geodata/VirtualObstacles/index');
GeodataEngine.init();

const talkingIslandRegion = '17_25';
const obeliskCenter = { locX: -84214, locY: 243003, locZ: -3730 };
const townShop = { locX: -84108, locY: 244604, locZ: -3729 };
const trappedCompanion = { locX: -84407, locY: 244651, locZ: -3730 };
const formerTempleBand = { locX: -84147, locY: 243414, locZ: -3730 };

assert(
    VirtualObstacles.checkObstacle(obeliskCenter.locX, obeliskCenter.locY, talkingIslandRegion),
    'the measured Talking Island obelisk interior should remain solid'
);
assert.strictEqual(
    VirtualObstacles.checkObstacle(townShop.locX, townShop.locY, talkingIslandRegion),
    false,
    'the Talking Island spawn and general shop must not be inside the obelisk'
);
assert.strictEqual(
    VirtualObstacles.checkObstacle(trappedCompanion.locX, trappedCompanion.locY, talkingIslandRegion),
    false,
    'the former false-positive companion position must remain walkable'
);
assert.strictEqual(
    VirtualObstacles.checkObstacle(formerTempleBand.locX, formerTempleBand.locY, talkingIslandRegion),
    false,
    'the removed Talking Island temple band must not trap companions'
);

const shopPath = GeodataEngine.findPath(
    trappedCompanion.locX, trappedCompanion.locY, trappedCompanion.locZ,
    townShop.locX, townShop.locY, townShop.locZ
);
assert(shopPath && shopPath.length > 1, 'a companion should be able to walk to the Talking Island general shop');

const templeBandShopPath = GeodataEngine.findPath(
    formerTempleBand.locX, formerTempleBand.locY, formerTempleBand.locZ,
    townShop.locX, townShop.locY, townShop.locZ,
    4000
);
assert(templeBandShopPath && templeBandShopPath.length > 1, 'the removed temple band should leave a route to the general shop');

console.log("Testing pathfinding to Talking Island south gate staging point...");
const startX = -84500;
const startY = 242800;
const startZ = -3730;

const endX = -83990;
const endY = 243336;
const endZ = -3700;

const startTime = Date.now();
const path = GeodataEngine.findPath(startX, startY, startZ, endX, endY, endZ);
const elapsed = Date.now() - startTime;

console.log(`Pathfinding took ${elapsed}ms`);
assert(path, "Expected path to Talking Island south gate staging point");
console.log("SUCCESS! Path found with", path.length, "waypoints:");
path.forEach((pt, idx) => {
    console.log(`  Waypoint ${idx}: X: ${pt.locX}, Y: ${pt.locY}, Z: ${pt.locZ}`);
});

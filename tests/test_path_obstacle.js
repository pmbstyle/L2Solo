require('../src/Global');
const assert = require('assert');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
GeodataEngine.init();

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

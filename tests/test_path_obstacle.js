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

// The tree at 45868, 34914 in the Elven fields: a body that ended inside its
// skirt (a cell that opens west and south while the ground there does not open
// back) walks out and reaches a mob; nobody walks in, and the trunk stays closed.
{
    const skirt = { locX: 45868, locY: 34914, locZ: -3632 };
    const ground = { locX: 45596, locY: 34037, locZ: GeodataEngine.getHeight(45596, 34037, -3640) };
    const out = GeodataEngine.findPath(skirt.locX, skirt.locY, skirt.locZ, ground.locX, ground.locY, ground.locZ);
    assert(out && out.length > 1, 'a body inside the tree skirt at 45868, 34914 has a route to the open ground');
    let from = skirt;
    for (const to of out) {
        assert(GeodataEngine.canWalkStraight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ),
            'every leg of the route out is a straight walk');
        from = to;
    }
    const mob = { locX: 45820, locY: 34990, locZ: GeodataEngine.getHeight(45820, 34990, -3640) };
    assert(GeodataEngine.hasLineOfSight(skirt.locX, skirt.locY, skirt.locZ, mob.locX, mob.locY, mob.locZ),
        'a hunter standing there sees a mob on the ground beside the tree');
    assert(GeodataEngine.hasLineOfSight(mob.locX, mob.locY, mob.locZ, skirt.locX, skirt.locY, skirt.locZ),
        'and the mob sees the hunter back across the one-way edge');
    assert(GeodataEngine.findPath(skirt.locX, skirt.locY, skirt.locZ, mob.locX, mob.locY, mob.locZ)?.length > 1, 'and reaches it');
    assert.strictEqual(GeodataEngine.canWalkStraight(mob.locX, mob.locY, mob.locZ, skirt.locX, skirt.locY, skirt.locZ), false,
        'the skirt is not walked into from the ground');
    assert.strictEqual(GeodataEngine.findPath(ground.locX, ground.locY, ground.locZ, skirt.locX, skirt.locY, skirt.locZ), null,
        'no route leads into the skirt');
    const hollow = { locX: 45912, locY: 34872, locZ: -3640 };
    assert.strictEqual(GeodataEngine.findPath(ground.locX, ground.locY, ground.locZ, hollow.locX, hollow.locY, hollow.locZ), null,
        'no route leads into the hollow of the trunk');

    // C4 sight is a height ray: bodies see each other over the low skirt
    // (cells 24 above the ground) though neither walks across it, and the
    // trunk (cells 136 above the ground) hides.
    const east = { locX: 46080, locY: 34890, locZ: -3632 }, west = { locX: 45692, locY: 35010, locZ: -3656 };
    const sees = (a, b) => GeodataEngine.hasLineOfSight(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ);
    const walks = (a, b) => GeodataEngine.canWalkStraight(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ);
    assert(sees(east, west) && sees(west, east), 'two bodies see each other over the tree skirt, both ways');
    assert.strictEqual(walks(east, west) || walks(west, east), false, 'neither walks straight across the skirt');
    const trunkEast = { locX: 46040, locY: 34890, locZ: -3640 }, trunkWest = { locX: 45768, locY: 34938, locZ: -3648 };
    assert.strictEqual(sees(trunkEast, trunkWest) || sees(trunkWest, trunkEast), false, 'the trunk hides, both ways');
}

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

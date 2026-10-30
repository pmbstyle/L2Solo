const assert = require('assert');
require('../src/Global');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

const original = {
    random: Math.random, findCurrentSpot: Spots.findCurrentSpot, findById: Spots.findById,
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
    if (process.env.L2NODE_SKIP_RAW_GEODATA_TESTS !== '1') {
        invoke('GameServer/Geodata/VirtualObstacles/index').init();
        // Real Giran geodata and the exact coordinates from EloraMoss's activation.
        assert(Math.abs(Geo.getHeight(roof.locX, roof.locY, anchor.locZ) - anchor.locZ) > 64,
            'the captured roof XY must not resolve to the street layer');
        assert.strictEqual(Geo.hasLineOfSight(anchor.locX, anchor.locY, anchor.locZ,
            roof.locX, roof.locY, roof.locZ), false);
        samplePoint(anchor, roof);
        const result = Placement.resolve({ loc: anchor });
        assert.deepStrictEqual(result.loc, { ...anchor, locZ: Geo.getHeight(anchor.locX, anchor.locY, anchor.locZ) },
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
        invoke('GameServer/DataCache').init({ validate: false });
        const dungeonRaid = Placement.resolve({ spotId: 'raid:10060',
            loc: { locX: -59968, locY: 188724, locZ: -4512 } }, { preferAnchor: true });
        assert(dungeonRaid, 'Kael raid profiles must resolve outside the ordinary hunting spot index');
        const rally = dungeonRaid.loc;
        assert(Geo.hasLineOfSight(-60428, 188264, -4512, rally.locX, rally.locY, rally.locZ),
            'the real dungeon rally is connected to Kael');
        const outdoorRaid = Placement.resolve({ spotId: 'raid:10357',
            loc: { locX: -2991, locY: 112359, locZ: -2995 } }, { preferAnchor: true });
        assert(outdoorRaid, 'Sukar historical spawn Z must ground onto its actual terrain');
        assert(Geo.hasLineOfSight(-3451, 112819, -3448,
            outdoorRaid.loc.locX, outdoorRaid.loc.locY, outdoorRaid.loc.locZ),
            'the outdoor rally must be reachable from the actual boss ground');
        // Repiro arrivals depend on terrain. Validate the generated roster's
        // placement and connectivity instead of pinning an old pack's cliff XY.
        const repiro = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById('raid:10099');
        const roster = [2006161,2006162,2006168,2006407,2006791,2006856,2007116,2007436,2007686]
            .map(characterId => ({ characterId, spotId: repiro.id }));
        const arrivals = Spots.arrivalPointsForParty(roster, repiro);
        const leader = roster.find(s => s.characterId === 2006407);
        assert(Spots.containsLocation(repiro, arrivals[leader.characterId]),
            'the generated leader arrival must stay inside the raid area');
        const bossFloor = { ...repiro.center, locZ: Geo.getHeight(64048,16048,-3536) };
        let randomCalls = 0;
        Math.random = () => { randomCalls++; return ((seed = (Math.imul(seed,1664525)+1013904223) >>> 0) / 4294967296); };
        for (let round = 0; round < 16; round++) {
            const rally = Placement.resolve({ ...leader, loc: arrivals[leader.characterId] },
                { preferAnchor: true, placementRadius: 240 });
            assert(rally, 'a height-valid but unusable cliff anchor must recover to a connected rally');
            assert(Geo.hasLineOfSight(64048,16048,bossFloor.locZ,rally.loc.locX,rally.loc.locY,rally.loc.locZ));
            for (const member of roster) {
                const placed = Placement.resolve({ ...member, loc: rally.loc }, { placementRadius: 420 });
                assert(placed, 'the whole nine must fit around the recovered leader');
                assert(Spots.containsLocation(repiro, placed.loc));
                const p = placed.loc;
                for (const [dx,dy] of [[0,0],[16,0],[-16,0],[0,16],[0,-16]])
                    assert(Geo.getCellData(p.locX+dx,p.locY+dy,p.locZ).nswe, 'each actor retains wall clearance');
                assert(Geo.hasLineOfSight(rally.loc.locX,rally.loc.locY,rally.loc.locZ,p.locX,p.locY,p.locZ));
            }
        }
        assert(randomCalls <= 16 * 9 * Config.activationPlacementAttempts * 2,
            'recovery does not expand the random placement budget');
    }

    const flat = { locX: 0, locY: 0, locZ: 0 };
    Geo.hasGeo = () => true;
    Geo.getHeight = () => 0;
    Geo.getCellData = () => ({ z: 0, nswe: 15 });
    Geo.hasLineOfSight = () => true;
    samplePoint(flat, { locX: 100, locY: 0 });
    assert.strictEqual(Placement.resolve({ loc: flat }).loc.locX, 100);
    let sample = 0;
    Math.random = () => sample++ % 2 === 0 ? 0 : 1;
    assert.strictEqual(Placement.resolve({ loc: flat }, { placementRadius: 240 }).loc.locX, 240,
        'party placement can constrain the search radius around its shared anchor');
    assert.deepStrictEqual(Placement.resolve({ loc: flat }, { preferAnchor: true, placementRadius: 240 }).loc, flat,
        'party leader prefers the persisted safe anchor before any displacement');
    samplePoint(flat, { locX: 100, locY: 0 });
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
    const rally = { locX: 650, locY: 0, locZ: 0 };
    const blocked = { locX: 460, locY: 460, locZ: 0 };
    const raid = { id: 'raid:10060', raidBoss: true, center: flat, arrivalPoints: [blocked, rally] };
    Spots.findById = () => raid;
    Geo.getCellData = (x, y) => ({ z: 0, nswe: x === blocked.locX && y === blocked.locY ? 0 : 15 });
    Geo.hasLineOfSight = () => true;
    assert.deepStrictEqual(Placement.resolve({ spotId: raid.id, loc: blocked }, { preferAnchor: true }).loc, rally,
        'a generated raid arrival inside a dungeon wall recovers at a checked rally on the boss floor');
    Geo.hasLineOfSight = (x, y, z, tx) => Math.abs(x - tx) <= 16;
    assert.strictEqual(Placement.resolve({ spotId: raid.id, loc: blocked }), null,
        'an isolated rally behind another wall cannot recover the raid placement');
    Geo.hasLineOfSight = () => true;
    Geo.getCellData = (x, y) => ({ z: x === 0 && y === 0 ? 400 : 0,
        nswe: x === blocked.locX && y === blocked.locY ? 0 : 15 });
    Geo.getHeight = (x, y) => x === 0 && y === 0 ? 400 : 0;
    assert.strictEqual(Placement.resolve({ spotId: raid.id, loc: blocked }), null,
        'raid recovery must not silently switch the boss floor');
    Geo.getHeight = () => 0;
    Geo.getCellData = (x,y) => ({ z: 0, nswe: x === blocked.locX + 16 && y === blocked.locY ? 0 : 15 });
    Geo.hasLineOfSight = () => true;
    Math.random = () => 0;
    assert.deepStrictEqual(Placement.resolve({ spotId: raid.id, loc: blocked }, { preferAnchor: true }).loc, rally,
        'a height-valid anchor with a blocked adjacent cell must also enter rally recovery');
    Geo.getCellData = () => ({ z: 0, nswe: 15 });
    Geo.hasLineOfSight = (x,y,z,tx,ty) => !(x === 0 && y === 0 && tx === blocked.locX && ty === blocked.locY);
    assert.deepStrictEqual(Placement.resolve({ spotId: raid.id, loc: blocked }, { preferAnchor: true }).loc, rally,
        'a clear but isolated anchor cannot publish actors across a wall from the raid');
    Spots.findById = original.findById;
    assert.strictEqual(Placement.resolve({ loc: { ...flat, locZ: null } }), null);
    assert.strictEqual(Placement.resolve({}), null);
    console.log('Bot activation placement tests passed');
} finally {
    Math.random = original.random;
    Spots.findCurrentSpot = original.findCurrentSpot;
    Spots.findById = original.findById;
    for (const key of ['getCellData', 'getHeight', 'hasGeo', 'hasLineOfSight']) Geo[key] = original[key];
}

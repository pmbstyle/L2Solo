const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-counter-geometry-'));
process.env.L2NODE_GEODATA_DIR = directory;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
    // A real complex L2J region with a flat floor and a solid NSWE divider.
    const region = Buffer.alloc(129 * 65536);
    for (let block = 0; block < 65536; block++) {
        region[block * 129] = 1;
        for (let cell = 0; cell < 64; cell++) region.writeInt16LE(15, block * 129 + 1 + cell * 2);
    }
    for (let by = 0; by < 256; by++) for (let cy = 0; cy < 8; cy++) {
        region.writeInt16LE(14, (7 * 256 + by) * 129 + 1 + (7 * 8 + cy) * 2);
        region.writeInt16LE(13, (8 * 256 + by) * 129 + 1 + cy * 2);
    }
    fs.writeFileSync(path.join(directory, '20_18.l2j'), region);
    require('../src/Global');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
    const npc = { npcSelfId: 90001, locX: 1000, locY: 1000, locZ: 0, head: 0 };
    const bot = { locX: 1072, locY: 1000, locZ: 0, fetchId: () => 12345,
        fetchLocX() { return this.locX; }, fetchLocY() { return this.locY; }, fetchLocZ() { return this.locZ; } };
    assert(!Approach.hasLineOfSight(bot, npc));
    assert(!Approach.hasInteractionLineOfSight(bot, npc), 'a flat-floor NSWE wall must remain opaque without verified geometry');
    assert(!Approach.plan({}, bot, npc, 'shopping').ready, 'a shopper behind the NSWE wall cannot trade');

    function geometry(height, expectedRegion = digest(region), triangles = [
        1024, 900, 0, 1024, 1100, 0, 1024, 1100, height,
        1024, 900, 0, 1024, 1100, height, 1024, 900, height
    ]) {
        const data = { schemaVersion: 1, radius: 192, sourceRegions: { '20_18': expectedRegion },
            triangles,
            records: [{ id: npc.npcSelfId, x: npc.locX, y: npc.locY, z: npc.locZ, region: '20_18',
                triangles: Array.from({ length: triangles.length / 9 }, (_, i) => i) }] };
        const bytes = Buffer.from(JSON.stringify(data));
        fs.writeFileSync(path.join(directory, 'npc-interaction-geometry.json'), bytes);
        fs.writeFileSync(path.join(directory, '.l2solo-geodata-manifest.json'), JSON.stringify({ schemaVersion: 1, format: 'L2J',
            regions: [{ region: '20_18', bytes: region.length, sha256: digest(region) }],
            interactionGeometry: { file: 'npc-interaction-geometry.json', bytes: bytes.length, sha256: digest(bytes) } }));
        Geo.navigationRevision = Number(Geo.navigationRevision || 0) + 1;
    }
    geometry(128);
    assert(!Approach.hasInteractionLineOfSight(bot, npc), 'a client wall at eye height must block conversation');
    geometry(24);
    assert(Approach.hasInteractionLineOfSight(bot, npc), 'verified low counter triangles permit conversation above the counter');
    assert(!Approach.hasLineOfSight(bot, npc), 'verified conversation must not permit walking through the counter');
    assert(Approach.plan({}, bot, npc, 'shopping').ready);
    geometry(0, digest(region), [1000, 900, 48, 1100, 900, 48, 1100, 1010, 48]);
    assert(Approach.hasInteractionLineOfSight(bot, npc), 'a coplanar triangle bounding box is not an actual intersection');
    geometry(0, digest(region), [1000, 900, 48, 1100, 900, 48, 1000, 1100, 48]);
    assert(!Approach.hasInteractionLineOfSight(bot, npc), 'a coplanar ray crossing the triangle must be blocked');
    geometry(0, digest(region), [1024, 900, 48, 1024, 1000, 48, 1024, 1100, 48]);
    assert(Approach.hasInteractionLineOfSight(bot, npc), 'a zero-area triangle must not invent an occluder');
    assert(!Approach.hasInteractionLineOfSight(bot, { ...npc, locX: 1001 }), 'unrecorded NPC positions cannot borrow visibility');
    geometry(24, '0'.repeat(64));
    assert(!Approach.hasInteractionLineOfSight(bot, npc), 'geometry from a different region pack must not bypass NSWE');
    geometry(24);
    const file = path.join(directory, 'npc-interaction-geometry.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"schemaVersion":1', '"schemaVersion":2'));
    Geo.navigationRevision = Number(Geo.navigationRevision || 0) + 1;
    assert(!Approach.hasInteractionLineOfSight(bot, npc), 'same-size sidecar corruption must fail closed');
    console.log('NPC NSWE walls and verified client counter geometry checks passed');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}

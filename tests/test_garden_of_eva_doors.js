const assert = require('assert');
const { mock } = require('node:test');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
require('../src/Global');
const Doors = require('../src/GameServer/World/GardenOfEvaDoors');
const Barriers = require('../src/GameServer/Geodata/GardenOfEvaBarriers');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const move = invoke('GameServer/Actor/Generics/MoveTo');
const validate = invoke('GameServer/Network/Request/ValidatePosition');
const { doors: definitions } = require('../data/World/garden_of_eva_doors.json');

// The photographed wall at LilSP's location: cross its vertical collision plane.
const from = { locX: 76760, locY: 253954, locZ: -8832 };
const to = { locX: 76980, locY: 253954, locZ: -8832 };
const blocked = () => Barriers.blocks(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ);
function player(location = from, accountId = 'eva_player') {
    const session = { accountId, sent: [], dataSendToMe(packet) { this.sent.push(packet); },
        dataSendToMeAndOthers(packet) { this.sent.push(packet); } };
    const actor = session.actor = {
        ...location, effects: {}, fetchId: () => 2002014, fetchHead: () => 0,
        fetchLocX() { return this.locX; }, fetchLocY() { return this.locY; }, fetchLocZ() { return this.locZ; },
        isDead: () => false, isBlocked: () => false,
        automation: { abortAll() {} }, updatePosition(data) { Object.assign(this, data); }
    };
    return session;
}
const statuses = session => session.sent.filter(packet => packet[0] === 0x4d);
const ownStatus = session => statuses(session).filter(packet => packet.readInt32LE(17) === 22250003);
function positionPacket(location) {
    const packet = Buffer.alloc(21);
    [location.locX, location.locY, location.locZ, 0, 0].forEach((value, index) => packet.writeInt32LE(value, 1 + index * 4));
    return packet;
}

async function main() {
    let worker;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
    try {
        const nearby = player(), distant = player({ locX: 0, locY: 0, locZ: 0 });
        const bot = player(from, 'bot_eva'), markedBot = player();
        markedBot.botSession = true;
        const world = { npc: { nextId: 1500000 }, user: { sessions: [nearby, distant, bot, markedBot] } };
        Doors.start(world);
        const walls = Doors.all();
        assert.equal(walls.length, 24);
        assert.equal(world.npc.nextId, 1500024, 'water walls reserve unique world object ids');
        assert.deepEqual(walls.map(wall => wall.id), Array.from({ length: 24 }, (_, index) => 22250001 + index));
        assert(walls.every(wall => !wall.open && wall.autoOpenDelay === 420000 && wall.autoCloseDelay === 420000));
        Doors.sync(nearby, nearby.actor, true);
        assert.equal(ownStatus(nearby).at(-1).readInt32LE(5), 1, 'new arrivals see the closed wall');
        const door = walls.find(wall => wall.id === 22250003);
        const info = nearby.sent.find(packet => packet[0] === 0x4c && packet.readInt32LE(5) === door.id);
        assert.equal(info.readInt32LE(1), door.objectId, 'native C4 DoorInfo binds the client-map wall');
        assert.equal(ownStatus(nearby).at(-1).readInt32LE(21), 187500);
        const sent = nearby.sent.length;
        Doors.sync(nearby, nearby.actor);
        assert.equal(nearby.sent.length, sent, 'unchanged visibility does not resend door packets');
        const edge = player({ locX: door.locX + 6000, locY: door.locY, locZ: from.locZ });
        Doors.sync(edge, edge.actor, true);
        assert.equal(ownStatus(edge).length, 0, 'the native client visibility boundary is respected');

        assert(blocked());
        assert.equal(validate(nearby, positionPacket(to)), false, 'closed walls reject client position reports across them');
        assert.equal(nearby.actor.locX, from.locX);
        move(nearby, nearby.actor, { from, to });
        const stoppedMove = nearby.sent.at(-1);
        assert.equal(stoppedMove[0], 0x01);
        assert(stoppedMove.readInt32LE(5) < door.locX, 'a click beyond a closed wall stops on the approach side');

        for (const wall of definitions) {
            const b = wall.bounds, x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2;
            const nx = b.maxY - b.minY, ny = b.minX - b.maxX, scale = 64 / Math.hypot(nx, ny);
            const z = b.minZ + 32;
            assert(Barriers.blocks(x - nx * scale, y - ny * scale, z, x + nx * scale, y + ny * scale, z),
                `${wall.name} blocks crossing, including the zero-width wall`);
            assert(!Barriers.blocks(x - nx * scale, y - ny * scale, -1000, x + nx * scale, y + ny * scale, -1000),
                'water walls do not block a different floor');
        }
        const horizontal = definitions.find(wall => wall.id === 22250005);
        const standing = { locX: horizontal.locX, locY: horizontal.locY, locZ: horizontal.bounds.minZ + 32 };
        assert.strictEqual(Barriers.clip(standing, { ...standing, locY: standing.locY + 100 }).locY, standing.locY + 100,
            'a wall closing on a stationary player still permits stepping away from its plane');

        // Exercise the real geodata entry points against an unobstructed floor.
        const original = { hasGeo: Geo.hasGeo, getCellData: Geo.getCellData, readCell: Geo.readCell };
        try {
            Geo.hasGeo = () => true;
            Geo.getCellData = (x, y, z) => ({ z, nswe: 15 });
            Geo.readCell = (_cx, _cy, slot) => {
                slot.closed = false; slot.n = 1; slot.z[0] = from.locZ; slot.nswe[0] = 15;
                return slot;
            };
            assert(!Geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ));
            const path = Geo.findPath(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ, 1000, { debug: false });
            assert(path?.length, 'A* can route around the end of a wall on the synthetic open floor');
            assert(path.every((point, index) => {
                const previous = index ? path[index - 1] : from;
                return !Barriers.blocks(previous.locX, previous.locY, previous.locZ, point.locX, point.locY, point.locZ);
            }), 'neither A* steps nor smoothed segments cross a closed wall');
            mock.timers.tick(419999);
            assert(blocked(), 'a wall remains closed until the full seven minutes have passed');
            mock.timers.tick(1);
            assert(!blocked());
            assert(walls.every(wall => wall.open));
            assert(Geo.hasLineOfSight(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ));
        } finally { Object.assign(Geo, original); }

        assert.equal(ownStatus(nearby).at(-1).readInt32LE(5), 0, 'nearby clients see the timed opening');
        assert.equal(distant.sent.length, 0);
        assert.equal(bot.sent.length, 0);
        assert.equal(markedBot.sent.length, 0);
        const newcomer = player();
        Doors.sync(newcomer, newcomer.actor, true);
        assert.equal(ownStatus(newcomer).at(-1).readInt32LE(5), 0, 'login during an open interval receives the current state');
        assert(validate(newcomer, positionPacket(to)), 'an open wall admits the same client movement');
        move(nearby, nearby.actor, { from, to });
        assert.equal(nearby.sent.at(-1).readInt32LE(5), to.locX, 'the open wall leaves movement intact');

        // A real worker must observe transitions through the same shared buffer.
        const descriptor = Geo.sharedDescriptor();
        assert.strictEqual(descriptor.gardenOfEvaBarriers, Barriers.sharedBuffer());
        worker = new Worker(`
            const { parentPort, workerData } = require('worker_threads');
            require(workerData.globals);
            invoke('GameServer/Geodata/GeodataEngine').attachShared(workerData.descriptor);
            const barriers = require(workerData.module);
            parentPort.on('message', () => parentPort.postMessage(barriers.blocks(...workerData.segment)));
        `, { eval: true, workerData: { module: require.resolve('../src/GameServer/Geodata/GardenOfEvaBarriers'),
            globals: require.resolve('../src/Global'), descriptor,
            segment: [from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ] } });
        const workerBlocked = async () => { const reply = once(worker, 'message'); worker.postMessage('check'); return (await reply)[0]; };
        assert.equal(await workerBlocked(), false);
        mock.timers.tick(419999);
        assert(!blocked());
        mock.timers.tick(1);
        assert(blocked(), 'the wall closes again after seven minutes open');
        assert.equal(await workerBlocked(), true, 'workers see closure without a restart or a stale snapshot');
        assert.equal(ownStatus(nearby).at(-1).readInt32LE(5), 1);
        mock.timers.tick(420000);
        assert(!blocked(), 'the cycle repeats');

        Doors.start(world);
        assert(blocked(), 'world initialization starts a new closed cycle');
        mock.timers.tick(420000);
        assert(Doors.all().every(wall => wall.open && wall.revision === 1), 'old timers cannot toggle the replacement world');
        Doors.sync(nearby, nearby.actor);
        assert.equal(ownStatus(nearby).at(-1).readInt32LE(5), 0);
        Doors.stop(world);
        mock.timers.tick(840000);
        assert.equal(Doors.all().length, 0);
        assert(!blocked(), 'shutdown cancels timers and releases the collision state');
        console.log('Garden of Eva: 24 C4 walls, seven-minute cycle, visibility, movement, A* and shared worker state passed');
    } finally {
        Doors.stop();
        mock.timers.reset();
        await worker?.terminate();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

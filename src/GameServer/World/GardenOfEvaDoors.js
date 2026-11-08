const { doors: definitions } = require('../../../data/World/garden_of_eva_doors.json');
const packets = require('../Network/DoorPackets');
const Barriers = require('../Geodata/GardenOfEvaBarriers');
const { inClientView } = require('./WorldConstants');
let runtime = null;

function sync(session, actor, force = false) {
    if (!runtime || !actor || !session?.dataSendToMe || session.botSession
        || session.constructor?.name === 'BotSession' || String(session.accountId || '').startsWith('bot_')) return;
    if (session.gardenOfEvaDoorVersions?.generation !== runtime.generation)
        session.gardenOfEvaDoorVersions = { generation: runtime.generation, versions: new Map() };
    const versions = session.gardenOfEvaDoorVersions.versions;
    for (const door of runtime.doors) {
        if (!inClientView(actor.fetchLocX(), actor.fetchLocY(), door.locX, door.locY)) continue;
        if (!force && versions.get(door.objectId) === door.revision) continue;
        for (const packet of packets(door)) session.dataSendToMe(packet);
        versions.set(door.objectId, door.revision);
    }
}

function schedule(current) {
    // Lisvus starts closed, waits autoOpenDelay, then waits autoCloseDelay.
    // One timer suffices: every timed water wall has the same 420000 ms delays.
    const door = current.doors[0];
    current.timer = setTimeout(() => {
        if (runtime !== current) return;
        const open = !door.open;
        for (const wall of current.doors) { wall.open = open; wall.revision++; }
        Barriers.setOpen(open);
        schedule(current);
        for (const session of current.world.user?.sessions || []) sync(session, session.actor);
    }, door.open ? door.autoCloseDelay : door.autoOpenDelay);
    current.timer.unref?.();
}

function stop(world) {
    if (!runtime || world && runtime.world !== world) return;
    clearTimeout(runtime.timer);
    runtime = null;
    Barriers.reset();
}

function start(world) {
    stop();
    runtime = { world, generation: Symbol('garden-of-eva'),
        doors: definitions.map(door => ({ ...door, objectId: world.npc.nextId++, open: false, revision: 0 })) };
    Barriers.setOpen(false);
    schedule(runtime);
}

module.exports = { start, stop, sync, all: () => runtime?.doors || [] };

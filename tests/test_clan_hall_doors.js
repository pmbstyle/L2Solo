const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const Doors = require('../src/GameServer/ClanHall/Doors');
const NpcUi = require('../src/GameServer/ClanHall/Npc');
const World = invoke('GameServer/World/World');
const Clans = invoke('GameServer/Clan/ClanService');
const Database = invoke('Database');
const originalInvoke = global.invoke;
const original = { npc: World.npc, user: World.user, fetchNpc: World.fetchNpc,
    clan: Clans.findById, auctions: Database.fetchClanHallAuctions };
const hall = Runtime.Policy.definition(22);
let rows = [{ id: hall.id, ownerId: 1, functionsJson: '{}', rentDueAt: Date.now() + 86400000 }];
const npc = { fetchId: () => 999, fetchSelfId: () => hall.doormanIds[0], fetchName: () => 'Gatekeeper',
    fetchLocX: () => hall.spawn.locX, fetchLocY: () => hall.spawn.locY, fetchLocZ: () => hall.spawn.locZ };
function player(id, clanId, privileges = 0, location = hall.spawn) {
    return {
        actor: { fetchId: () => id, fetchClanId: () => clanId, fetchClanPrivileges: () => privileges,
            fetchLocX: () => location.locX, fetchLocY: () => location.locY, fetchLocZ: () => location.locZ,
            isDead: () => false },
        activeNpcTalk: { selfId: hall.doormanIds[0], objectId: 999 },
        sent: [], dataSendToMe(packet) { this.sent.push(packet); }
    };
}
const status = session => session.sent.filter(packet => packet[0] === 0x4d);
const html = session => session.sent.filter(packet => packet[0] === 0x0f).at(-1)?.toString('utf16le', 5) || '';
async function main() {
    try {
        World.npc = { nextId: 1500000 };
        World.fetchNpc = async () => npc;
        Clans.findById = id => ({ id, leaderId: id === 1 ? 100 : 200, name: 'TestClan', members: [] });
        Database.fetchClanHallAuctions = async () => rows;
        Runtime.applyRows(rows);
        Doors.start(World);
        const doors = Doors.all();
        assert.equal(new Set(doors.map(door => door.objectId)).size, doors.length);
        for (const definition of Runtime.Policy.catalog.halls)
            assert(doors.some(door => door.hallId === definition.id), `hall ${definition.id} needs native doors`);
        assert.deepEqual(doors.filter(door => door.hallId === 22).map(door => door.id), [19210017, 19210018]);
        const leader = player(100, 1), member = player(101, 1), delegate = player(102, 1, 16);
        const outsider = player(200, 2, 2047), distant = player(100, 1, 0, { locX: 0, locY: 0, locZ: 0 });
        World.user = { sessions: [leader, member, outsider, distant] };
        Doors.sync(leader, leader.actor, true);
        const firstDoor = doors.find(door => door.hallId === 22);
        const seesDoor = locX => {
            const viewer = player(100, 1, 0, { locX, locY: firstDoor.locY, locZ: 0 });
            Doors.sync(viewer, viewer.actor, true);
            return viewer.sent.some(packet => packet.readInt32LE(1) === firstDoor.objectId);
        };
        assert(seesDoor(firstDoor.locX + 5999), 'a door inside the view is sent');
        assert(!seesDoor(firstDoor.locX + 6000), 'the view ends at the radius, as for every packet to a viewer');
        const [info, closed] = Doors.packets(firstDoor);
        assert.equal(info.length, 16, 'DoorInfo uses the shared packet padding');
        assert.equal(info.readInt32LE(1), firstDoor.objectId);
        assert.equal(info.readInt32LE(5), firstDoor.id);
        assert.equal(closed.length, 40);
        assert.equal(closed.readInt32LE(5), 1, 'C4 uses 1 for closed and 0 for open');
        assert.equal(closed.readInt32LE(17), firstDoor.id);
        assert.equal(closed.readInt32LE(21), firstDoor.maxHp);
        assert.equal(closed.readInt32LE(25), firstDoor.maxHp);
        await NpcUi.render(leader);
        assert(html(leader).includes('Open doors'), 'leader with a zero privilege mask still has door controls');
        await NpcUi.render(member);
        assert(!html(member).includes('Open doors'));
        await NpcUi.handle(leader, ['clan-hall', 'doors', 'open']);
        assert(doors.filter(door => door.hallId === 22).every(door => door.open));
        assert(doors.filter(door => door.hallId !== 22).every(door => !door.open), 'only the selected residence changes');
        for (const session of [leader, member, outsider])
            assert(status(session).some(packet => packet.readInt32LE(17) === firstDoor.id && packet.readInt32LE(5) === 0),
                'all nearby players see the open door');
        assert.equal(status(distant).length, 0, 'do not broadcast doors across the world');
        const newcomer = player(300, 0);
        Doors.sync(newcomer, newcomer.actor, true);
        assert(status(newcomer).some(packet => packet.readInt32LE(17) === firstDoor.id && packet.readInt32LE(5) === 0),
            'login and return visibility receive the current open state');
        const count = newcomer.sent.length;
        Doors.sync(newcomer, newcomer.actor);
        assert.equal(newcomer.sent.length, count);
        for (const denied of [member, outsider, distant]) {
            await NpcUi.handle(denied, ['clan-hall', 'doors', 'close']);
            assert(firstDoor.open, 'non-privileged, foreign and remote requests cannot close the door');
        }
        await NpcUi.handle(delegate, ['clan-hall', 'doors', 'close']);
        assert(!firstDoor.open, 'delegated native clan door privilege works');
        npc.fetchSelfId = () => hall.managerIds[0];
        leader.activeNpcTalk.selfId = hall.managerIds[0];
        await NpcUi.render(leader);
        assert(html(leader).includes('Open doors'), 'manager also provides door controls');
        await NpcUi.handle(leader, ['clan-hall', 'doors', 'open']);
        assert(firstDoor.open);
        rows = [{ ...rows[0], ownerId: 0 }];
        global.invoke = name => name === 'GameServer/Actor/Generics/TeleportTo' ? () => true : originalInvoke(name);
        await Runtime.refresh();
        global.invoke = originalInvoke;
        assert(!firstDoor.open, 'ownership loss closes the residence');
        assert.equal(Doors.setOpen(leader, npc, hall, true).ok, false);

        const ids = new Set(Runtime.Policy.catalog.auctioneerIds);
        const spawns = Data.npcSpawns.flatMap(group => group.spawns)
            .filter(spawn => ids.has(spawn.selfId)).flatMap(spawn => spawn.coords.map(point => ({ ...point, id: spawn.selfId })));
        for (let i = 0; i < spawns.length; i++) for (let j = i + 1; j < spawns.length; j++) {
            const a = spawns[i], b = spawns[j];
            assert(!(a.id === b.id && a.locX === b.locX && a.locY === b.locY && Math.abs(a.locZ - b.locZ) < 64),
                'a small height correction must not create a second auctioneer');
        }
        console.log('Clan hall door packets, privileges, visibility, ownership and auctioneer uniqueness checks passed');
    } finally {
        global.invoke = originalInvoke;
        World.npc = original.npc;
        World.user = original.user;
        World.fetchNpc = original.fetchNpc;
        Clans.findById = original.clan;
        Database.fetchClanHallAuctions = original.auctions;
        Runtime.applyRows([]);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

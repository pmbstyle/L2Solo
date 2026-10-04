const definitions = require('../../../data/ClanHalls/doors.json');
const SendPacket = invoke('Packet/Send');
const Rules = require('../Clan/ClanRules');
const { CLIENT_VISIBILITY_RADIUS } = invoke('GameServer/World/WorldConstants');
let doors = [];

function packets(door) {
    // C4 DoorInfo binds a world object to the door already in the client map.
    return [
        new SendPacket(0x4c).writeD(door.objectId).writeD(door.id).fetchBuffer(),
        new SendPacket(0x4d).writeD(door.objectId).writeD(door.open ? 0 : 1)
            .writeD(0).writeD(0).writeD(door.id).writeD(door.maxHp).writeD(door.maxHp).fetchBuffer()
    ];
}

function start(world) {
    doors = definitions.map(door => ({ ...door, objectId: world.npc.nextId++, open: false, revision: 0 }));
}

function sync(session, actor, force = false) {
    if (!actor || !session?.dataSendToMe || session.botSession || String(session.accountId || '').startsWith('bot_')) return;
    session.clanHallDoorVersions ||= new Map();
    for (const door of doors) {
        if (Math.hypot(actor.fetchLocX() - door.locX, actor.fetchLocY() - door.locY) > CLIENT_VISIBILITY_RADIUS) continue;
        if (!force && session.clanHallDoorVersions.get(door.objectId) === door.revision) continue;
        for (const packet of packets(door)) session.dataSendToMe(packet);
        session.clanHallDoorVersions.set(door.objectId, door.revision);
    }
}

function change(hallId, open) {
    let changed = false;
    for (const door of doors.filter(door => door.hallId === hallId)) {
        if (door.open === open) continue;
        door.open = open;
        door.revision++;
        changed = true;
    }
    if (changed) for (const session of invoke('GameServer/World/World').user?.sessions || [])
        sync(session, session.actor);
}

function canManage(actor, hall) {
    const clanId = Number(actor?.fetchClanId?.());
    if (!hall || !clanId || hall.ownerId !== clanId) return false;
    const clan = invoke('GameServer/Clan/ClanService').findById(clanId);
    return !!clan && (Number(clan.leaderId) === Number(actor.fetchId())
        || Rules.hasPrivilege(actor, Rules.CP_CH_OPEN_DOOR));
}

function setOpen(session, npc, definition, open) {
    const actor = session.actor;
    const hall = require('./Runtime').forActor(actor);
    if (!hall || hall.id !== definition?.id || !canManage(actor, hall)
        || actor.isDead?.() || actor.state?.fetchDead?.()
        || ![...definition.managerIds, ...(definition.doormanIds || [])].includes(Number(npc?.fetchSelfId?.()))
        || Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY(),
            actor.fetchLocZ() - npc.fetchLocZ()) > 250) return { ok: false, code: 'not_authorized' };
    if (!doors.some(door => door.hallId === hall.id)) return { ok: false, code: 'invalid_function' };
    change(hall.id, open);
    sync(session, actor);
    return { ok: true };
}

module.exports = { start, sync, change, canManage, setOpen, packets, all: () => doors };

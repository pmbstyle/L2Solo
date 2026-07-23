const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');

function autoSoulShot(session, buffer) {
    if (buffer.length < 11) {
        return;
    }

    const packet = new ReceivePacket(buffer);
    packet
        .readH() // Extended request id (0x05)
        .readD() // Item id
        .readD(); // 1 = on, 0 = off

    const [requestId, selfId, enabled] = packet.data;
    if (requestId !== 5 || session.actor.isDead?.() || ![0, 1].includes(enabled)) {
        return;
    }

    const kind = ShotStock.kindForSelfId(selfId);
    if (!kind || !ShotStock.isCompatibleWithActor(kind, selfId, session.actor) || !session.actor.backpack.fetchItemFromSelfId(selfId)) {
        return;
    }

    const autoShots = session.actor.autoSoulshots || (session.actor.autoSoulshots = new Set());
    if (enabled) {
        autoShots.add(selfId);
    }
    else {
        autoShots.delete(selfId);
    }

    session.dataSendToMe(ServerResponse.autoSoulShot(selfId, enabled));
    if (enabled) {
        chargeFirstShot(session, selfId);
    }
}

function chargeFirstShot(session, selfId) {
    const actor = session.actor;
    const kind = ShotStock.kindForSelfId(selfId);
    if (!kind || !ShotStock.isCompatibleWithActor(kind, selfId, actor)) return;

    const charge = (success, shot = {}) => {
        if (!success) return;
        if (kind === 'soulshot') {
            actor.soulshotLoaded = true;
        }
        else {
            actor.spiritshotLoaded = true;
            actor.blessedSpiritshotLoaded = !!shot.blessedSpiritshot;
        }
        session.dataSendToMeAndOthers(
            ServerResponse.skillStarted(actor, actor.fetchId(), {
                fetchSelfId: () => shot.skillId,
                fetchCalculatedHitTime: () => 0,
                fetchReuseTime: () => 0
            }),
            actor
        );
    };

    if (kind === 'soulshot' && !actor.soulshotLoaded) {
        actor.backpack.consumeSoulshot(session, charge, selfId);
    }
    else if (kind !== 'soulshot' && !actor.spiritshotLoaded) {
        actor.backpack.consumeSpiritshot(session, charge, kind, selfId);
    }
}

module.exports = autoSoulShot;

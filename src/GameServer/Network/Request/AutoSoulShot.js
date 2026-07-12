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

    if (!ShotStock.SHOT_IDS.includes(selfId) || !session.actor.backpack.fetchItemFromSelfId(selfId)) {
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
    const kind = ShotStock.SOULSHOT_IDS.includes(selfId)
        ? 'soulshot'
        : ShotStock.BLESSED_SPIRITSHOT_IDS.includes(selfId)
            ? 'blessedSpiritshot'
            : 'spiritshot';
    const expectedId = ShotStock.planForActorKind(kind, actor).selfId;
    if (expectedId !== selfId) return;

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
        actor.backpack.consumeSoulshot(session, charge);
    }
    else if (kind !== 'soulshot' && !actor.spiritshotLoaded) {
        actor.backpack.consumeSpiritshot(session, charge, kind);
    }
}

module.exports = autoSoulShot;

const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');
const Database       = invoke('Database');

function addShortcut(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Kind
        .readD()  // Slot
        .readD()  // Id
        .readD(); // ?

    return consume(session, {
           kind: packet.data[0],
           slot: packet.data[1],
             id: packet.data[2],
        unknown: packet.data[3],
    });
}

function consume(session, data) {
    const characterId = session.actor.fetchId();

    if (data.kind === 2) {
        const skill = session.actor.skillset.fetchSkill(data.id);
        if (!skill || skill.fetchPassive()) {
            return;
        }
    }

    return Database.deleteShortcut(characterId, data.slot).then(() => {

        return Database.setShortcut(characterId, data).then(() => {
            session.dataSendToMe(
                ServerResponse.addShortcut({
                    ...data,
                    level: data.kind === 2 ? session.actor.skillset.fetchSkill(data.id)?.fetchLevel() ?? 1 : undefined
                })
            );
        });
    });
}

module.exports = addShortcut;

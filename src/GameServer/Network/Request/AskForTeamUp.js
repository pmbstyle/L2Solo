const World         = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');

function askForTeamUp(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readS()  // Name
        .readD(); // Distribution

    consume(session, {
                name: packet.data[0],
        distribution: packet.data[1],
    });
}

function consume(session, data) {
    if (!invoke('GameServer/Bot/AI/PartyCompanionService').syncClientDistribution(session, data.distribution)) return;
    World.askForTeamUp(session, session.actor, data);
}

module.exports = askForTeamUp;

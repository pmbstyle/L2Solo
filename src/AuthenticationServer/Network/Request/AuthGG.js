const ServerResponse = invoke('AuthenticationServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');

function authGG(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Session Id
        .readD()  // Data 1
        .readD()  // Data 2
        .readD()  // Data 3
        .readD(); // Data 4

    session.dataSend(
        ServerResponse.authGG(packet.data[0])
    );
}

module.exports = authGG;

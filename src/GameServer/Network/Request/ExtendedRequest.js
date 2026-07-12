const ReceivePacket = invoke('Packet/Receive');
const AutoSoulShot  = invoke('GameServer/Network/Request/AutoSoulShot');

// C4 multiplexes several requests behind opcode 0xD0. Route only the
// subcommands we implement; their payloads are not interchangeable.
function extendedRequest(session, buffer) {
    if (buffer.length < 3) {
        return;
    }

    const packet = new ReceivePacket(buffer);
    packet.readH();

    if (packet.data[0] === 5) {
        AutoSoulShot(session, buffer);
    }
}

module.exports = extendedRequest;

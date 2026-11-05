const SendPacket = invoke('Packet/Send');

function consoleText(textId, params) {
    const packet = new SendPacket(0x64);

    packet
        .writeD(textId)
        .writeD(utils.size(params))

    params.forEach((param) => {
        packet.writeD(param.kind);
        if (param.kind === 0) {
            packet.writeS(String(param.value ?? ''));
        }
        else {
            packet.writeD(param.value);
            // C4 skill-name parameters contain both id and level.
            if (param.kind === 4) packet.writeD(param.level ?? 1);
        }
    });

    return packet.fetchBuffer();
}

module.exports = consoleText;

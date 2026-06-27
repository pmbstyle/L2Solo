const SendPacket = invoke('Packet/Send');

function statusUpdate(id, params = []) {
    const packet = new SendPacket(0x0e);

    packet
        .writeD(id)
        .writeD(utils.size(params));

    params.forEach((param) => {
        packet
            .writeD(param.id)
            .writeD(param.value);
    });

    return packet.fetchBuffer();
}

module.exports = statusUpdate;

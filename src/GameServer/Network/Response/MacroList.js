const SendPacket = invoke('Packet/Send');

function macroPacket(macro, count, revision) {
    const packet = new SendPacket(0xe7);

    packet
        .writeD(revision)
        .writeC(0)
        .writeC(count)
        .writeC(macro ? 1 : 0);

    if (!macro) return packet.fetchBuffer();

    packet
        .writeD(macro.id)
        .writeS(macro.name)
        .writeS(macro.descr)
        .writeS(macro.acronym)
        .writeC(macro.icon)
        .writeC(macro.commands.length);

    macro.commands.forEach((command, index) => {
        packet
            .writeC(index + 1)
            .writeC(command.type)
            .writeD(command.d1)
            .writeC(command.d2)
            .writeS(command.command);
    });

    return packet.fetchBuffer();
}

function macroList(macros, revision) {
    if (!macros.length) return [macroPacket(null, 0, revision)];
    return macros.map((macro) => macroPacket(macro, macros.length, revision));
}

module.exports = macroList;

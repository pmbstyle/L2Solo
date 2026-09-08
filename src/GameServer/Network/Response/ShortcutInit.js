const SendPacket = invoke('Packet/Send');

function shortcutInit(shortcuts, skillset) {
    const packet = new SendPacket(0x45);

    packet
        .writeD(utils.size(shortcuts));

    shortcuts.forEach((shortcut) => {
        packet
            .writeD(shortcut.kind)
            .writeD(shortcut.slot)
            .writeD(shortcut.id);

        if (shortcut.kind === 2) {
            packet.
                writeD(skillset.fetchSkill(shortcut.id)?.fetchLevel() ?? 1);
        }

        packet
            .writeD(shortcut.unknown);
    });

    return packet.fetchBuffer();
}

module.exports = shortcutInit;

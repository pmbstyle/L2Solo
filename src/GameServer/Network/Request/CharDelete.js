const Shared        = invoke('GameServer/Network/Shared');
const ReceivePacket = invoke('Packet/Receive');
const Database      = invoke('Database');

function charDelete(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Character Slot

    return consume(session, {
        characterSlot: packet.data[0]
    });
}

function consume(session, data) {
    return Shared.fetchCharacters(session.accountId).then((characters) => {
        const character = characters[data.characterSlot];

        // The leave rule: the character's board records
        // close first, so the board in memory and its index drop them.
        return invoke('GameServer/AfkTrade/AfkTradeService').leave(character.id).catch((error) => {
            utils.infoWarn('CharDelete', 'board leave failed for %s: %s', character.name, error.message);
        }).then(() => Database.deleteCharacter(session.accountId, character.name)).then((deleted) => {
            // Its meetings' ends land as any meeting end does: the other actor's row, its trace.
            const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
            for (const result of deleted?.meetings || []) Meetings.acceptRows(result);
            // The character's items, skills, shortcuts and macros go with its
            // row: every table references characters(id) ON DELETE CASCADE and
            // the game connection enables foreign keys.
            characters.splice(data.characterSlot, 1);
            Shared.enterCharacterHall(session, characters);
        });
    });
}

module.exports = charDelete;

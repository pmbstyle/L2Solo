const ReceivePacket = invoke('Packet/Receive');

function skillUse(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Skill Id
        .readD()  // Ctrl
        .readC(); // Shift

    consume(session, {
        selfId: packet.data[0],
          ctrl: packet.data[1],
         shift: packet.data[2],
    });
}

function consume(session, data) {
    // In C4 the client activates the recipe book by using the Dwarven Craft
    // skill icon; it does not send RequestRecipeBookOpen from this UI path.
    if (Number(data.selfId) === 1321) {
        invoke('GameServer/Network/Request/RecipeBookOpen').open(session, true);
        return;
    }

    if (session.actor.skillset.fetchSkill(data.selfId)?.fetchPassive() ?? false) {
        return;
    }

    session.actor.skillRequest(data);
}

module.exports = skillUse;

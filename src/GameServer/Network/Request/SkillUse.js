const ReceivePacket = invoke('Packet/Receive');
const RECIPE_BOOK_SKILLS = new Map([[1321, true], [1322, false]]);

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
    // In C4 the client activates recipe books from their skill icons; it does
    // not send RequestRecipeBookOpen from this UI path.
    const recipeBookKind = RECIPE_BOOK_SKILLS.get(Number(data.selfId));
    if (recipeBookKind !== undefined) {
        invoke('GameServer/Network/Request/RecipeBookOpen').open(session, recipeBookKind);
        return;
    }

    if (session.actor.skillset.fetchSkill(data.selfId)?.fetchPassive() ?? false) {
        return;
    }

    session.actor.skillRequest(data);
}

module.exports = skillUse;

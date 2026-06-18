const ServerResponse = invoke('GameServer/Network/Response');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');

module.exports = function(session, parts) {
    const actor = session.actor;
    if (!actor) return;

    if (actor.fetchLevel() > 25) {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Your level is too high! I can only help adventurers under level 25." }));
        return;
    }

    const buffType = parts[1];

    if (buffType === 'windwalk') {
        BotBuffs.applyNewbieBuff(session, actor, 'windwalk');
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Wind Walk! May the wind guide your steps." }));
    }
    else if (buffType === 'shield') {
        BotBuffs.applyNewbieBuff(session, actor, 'shield');
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Shield! May your defenses be unbreakable." }));
    }
    else if (buffType === 'haste') {
        BotBuffs.applyNewbieBuff(session, actor, 'haste');
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Haste! Strike with the speed of lightning." }));
    }
    else if (buffType === 'heal') {
        actor.setHp(actor.fetchMaxHp());
        actor.setMp(actor.fetchMaxMp());
        actor.statusUpdateVitals(actor);
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: You have been fully healed and refreshed!" }));
    }
};

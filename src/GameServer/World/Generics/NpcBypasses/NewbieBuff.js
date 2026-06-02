const ServerResponse = invoke('GameServer/Network/Response');

module.exports = function(session, parts) {
    const actor = session.actor;
    if (!actor) return;

    if (actor.fetchLevel() > 25) {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Your level is too high! I can only help adventurers under level 25." }));
        return;
    }

    if (!actor.activeBuffs) {
        actor.activeBuffs = {};
    }

    const buffType = parts[1];

    if (buffType === 'windwalk') {
        actor.activeBuffs.windWalk = Date.now() + 20 * 60 * 1000;
        invoke(path.actor).calculateStats(session, actor);
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Wind Walk! May the wind guide your steps." }));
    }
    else if (buffType === 'shield') {
        actor.activeBuffs.shield = Date.now() + 20 * 60 * 1000;
        invoke(path.actor).calculateStats(session, actor);
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Shield! May your defenses be unbreakable." }));
    }
    else if (buffType === 'haste') {
        actor.activeBuffs.haste = Date.now() + 20 * 60 * 1000;
        invoke(path.actor).calculateStats(session, actor);
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Haste! Strike with the speed of lightning." }));
    }
    else if (buffType === 'heal') {
        actor.setHp(actor.fetchMaxHp());
        actor.setMp(actor.fetchMaxMp());
        actor.statusUpdateVitals(actor);
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: You have been fully healed and refreshed!" }));
    }
};

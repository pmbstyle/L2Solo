function receivedHit(session, actor, hit) {
    const Generics = invoke(path.actor);

    actor.setHp(Math.max(0, actor.fetchHp() - hit)); // HP bar would disappear if less than zero
    actor.statusUpdateVitals(actor);

    // On hit, actor should stand-up
    if (actor.state.fetchSeated()) {
        Generics.basicAction(session, actor, { actionId: 0 });
    }

    // Bummer
    if (actor.fetchHp() <= 0) {
        if (session.actor && session.actor !== actor) {
            const attacker = session.actor;
            const victim = actor;
            const Database = invoke('Database');
            const ServerResponse = invoke('GameServer/Network/Response');

            if (victim.fetchPvpFlag() === 1 || victim.fetchKarma() > 0) {
                // Legitimate PvP or PK-hunting kill
                attacker.setPvp(attacker.fetchPvp() + 1);
                session.dataSendToMe(ServerResponse.userInfo(attacker));
                session.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            } else {
                // PK kill (murdering an innocent white player/bot)
                attacker.setPk(attacker.fetchPk() + 1);
                attacker.setKarma(attacker.fetchKarma() + 360);
                session.dataSendToMe(ServerResponse.userInfo(attacker));
                session.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            }

            // Clear victim's flag
            victim.setPvpFlag(0);
            if (victim.session && victim.session.pvpFlagTimer) {
                clearTimeout(victim.session.pvpFlagTimer);
                victim.session.pvpFlagTimer = undefined;
            }
        }

        Generics.die(session, actor);
        return;
    }

    actor.automation.replenishVitals(actor);
    Generics.enterCombatState(session, actor);
}

module.exports = receivedHit;

const BOT_WAKEUP_THROTTLE_MS = 750;

function isBotSession(session) {
    return !!(
        session &&
        session.accountId &&
        String(session.accountId).startsWith('bot_')
    );
}

function wakeBotOnDamage(victimSession, attacker) {
    if (!isBotSession(victimSession) || !victimSession.aiActive) return;

    if (attacker && attacker !== victimSession.actor && typeof attacker.fetchId === 'function') {
        victimSession.incomingThreatId = attacker.fetchId();
        victimSession.incomingThreatAt = Date.now();
    }

    const now = Date.now();
    if (now - Number(victimSession.lastDamageWakeAt || 0) < BOT_WAKEUP_THROTTLE_MS) return;

    victimSession.lastDamageWakeAt = now;
    invoke('GameServer/Bot/BotAI').wakeup(victimSession);
}

function shouldDamageCp(session, actor) {
    const attacker = session?.actor;
    return !!(
        attacker &&
        attacker !== actor &&
        !attacker.fetchKind &&
        typeof actor?.fetchCp === 'function' &&
        typeof actor?.setCp === 'function'
    );
}

function applyCombatPointShield(session, actor, hit) {
    let damage = Math.max(0, Number(hit) || 0);
    if (!shouldDamageCp(session, actor)) {
        return damage;
    }

    const currentCp = Math.max(0, Number(actor.fetchCp()) || 0);
    const cpDamage = Math.min(currentCp, damage);
    if (cpDamage <= 0) {
        return damage;
    }

    actor.setCp(currentCp - cpDamage);
    return damage - cpDamage;
}

function receivedHit(session, actor, hit) {
    const Generics = invoke(path.actor);
    const victimSession = actor?.session;
    const hpDamage = applyCombatPointShield(session, actor, hit);

    actor.setHp(Math.max(0, actor.fetchHp() - hpDamage)); // HP bar would disappear if less than zero
    actor.statusUpdateVitals(actor);

    // On hit, actor should stand-up
    if (actor.state.fetchSeated()) {
        Generics.basicAction(session, actor, { actionId: 0 });
    }

    // Bummer
    if (actor.fetchHp() <= 0) {
        if (session.actor && session.actor !== actor && !session.actor.fetchKind) {
            const attacker = session.actor;
            const victim = actor;
            const Database = invoke('Database');
            const ServerResponse = invoke('GameServer/Network/Response');

            if (victim.fetchPvpFlag() === 1 || victim.fetchKarma() > 0) {
                // Legitimate PvP or PK-hunting kill
                attacker.setPvp(attacker.fetchPvp() + 1);
                session.dataSendToMe(ServerResponse.userInfo(attacker));
                session.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                session.dataSendToOthers(ServerResponse.relationChanged(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            } else {
                // PK kill (murdering an innocent white player/bot)
                attacker.setPk(attacker.fetchPk() + 1);
                attacker.setKarma(attacker.fetchKarma() + 360);
                session.dataSendToMe(ServerResponse.userInfo(attacker));
                session.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                session.dataSendToOthers(ServerResponse.relationChanged(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            }

            // Clear victim's flag
            victim.setPvpFlag(0);
            if (victim.session) {
                victim.session.dataSendToMe(ServerResponse.userInfo(victim));
                victim.session.dataSendToOthers(ServerResponse.relationChanged(victim), victim);
            } else {
                session.dataSendToOthers(ServerResponse.relationChanged(victim), victim);
            }
            session.dataSendToMe(ServerResponse.relationChanged(victim));

            if (victim.session && victim.session.pvpFlagTimer) {
                clearTimeout(victim.session.pvpFlagTimer);
                victim.session.pvpFlagTimer = undefined;
            }
        }

        Generics.die(session, actor);
        return;
    }

    wakeBotOnDamage(victimSession, session?.actor);
    actor.automation.replenishVitals(actor);
    Generics.enterCombatState(session, actor);
}

module.exports = receivedHit;
module.exports.applyCombatPointShield = applyCombatPointShield;

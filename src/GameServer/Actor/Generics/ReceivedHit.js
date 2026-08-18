const BOT_WAKEUP_THROTTLE_MS = 750;
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Karma = invoke('GameServer/Karma');

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
    // Damage needs a prompt response even if a visibility refresh woke this
    // bot a moment ago. Repeated damage is already rate-limited above.
    const BotAI = invoke('GameServer/Bot/BotAI');
    if (!BotAI.promoteForPlayerInteraction(victimSession, 'player_damage', attacker?.session)) {
        BotAI.wakeup(victimSession, { urgent: true });
    }
}

function damageSource(session, options = {}) {
    return options.source ?? session?.actor;
}

function shouldDamageCp(session, actor, source) {
    const attacker = source ?? session?.actor;
    return !!(
        attacker &&
        attacker !== actor &&
        !attacker.fetchKind &&
        typeof actor?.fetchCp === 'function' &&
        typeof actor?.setCp === 'function'
    );
}

function applyCombatPointShield(session, actor, hit, source) {
    let damage = Math.max(0, Number(hit) || 0);
    if (!shouldDamageCp(session, actor, source)) {
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

function applyTransferPain(session, actor, hit) {
    const incoming = Math.max(0, Number(hit) || 0);
    const percent = Math.max(0, Math.min(100, Number(EffectStats.add(actor, 'transDam')) || 0));
    const summon = actor?.summon;
    if (!incoming || !percent || !summon || summon.state?.fetchDead?.() === true || summon.isDead?.() === true) {
        return incoming;
    }

    const desired = Math.floor(incoming * percent / 100);
    const summonHp = Math.max(0, Number(summon.fetchHp?.()) || 0);
    const transferred = Math.min(desired, summonHp);
    if (!transferred) return incoming;

    summon.setHp(summonHp - transferred);
    summon.broadcastVitals?.();
    if ((Number(summon.fetchHp?.()) || 0) <= 0) {
        invoke(path.npc).die(session, session?.actor, summon);
    }
    return incoming - transferred;
}

function tauntAfterPkKill(session, victim, attacker = session?.actor) {
    if (!isBotSession(session) || !attacker || Number(attacker.fetchKarma?.() || 0) <= 0) return;

    const now = Date.now();
    if (now - Number(session.lastPkTauntAt || 0) < 15000) return;
    session.lastPkTauntAt = now;

    const victimName = victim?.fetchName?.() || 'another victim';
    const lines = [
        `${victimName}, you should have run while you could.`,
        `Another one falls. Remember the name ${attacker.fetchName()}.`,
        `${victimName} was easy prey.`
    ];
    invoke('GameServer/Bot/BotAI').say(session, lines[Math.floor(Math.random() * lines.length)]);
}

function receivedHit(session, actor, hit, options = {}) {
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const victimSession = actor?.session;
    const source = damageSource(session, options);
    const hpDamage = applyCombatPointShield(session, actor, applyTransferPain(session, actor, hit), source);

    if (options.wakeSleep !== false) {
        EffectRestrictions.wakeOnDamage(actor, victimSession || session);
    }
    actor.setHp(Math.max(0, actor.fetchHp() - hpDamage)); // HP bar would disappear if less than zero
    actor.statusUpdateVitals(actor);

    // On hit, actor should stand-up
    if (actor.state.fetchSeated()) {
        Generics.basicAction(session, actor, { actionId: 0 });
    }

    // Bummer
    if (actor.fetchHp() <= 0) {
        if (source && source !== actor && !source.fetchKind) {
            const attacker = source;
            const victim = actor;
            const attackerSession = attacker.session || session;
            const Database = invoke('Database');
            const ServerResponse = invoke('GameServer/Network/Response');

            if (victim.fetchPvpFlag() === 1 || victim.fetchKarma() > 0) {
                // Legitimate PvP or PK-hunting kill
                attacker.setPvp(attacker.fetchPvp() + 1);
                attackerSession.dataSendToMe(ServerResponse.userInfo(attacker));
                attackerSession.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                attackerSession.dataSendToOthers(ServerResponse.relationChanged(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            } else {
                // PK kill (murdering an innocent white player/bot)
                const karmaAward = Karma.pkKillKarma(attacker, victim);
                attacker.setPk(attacker.fetchPk() + 1);
                attacker.setKarma(attacker.fetchKarma() + karmaAward);
                attackerSession.dataSendToMe(ServerResponse.userInfo(attacker));
                attackerSession.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
                attackerSession.dataSendToOthers(ServerResponse.relationChanged(attacker), attacker);
                Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
            }

            // Clear victim's flag
            victim.setPvpFlag(0);
            if (victim.session) {
                victim.session.dataSendToMe(ServerResponse.userInfo(victim));
                victim.session.dataSendToOthers(ServerResponse.relationChanged(victim), victim);
            } else {
                attackerSession.dataSendToOthers(ServerResponse.relationChanged(victim), victim);
            }
            attackerSession.dataSendToMe(ServerResponse.relationChanged(victim));

            if (victim.session && victim.session.pvpFlagTimer) {
                clearTimeout(victim.session.pvpFlagTimer);
                victim.session.pvpFlagTimer = undefined;
            }

            tauntAfterPkKill(attackerSession, victim, attacker);
        }

        Generics.die(session, actor);
        return;
    }

    wakeBotOnDamage(victimSession, source);
    actor.automation.replenishVitals(actor);
    Generics.enterCombatState(session, actor);
}

module.exports = receivedHit;
module.exports.applyCombatPointShield = applyCombatPointShield;
module.exports.applyTransferPain = applyTransferPain;

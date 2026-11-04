const BOT_WAKEUP_THROTTLE_MS = 750;
const EffectStats = invoke('GameServer/Effects/EffectStats');
const PvpRules = invoke('GameServer/PvpRules');

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
    invoke('GameServer/Bot/AI/PartyAwareness').invalidateThreatProjection(victimSession);

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

function applyCombatPointShield(session, actor, hit, source) {
    const attacker = source ?? session?.actor;
    const playable = !!attacker && attacker !== actor && PvpRules.isPlayable(attacker)
        && typeof actor?.fetchCp === 'function' && typeof actor?.setCp === 'function';
    const cp = playable ? Math.max(0, Number(actor.fetchCp()) || 0) : 0;
    const shielded = PvpRules.shieldDamage(cp, hit, playable);
    if (shielded.cp !== cp) actor.setCp(shielded.cp);
    return shielded.hp;
}

function applyTransferPain(session, actor, hit) {
    const incoming = Math.max(0, Number(hit) || 0);
    const percent = Math.max(0, Math.min(100, Number(EffectStats.add(actor, 'transDam')) || 0));
    const summon = actor?.summon;
    if (!incoming || !percent || !summon || summon.state?.fetchDead?.() === true || summon.isDead?.() === true) {
        return incoming;
    }

    // Lisvus C4 uses the master's 4000-unit forget range, not the later
    // chronicles' short transfer radius. A servitor must survive the transfer.
    const distanceSquared = ['fetchLocX', 'fetchLocY', 'fetchLocZ'].reduce((sum, coord) => {
        const delta = (Number(actor[coord]?.()) || 0) - (Number(summon[coord]?.()) || 0);
        return sum + delta * delta;
    }, 0);
    if (distanceSquared > 4000 * 4000) return incoming;

    const desired = Math.floor(incoming * percent / 100);
    const summonHp = Math.max(0, Number(summon.fetchHp?.()) || 0);
    const transferred = Math.min(desired, Math.max(0, summonHp - 1));
    if (!transferred) return incoming;

    summon.setHp(summonHp - transferred);
    summon.broadcastVitals?.();
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

// Lisvus L2PlayableInstance.doDie -> onKillUpdatePvPKarma: the acting
// player of the killer (a summon's or pet's owner) gets what PvpRules says for
// killing a character or its summon/pet; nothing inside an arena duel. A
// killed character loses its flag. Called for a character here and for a
// summon or pet by Npc Die.
function creditKill(session, source, victim) {
    if (!PvpRules.isPlayable(source) || !PvpRules.isPlayable(victim)) return null;
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const attacker = Threats.character(source), owner = Threats.character(victim);
    if (!attacker || !owner || attacker === owner
        || invoke('GameServer/World/ArenaCombatRules').suppressConsequences(attacker, owner)) return null;
    const attackerSession = attacker.session || session;
    const Database = invoke('Database');
    const ServerResponse = invoke('GameServer/Network/Response');
    const outcome = PvpRules.killOutcome({ killerKarma: attacker.fetchKarma(), victimKarma: owner.fetchKarma(),
        victimFlagged: owner.fetchPvpFlag() > 0, mutualWar: invoke('GameServer/Clan/ClanWarRuntime').between(attacker, owner).mutual,
        victimIsPlayer: victim === owner });
    if (victim === owner) {
        const isBotSession = invoke('GameServer/World/World').isBotSession;
        const isPlayer = (character) => !!character.session && !isBotSession(character.session);
        invoke('PvpJournal').hotKill({ attacker, victim, outcome, attackerKarma: attacker.fetchKarma(),
            playerInvolved: isPlayer(attacker) || isPlayer(victim), at: Date.now() });
    }
    if (outcome !== 'none') {
        const tally = PvpRules.tallyAfterKill({ pvp: attacker.fetchPvp(), pk: attacker.fetchPk(), karma: attacker.fetchKarma(),
            level: attacker.fetchLevel() }, outcome, owner.fetchLevel());
        attacker.setPvp(tally.pvp);
        attacker.setPk(tally.pk);
        attacker.setKarma(tally.karma);
        attackerSession.dataSendToMe(ServerResponse.userInfo(attacker));
        attackerSession.dataSendToOthers(ServerResponse.charInfo(attacker), attacker);
        attackerSession.dataSendToOthers(ServerResponse.relationChanged(attacker), attacker);
        Database.updateCharacterPvpPkKarma(attacker.fetchId(), attacker.fetchPvp(), attacker.fetchPk(), attacker.fetchKarma());
    }
    if (victim !== owner) return outcome;

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
    return outcome;
}

function receivedHit(session, actor, hit, options = {}) {
    if (invoke('GameServer/Effects/EffectStore').hasDebuff(actor, 'petrification')) return;
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const victimSession = actor?.session;
    const source = damageSource(session, options);
    const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
    if (source && source !== actor && !ArenaCombatRules.canInteract(source, actor)) return;
    if (Number(hit) > 0) {
        if (!ArenaCombatRules.suppressConsequences(source, actor) && Number(actor.fetchClanId?.()) > 0
            && (Number(source?.fetchClanId?.()) > 0 || Number(source?.fetchOwnerId?.()) > 0)) {
            invoke('GameServer/Clan/ClanWarRuntime').recordCombat(source, actor);
        }
        invoke('GameServer/Bot/AI/BotPvpThreats').record(actor, source);
    }
    const hpDamage = applyCombatPointShield(session, actor, applyTransferPain(session, actor, hit), source);

    if (options.wakeSleep !== false) {
        EffectRestrictions.wakeOnDamage(actor, victimSession || session);
    }
    const hpBefore = actor.fetchHp();
    if (Number(hit) > 0 && source && !source.fetchKind && !actor.fetchKind) {
        const Knowledge = require('../../Social/PeopleKnowledge');
        Knowledge.recordActor(actor, source); Knowledge.recordActor(source, actor);
    }
    actor.setHp(Math.max(0, hpBefore - hpDamage)); // HP bar would disappear if less than zero
    invoke('GameServer/Social/CombatHelpMemory').recordDamage(source, actor, hpBefore - actor.fetchHp());
    actor.statusUpdateVitals(actor);

    // On hit, actor should stand-up
    if (actor.state.fetchSeated()) {
        Generics.basicAction(session, actor, { actionId: 0 });
    }

    // Bummer
    if (actor.fetchHp() <= 0) {
        invoke('GameServer/Social/CombatHelpMemory').recordDefeat(source, actor);
        const killer = invoke('GameServer/Bot/AI/BotPvpThreats').character(source);
        if (killer && !ArenaCombatRules.suppressConsequences(killer, actor)) {
            invoke('GameServer/Bot/AI/BotEnemyMemory').record(actor, killer, true);
        }
        if (hpBefore > 0 && !actor.fetchKind) creditKill(session, source, actor);

        Generics.die(session, actor, { source, killer });
        return;
    }

    wakeBotOnDamage(victimSession, source);
    actor.automation.replenishVitals(actor);
    Generics.enterCombatState(session, actor);
}

module.exports = receivedHit;
module.exports.applyCombatPointShield = applyCombatPointShield;
module.exports.creditKill = creditKill;
module.exports.applyTransferPain = applyTransferPain;

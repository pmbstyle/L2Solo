'use strict';

const PvpRules = invoke('GameServer/PvpRules');
const Arena = invoke('GameServer/World/ArenaCombatRules');

function isSummon(target) {
    return target?.fetchIsSummon?.() === true || target?.fetchIsPet?.() === true;
}

function blockReason(attacker, target, requireFlag = false) {
    if (!isSummon(target) || attacker === target || !PvpRules.isPlayable(attacker)) return null;

    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    if (Threats.inPeace(attacker) || Threats.inPeace(target)) return 'peace_zone';
    const player = Threats.character(attacker);
    const owner = Threats.character(target);
    if (!player || !owner || player === owner || !Arena.canInteract(attacker, target)) return 'invalid_target';
    if (invoke('GameServer/Bot/AI/BotPvpRisk').sameParty(player.session, owner.session)) return 'invalid_target';

    // Lisvus L2Summon.isAutoAttackable delegates to the owner. A normal
    // request uses the owner's PvP status, including for persistent pets.
    if (!requireFlag || owner.fetchPvpFlag?.() > 0 || owner.fetchKarma?.() > 0) return null;
    const duel = invoke('GameServer/World/ArenaDuelService').duelForActor(target);
    return duel?.state === 'FIGHTING' ? null : 'invalid_target';
}

function allowRequest(session, attacker, target, ctrl) {
    const reason = blockReason(attacker, target, !ctrl);
    if (!reason) return true;

    const Response = invoke('GameServer/Network/Response');
    if (reason === 'peace_zone') {
        session.dataSendToMe(Response.speak(attacker, { kind: 0, text: 'You cannot attack summons or pets in a peace zone.' }));
    }
    session.dataSendToMe(Response.actionFailed());
    return false;
}

module.exports = { isSummon, blockReason, allowRequest };

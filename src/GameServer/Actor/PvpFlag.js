const PvpRules = invoke('GameServer/PvpRules');

function mark(session, actor, durationMs = PvpRules.FLAG_MS, until = Date.now() + durationMs) {
    const Response = invoke('GameServer/Network/Response');
    actor.setPvpFlag(1);
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToOthers(Response.charInfo(actor), actor);
    session.dataSendToOthers(Response.relationChanged(actor), actor);
    if (session.pvpFlagTimer) clearTimeout(session.pvpFlagTimer);
    session.pvpFlagUntil = until;
    session.pvpFlagTimer = setTimeout(() => {
        actor.setPvpFlag(0);
        session.dataSendToMe(Response.userInfo(actor));
        session.dataSendToOthers(Response.charInfo(actor), actor);
        session.dataSendToOthers(Response.relationChanged(actor), actor);
        session.pvpFlagTimer = undefined;
        session.pvpFlagUntil = 0;
    }, durationMs);
}

// Lisvus L2Character.doAttack and callSkill: a swing (hit or miss) or an
// offensive skill on a character or its summon/pet flags the acting player
// (a summon's or pet's owner) when PvpRules says so. Not its own summon, not
// a summon on its owner, not inside an arena duel.
function attack(session, attacker, target) {
    if (!PvpRules.isPlayable(attacker) || !PvpRules.isPlayable(target)) return false;
    const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const player = Threats.character(attacker), targetPlayer = Threats.character(target);
    if (!player || !targetPlayer || player === targetPlayer) return false;
    const Arena = invoke('GameServer/World/ArenaCombatRules');
    if (!Arena.canInteract(player, targetPlayer) || Arena.suppressConsequences(player, targetPlayer)) return false;
    if (!PvpRules.flagsAttacker(targetPlayer.fetchKarma?.())) return false;
    const playerSession = player === session?.actor ? session : player.session;
    if (!playerSession) return false;
    PvpFlag.mark(playerSession, player);
    return true;
}

function restore(session, actor, until) {
    const remaining = Number(until) - Date.now();
    if (remaining > 0) mark(session, actor, remaining, until);
}
const PvpFlag = module.exports = { mark, attack, restore };

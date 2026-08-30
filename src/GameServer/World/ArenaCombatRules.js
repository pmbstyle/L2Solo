// Rules shared by attack/skill/damage paths. Keeping this independent from
// ArenaDuelService makes it safe to call from packet handlers and tests.
function service() {
    return invoke('GameServer/World/ArenaDuelService');
}

function isEphemeral(actor) {
    return actor?.session?.arenaEphemeral === true;
}

function isArenaParticipant(actor) {
    return !!actor?.session?.arenaDuelId || isEphemeral(actor) || !!service().duelForActor?.(actor);
}

function participantFor(duel, actor) {
    if (!duel || !actor) return null;
    if (duel.player === actor) return duel.player;
    if (duel.bot === actor) return duel.bot;
    const ownerId = Number(actor.fetchOwnerId?.()) || 0;
    if (ownerId > 0 && Number(duel.player?.fetchId?.()) === ownerId) return duel.player;
    if (ownerId > 0 && Number(duel.bot?.fetchId?.()) === ownerId) return duel.bot;
    return null;
}

function canInteract(attacker, victim) {
    if (!attacker || !victim || attacker === victim) return false;
    const duel = service().duelForActor?.(attacker) || service().duelForActor?.(victim);
    if (!duel) return !isArenaParticipant(attacker) && !isArenaParticipant(victim);
    if (duel.state === 'PREPARED' && duel.enteredArena !== true) {
        return !isEphemeral(attacker) && !isEphemeral(victim);
    }
    const attackerParticipant = participantFor(duel, attacker);
    const victimParticipant = participantFor(duel, victim);
    return duel.state === 'FIGHTING'
        && !!attackerParticipant
        && !!victimParticipant
        && attackerParticipant !== victimParticipant;
}

function suppressConsequences(attacker, victim) {
    if (!attacker || !victim) return false;
    const duel = service().duelForActor?.(attacker) || service().duelForActor?.(victim);
    if (!duel) return false;
    const attackerParticipant = participantFor(duel, attacker);
    const victimParticipant = participantFor(duel, victim);
    return !!attackerParticipant && !!victimParticipant && attackerParticipant !== victimParticipant;
}

module.exports = { isEphemeral, isArenaParticipant, participantFor, canInteract, suppressConsequences };

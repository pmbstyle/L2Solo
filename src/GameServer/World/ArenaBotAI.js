const Generics = invoke('GameServer/Actor/Generics');
const BotAI = invoke('GameServer/Bot/BotAI');

function stop(duel) {
    if (!duel?.botSession) return;
    clearInterval(duel.botSession.arenaCombatTimer);
    duel.botSession.arenaCombatTimer = undefined;
    duel.bot?.automation?.abortAll?.(duel.bot);
}

function tick(duel) {
    if (!duel || duel.state !== 'FIGHTING' || !duel.player || !duel.bot) return;
    if (duel.player.state?.fetchDead?.() || duel.bot.state?.fetchDead?.()) return;
    // The native attack/cast implementation owns its complete action window:
    // meleeHit repeats on the actor's attack speed and remoteHit keeps casts
    // busy until their calculated hit time. Starting another combat decision
    // from the 250 ms arena poll would create parallel attack/cast chains.
    if (duel.bot.state?.fetchTowards?.()
        || duel.bot.state?.fetchHits?.()
        || duel.bot.state?.fetchCasts?.()) return;
    try {
        BotAI.executePvPCombat(duel.botSession, duel.bot, duel.player, Generics, {
            arena: true,
            playerPartyRaidLeaderSession: duel.playerSession
        });
    } catch (error) {
        utils.infoWarn('Arena', 'bot combat tick failed: %s', error.message || error);
    }
}

function start(duel) {
    if (!duel?.botSession || !duel.bot || !duel.player) return false;
    stop(duel);
    duel.botSession.arenaCombatTimer = setInterval(() => tick(duel), 250);
    duel.botSession.arenaCombatTimer.unref?.();
    tick(duel);
    return true;
}

module.exports = { start, stop, tick };

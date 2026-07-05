const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const SpeckMath = invoke('GameServer/SpeckMath');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

const MAX_LEVEL_GAP = 12;
const RECENT_ABANDON_MS = 5 * 60 * 1000;

function actorLocation(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function distance(a, b) {
    if (!a || !b) return null;
    return new SpeckMath.Point3D(a.locX, a.locY, a.locZ).distance(new SpeckMath.Point3D(b.locX, b.locY, b.locZ));
}

function reasonText(reason) {
    const text = {
        available: 'available',
        missing_actor: 'missing actor',
        player_dead: 'you are dead',
        bot_dead: 'dead',
        already_grouped: 'already grouped',
        merchant_duty: 'merchant duty',
        too_far: 'too far',
        low_trust: 'low trust',
        recently_abandoned: 'recently abandoned',
        level_gap_too_large: 'level gap too large',
        hunting_target: 'busy fighting'
    };
    return text[reason] || reason;
}

function clanIdOf(subject) {
    if (subject?.actor?.fetchClanId) return Number(subject.actor.fetchClanId()) || 0;
    if (subject?.fetchClanId) return Number(subject.fetchClanId()) || 0;
    return Number(subject?.clanId || subject?.stats?.clanId || 0);
}

function sameClan(player, botSubject) {
    const playerClanId = clanIdOf(player);
    if (playerClanId === 0) return false;
    return playerClanId === clanIdOf(botSubject);
}

function emptyResult(playerSession, botSubject) {
    const memory = BotSocialMemory.getSnapshot(playerSession, botSubject);
    return {
        available: false,
        reason: 'missing_actor',
        reasonText: reasonText('missing_actor'),
        distance: null,
        clanmate: false,
        relationship: BotSocialMemory.relationship(memory),
        memory
    };
}

const BotAvailability = {
    inviteRange: Config.partyInviteRange,

    evaluate(playerSession, botSession) {
        const player = playerSession?.actor;
        const bot = botSession?.actor;
        const result = emptyResult(playerSession, botSession);

        if (!player || !bot) return result;

        result.distance = distance(actorLocation(player), actorLocation(bot));
        result.clanmate = sameClan(player, bot);

        let reason = 'available';
        if (result.clanmate) reason = 'available';
        else if (player.isDead && player.isDead()) reason = 'player_dead';
        else if (bot.isDead && bot.isDead()) reason = 'bot_dead';
        else if (botSession.plan === 'merchant') reason = 'merchant_duty';
        else if (botSession.partyCompanion === true && botSession.followPlayerSession) reason = 'already_grouped';
        else if (result.distance !== null && result.distance > Config.partyInviteRange) reason = 'too_far';
        else if (result.memory.trust <= -6) reason = 'low_trust';
        else if (result.memory.recentlyAbandonedAt && Date.now() - result.memory.recentlyAbandonedAt < RECENT_ABANDON_MS) reason = 'recently_abandoned';
        else if (Math.abs(bot.fetchLevel() - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';

        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = reasonText(reason);
        return result;
    },

    evaluateState(playerSession, state) {
        const player = playerSession?.actor;
        const result = emptyResult(playerSession, state);
        if (!player || !state) return result;

        result.distance = distance(actorLocation(player), state.loc);
        result.clanmate = sameClan(player, state);

        let reason = 'available';
        if (result.clanmate) reason = 'available';
        else if (player.isDead && player.isDead()) reason = 'player_dead';
        else if (state.activity === 'dead' || Number(state.vitals?.hp || 1) <= 0) reason = 'bot_dead';
        else if (state.activity === 'merchant') reason = 'merchant_duty';
        else if (result.memory.trust <= -6) reason = 'low_trust';
        else if (result.memory.recentlyAbandonedAt && Date.now() - result.memory.recentlyAbandonedAt < RECENT_ABANDON_MS) reason = 'recently_abandoned';
        else if (Math.abs(Number(state.level || 1) - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';

        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = reasonText(reason);
        return result;
    },

    listForPlayer(playerSession, botSessions) {
        return botSessions
            .filter((session) => session.actor)
            .map((session) => ({
                session,
                bot: session.actor,
                availability: this.evaluate(playerSession, session)
            }))
            .sort((a, b) => {
                if (a.availability.available !== b.availability.available) return a.availability.available ? -1 : 1;
                return (a.availability.distance ?? Number.MAX_SAFE_INTEGER) - (b.availability.distance ?? Number.MAX_SAFE_INTEGER);
            });
    },

    reasonText
};

module.exports = BotAvailability;

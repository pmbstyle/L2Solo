const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const SpeckMath = invoke('GameServer/SpeckMath');

const INVITE_RANGE = 1500;
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

const BotAvailability = {
    inviteRange: INVITE_RANGE,

    evaluate(playerSession, botSession) {
        const player = playerSession?.actor;
        const bot = botSession?.actor;
        const memory = BotSocialMemory.getSnapshot(playerSession, botSession);
        const result = {
            available: false,
            reason: 'missing_actor',
            reasonText: reasonText('missing_actor'),
            distance: null,
            relationship: BotSocialMemory.relationship(memory),
            memory
        };

        if (!player || !bot) return result;

        result.distance = distance(actorLocation(player), actorLocation(bot));

        let reason = 'available';
        if (player.isDead && player.isDead()) reason = 'player_dead';
        else if (bot.isDead && bot.isDead()) reason = 'bot_dead';
        else if (botSession.plan === 'merchant') reason = 'merchant_duty';
        else if (botSession.partyCompanion === true && botSession.followPlayerSession) reason = 'already_grouped';
        else if (result.distance !== null && result.distance > INVITE_RANGE) reason = 'too_far';
        else if (memory.trust <= -6) reason = 'low_trust';
        else if (memory.recentlyAbandonedAt && Date.now() - memory.recentlyAbandonedAt < RECENT_ABANDON_MS) reason = 'recently_abandoned';
        else if (Math.abs(bot.fetchLevel() - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';

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

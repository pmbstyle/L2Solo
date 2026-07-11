const ServerResponse = invoke('GameServer/Network/Response');

const SOE_SKILL_ID = 2013;
const SOE_CAST_MS = 20000;
const SOE_DISTANCE = 2500;

function distance2d(bot, target) {
    const dx = bot.fetchLocX() - target.x;
    const dy = bot.fetchLocY() - target.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function hasCombatThreat(session, bot) {
    const recentIncoming = !!session.incomingThreatId &&
        Date.now() - Number(session.incomingThreatAt || 0) <= 5000;
    return !!session.currentTargetId || recentIncoming || !!bot.state.fetchHits?.();
}

function inCombat(session, bot) {
    return hasCombatThreat(session, bot) || !!bot.state.fetchCasts?.();
}

function clearCombatTrip(session) {
    session.pendingTownTrip = undefined;
    session.townEscape = undefined;
}

function interruptEscape(session, bot) {
    if (!session.townEscape) return false;
    session.townEscape = undefined;
    session.pendingTownTrip = session.pendingTownTrip || { reason: 'Finishing the fight before going to town.', requestedAt: Date.now() };
    session.plan = 'hunting';
    bot.state.setCasts(false);
    return true;
}

function beginEscape(session, bot, town) {
    const token = Symbol('bot_town_escape');
    const skill = {
        fetchSelfId: () => SOE_SKILL_ID,
        fetchCalculatedHitTime: () => SOE_CAST_MS,
        fetchReuseTime: () => 0
    };

    session.townEscape = { token, town: town.name, startedAt: Date.now(), completesAt: Date.now() + SOE_CAST_MS };
    bot.state.setCasts(true);
    session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);

    setTimeout(() => {
        if (session.townEscape?.token !== token) return;
        if (bot.isDead() || hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
            bot.state.setCasts(false);
            session.townEscape = undefined;
            session.plan = 'hunting';
            return;
        }

        bot.state.setCasts(false);
        session.townEscape = undefined;
        const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
        TeleportTo(session, bot, { locX: town.x, locY: town.y, locZ: town.z });
    }, SOE_CAST_MS);
}

function request(session, bot, BotAI, reason) {
    if (session.partyCompanion === true && session.followPlayerSession) return 'companion';

    const pending = session.pendingTownTrip || {};
    session.pendingTownTrip = { reason: reason || pending.reason || null, requestedAt: pending.requestedAt || Date.now() };
    if (inCombat(session, bot)) return 'deferred';

    const town = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.plan = 'shopping';
    session.shopTimer = Date.now();
    session.shoppingTarget = undefined;
    BotAI.say(session, session.pendingTownTrip.reason || `Heading to ${town.name} to sell and restock.`);
    session.pendingTownTrip = undefined;

    if (distance2d(bot, town) > SOE_DISTANCE) {
        BotAI.say(session, `${town.name} is far away. Using a Scroll of Escape.`);
        beginEscape(session, bot, town);
        return 'escape';
    }

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: { locX: town.x, locY: town.y, locZ: town.z }
    });
    return 'walk';
}

module.exports = { SOE_CAST_MS, SOE_DISTANCE, clearCombatTrip, hasCombatThreat, inCombat, interruptEscape, request };

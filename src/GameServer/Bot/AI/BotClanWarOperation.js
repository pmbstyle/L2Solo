'use strict';
const Home = require('../Population/ClanWarHome');
function tick(session, bot, party, now = Date.now()) {
    const op = party?.stats?.warOperation;
    if (!op || !require('../../Clan/ClanWarConfig').enabled) return false;
    if (session.pvpDefense || session.pvpRevenge || session.pvpEncounter) return false;
    if (bot.state?.fetchCasts?.() || !invoke('GameServer/Effects/EffectRestrictions').canUseBasicAction(bot)) return true;
    const returning = op.status === 'returning' || now >= op.expiresAt || Number(bot.fetchClanId?.()) !== op.clanId
        || !invoke('GameServer/Clan/ClanWarRuntime').view.between(op.clanId, op.enemyClanId).mutual;
    const spotId = returning ? op.homeSpotId : op.targetSpotId;
    const template = invoke('GameServer/Bot/AI/SpotService').findById(spotId) || invoke('GameServer/Bot/Population/SpotProfiles').findById(spotId);
    const point = returning ? Home.point(op, template) : op.targetLoc;
    if (!point || !template) return true;
    const loc = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    const atPoint = returning ? Home.reached(loc, point, 600)
        : Math.hypot(loc.locX - point.locX, loc.locY - point.locY) <= 600
            && Math.abs(loc.locZ - point.locZ) <= 200;
    if (atPoint) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, bot);
        session.lastDecision = { action: returning ? 'clan_war_home' : 'clan_war_hold', operationId: op.id, at: now };
        return true;
    }
    const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
    if (session.currentTargetId) {
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, bot);
        session.currentTargetId = undefined; bot.unselect?.();
    }
    const started = session.spotRelocation ? Travel.tick(session, bot)
        : Travel.start(session, bot, { ...template, center: point, arrivalPoints: [point] }, point);
    session.lastDecision = { action: started || session.spotRelocation ? 'clan_war_travel' : 'clan_war_wait_route',
        returning, operationId: op.id, spotId, at: now };
    return true;
}
module.exports = { tick };

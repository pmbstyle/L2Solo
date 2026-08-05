const ServerResponse = invoke('GameServer/Network/Response');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

const SOE_SKILL_ID = 2013;
const SOE_CAST_MS = 20000;
const TELEPORT_SETTLE_MS = 1200;

function active(session) {
    return !!session?.spotRelocation;
}

function cancel(session, bot, reason = 'cancelled') {
    if (!session?.spotRelocation) return false;
    if (session.spotRelocation.arrivalPending) return false;
    session.spotRelocation = undefined;
    bot?.state?.setCasts?.(false);
    session.lastSpotRelocation = { reason, at: Date.now() };
    return true;
}

function start(session, bot, spot, targetLoc = null) {
    if (!session || !bot || !spot) return false;
    if (session.spotRelocation) return session.spotRelocation.spotId === spot.id;

    const token = Symbol('spot-relocation');
    const destination = { ...(targetLoc || spot.center) };
    session.spotRelocation = {
        token,
        spotId: spot.id,
        destination,
        startedAt: Date.now(),
        completesAt: Date.now() + SOE_CAST_MS,
        method: 'soe_gatekeeper'
    };
    bot.state.setCasts(true);
    const skill = {
        fetchSelfId: () => SOE_SKILL_ID,
        fetchCalculatedHitTime: () => SOE_CAST_MS,
        fetchReuseTime: () => 0
    };
    session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);

    setTimeout(() => {
        const relocation = session.spotRelocation;
        if (!relocation || relocation.token !== token) return;
        if (bot.isDead?.() || session.currentTargetId || session.incomingThreatId) {
            cancel(session, bot, 'combat_interrupt');
            return;
        }

        bot.state.setCasts(false);
        const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
        TeleportTo(session, bot, destination);
        const arrivedSpot = SpotService.findById(spot.id) || spot;
        SpotService.assignSpot(session, arrivedSpot);
        session.initialSpawnCoord = { ...arrivedSpot.center };
        session.townRoutePlan = null;
        session.spotRelocation = { ...relocation, arrivalPending: true };
        setTimeout(() => {
            if (session.spotRelocation?.token !== token) return;
            session.spotRelocation = undefined;
            session.lastSpotRelocation = {
                spotId: arrivedSpot.id,
                method: 'soe_gatekeeper',
                at: Date.now()
            };
        }, TELEPORT_SETTLE_MS);
        Promise.resolve(BotEventJournal.record({
            botId: bot.fetchId(),
            eventType: 'travel_complete',
            summary: `${bot.fetchName?.() || 'Bot'} reached ${arrivedSpot.name || 'a hunting ground'} via SoE and gatekeeper.`,
            weight: 2,
            dedupeKey: `spot-travel:${bot.fetchId()}:${arrivedSpot.id}`,
            coalesceWindowMs: 30000,
            meta: { spotId: arrivedSpot.id, method: 'soe_gatekeeper' }
        })).catch(() => {});
    }, SOE_CAST_MS);
    return true;
}

module.exports = { SOE_CAST_MS, TELEPORT_SETTLE_MS, active, cancel, start };

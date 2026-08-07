const ServerResponse = invoke('GameServer/Network/Response');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

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

function revealSupplyErrand(session, bot, options = {}) {
    if (session?.supplyErrandHidden !== true) return;
    session.supplyErrandHidden = false;
    session.dataSendToOthers?.(ServerResponse.charInfo(bot), bot);
    session.dataSendToOthers?.(ServerResponse.relationChanged(bot), bot);
    // Do not leave a half-started errand blocking the next player request.
    // The combat state remains authoritative; the player can ask again once
    // the party is safe.
    if (options.clearErrand === true && session.companionShopping?.kind === 'player_resource_purchase') {
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        session.preShopLocation = undefined;
    }
}

function revealInterruptedSupplyErrand(session, bot) {
    revealSupplyErrand(session, bot, { clearErrand: true });
}

function restoreSupplyHot(session, bot, reason = 'supply_errand_interrupted') {
    if (session?.supplyErrandPhase !== 'cold') {
        revealInterruptedSupplyErrand(session, bot);
        return Promise.resolve({ ok: true, reason: 'not_parked_cold' });
    }

    session.supplyErrandPhase = 'returning';
    revealInterruptedSupplyErrand(session, bot);
    if (session.coldLifeState) {
        session.coldLifeState = { ...session.coldLifeState, activity: session.plan || 'hunting' };
    }
    const BotAI = invoke('GameServer/Bot/BotAI');
    BotAI.stop?.(session);
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    return Promise.resolve().then(() => PopulationService.markHot(session, reason)).catch(() => null).then(() => {
        session.supplyErrandPhase = undefined;
        BotAI.init?.(session);
        return { ok: true, reason };
    });
}

function interruptEscape(session, bot) {
    if (!session.townEscape) return false;
    session.townEscape = undefined;
    session.pendingTownTrip = session.pendingTownTrip || { reason: 'Finishing the fight before going to town.', requestedAt: Date.now() };
    session.plan = 'hunting';
    bot.state.setCasts(false);
    restoreSupplyHot(session, bot, 'supply_errand_interrupted');
    return true;
}

function beginEscape(session, bot, town, options = {}) {
    const token = Symbol('bot_town_escape');
    const skill = {
        fetchSelfId: () => SOE_SKILL_ID,
        fetchCalculatedHitTime: () => SOE_CAST_MS,
        fetchReuseTime: () => 0
    };

    session.townEscape = { token, town: town.name, startedAt: Date.now(), completesAt: Date.now() + SOE_CAST_MS };
    bot.state.setCasts(true);
    if (session.supplyErrandHidden !== true) {
        session.dataSendToMeAndOthers?.(ServerResponse.skillStarted(bot, bot.fetchId(), skill), bot);
    }

    setTimeout(() => {
        if (session.townEscape?.token !== token) return;
        if (bot.isDead() || hasCombatThreat(session, bot) || !bot.state.fetchCasts()) {
            bot.state.setCasts(false);
            session.townEscape = undefined;
            session.plan = 'hunting';
            restoreSupplyHot(session, bot, 'supply_errand_interrupted');
            return;
        }

        bot.state.setCasts(false);
        session.townEscape = undefined;
        const destination = { locX: town.x, locY: town.y, locZ: town.z };
        if (session.supplyErrandHidden === true) {
            // A companion supply run is a parked cold operation. The player
            // sees the request and the eventual return, never a bot walking
            // across the world or teleporting through intermediate locations.
            bot.setLocXYZ?.(destination);
        } else {
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            TeleportTo(session, bot, destination);
        }
        if (typeof options.onArrival === 'function') {
            Promise.resolve(options.onArrival(destination)).catch((error) => {
                utils.infoWarn('BotTownTravel', 'arrival callback failed for %s: %s', bot.fetchName?.() || bot.fetchId?.(), error.message || error);
            });
        }
        Promise.resolve(BotEventJournal.record({
            botId: bot.fetchId(),
            eventType: 'travel_complete',
            summary: `${bot.fetchName?.() || 'Bot'} arrived in ${town.name}.`,
            weight: 3,
            dedupeKey: `travel:${bot.fetchId()}:${town.name}`,
            coalesceWindowMs: 30000,
            meta: { town: town.name, mode: 'scroll_of_escape' }
        })).catch(() => {});
    }, SOE_CAST_MS);
}

function request(session, bot, BotAI, reason, options = {}) {
    if (session.partyCompanion === true && session.followPlayerSession && options.allowCompanion !== true) return 'companion';

    const pending = session.pendingTownTrip || {};
    session.pendingTownTrip = { reason: reason || pending.reason || null, requestedAt: pending.requestedAt || Date.now() };
    if (inCombat(session, bot)) return 'deferred';

    const town = options.destinationTown || BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.plan = 'shopping';
    session.shopTimer = Date.now();
    if (options.preserveShoppingTarget !== true) session.shoppingTarget = undefined;
    if (options.announce !== false) {
        BotAI.say(session, session.pendingTownTrip.reason || `Heading to ${town.name} to sell and restock.`);
    }
    session.pendingTownTrip = undefined;

    if (options.forceScrollOfEscape === true || distance2d(bot, town) > SOE_DISTANCE) {
        BotAI.say(session, options.forceScrollOfEscape === true
            ? `Using a Scroll of Escape to reach ${town.name}.`
            : `${town.name} is far away. Using a Scroll of Escape.`);
        beginEscape(session, bot, town, options);
        return 'escape';
    }

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: { locX: town.x, locY: town.y, locZ: town.z }
    });
    return 'walk';
}

module.exports = {
    SOE_CAST_MS,
    SOE_DISTANCE,
    clearCombatTrip,
    hasCombatThreat,
    inCombat,
    interruptEscape,
    request,
    revealSupplyErrand,
    restoreSupplyHot
};

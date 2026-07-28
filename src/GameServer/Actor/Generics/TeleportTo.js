const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');

const COMPANION_TELEPORT_OFFSETS = [
    { locX: 80, locY: 0 },
    { locX: -80, locY: 0 },
    { locX: 0, locY: 80 },
    { locX: 0, locY: -80 },
    { locX: 60, locY: 60 },
    { locX: -60, locY: -60 },
    { locX: 60, locY: -60 },
    { locX: -60, locY: 60 }
];

function isBotSession(session) {
    return session?.constructor?.name === 'BotSession'
        || String(session?.accountId || '').startsWith('bot_');
}

function syncPartyCompanions(leaderSession, destination, Generics, companions = null) {
    if (isBotSession(leaderSession)) {
        return 0;
    }

    const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
    const activeCompanions = companions || PartyCompanionService.membersForLeader(leaderSession);
    let moved = 0;

    activeCompanions.forEach((companionSession) => {
        if (!companionSession?.actor) {
            return;
        }

        const companion = companionSession.actor;
        const offset = COMPANION_TELEPORT_OFFSETS[moved % COMPANION_TELEPORT_OFFSETS.length];
        const companionDestination = {
            locX: destination.locX + offset.locX,
            locY: destination.locY + offset.locY,
            locZ: destination.locZ
        };
        moved += 1;

        // A leader's teleport ends a field recovery attempt. Revive first because
        // TeleportTo deliberately rejects dead actors, then place every active
        // companion beside the leader instead of leaving it on the former spot.
        if (companion.isDead?.()) {
            Generics.revive(companionSession, companion, { delayMs: 0, restoreFullVitals: true });
        }

        companionSession.deathTimerStart = undefined;
        companionSession.currentTargetId = undefined;
        companionSession.incomingThreatId = undefined;
        companionSession.incomingThreatAt = undefined;
        companionSession.returnToPartyAfterSupport = false;
        companionSession.resumeAfterBuff = undefined;
        companionSession.companionShopping = undefined;
        companionSession.shoppingTarget = undefined;
        companionSession.preShopLocation = undefined;
        companionSession.plan = 'following';
        // Keep an explicit Hold order, but move its anchor to the leader's new
        // location. A teleport must not silently turn a player command off.
        companionSession.stayLocation = companionSession.botStay ? { ...companionDestination } : null;
        companion.unselect?.();
        Generics.teleportTo(companionSession, companion, companionDestination);
    });

    return moved;
}

function teleportTo(session, actor, coords) {
    const Generics = invoke(path.actor);

    if (actor.isDead()) {
        return;
    }

    // NOTE: Do NOT override coords.locZ with GeodataEngine.getHeight() here.
    // Teleport destinations (from teleports.json, spawn coords, etc.) already have
    // correct Z values taken from authentic L2J server data. Overriding with geodata
    // produces wrong Z (e.g. underground layer, water level) causing the actor to
    // fall through terrain. Geodata Z-correction is only appropriate during movement.

    actor.clearDestId();
    actor.automation.abortAll(actor);
    session.dataSendToMeAndOthers(ServerResponse.teleportToLocation(actor.fetchId(), coords), actor);

    // Turns out to be a viable solution
    setTimeout(() => {
        Generics.updatePosition(session, actor, coords, { immediateNpcInfo: true, forceRefresh: true });

        // The leader must be at the destination before companions receive an
        // AI wakeup. Otherwise their follow tick still reads the old leader
        // position and immediately schedules a catch-up teleport backwards.
        syncPartyCompanions(session, coords, Generics);

        // Wake up bot AI after teleportation is complete and position updated
        if (session.aiActive) {
            const BotAI = invoke('GameServer/Bot/BotAI');
            BotAI.wakeup(session);
        }
    }, 1000);
}

module.exports = teleportTo;
module.exports.syncPartyCompanions = syncPartyCompanions;

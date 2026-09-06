const assert = require('assert');

require('../src/Global');

const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const BotSpotTravel = invoke('GameServer/Bot/AI/BotSpotTravel');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const TownGatekeeperCatalog = invoke('GameServer/Bot/AI/TownGatekeeperCatalog');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');

function botAt(loc) {
    let casts = false;
    return {
        moves: [],
        teleports: [],
        fetchId: () => 2000500,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchName: () => 'Travel Bot',
        isDead: () => false,
        clearDestId() {},
        automation: { abortAll() {} },
        moveTo(data) { this.moves.push(data); },
        state: {
            fetchHits: () => false,
            fetchCasts: () => casts,
            setCasts(value) { casts = value; }
        }
    };
}

function session(actor) {
    return {
        actor,
        plan: 'hunting',
        dataSendToMeAndOthers() {}
    };
}

const originalSetTimeout = global.setTimeout;
const originalNow = Date.now;
const originalCharInfo = Response.charInfo;
const originalRelationChanged = Response.relationChanged;
const originalFindById = SpotService.findById;
const originalAssignSpot = SpotService.assignSpot;
const originalRecord = BotEventJournal.record;
const originalNavigationMove = CompanionNavigationRecovery.move;
const originalNpcs = DataCache.npcs;
const originalNpcSpawns = DataCache.npcSpawns;

try {
    const timers = [];
    global.setTimeout = (fn, delay) => {
        timers.push({ fn, delay });
        return 0;
    };
    Response.charInfo = () => Buffer.from('char-info');
    Response.relationChanged = () => Buffer.from('relation');
    SpotService.findById = (id) => ({ id, name: 'Remote Field', center: { locX: 30000, locY: 0, locZ: -100 } });
    SpotService.assignSpot = (targetSession, spot) => {
        targetSession.currentSpot = spot;
        return spot;
    };
    BotEventJournal.record = () => Promise.resolve();

    const farBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const farSession = session(farBot);
    const farAi = {
        getClosestTown: () => ({ name: 'Far Town', x: 5000, y: 0, z: -100 }),
        say() {}
    };
    const farResult = BotTownTravel.request(farSession, farBot, farAi, 'Restocking.');
    assert.strictEqual(farResult, 'escape', 'far town trip should use Scroll of Escape');
    assert.strictEqual(farBot.moves.length, 0, 'far town trip should not start a long walk');
    assert.strictEqual(farSession.plan, 'shopping', 'SoE cast should enter shopping state');
    assert(farSession.townEscape, 'far town trip should expose an active SoE cast');
    assert.strictEqual(timers[0].delay, BotTownTravel.SOE_CAST_MS, 'ordinary bot SoE should preserve its 20 second cast');

    const closeBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const closeSession = session(closeBot);
    const closeResult = BotTownTravel.request(closeSession, closeBot, {
        getClosestTown: () => ({ name: 'Close Town', x: 1000, y: 0, z: -100 }),
        say() {}
    });
    assert.strictEqual(closeResult, 'walk', 'nearby town trip should stay on foot');
    assert.strictEqual(closeBot.moves.length, 1, 'nearby town trip should issue movement');

    const fightingBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const fightingSession = session(fightingBot);
    fightingSession.currentTargetId = 9001;
    const fightingResult = BotTownTravel.request(fightingSession, fightingBot, farAi, 'Restocking after combat.');
    assert.strictEqual(fightingResult, 'deferred', 'town trip should wait for active combat to finish');
    assert.strictEqual(fightingSession.plan, 'hunting', 'deferred trip should preserve combat state');
    assert(fightingSession.pendingTownTrip, 'deferred trip should remain pending');
    assert.strictEqual(fightingBot.moves.length, 0, 'fighting bot should not move toward town');
    fightingSession.currentTargetId = undefined;
    const resumedResult = BotTownTravel.request(fightingSession, fightingBot, farAi, fightingSession.pendingTownTrip.reason);
    assert.strictEqual(resumedResult, 'escape', 'pending town trip should start after combat ends');
    assert.strictEqual(fightingSession.pendingTownTrip, undefined, 'started town trip should clear its pending marker');

    const visiblePackets = [];
    const interruptedBot = botAt({ locX: 10, locY: 20, locZ: 30 });
    const interruptedSession = session(interruptedBot);
    interruptedSession.supplyErrandHidden = true;
    interruptedSession.dataSendToOthers = (packet) => visiblePackets.push(packet);
    BotTownTravel.revealSupplyErrand(interruptedSession, interruptedBot);
    assert.strictEqual(interruptedSession.supplyErrandHidden, false, 'terminal supply workflow must reveal the bot');
    assert.strictEqual(visiblePackets.length, 2, 'reveal must broadcast both character and relation packets');

    const kickedBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const kickedSession = session(kickedBot);
    kickedSession.incomingThreatId = 9002;
    kickedSession.incomingThreatAt = Date.now() - 6000;
    kickedSession.dataSendToMeAndOthers = () => {};
    const remoteSpot = { id: 'remote_field', name: 'Remote Field', center: { locX: 30000, locY: 0, locZ: -100 } };
    const kickedTimerBase = timers.length;
    assert.strictEqual(BotSpotTravel.start(kickedSession, kickedBot, remoteSpot), true, 'dismissed bot should start its hunting-ground SoE');
    assert.strictEqual(timers.length - kickedTimerBase, 1, 'starting hunting-ground travel must schedule exactly one cast timer');
    const kickedCastTimer = timers[kickedTimerBase];
    kickedCastTimer.fn();
    assert.strictEqual(kickedSession.spotRelocation?.arrivalPending, true, 'stale party combat memory must not cancel a completed SoE cast');
    assert.strictEqual(kickedSession.currentSpot?.id, remoteSpot.id, 'completed SoE must commit the requested hunting ground');

    const threatenedBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const threatenedSession = session(threatenedBot);
    threatenedSession.incomingThreatId = 9003;
    threatenedSession.incomingThreatAt = Date.now();
    const threatenedTimerBase = timers.length;
    BotSpotTravel.start(threatenedSession, threatenedBot, remoteSpot);
    assert.strictEqual(timers.length - threatenedTimerBase, 1, 'threatened travel must bind its own cast timer');
    timers[threatenedTimerBase].fn();
    assert.strictEqual(threatenedSession.spotRelocation, undefined, 'a live combat threat should still interrupt hunting-ground SoE');
    assert.strictEqual(threatenedSession.lastSpotRelocation?.reason, 'combat_interrupt', 'live-threat cancellation should remain observable');

    const cancelledBot = botAt({ locX: 0, locY: 0, locZ: 0 });
    const cancelledSession = session(cancelledBot);
    const cancelledTimerBase = timers.length;
    BotSpotTravel.start(cancelledSession, cancelledBot, remoteSpot);
    assert.strictEqual(timers.length - cancelledTimerBase, 1, 'cancelled travel must bind its own cast timer');
    assert.strictEqual(cancelledBot.state.fetchCasts(), true, 'travel must start the SoE cast before cancellation is exercised');
    cancelledBot.state.setCasts(false);
    timers[cancelledTimerBase].fn();
    assert.strictEqual(cancelledSession.spotRelocation, undefined, 'an externally cancelled cast must not teleport later from its stale timer');
    assert.strictEqual(cancelledSession.lastSpotRelocation?.reason, 'cast_interrupted', 'cancelled-cast cleanup should remain observable');

    DataCache.npcs = [{
        selfId: 7006,
        template: { kind: 'Teleporter', name: 'Roxxy', title: 'Gatekeeper' }
    }];
    DataCache.npcSpawns = [{
        spawns: [{
            selfId: 7006,
            name: 'Roxxy',
            coords: [{ locX: -84108, locY: 244604, locZ: -3729, head: 40960 }]
        }]
    }];
    const gatekeeper = TownGatekeeperCatalog.targetNear({ locX: -83000, locY: 244000, locZ: -3729 }, {
        worldSpawns: []
    });
    assert.strictEqual(gatekeeper?.npcSelfId, 7006, 'a bot in Talking Island must resolve the real city gatekeeper');

    const townLoc = { locX: -83000, locY: 244000, locZ: -3729 };
    const townBot = botAt(townLoc);
    const townSession = session(townBot);
    townSession.dataSendToMeAndOthers = () => {};
    const gateMoveBase = townBot.moves.length;
    assert.strictEqual(
        BotSpotTravel.startViaTownGatekeeper(townSession, townBot, remoteSpot),
        true,
        'a hot bot in town should start by walking to its gatekeeper'
    );
    assert.strictEqual(townSession.spotRelocation?.method, 'town_gatekeeper');
    assert.strictEqual(townBot.state.fetchCasts(), false, 'gatekeeper departure must not start a Scroll of Escape cast');
    assert.strictEqual(townBot.moves.length - gateMoveBase, 1, 'gatekeeper departure should issue a real movement command');

    const approachPoints = TownNpcApproach.pointsFor(gatekeeper);
    townLoc.locX = approachPoints.staging.locX;
    townLoc.locY = approachPoints.staging.locY;
    townLoc.locZ = approachPoints.staging.locZ;
    BotSpotTravel.tick(townSession, townBot);
    const interaction = townSession.townNpcApproach.destination;
    townLoc.locX = interaction.locX;
    townLoc.locY = interaction.locY;
    townLoc.locZ = interaction.locZ;
    BotSpotTravel.tick(townSession, townBot);
    assert(townSession.spotRelocation?.interactionReadyAt > Date.now(), 'arrival must begin a short visible interaction');
    assert(!townSession.spotRelocation.arrivalPending, 'arrival must not instantly transfer the bot');
    townSession.spotRelocation.interactionReadyAt = Date.now() - 1;
    BotSpotTravel.tick(townSession, townBot);
    assert.strictEqual(townSession.spotRelocation?.arrivalPending, true, 'interaction must complete before transfer');
    assert.strictEqual(townBot.state.fetchCasts(), false,
        'the transfer at the gatekeeper must remain free of cast animation');
    assert.strictEqual(townSession.currentSpot?.id, remoteSpot.id,
        'gatekeeper transfer should commit the chosen farming destination');

    const fallbackLoc = { locX: -83000, locY: 244000, locZ: -3729 };
    const fallbackBot = botAt(fallbackLoc);
    const fallbackSession = session(fallbackBot);
    fallbackSession.dataSendToMeAndOthers = () => {};
    CompanionNavigationRecovery.move = () => ({ status: 'exhausted', failures: 3 });
    const fallbackTimerBase = timers.length;
    assert.strictEqual(
        BotSpotTravel.startViaTownGatekeeper(fallbackSession, fallbackBot, remoteSpot),
        true,
        'an unreachable gatekeeper must still begin with the physical town route'
    );
    assert.strictEqual(fallbackSession.spotRelocation, undefined);
    assert.strictEqual(fallbackSession.lastSpotRelocation?.reason, 'gatekeeper_route_unreachable');
    assert(fallbackSession.townTravelRetryAt > Date.now(), 'unreachable routes need a finite cooldown');
    assert.strictEqual(fallbackBot.state.fetchCasts(), false, 'one failed recovery cycle must not grant a teleport');
    assert.strictEqual(timers.length, fallbackTimerBase, 'navigation failure must not schedule SoE');
    assert.strictEqual(BotSpotTravel.start(fallbackSession, fallbackBot, remoteSpot), false,
        'the next hunting tick must respect the cooldown instead of bypassing it with SoE');
    let recoveryNow = fallbackSession.townTravelRetryAt + 1;
    Date.now = () => recoveryNow;
    BotSpotTravel.start(fallbackSession, fallbackBot, remoteSpot);
    assert.strictEqual(fallbackBot.state.fetchCasts(), false, 'the second exhausted cycle must still wait');
    recoveryNow = fallbackSession.townTravelRetryAt + 1;
    BotSpotTravel.start(fallbackSession, fallbackBot, remoteSpot);
    assert.strictEqual(fallbackBot.state.fetchCasts(), true, 'confirmed prolonged stuckness must retain the emergency SoE');
    assert.strictEqual(fallbackSession.spotRelocation?.recoveryReason, 'town_stuck_after_recovery');
    assert.strictEqual(fallbackSession.spotRelocation?.arrivalPending, undefined, 'emergency recovery must not teleport instantly');
    const emergencyTimer = timers.at(-1);
    assert.strictEqual(emergencyTimer.delay, BotSpotTravel.SOE_CAST_MS);
    emergencyTimer.fn();
    assert.strictEqual(fallbackSession.spotRelocation?.arrivalPending, true, 'the full emergency cast must complete travel');
    timers.at(-1).fn();
    assert.strictEqual(fallbackSession.lastSpotRelocation?.recoveryReason, 'town_stuck_after_recovery', 'last-resort escapes must remain diagnosable');

    const movedLoc = { ...fallbackLoc }, movedBot = botAt(movedLoc), movedSession = session(movedBot);
    for (let cycle = 0; cycle < 3; cycle++) {
        BotSpotTravel.startViaTownGatekeeper(movedSession, movedBot, remoteSpot);
        if (cycle < 2) recoveryNow = movedSession.townTravelRetryAt + 1;
    }
    assert(movedSession.spotRelocation?.recoveryReason);
    const movedTimer = timers.at(-1);
    movedLoc.locX += 32;
    movedTimer.fn();
    assert.strictEqual(movedSession.spotRelocation, undefined, 'movement during emergency SoE must cancel the transfer');
    assert.strictEqual(movedSession.lastSpotRelocation.reason, 'cast_moved');

    CompanionNavigationRecovery.move = () => ({ status: 'moving', failures: 0 });
    const queuedBot = botAt({ ...fallbackLoc }), queuedSession = session(queuedBot);
    for (let cycle = 0; cycle < 3; cycle++) {
        BotSpotTravel.startViaTownGatekeeper(queuedSession, queuedBot, remoteSpot);
        queuedSession.lastPathfinding = { routeUsable: false, error: 'QUEUE_FULL', at: recoveryNow };
        recoveryNow += 120000;
        BotSpotTravel.recoverOrDefer(queuedSession, queuedBot);
        assert.strictEqual(queuedBot.state.fetchCasts(), false, 'repeated queue timeouts must never grant an escape');
        assert.strictEqual(queuedSession.townTravelRecovery.failures, 0);
        recoveryNow = queuedSession.townTravelRetryAt + 1;
    }
    const frozenBot = botAt({ ...fallbackLoc }), frozenSession = session(frozenBot);
    for (let cycle = 0; cycle < 3; cycle++) {
        BotSpotTravel.startViaTownGatekeeper(frozenSession, frozenBot, remoteSpot);
        frozenSession.lastPathfinding = { routeUsable: true, at: recoveryNow };
        recoveryNow += 120000;
        BotSpotTravel.recoverOrDefer(frozenSession, frozenBot);
        if (cycle < 2) recoveryNow = frozenSession.townTravelRetryAt + 1;
    }
    assert.strictEqual(frozenSession.spotRelocation?.recoveryReason, 'town_stuck_after_recovery',
        'repeated usable paths with no physical progress must also have a last-resort exit');
    BotSpotTravel.cancel(frozenSession, frozenBot);
    const missingGateBot = botAt({ locX: 83000, locY: 148000, locZ: -3400 });
    const missingGateSession = session(missingGateBot);
    for (let cycle = 0; cycle < 3; cycle++) {
        BotSpotTravel.start(missingGateSession, missingGateBot, remoteSpot);
        if (cycle < 2) {
            assert.strictEqual(missingGateBot.state.fetchCasts(), false);
            recoveryNow = missingGateSession.townTravelRetryAt + 1;
        }
    }
    assert.strictEqual(missingGateSession.spotRelocation?.recoveryReason, 'town_stuck_after_recovery',
        'a missing town service must not trap a stationary bot in cooldowns forever');
    BotSpotTravel.cancel(missingGateSession, missingGateBot);
    Date.now = originalNow;
    CompanionNavigationRecovery.move = originalNavigationMove;
    const localBot = botAt({ locX: gatekeeper.locX + 60, locY: gatekeeper.locY, locZ: gatekeeper.locZ });
    const localSession = session(localBot);
    assert.strictEqual(BotSpotTravel.start(localSession, localBot, remoteSpot), true);
    assert.strictEqual(localSession.spotRelocation.method, 'town_gatekeeper',
        'town location must select the gatekeeper even without a shopping announcement flag');
    assert.strictEqual(localBot.state.fetchCasts(), false);
    localSession.spotRelocation.startedAt = Date.now() - 120000;
    BotSpotTravel.recoverOrDefer(localSession, localBot);
    assert.strictEqual(localSession.spotRelocation.method, 'town_gatekeeper', 'arrival at a usable gatekeeper must win over an expired route timer');
    assert.strictEqual(localBot.state.fetchCasts(), false);
    BotSpotTravel.cancel(localSession, localBot);

    console.log('Bot town travel checks passed');
} finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    Response.charInfo = originalCharInfo;
    Response.relationChanged = originalRelationChanged;
    SpotService.findById = originalFindById;
    SpotService.assignSpot = originalAssignSpot;
    BotEventJournal.record = originalRecord;
    CompanionNavigationRecovery.move = originalNavigationMove;
    DataCache.npcs = originalNpcs;
    DataCache.npcSpawns = originalNpcSpawns;
}

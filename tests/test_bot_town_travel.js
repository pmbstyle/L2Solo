const assert = require('assert');

require('../src/Global');

const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
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
        isDead: () => false,
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
const originalCharInfo = Response.charInfo;
const originalRelationChanged = Response.relationChanged;

try {
    const timers = [];
    global.setTimeout = (fn, delay) => {
        timers.push({ fn, delay });
        return 0;
    };
    Response.charInfo = () => Buffer.from('char-info');
    Response.relationChanged = () => Buffer.from('relation');

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

    console.log('Bot town travel checks passed');
} finally {
    global.setTimeout = originalSetTimeout;
    Response.charInfo = originalCharInfo;
    Response.relationChanged = originalRelationChanged;
}

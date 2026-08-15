const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

const originalUsers = World.user;
const originalSessions = BotManager.sessions;
const originalUpsertState = LifeState.upsertState;
const originalMarkHot = LifeState.markHot;
const originalStop = BotAI.stop;
const originalAcceptColdState = ColdSimulationCoordinator.acceptColdState;

async function run() {
    const packets = [];
    let destroyed = false;
    const botSession = {
        accountId: 'bot_ghost',
        actor: {
            fetchId: () => 481516,
            destructor() { destroyed = true; }
        }
    };
    const playerSession = {
        accountId: 'player',
        dataSendToMe(packet) { packets.push(packet); }
    };

    World.user = { sessions: [playerSession, botSession] };
    BotManager.sessions = [botSession];
    LifeState.upsertState = (state) => Promise.resolve(state);
    BotAI.stop = () => {};
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: true, reason: 'test_ack' });

    const result = await Cooldown.transitionToColdState(botSession, {
        characterId: 481516,
        name: 'GhostBot'
    }, 'test_cleanup');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(destroyed, true, 'the cooled bot should be destroyed on the server');
    assert.strictEqual(botSession.actor, null, 'the cooled bot should no longer have an active actor');
    assert.strictEqual(BotManager.sessions.includes(botSession), false, 'the cooled bot should leave the hot population');
    assert.strictEqual(packets.length, 1, 'players must receive a cleanup packet even when the bot is no longer visible');
    assert.strictEqual(packets[0][0], 0x12, 'the cleanup packet must be DeleteObject');
    assert.strictEqual(packets[0].readInt32LE(1), 481516, 'DeleteObject must identify the cooled bot');

    let fencedDestroyed = false;
    const fencedSession = {
        accountId: 'bot_fenced',
        actor: {
            fetchId: () => 481517,
            destructor() { fencedDestroyed = true; }
        }
    };
    BotManager.sessions = [fencedSession];
    World.user = { sessions: [playerSession, fencedSession] };
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: false, reason: 'cold_worker_accept_timeout' });
    LifeState.markHot = () => Promise.resolve({ characterId: 481517, phase: 'hot' });
    const rejected = await Cooldown.transitionToColdState(fencedSession, {
        characterId: 481517,
        name: 'FencedBot'
    }, 'test_handoff_timeout');
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'cold_worker_accept_timeout');
    assert.strictEqual(fencedDestroyed, false, 'actor must remain authoritative until the worker acknowledges cold handoff');
    assert(fencedSession.actor, 'failed handoff must keep the hot actor alive');
    assert(BotManager.sessions.includes(fencedSession), 'failed handoff must keep the session in the hot population');
}

run()
    .then(() => console.log('Bot population cooldown cleanup checks passed'))
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        World.user = originalUsers;
        BotManager.sessions = originalSessions;
        LifeState.upsertState = originalUpsertState;
        LifeState.markHot = originalMarkHot;
        BotAI.stop = originalStop;
        ColdSimulationCoordinator.acceptColdState = originalAcceptColdState;
    });

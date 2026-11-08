const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Actor = invoke('GameServer/Actor/Actor');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const FailureLog = require('../src/FailureLog');
const Data = invoke('GameServer/DataCache');

const originalUsers = World.user;
const originalSessions = BotManager.sessions;
const originalUpsertState = LifeState.upsertState;
const originalMarkHot = LifeState.markHot;
const originalStop = BotAI.stop;
const originalAcceptColdState = ColdSimulationCoordinator.acceptColdState;

async function run() {
    const chaotic = { actor: { fetchKarma: () => 45, state: { fetchDead: () => false } }, plan: 'hunting' };
    assert.strictEqual(Cooldown.canCooldown(chaotic, { ignoreVisibility: true }).ok, true);
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, pvpDefense: {} }, { ignoreVisibility: true }).reason, 'pvp_active');
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, pkProfile: {} }, { ignoreVisibility: true }).reason, 'pk_active');
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, plan: 'pk_hunting' }, { ignoreVisibility: true }).reason, 'pk_active');
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

    // A cooled bot's body has left the world: a timed buff it carried ends with
    // no packet about it to anyone around and no failure.
    Data.init();
    const sent = [];
    const buffedSession = { accountId: 'bot_buffed', dataSendToMe: (packet) => sent.push(packet),
        dataSendToOthers: (packet) => sent.push(packet), dataSendToMeAndOthers: (packet) => sent.push(packet) };
    buffedSession.actor = new Actor(buffedSession, { id: 481518, name: 'BuffedBot', title: '',
        ...utils.crushOb(Data.classTemplates.find((row) => row.classId === 0)), level: 20, hp: 100, mp: 100,
        locX: 0, locY: 0, locZ: 0, items: [], paperdoll: utils.tupleAlloc(16, {}) });
    const shield = EffectStore.apply(buffedSession.actor, { key: 'shield', id: 1040, level: 1, type: 'buff', durationMs: 40 });
    assert.strictEqual(EffectTicker.scheduleExpiry(buffedSession, buffedSession.actor, shield), true);
    BotManager.sessions = [buffedSession];
    World.user = { sessions: [playerSession, buffedSession] };
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: true, reason: 'test_ack' });
    const failures = JSON.stringify(FailureLog.snapshot());
    assert.strictEqual((await Cooldown.transitionToColdState(buffedSession, { characterId: 481518, name: 'BuffedBot' },
        'test_buff_cleanup')).ok, true);
    sent.length = 0;
    packets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepStrictEqual(sent, [], 'an expiring buff sends nothing about a cooled bot');
    assert.deepStrictEqual(packets, []);
    assert.strictEqual(JSON.stringify(FailureLog.snapshot()), failures, 'no failure when a cooled bot\'s buff ends');
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

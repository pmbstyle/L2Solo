const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');

const originalUsers = World.user;
const originalSessions = BotManager.sessions;
const originalUpsertState = LifeState.upsertState;
const originalStop = BotAI.stop;

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
        BotAI.stop = originalStop;
    });

const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ReceivePacket = invoke('Packet/Receive');

function decode(packet) {
    const received = new ReceivePacket(packet);
    received.readD().readD().readS().readS();
    return { kind: received.data[1], text: received.data[3] };
}

async function main() {
    const originalFindSessionByName = BotManager.findSessionByName;
    const originalSessions = BotManager.sessions;
    const originalFindByName = LifeState.findByName;
    const originalAllStates = LifeState.allStates;
    const packets = [];
    const player = {
        actor: { fetchId: () => 9910, fetchName: () => 'NameTester' },
        dataSendToMe(packet) { packets.push(packet); }
    };
    try {
        BotManager.sessions = [{ actor: { fetchName: () => 'FennaHaven' } }];
        BotManager.findSessionByName = () => null;
        LifeState.findByName = async () => null;
        LifeState.allStates = () => [{ name: 'EloraHaven' }];

        const handled = await World.messageBotByName(player, player.actor, 'FenaHaven', 'hello', 'client_tell');
        assert.strictEqual(handled, false);
        const reply = decode(packets[0]);
        assert.strictEqual(reply.kind, 0);
        assert.match(reply.text, /Did you mean "FennaHaven"/i);
    } finally {
        BotManager.findSessionByName = originalFindSessionByName;
        BotManager.sessions = originalSessions;
        LifeState.findByName = originalFindByName;
        LifeState.allStates = originalAllStates;
    }
    console.log('Bot name suggestion checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

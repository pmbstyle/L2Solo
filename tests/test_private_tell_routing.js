const assert = require('assert');

require('../src/Global');

const SendPacket = invoke('Packet/Send');
const SpeakRequest = invoke('GameServer/Network/Request/Speak');
const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');

function actor(name, id = 2000001) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: () => true
    };
}

function privateTellBuffer(text, target) {
    return new SendPacket(0x38)
        .writeS(text)
        .writeD(2)
        .writeS(target)
        .fetchBuffer(false);
}

const originalMessageBotByName = World.messageBotByName;
const originalHandlePlayerSpeak = BotManager.handlePlayerSpeak;
const originalFindSessionByName = BotManager.findSessionByName;

try {
    const playerSession = {
        accountId: 'player_test',
        actor: actor('Slava'),
        selfPackets: 0,
        failed: 0,
        broadcasts: 0,
        dataSendToMe() { this.selfPackets++; },
        dataSendToMeAndOthers() { this.broadcasts++; }
    };

    let routedTell = null;
    let nearbyHookCalled = false;

    BotManager.findSessionByName = (name) => (
        String(name).toLowerCase() === 'partybot'
            ? { accountId: 'bot_partybot', actor: actor('PartyBot', 2000002) }
            : null
    );
    BotManager.handlePlayerSpeak = () => {
        nearbyHookCalled = true;
    };
    World.messageBotByName = (session, requestActor, name, text, source) => {
        routedTell = {
            session,
            actorName: requestActor.fetchName(),
            name,
            text,
            source
        };
        return Promise.resolve(true);
    };

    SpeakRequest(playerSession, privateTellBuffer('follow me', 'PartyBot'));

    assert.deepStrictEqual(routedTell, {
        session: playerSession,
        actorName: 'Slava',
        name: 'PartyBot',
        text: 'follow me',
        source: 'client_tell'
    });
    assert.strictEqual(nearbyHookCalled, false, 'private tell should not trigger nearby bot chat hook');
    assert.strictEqual(playerSession.broadcasts, 0, 'private tell should not broadcast to nearby players/bots');
    assert.strictEqual(playerSession.selfPackets, 1, 'private tell should echo the outgoing line to the sender');
} finally {
    World.messageBotByName = originalMessageBotByName;
    BotManager.handlePlayerSpeak = originalHandlePlayerSpeak;
    BotManager.findSessionByName = originalFindSessionByName;
}

console.log('Private tell routing regression checks passed');

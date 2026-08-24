const assert = require('assert');

require('../src/Global');

const SendPacket = invoke('Packet/Send');
const Speak = invoke('GameServer/Network/Request/Speak');

function chatBuffer(text) {
    return new SendPacket(0x38)
        .writeS(text)
        .writeD(0)
        .fetchBuffer(false);
}

const session = {
    accountId: 'player_alias_test',
    actor: {
        fetchId: () => 2000001,
        fetchName: () => 'AliasTester'
    }
};

const calls = [];
const originalInvoke = global.invoke;

try {
    global.invoke = (module) => {
        switch (module) {
            case 'GameServer/World/Generics/NpcBypasses/CompanionControl':
                return { render: (target) => calls.push(['bot', target]) };
            case 'GameServer/World/Generics/NpcBypasses/BotFriends':
                return { render: (target, view) => calls.push(['friends', target, view]) };
            case 'GameServer/World/Generics/NpcBypasses/BotParty':
                return { open: (target) => calls.push(['party', target]) };
            case 'GameServer/World/Generics/NpcBypasses/BotStatus':
                return (target, parts) => calls.push(['status', target, parts]);
            case 'GameServer/World/Generics/NpcBypasses/BotPath':
                return (target, parts) => calls.push(['path', target, parts]);
            default:
                return originalInvoke(module);
        }
    };

    Speak(session, chatBuffer('.b'));
    Speak(session, chatBuffer('.bf'));
    Speak(session, chatBuffer('.bf add'));
    Speak(session, chatBuffer('.bp'));
    Speak(session, chatBuffer('.bs AliasBot'));
    Speak(session, chatBuffer('.bpath AliasBot'));

    assert.deepStrictEqual(calls, [
        ['bot', session],
        ['friends', session, 'friends'],
        ['friends', session, 'add'],
        ['party', session],
        ['status', session, ['bot-status', 'AliasBot']],
        ['path', session, ['bot-path', 'AliasBot']]
    ], 'short bot commands should use the canonical command handlers and preserve arguments');

    assert.strictEqual(Speak.expandBotCommandAlias('.bystander'), '.bystander', 'aliases should only match a complete command token');
} finally {
    global.invoke = originalInvoke;
}

console.log('Bot command alias checks passed');

const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');

const originalFindSessionByName = BotManager.findSessionByName;
const originalRenderBotStatusPanel = BotManager.renderBotStatusPanel;

try {
    const playerSession = { actor: { fetchId: () => 1 } };
    const botSession = { actor: { fetchName: () => 'PartyHealer' } };
    let rendered = null;

    BotManager.findSessionByName = (name) => name === 'PartyHealer' ? botSession : null;
    BotManager.renderBotStatusPanel = (session, target) => { rendered = { session, target }; };

    NpcTalkResponse(playerSession, { link: 'bot-status PartyHealer' });
    assert.deepStrictEqual(
        rendered,
        { session: playerSession, target: botSession },
        'bot-status bypass should route the requested companion to its status panel'
    );
} finally {
    BotManager.findSessionByName = originalFindSessionByName;
    BotManager.renderBotStatusPanel = originalRenderBotStatusPanel;
}

console.log('Bot status bypass checks passed');

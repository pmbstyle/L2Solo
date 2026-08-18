const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');

const originalFindSessionByName = BotManager.findSessionByName;
const originalGetBotStatus = BotManager.getBotStatus;
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

    let statusPacket = null;
    const detailPlayerSession = {
        actor: {
            fetchId: () => 1,
            fetchLocX: () => 0,
            fetchLocY: () => 0,
            fetchLocZ: () => 0
        },
        dataSendToMe: (packet) => { statusPacket = packet; }
    };
    const detailBotSession = {
        staticService: true,
        actor: {
            fetchId: () => 2,
            fetchName: () => 'PartyHealer',
            fetchLocX: () => 0,
            fetchLocY: () => 0,
            fetchLocZ: () => 0
        }
    };
    BotManager.getBotStatus = () => ({
        available: true,
        name: 'PartyHealer',
        mode: 'hunting',
        intent: 'find_target',
        role: 'healer',
        home: { region: 'Talking Island', visitor: false },
        vitals: { hpPct: 1, mpPct: 1 },
        target: null,
        party: null,
        spot: null,
        nearby: { realPlayers: 0, friendlyBots: 0, attackableNpcs: 0 },
        movement: { moving: false, pathfinding: null, pathSummary: 'none' },
        blockers: [],
        decisions: { role: null, hunt: null, target: null, combat: null, pvp: null },
        buffs: { eligible: false, might: 0 },
        trade: {},
        persona: null
    });
    BotManager.renderBotStatusPanel = originalRenderBotStatusPanel;
    BotManager.renderBotStatusPanel(detailPlayerSession, detailBotSession);
    assert(statusPacket, 'bot status detail renderer should send an HTML response');
} finally {
    BotManager.findSessionByName = originalFindSessionByName;
    BotManager.getBotStatus = originalGetBotStatus;
    BotManager.renderBotStatusPanel = originalRenderBotStatusPanel;
}

console.log('Bot status bypass checks passed');

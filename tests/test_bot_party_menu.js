const assert = require('assert');

require('../src/Global');

const BotParty = invoke('GameServer/World/Generics/NpcBypasses/BotParty');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const NPC_HTML_LIMIT = ServerResponse.npcHtml.MAX_NPC_HTML_LENGTH;

const originals = {
    listForPlayer: BotAvailability.listForPlayer,
    sessions: BotManager.sessions,
    getBotStatus: BotManager.getBotStatus,
    findSessionByName: BotManager.findSessionByName,
    presentation: BotRoles.presentation,
    npcHtml: ServerResponse.npcHtml,
    inviteBotCompanion: World.inviteBotCompanion
};

let rendered = '';
let invited = null;
const entries = Array.from({ length: 19 }, (_, index) => {
    const name = `PartyCandidate${String(index + 1).padStart(2, '0')}`;
    const bot = {
        fetchId: () => 2000000 + index,
        fetchName: () => name,
        fetchLevel: () => 76
    };
    return {
        bot,
        session: { actor: bot, plan: 'hunting' },
        availability: {
            available: true,
            reasonText: 'available',
            memory: { trust: 42 },
            relationship: 'acquaintance',
            distance: 123456
        }
    };
});

const session = {
    actor: { fetchId: () => 1 },
    dataSendToMe() {}
};

try {
    BotAvailability.listForPlayer = () => entries;
    BotManager.sessions = entries.map((entry) => entry.session);
    BotManager.getBotStatus = () => ({ mode: 'hunting', vitals: { hpPct: 0.87 } });
    BotManager.findSessionByName = (name) => entries.find((entry) => entry.bot.fetchName() === name)?.session || null;
    BotRoles.presentation = () => ({ className: 'Elven Elder', role: 'healer' });
    ServerResponse.npcHtml = (_id, html) => {
        rendered = html;
        return Buffer.alloc(0);
    };
    World.inviteBotCompanion = (_session, _actor, targetSession) => {
        invited = targetSession;
        return true;
    };

    BotParty.render(session, 0);
    assert.ok(rendered.includes('PartyCandidate01'));
    assert.ok(rendered.includes('PartyCandidate08'));
    assert.ok(!rendered.includes('PartyCandidate09'), 'the first page must contain only eight candidate cards');
    assert.ok(rendered.includes('bot-party page 1'), 'the first page must link to the next page');
    assert.ok(rendered.includes('Page 1/3 (19)'));
    assert.ok(rendered.length < NPC_HTML_LIMIT,
        'a candidate page must stay under the C4 NpcHtml limit');

    BotParty(session, ['bot-party', 'page', '1']);
    assert.ok(rendered.includes('PartyCandidate09'));
    assert.ok(rendered.includes('PartyCandidate16'));
    assert.ok(!rendered.includes('PartyCandidate17'), 'the second page must not leak cards from the next page');
    assert.ok(rendered.includes('bot-party refresh 1'), 'refresh must retain the current page');
    assert.ok(rendered.includes('bot-party invite PartyCandidate09 1'), 'invite actions must retain the current page');
    assert.ok(rendered.length < NPC_HTML_LIMIT,
        'every candidate page must stay under the C4 NpcHtml limit');

    BotParty(session, ['bot-party', 'invite', 'PartyCandidate09', '1']);
    assert.strictEqual(invited, entries[8].session);
    assert.ok(rendered.includes('Page 2/3 (19)'), 'the menu must reopen on the same page after an invite');

    BotParty.render(session, 99);
    assert.ok(rendered.includes('PartyCandidate17'));
    assert.ok(rendered.includes('PartyCandidate19'));
    assert.ok(!rendered.includes('bot-party page 3'), 'an out-of-range page must clamp to the final page');

    console.log('Bot party menu pagination checks passed');
} finally {
    BotAvailability.listForPlayer = originals.listForPlayer;
    BotManager.sessions = originals.sessions;
    BotManager.getBotStatus = originals.getBotStatus;
    BotManager.findSessionByName = originals.findSessionByName;
    BotRoles.presentation = originals.presentation;
    ServerResponse.npcHtml = originals.npcHtml;
    World.inviteBotCompanion = originals.inviteBotCompanion;
}

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
    catalogForPlayer: BotAvailability.catalogForPlayer,
    evaluate: BotAvailability.evaluate,
    evaluateState: BotAvailability.evaluateState,
    sessions: BotManager.sessions,
    getBotStatus: BotManager.getBotStatus,
    presentation: BotRoles.presentation,
    npcHtml: ServerResponse.npcHtml,
    inviteBotByName: World.inviteBotByName
};

let rendered = '';
let invited = null;
let availabilityChecks = 0;
const entries = Array.from({ length: 19 }, (_, index) => {
    const name = `PartyCandidate${String(index + 1).padStart(2, '0')}`;
    const level = 76 - index;
    const bot = {
        fetchId: () => 2000000 + index,
        fetchName: () => name,
        fetchLevel: () => level
    };
    const hot = index % 2 === 0;
    return {
        session: hot ? { actor: bot, plan: 'hunting' } : null,
        state: hot ? null : {
            characterId: 2000000 + index,
            name,
            level,
            activity: 'traveling',
            vitals: { hp: 75, maxHp: 100 }
        },
        subject: bot,
        name,
        level,
        phase: hot ? 'hot' : 'cold',
        availability: {
            available: true,
            reasonText: 'available',
            relationship: 'acquaintance'
        }
    };
});

const session = {
    actor: { fetchId: () => 1 },
    dataSendToMe() {}
};

try {
    BotAvailability.catalogForPlayer = () => entries;
    BotAvailability.evaluate = (_playerSession, subject, options) => {
        availabilityChecks += 1;
        assert.deepStrictEqual(options, { loadMemory: false }, 'catalog sorting must not load social memory for every candidate');
        const name = subject.actor?.fetchName?.() || subject.name;
        const available = name !== 'PartyCandidate18' && name !== 'PartyCandidate19';
        return {
            available,
            reasonText: available ? 'available' : 'busy',
            relationship: 'acquaintance'
        };
    };
    BotAvailability.evaluateState = BotAvailability.evaluate;
    BotManager.sessions = entries.map((entry) => entry.session).filter(Boolean);
    BotManager.getBotStatus = () => ({ mode: 'hunting', vitals: { hpPct: 0.87 } });
    BotRoles.presentation = () => ({ className: 'Elven Elder', role: 'healer' });
    ServerResponse.npcHtml = (_id, html) => {
        rendered = html;
        return Buffer.alloc(0);
    };
    World.inviteBotByName = (_session, _actor, name) => {
        invited = name;
        return Promise.resolve(true);
    };

    BotParty.open(session);
    assert.ok(rendered.includes('<edit var="bot_name"'), 'the landing page should expose partial-name search');
    assert.ok(rendered.includes('bot-party level 70+'), 'the landing page should expose level-range browsing');
    assert.strictEqual((rendered.match(/<button /g) || []).length, 1,
        'the search action should be the only bitmap button on the landing page');
    assert.ok(rendered.includes('<a action="bypass -h bot-party level 1-19"'),
        'level ranges should render as stable C4 text links');
    assert.ok(!rendered.includes('PartyCandidate01'), 'the landing page should not dump the whole catalog before a selection');
    assert.strictEqual(availabilityChecks, 0, 'the landing page should not evaluate social availability for the whole catalog');

    BotParty(session, ['bot-party', 'search', 'candidate']);
    assert.ok(rendered.includes('PartyCandidate17'));
    assert.ok(rendered.includes('PartyCandidate10'));
    assert.ok(!rendered.includes('PartyCandidate09'), 'the first search page must contain only eight candidate cards');
    assert.ok(!rendered.includes('PartyCandidate19'), 'unavailable low-level bots must follow every inviteable candidate');
    assert.ok(rendered.includes('bot-party page 1'), 'the first search page must link to the next page');
    assert.ok(rendered.includes('Page 1/3 (19)'));
    assert.ok(rendered.includes('background / traveling'), 'cold bots should be distinguishable in search results');
    assert.strictEqual(availabilityChecks, 19,
        'the selected result set should be classified once so availability ordering works across pagination');
    assert.ok(rendered.length < NPC_HTML_LIMIT, 'a search result page must stay under the C4 NpcHtml limit');

    BotParty(session, ['bot-party', 'page', '1']);
    assert.ok(rendered.includes('PartyCandidate09'));
    assert.ok(rendered.includes('PartyCandidate02'));
    assert.ok(!rendered.includes('PartyCandidate01'), 'the second search page must not leak cards from the next page');
    assert.ok(rendered.includes('bot-party refresh'), 'refresh must retain the current menu state');
    assert.ok(rendered.includes('bot-party invite PartyCandidate09 1'), 'invite actions must retain the current page');
    assert.ok(rendered.length < NPC_HTML_LIMIT, 'every search result page must stay under the C4 NpcHtml limit');

    BotParty(session, ['bot-party', 'invite', 'PartyCandidate09', '1']);
    assert.strictEqual(invited, 'PartyCandidate09', 'menu invites must use the global named-invite path for hot and cold bots');
    assert.ok(rendered.includes('Page 2/3 (19)'), 'the menu must reopen on the same page after an invite');

    BotParty(session, ['bot-party', 'page', '99']);
    assert.ok(rendered.includes('PartyCandidate01'));
    assert.ok(rendered.includes('PartyCandidate19'));
    assert.ok(rendered.indexOf('PartyCandidate01') < rendered.indexOf('PartyCandidate19'),
        'all inviteable bots must sort ahead of unavailable bots across page boundaries');
    assert.ok(rendered.indexOf('PartyCandidate19') < rendered.indexOf('PartyCandidate18'),
        'unavailable bots should still sort from lower level to higher level');
    assert.ok(!rendered.includes('bot-party page 3'), 'an out-of-range page must clamp to the final page');

    BotParty(session, ['bot-party', 'home']);
    BotParty(session, ['bot-party', 'level', '70+']);
    assert.ok(rendered.includes('Role for Lv 70+'));
    assert.ok(rendered.includes('bot-party role healer'));
    assert.strictEqual((rendered.match(/<button /g) || []).length, 0,
        'role choices should use text links instead of bitmap buttons');
    BotParty(session, ['bot-party', 'role', 'healer']);
    assert.ok(rendered.includes('Lv 70+ / Healer (7)'), 'level and role filters should produce a level-sorted result set');
    assert.ok(rendered.indexOf('PartyCandidate07') < rendered.indexOf('PartyCandidate01'),
        'filtered results should order lower-level inviteable bots first');

    console.log('Bot party catalog, filtering and pagination checks passed');
} finally {
    BotAvailability.catalogForPlayer = originals.catalogForPlayer;
    BotAvailability.evaluate = originals.evaluate;
    BotAvailability.evaluateState = originals.evaluateState;
    BotManager.sessions = originals.sessions;
    BotManager.getBotStatus = originals.getBotStatus;
    BotRoles.presentation = originals.presentation;
    ServerResponse.npcHtml = originals.npcHtml;
    World.inviteBotByName = originals.inviteBotByName;
}

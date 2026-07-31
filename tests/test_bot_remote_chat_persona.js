const assert = require('assert');

require('../src/Global');

const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');

const state = {
    characterId: 7001,
    name: 'RemotePersonaBot',
    stats: { generatedIndex: 17 },
    homeRegion: 'Talking Island',
    vitals: { hp: 100, maxHp: 100 }
};

const first = BotRemoteChat.personaForState(state);
const second = BotRemoteChat.personaForState(state);
assert.deepStrictEqual(first, second, 'remote chat must use the same deterministic persona on every reply');
assert(first?.primaryDrive && first?.archetype && first?.textCard, 'remote chat context must include a complete persona card');

const soloReply = BotRemoteChat.fallbackReply(state, { available: false, reason: 'prefers_solo' }, 'party?');
assert(soloReply.includes('get to know'), 'fallback refusal must explain the social path forward');

console.log('Bot remote chat persona checks passed');

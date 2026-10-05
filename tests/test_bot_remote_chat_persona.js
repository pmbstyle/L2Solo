const assert = require('assert');

require('../src/Global');

const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const Database = invoke('Database');

const state = {
    characterId: 7001,
    name: 'RemotePersonaBot',
    stats: { generatedIndex: 17 },
    homeRegion: 'Talking Island',
    vitals: { hp: 100, maxHp: 100 }
};

(async () => {
// The stored persona, loaded at boot (BotPersona.loadAll).
const stored = BotPersona.generate(state);
const originalExecute = Database.execute;
Database.execute = () => Promise.resolve([{ characterId: stored.characterId, version: 2, seed: stored.seed,
    primaryDrive: stored.primaryDrive, archetype: stored.archetype, traitsJson: JSON.stringify(stored.traits),
    inclinationsJson: JSON.stringify(stored.inclinations), textCard: stored.textCard }]);
await BotPersona.loadAll();
Database.execute = originalExecute;
const first = BotRemoteChat.personaForState(state);
const second = BotRemoteChat.personaForState(state);
assert.deepStrictEqual(first, second, 'remote chat must use the same deterministic persona on every reply');
assert(first?.primaryDrive && first?.archetype && first?.textCard, 'remote chat context must include a complete persona card');
assert(first.dialogueVoice, 'off-screen private chat must retain the derived dialogue voice');
assert.strictEqual(first.archetype, stored.archetype, 'remote chat reads the stored persona');

const soloReply = BotRemoteChat.fallbackReply(state, { available: false, reason: 'prefers_solo' }, 'party?');
assert(soloReply.includes('get to know'), 'fallback refusal must explain the social path forward');

console.log('Bot remote chat persona checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

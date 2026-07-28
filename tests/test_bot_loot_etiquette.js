const assert = require('assert');

require('../src/Global');

const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');

function actor(id, dead = false) {
    return {
        fetchId: () => id,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => dead,
        state: { fetchDead: () => dead }
    };
}

const playerSession = { actor: actor(1) };
const liveBotSession = {
    actor: actor(2),
    followPlayerSession: playerSession,
    partyCompanion: true
};
const deadBotSession = {
    actor: actor(3, true),
    followPlayerSession: playerSession,
    partyCompanion: true
};

assert.strictEqual(
    BotLootEtiquette.shouldRecordIgnoredRequest({ playerSession, botSession: liveBotSession }),
    true,
    'an ignored request from a live companion should still affect social trust'
);
assert.strictEqual(
    BotLootEtiquette.shouldRecordIgnoredRequest({ playerSession, botSession: deadBotSession }),
    false,
    'a request that expires after the companion dies must not penalize the player'
);

console.log('Bot loot etiquette checks passed');

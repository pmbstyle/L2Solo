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

const casterDemand = BotLootEtiquette.itemDemand({ actor: { fetchClassId: () => 29 } }, {
    selfId: 321,
    name: 'Demon Fangs',
    kind: 'Weapon.Etc',
    weapon: true,
    armor: false,
    shot: false,
    potion: false,
    scroll: false,
    pAtk: 67,
    mAtk: 66,
    price: 1520000
});
assert(casterDemand.reasons.includes('caster weapon'), 'a healer must recognize Weapon.Etc caster drops without relying on name heuristics');

const physicalSword = {
    selfId: 148,
    name: 'Sword of Damascus',
    kind: 'Weapon.Sword',
    weapon: true,
    armor: false,
    shot: false,
    potion: false,
    scroll: false,
    pAtk: 194,
    mAtk: 61,
    price: 13100000
};
const healerSwordDemand = BotLootEtiquette.itemDemand({ actor: { fetchClassId: () => 29 } }, physicalSword);
const fighterSwordDemand = BotLootEtiquette.itemDemand({ actor: { fetchClassId: () => 0 } }, physicalSword);
assert(!healerSwordDemand.reasons.includes('caster weapon'), 'a healer must not claim an ordinary physical sword as caster gear');
assert(fighterSwordDemand.score > healerSwordDemand.score, 'a physical sword must retain higher demand for a melee damage dealer');

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

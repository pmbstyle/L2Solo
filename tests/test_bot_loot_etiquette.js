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

const meleeStaffDemand = BotLootEtiquette.itemDemand({ actor: { fetchClassId: () => 47 } }, {
    selfId: 178,
    name: 'Bone Staff',
    kind: 'Weapon.Blunt',
    weapon: true,
    armor: false,
    shot: false,
    potion: false,
    scroll: false,
    pAtk: 39,
    mAtk: 35,
    price: 409000
});
assert(!meleeStaffDemand.reasons.includes('damage weapon'),
    'an Orc Monk must not request a Bone Staff as a melee damage upgrade');
assert(meleeStaffDemand.reasons.includes('valuable drop'),
    'the negative weapon assertion must remain bound to a non-empty demand result');

const monkFistDemand = BotLootEtiquette.itemDemand({ actor: { fetchClassId: () => 47 } }, {
    selfId: 262,
    name: 'Scallop Jamadhr',
    kind: 'Weapon.DualFist',
    weapon: true,
    armor: false,
    shot: false,
    potion: false,
    scroll: false,
    pAtk: 112,
    mAtk: 54,
    price: 1800000
});
assert(monkFistDemand.reasons.includes('fist weapon'),
    'an Orc Monk must recognize Scallop Jamadhr as a class weapon');

const worseSwordDemand = BotLootEtiquette.itemDemand({
    actor: {
        fetchClassId: () => 0,
        backpack: { fetchEquippedWeapon: () => ({ fetchPAtk: () => 250, fetchMAtk: () => 100 }) }
    }
}, physicalSword);
assert(!worseSwordDemand.reasons.includes('damage weapon'),
    'a fighter must not claim a strictly worse sword as an equipment upgrade');

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

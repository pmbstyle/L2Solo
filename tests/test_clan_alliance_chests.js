const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
DataCache.init();
const world = { npc: { nextId: 1000000, spawns: [] }, user: { sessions: [] }, addNpcToGrid() {} };
const kills = [];
const mocks = {
    'GameServer/Pets/PetRuntime': { recordDamage() {} },
    'GameServer/Quest/QuestService': { onAttack: async () => {} },
    'GameServer/Bot/AI/BotSocialMemory': { recordCombatHelp() {} },
    'GameServer/Social/CombatHelpMemory': { recordDefeat() {} },
    'GameServer/Effects/EffectRestrictions': { wakeOnDamage() {} },
    'GameServer/Npc/SocialAggro': { notifyClan() {} },
    'GameServer/World/RaidBossMinionManager': {},
    'GameServer/World/World': world,
    'GameServer/Bot/AI/BotMobCompetition': { record() {} },
    'npc-generics': { die(session, actor, npc) { npc.state.setDead(true); kills.push(npc.fetchId()); } }
};
const moduleBox = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/GameServer/Npc/Generics/ReceivedHit.js'), 'utf8'), {
    module: moduleBox, invoke: key => { assert(key in mocks, key); return mocks[key]; }, path: { npc: 'npc-generics' },
    utils: { infoWarn: (...args) => assert.fail(args.join(' ')) }
});
const receiveHit = moduleBox.exports;
const spawn = (selfId, questId = 501) => SpawnNpcs.spawnQuestNpc(world, {
    selfId, questId, ownerId: 2000001, locX: 102273, locY: 103433, locZ: -3512
});
// The same native HP pipeline receives weapon, spell, summon and DOT damage;
// the smallest positive hit and powerful hits must all break each chest type.
for (const selfId of [5173, 5174, 5175, 5176, 5177]) {
    const template = DataCache.npcs.find(row => row.selfId === selfId);
    const original = JSON.stringify(template);
    for (const hit of [1, 50, 5000]) {
        const chest = spawn(selfId);
        assert.strictEqual(chest.fetchMaxHp(), 1);
        assert.strictEqual(chest.fetchHp(), 1);
        assert.strictEqual(chest.fetchRevHp(), 0);
        const attacker = { fetchLevel: () => 1, fetchId: () => 2000001 };
        receiveHit({ actor: attacker }, attacker, chest, hit);
        assert.strictEqual(chest.fetchHp(), 0, `${selfId} breaks from ${hit} damage`);
        assert(chest.state.fetchDead());
        const killed = kills.length;
        receiveHit({ actor: attacker }, attacker, chest, hit);
        assert.strictEqual(kills.length, killed, 'late hits cannot grant another kill');
        SpawnNpcs.despawnQuestNpc(world, chest);
    }
    assert.strictEqual(JSON.stringify(template), original, 'the shared C4 template stays unchanged');
    const otherQuest = spawn(selfId, 999);
    assert(otherQuest.fetchMaxHp() > 1, 'the override applies only to Athrea quest spawns');
    SpawnNpcs.despawnQuestNpc(world, otherQuest);
}
const ordinary = spawn(685);
assert(ordinary.fetchMaxHp() > 1, 'other quest mobs retain their real combat stats');
SpawnNpcs.despawnQuestNpc(world, ordinary);
console.log('Clan alliance chests: all five real templates, native damage, duplicate-hit and quest scope passed');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const Rules = require('../src/GameServer/Clan/ClanAllianceRules');
let state = { kind: 'player', stage: 'gathering', leaderId: 1, members: [
    { id: 2, itemId: 3833, npcId: 685, herb: false, delivered: false, blood: false }
] };
const transitions = [], movements = [], fights = [];
let incomingThreat = null;
const poisonEffects = [], spawnedChests = [];
function actor(id, selfId, x = 0) {
    return { x, y: 0, z: 0, dead: false, effects: {}, fetchId: () => id, fetchSelfId: () => selfId,
        fetchClanId: () => 1, fetchIsOnline: () => true, fetchLevel: () => 1, isDead() { return this.dead; },
        fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
        state: { fetchCasts: () => false, fetchSeated: () => false }, automation: { abortAll() {} },
        backpack: { items: [], fetchItemFromSelfId: () => null, fetchItems: () => [], insertItem() {} } };
}
const leader = { actor: actor(1, 0), accountId: 'player', dataSendToMe() {} };
const courier = { actor: actor(2, 0), accountId: 'bot_pop_test', dataSendToMe() {}, dataSendToOthers() {} };
const herb = actor(100, 685, 10000), kalis = actor(101, 7759, 10000), athrea = actor(102, 7758, 10000);
const world = { user: { sessions: [leader, courier] }, npc: { spawns: [herb, kalis, athrea] }, fetchNpcsInRadius: () => [] };
const mocks = {
    Database: {
        fetchClanAllianceQuest: async () => structuredClone(state), fetchItems: async () => [],
        transitionClanAlliance: async event => {
            transitions.push(event);
            if (event.event === 'kill') state.members[0].herb = true;
            if (event.event === 'deliver') state.members[0].delivered = true;
            return { ok: true, state: structuredClone(state) };
        }
    },
    'GameServer/World/World': world,
    'GameServer/Effects/EffectStore': {
        apply(actor, effect) { poisonEffects.push(effect); actor.effects[effect.key] = effect; return effect; },
        remove(actor, key) { delete actor.effects[key]; }
    },
    'GameServer/Effects/EffectTicker': { applyDot() {}, scheduleExpiry() {}, refreshEffects() {}, clear() {} },
    'GameServer/Actor/Generics/Die': (session, actor) => { actor.dead = true; },
    'GameServer/Network/Response': { itemsList() {}, sitAndStand() {} },
    'GameServer/Bot/AI/HotActorLodPolicy': { promote() {} },
    'GameServer/Quest/QuestService': { questRates: () => ({ questSp: 1 }) },
    'GameServer/Bot/AI/CompanionNavigationRecovery': { move: (...args) => movements.push(args) },
    'GameServer/Bot/AI/PartyAwareness': { npcThreateningActor: () => incomingThreat },
    'GameServer/Bot/AI/TownTransitPolicy': { townAt: () => null },
    'GameServer/Bot/AI/BotSpotTravel': { tick() {}, cancel() {}, startViaTownGatekeeper: () => false }
};
function load(relative) {
    const filename = path.join(root, relative), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: createRequire(filename),
        invoke: key => { if (!(key in mocks)) throw new Error(`Unexpected module ${key}`); return mocks[key]; },
        utils: { infoWarn: (...args) => { throw new Error(args.join(' ')); } }, Date, Math, Map, Set, Promise, Number, String }, { filename });
    return module.exports;
}
const service = load('src/GameServer/Clan/ClanAllianceService.js');
mocks['GameServer/Clan/ClanAllianceService'] = service;
const ai = load('src/GameServer/Bot/AI/ClanAllianceQuestAI.js');
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function main() {
    await service.snapshot(courier);
    assert(courier.clanAllianceQuest, 'online member receives persisted assignment without a level check');
    courier.clanAllianceRefreshAt = Date.now() + 10000;
    const combat = { executeCombat: (...args) => fights.push(args) };
    assert(ai.tick(courier, courier.actor, {}, combat));
    assert.strictEqual(movements.length, 1, 'far member physically travels toward the herb mob');
    assert.strictEqual(transitions.length, 0, 'travel does not synthesize kills or items');
    assert.strictEqual(fights.length, 0);
    courier.actor.x = herb.x;
    ai.tick(courier, courier.actor, {}, combat);
    assert.strictEqual(fights.length, 1, 'arrival invokes actual combat');
    assert.strictEqual(transitions.length, 0, 'combat attempt alone is not a kill');
    incomingThreat = actor(200, 123, courier.actor.x);
    ai.tick(courier, courier.actor, {}, combat);
    assert.strictEqual(fights.at(-1)[2], incomingThreat, 'courier defends against real attackers');
    assert.strictEqual(transitions.length, 0, 'self-defense does not fabricate quest progress');
    incomingThreat = null;
    await service.onKill(courier, herb);
    assert.strictEqual(transitions.length, 0, 'a living target is not a quest kill');
    herb.dead = true;
    courier.actor.x = 0;
    await service.onKill(courier, herb);
    assert.strictEqual(transitions.length, 0, 'remote kills do not grant items');
    courier.actor.x = herb.x;
    await service.onKill(courier, herb);
    assert.strictEqual(transitions[0].event, 'kill');
    await service.onKill(courier, herb);
    assert.strictEqual(transitions.length, 1, 'duplicate death callbacks do not reroll drops');
    ai.tick(courier, courier.actor, {}, combat);
    assert.strictEqual(movements.at(-1)[2].locX, 0, 'carrying member heads to leader, not to warehouse');
    assert(!(await service.transition(courier, 'deliver')).ok, 'even internal delivery requires proximity');
    courier.activeNpcTalk = { selfId: 7759, objectId: kalis.fetchId() };
    assert(!(await service.event(courier, 'deliver')).ok, 'being near Kalis is insufficient while leader is far away');
    courier.actor.x = 0;
    ai.tick(courier, courier.actor, {}, combat);
    await flush();
    assert.strictEqual(transitions.at(-1).event, 'deliver');
    assert.strictEqual(state.members[0].delivered, true);
    assert.strictEqual(ai.tick(courier, courier.actor, {}, combat), false, 'returned member can resume party support');
    const chest = actor(103, 5173, 0);
    chest.dead = true; chest.allianceChestToken = 'attempt'; chest.questSpawn = { ownerId: 999, questId: 501 };
    const before = transitions.length;
    await service.onKill(courier, chest);
    assert.strictEqual(transitions.length, before, 'another clans chest cannot advance this quest');
    leader.actor.dead = true;
    await service.onKill(courier, herb);
    assert.strictEqual(transitions.length, before, 'dead leader cannot receive hunt progress');
    leader.actor.dead = false;
    courier.actor.x = 0; courier.activeNpcTalk = { selfId: 7758, objectId: athrea.fetchId() };
    assert(!(await service.event(courier, 'chests')).ok, 'stale NPC bypass cannot start a remote chest trial');
    state.poisonedAt = Date.now();
    await service.transition(leader, 'poison');
    assert.strictEqual(poisonEffects.at(-1).id, 4082, 'poison uses the C4 effect');
    assert.strictEqual(poisonEffects.at(-1).dot.damage, 100);
    assert.strictEqual(poisonEffects.at(-1).dispellable, false);
    await service.transition(leader, 'cure');
    assert.strictEqual(leader.actor.effects.clan_alliance_poison, undefined, 'antidote removes the poison timer and effect');
    world.spawnQuestNpc = opts => {
        const npc = { questSpawn: { ownerId: opts.ownerId, questId: opts.questId } };
        spawnedChests.push({ opts, npc }); return npc;
    };
    state.chests = { token: 'new-trial' };
    await service.transition(courier, 'chests');
    assert.strictEqual(spawnedChests.length, 16, 'Athrea creates the actual C4 chest field');
    assert(spawnedChests.every(entry => entry.opts.ownerId === 2 && entry.opts.despawnDelay === 60000 && entry.npc.allianceChestToken === 'new-trial'));
    await service.transition(courier, 'pledge');
    assert.strictEqual(courier.actor.dead, true, 'the altar sacrifice invokes the normal death lifecycle');
    courier.actor.dead = false;
    state.stage = 'failed'; await service.snapshot(courier);
    assert.strictEqual(courier.clanAllianceQuest, null, 'failure releases the courier');
    console.log('Clan alliance runtime: physical travel/combat/return, NPC distance, chest ownership, live leader, and task release passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

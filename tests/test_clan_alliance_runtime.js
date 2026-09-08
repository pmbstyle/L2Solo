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
const transitions = [], movements = [], fights = [], reports = [];
const trips = [];
let incomingThreat = null;
let routeResult;
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
            if (event.event === 'deliver') state.members[0][state.stage === 'loyalty' ? 'loyaltyDelivered' : 'delivered'] = true;
            if (event.event === 'fail') state.stage = 'failed';
            return { ok: true, state: structuredClone(state) };
        }
    },
    'GameServer/World/World': world,
    'GameServer/Bot/BotManager': { botPartySay: (session, text) => { reports.push(text); return true; }, botTell() { throw new Error('Unexpected whisper'); } },
    'GameServer/Effects/EffectStore': {
        apply(actor, effect) { poisonEffects.push(effect); actor.effects[effect.key] = effect; return effect; },
        remove(actor, key) { delete actor.effects[key]; }
    },
    'GameServer/Effects/EffectTicker': { applyDot() {}, scheduleExpiry() {}, refreshEffects() {}, clear() {} },
    'GameServer/Effects/EffectRestrictions': { stopMovement() {} },
    'GameServer/Actor/Generics/Die': (session, actor) => { actor.dead = true; },
    'GameServer/Network/Response': { itemsList() {}, sitAndStand() {} },
    'GameServer/Bot/AI/HotActorLodPolicy': { promote() {} },
    'GameServer/Quest/QuestService': { questRates: () => ({ questSp: 1 }) },
    'GameServer/Bot/AI/CompanionNavigationRecovery': { move: (...args) => { movements.push(args); return routeResult; } },
    'GameServer/Bot/AI/PartyAwareness': { npcThreateningActor: () => incomingThreat },
    'GameServer/Bot/AI/TownTransitPolicy': { townAt: () => null },
    'GameServer/Geodata/GeodataEngine': { getHeight: (x, y, z) => z, hasLineOfSight: () => true },
    'GameServer/Bot/AI/BotSpotTravel': { tick() {}, cancel() {}, startViaEscape: (...args) => { trips.push(args); return false; } }
};
function load(relative, globals = {}) {
    const filename = path.join(root, relative), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: createRequire(filename),
        invoke: key => { if (!(key in mocks)) throw new Error(`Unexpected module ${key}`); return mocks[key]; },
        utils: { infoWarn: (...args) => { throw new Error(args.join(' ')); } }, Date, Math, Map, Set, Promise, Number, String, setTimeout, ...globals }, { filename });
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
    assert.strictEqual(trips.length, 1, 'far member requests SoE and gatekeeper travel');
    assert.strictEqual(trips[0][3].locX, herb.x);
    assert.strictEqual(movements.length, 0, 'unavailable transport must not fall back to a long walk');
    assert.strictEqual(transitions.length, 0, 'travel does not synthesize kills or items');
    assert.strictEqual(fights.length, 0);
    courier.actor.x = herb.x - 800;
    routeResult = { status: 'waiting', reason: 'budget_deferred' };
    ai.move(courier, herb, 'hunt');
    assert.strictEqual(trips.length, 1, 'queued local pathfinding is allowed to finish');
    routeResult = { status: 'exhausted' };
    ai.move(courier, herb, 'hunt');
    assert.strictEqual(trips.length, 2, 'failed local approach also recovers through quest transport');
    routeResult = undefined;
    const reportCount = reports.length;
    courier.actor.x = herb.x;
    ai.tick(courier, courier.actor, {}, combat);
    assert.strictEqual(reports.length, reportCount, 'unchanged task does not spam party chat');
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
    courier.actor.dead = true;
    service.onDeath(courier);
    assert(reports.at(-1).includes('down'));
    assert.strictEqual(state.stage, 'gathering', 'courier death does not fail the trial');
    courier.actor.dead = false;
    service.records.clear();
    courier.clanAllianceQuest = null;
    await service.resume(courier);
    assert(service.records.get(1).members[0].herb, 'resume restores the acquired ingredient assignment');
    ai.tick(courier, courier.actor, {}, combat);
    const landing = trips.at(-1)[3];
    assert(Math.hypot(landing.locX, landing.locY) > 180, 'return teleport leaves a physical approach to the leader');
    courier.actor.x = landing.locX; courier.actor.y = landing.locY;
    ai.tick(courier, courier.actor, {}, combat);
    assert.strictEqual(movements.at(-1)[2].locX, leader.actor.x, 'after landing the courier walks toward the leader');
    assert.strictEqual(state.members[0].delivered, false, 'landing near the leader does not deliver remotely');
    assert(!(await service.transition(courier, 'deliver')).ok, 'even internal delivery requires proximity');
    courier.activeNpcTalk = { selfId: 7759, objectId: kalis.fetchId() };
    assert(!(await service.event(courier, 'deliver')).ok, 'being near Kalis is insufficient while leader is far away');
    courier.actor.x = 0; courier.actor.y = 0;
    courier.spotRelocation = { arrivalPending: true };
    assert.strictEqual(ai.move(courier, leader.actor, 'leader'), false, 'teleport must settle before delivery');
    courier.spotRelocation = undefined;
    ai.tick(courier, courier.actor, {}, combat);
    await flush();
    assert.strictEqual(transitions.at(-1).event, 'deliver');
    assert.strictEqual(state.members[0].delivered, true);
    assert.strictEqual(ai.tick(courier, courier.actor, {}, combat), false, 'returned member can resume party support');
    courier.actor.x = 400;
    assert.strictEqual(ai.tick(courier, courier.actor, {}, combat), false, 'delivered courier keeps normal party formation instead of repeatedly approaching delivery range');
    courier.actor.x = 0;
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
    assert.strictEqual(poisonEffects.at(-1).dot.damage, 50);
    assert.strictEqual(poisonEffects.at(-1).dot.intervalMs, 1000);
    assert.strictEqual(poisonEffects.at(-1).stats.immobile, true);
    assert.strictEqual(poisonEffects.at(-1).dispellable, false);
    await service.transition(leader, 'cure');
    assert(leader.actor.effects.clan_alliance_poison, 'handing in ingredients must not drink the medicine automatically');
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
    state.stage = 'started'; state.members = []; state.selection = [2, 3, 4];
    const third = { actor: actor(3, 0), accountId: 'bot_three', dataSendToMe() {} };
    const fourth = { actor: actor(4, 0), accountId: 'bot_four', dataSendToMe() {} };
    world.user.sessions.push(third, fourth);
    leader.actor.x = kalis.x; leader.activeNpcTalk = { selfId: 7759, objectId: kalis.fetchId() };
    await service.snapshot(leader);
    assert((await service.event(leader, 'assign_0_2')).ok);
    assert.strictEqual(transitions.at(-1).memberId, 2);
    assert.strictEqual(transitions.at(-1).slot, 0);
    assert(!(await service.event(leader, 'assign_0_999')).ok, 'unknown member is rejected');
    courier.actor.x = kalis.x;
    assert(!(await service.event(courier, 'assign_0_3')).ok, 'only leader can select couriers');
    assert((await service.event(leader, 'choose_blood_2')).ok);
    assert.strictEqual(transitions.at(-1).bloodId, 2);
    fourth.actor.dead = true;
    assert(!(await service.event(leader, 'ritual')).ok, 'unavailable selection must be corrected before ritual');
    fourth.actor.dead = false;
    assert((await service.event(leader, 'ritual')).ok);
    const quest = load('src/GameServer/Quest/quests/Q501_ProofOfClanAlliance.js');
    assert.strictEqual(quest.eventNpc('assign_0_2'), Rules.NPC.kalis);
    assert.strictEqual(quest.eventNpc('assign_8_2'), null);
    const html = await quest.onTalk({ session: leader }, kalis);
    assert(html.includes('assign_0_2') && !html.includes('choose_blood_') && html.includes('Confirm assignments'));
    state.stage = 'loyalty'; state.members = [{ id: 2, pledged: true }, { id: 3, pledged: false }, { id: 4, pledged: false }];
    await service.snapshot(courier);
    courier.clanAllianceRefreshAt = Date.now() + 10000;
    const beforeRitualDelivery = transitions.length;
    const beforeRitualReport = reports.length;
    ai.tick(courier, courier.actor, {}, combat);
    await flush();
    assert.strictEqual(transitions.length, beforeRitualDelivery, 'an early resurrected courier waits for the third sacrifice');
    assert(reports.at(-1).includes('Waiting for all three offerings'));
    assert(!reports.slice(beforeRitualReport).some(text => /handed over|delivered|drink the poison/.test(text)), 'no premature delivery or poison readiness report');
    state.members.forEach(member => { member.pledged = true; });
    await service.snapshot(courier);
    ai.tick(courier, courier.actor, {}, combat);
    await flush();
    assert.strictEqual(state.members[0].loyaltyDelivered, true);
    ai.tick(courier, courier.actor, {}, combat);
    assert(reports.at(-1).includes('Waiting for the remaining couriers'));
    state.members.forEach(member => { member.loyaltyDelivered = true; });
    await service.snapshot(courier);
    ai.tick(courier, courier.actor, {}, combat);
    assert(reports.at(-1).includes('All three Symbols of Loyalty are delivered'));
    state.stage = 'gathering'; state.bloodObtained = false; state.chestAttempts = 3;
    state.members = [{ id: 2, herb: true, blood: true }];
    state.chests = { token: 'low-mp-trial', deadline: Date.now() + 60000, bingo: 1 };
    const liveChest = actor(104, 5177, courier.actor.x);
    liveChest.allianceChestToken = state.chests.token; liveChest.questSpawn = { ownerId: 2, questId: 501 };
    world.fetchNpcsInRadius = () => [liveChest];
    Object.assign(courier.actor, { fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 0, fetchMaxMp: () => 100 });
    courier.clanAllianceRecovering = true;
    await service.snapshot(courier);
    const chestActions = [];
    ai.tick(courier, courier.actor, {}, { executeCombat: (...args) => chestActions.push(args) });
    assert.strictEqual(chestActions.length, 1, 'a courier with zero MP still breaks the one-hit chests');
    assert.strictEqual(chestActions[0][4].basicAttackOnly, true, 'chests do not spend MP on an offensive spell rotation');
    assert(reports.at(-1).includes('attempt 3: 1/4 BINGOs'), 'ongoing chest progress explains why the courier has not returned');
    state.stage = 'failed'; await service.snapshot(courier);
    assert.strictEqual(courier.clanAllianceQuest, null, 'failure releases the courier');
    // Run the actual poison timer through the real character death handler
    // and back into the clan service, rather than mocking lethal damage.
    const intervals = new Map();
    const ticker = load('src/GameServer/Effects/EffectTicker.js', {
        setInterval: fn => { const token = {}; intervals.set(token, fn); return token; },
        clearInterval: token => intervals.delete(token), clearTimeout() {}
    });
    ticker.refreshEffects = () => {};
    ticker.scheduleExpiry = () => {};
    mocks['GameServer/Effects/EffectTicker'] = ticker;
    mocks['GameServer/Effects/EffectStore'].prune = () => {};
    mocks['GameServer/Actor/Generics/CalculateStats'] = () => {};
    mocks['GameServer/Skills/ChargeLifecycle'] = { clear() {} };
    mocks['GameServer/World/ArenaDuelService'] = { onPlayerDeath: () => false };
    mocks['GameServer/Network/Response'].die = id => ({ deadId: id });
    mocks['GameServer/Actor/Generics/Die'] = load('src/GameServer/Actor/Generics/Die.js');
    const deathPackets = [];
    leader.dataSendToMeAndOthers = packet => deathPackets.push(packet);
    Object.assign(leader.actor, {
        session: leader, hp: 150, dead: false, effects: {},
        fetchId: () => 2000001, fetchHp() { return this.hp; }, setHp(hp) { this.hp = hp; },
        statusUpdateVitals() {}, destructor() {}
    });
    Object.assign(leader.actor.state, {
        fetchDead: () => leader.actor.dead, setDead: dead => { leader.actor.dead = dead; }, destructor() {}
    });
    state.stage = 'gathering'; state.leaderId = 2000001; state.poisonedAt = Date.now();
    await service.transition(leader, 'poison');
    const poisonTick = [...intervals.values()][0];
    assert(poisonTick, 'quest starts the actual poison timer');
    poisonTick();
    assert.strictEqual(leader.actor.hp, 100);
    assert.strictEqual(leader.actor.dead, false, 'nonlethal poison tick leaves leader alive');
    poisonTick();
    assert.strictEqual(leader.actor.hp, 50);
    poisonTick();
    await flush();
    assert.strictEqual(leader.actor.hp, 0);
    assert.strictEqual(leader.actor.dead, true, 'lethal self-applied poison runs character death');
    assert.strictEqual(deathPackets.length, 1, 'client receives the death packet');
    assert.strictEqual(state.stage, 'failed', 'leader death fails the quest');
    assert.strictEqual(intervals.size, 0, 'death cancels poison ticking');
    poisonTick();
    assert.strictEqual(deathPackets.length, 1, 'late timer callback cannot kill twice');
    console.log('Clan alliance runtime: physical travel/combat/return, NPC distance, chest ownership, live leader, and task release passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

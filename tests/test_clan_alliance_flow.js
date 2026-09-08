// Exercise the real quest service, courier AI, transport state machine and
// SQLite repository together. Movement and combat outcomes are deterministic;
// native damage/cast cancellation and resurrection have their own tests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const BotAI = invoke('GameServer/Bot/BotAI');
const Rules = require('../src/GameServer/Clan/ClanAllianceRules');
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'tmp', `test-clan-alliance-flow-${process.pid}.sqlite`);
const ids = [2000001, 2000002, 2000003, 2000004];
const seed = new DatabaseSync(file);
seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
for (const [index, id] of ids.entries()) {
    const username = index ? `bot_flow_${id}` : 'flow_player';
    seed.prepare('INSERT INTO accounts(username,password) VALUES (?,?)').run(username, 'test');
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,0,0,1,500,250,0,0,0,0,0,0,0)`).run(id, username, `Flow${index}`);
}
seed.prepare("INSERT INTO clans(id,name,leaderId,level) VALUES (1,'FlowClan',?,3)").run(ids[0]);
seed.exec('UPDATE characters SET clanId=1');
seed.close();
options.default.Database.path = path.relative(root, file);
Database.init();
let now = 1000000;
class Clock extends Date { static now() { return now; } }
const timers = [], movements = [], teleports = [], fights = [], reports = [], kills = [], requests = [];
let shouldKill = true;
let pendingSacrificeId = 0;
let objectId = 1000000;
function actor(id, selfId, x) {
    return {
        x, y: 0, z: 0, dead: false, online: true, effects: {}, sp: 0,
        fetchId: () => id, fetchSelfId: () => selfId, fetchName: () => `Actor${id}`,
        fetchClanId: () => 1, fetchIsOnline() { return this.online; }, fetchLevel: () => 1,
        fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
        isDead() { return this.dead; }, fillupVitals() {}, fetchHp: () => 500, fetchMaxHp: () => 500,
        fetchMp: () => 250, fetchMaxMp: () => 250, setSp(value) { this.sp = value; },
        state: { casts: false, hits: false, seated: false, setDead(v) { this.owner.dead = v; },
            fetchCasts() { return this.casts; }, setCasts(v) { this.casts = v; },
            fetchHits() { return this.hits; }, setHits(v) { this.hits = v; },
            fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; } },
        attack: { abortCast() {}, clearTimers() {} }, automation: { abortAll() {}, stopReplenish() {} }, unselect() {},
        backpack: { items: [], fetchItems() { return this.items; },
            fetchItemFromSelfId(id) { return this.items.find(i => i.fetchSelfId() === id); },
            insertItem(id, selfId, { amount }) { this.items.push({ amount, fetchId: () => id,
                fetchSelfId: () => selfId, setAmount(v) { this.amount = v; } }); } }
    };
}
const sessions = ids.map((id, index) => ({ actor: actor(id, 0, 20000), accountId: index ? `bot_flow_${id}` : 'player',
    dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} }));
const [leader, ...couriers] = sessions;
for (const s of sessions) s.actor.state.owner = s.actor;
for (const s of couriers) { s.partyCompanion = true; s.followPlayerSession = leader; }
const npcs = new Map([...Object.values(Rules.NPC), ...Rules.HERBS.map(h => h.npcId)]
    .map((id, index) => [id, actor(objectId++, id, 20000 + index * 10000)]));
Object.assign(npcs.get(Rules.NPC.athrea), { x: 102082, y: 103138, z: -3506 });
const world = { user: { sessions }, npc: { spawns: [...npcs.values()] },
    fetchNpcsInRadius: (x, y, radius) => world.npc.spawns.filter(n => Math.hypot(n.x - x, n.y - y) <= radius),
    spawnQuestNpc(opts) {
        const npc = actor(objectId++, opts.selfId, opts.locX);
        npc.y = opts.locY; npc.z = opts.locZ;
        npc.questSpawn = { ownerId: opts.ownerId, questId: opts.questId };
        world.npc.spawns.push(npc);
        timers.push({ at: now + opts.despawnDelay, fn: () => despawn(npc) });
        return npc;
    }
};
function place(a, loc) { a.x = loc.locX; a.y = loc.locY; a.z = loc.locZ; }
function despawn(npc) { world.npc.spawns = world.npc.spawns.filter(n => n !== npc); }
const mocks = {
    Database: { fetchClanAllianceQuest: id => Database.fetchClanAllianceQuest(id, now),
        fetchItems: (...args) => {
            if (pendingSacrificeId) {
                assert(sessions.find(s => s.actor.fetchId() === pendingSacrificeId).actor.dead, 'sacrifice must kill before inventory synchronization yields');
                pendingSacrificeId = 0;
            }
            return Database.fetchItems(...args);
        },
        transitionClanAlliance: args => { requests.push(args.event); if (args.event === 'pledge') pendingSacrificeId = args.characterId;
            return Database.transitionClanAlliance({ ...args, timestamp: now,
            ...(args.event === 'chests' ? { winningTypes: [5173, 5174] } : {}) }); } },
    'GameServer/World/World': world,
    'GameServer/Bot/BotManager': { botPartySay(s, message) { reports.push(message); return true; } },
    'GameServer/Bot/AI/HotActorLodPolicy': { promote() {} },
    'GameServer/Effects/EffectStore': { apply(a, effect) { a.effects[effect.key] = effect; return effect; },
        remove(a, key) { delete a.effects[key]; } },
    'GameServer/Effects/EffectTicker': { applyDot() {}, scheduleExpiry() {}, refreshEffects() {}, clear() {} },
    'GameServer/Effects/EffectRestrictions': { stopMovement() {} },
    'GameServer/Network/Response': { itemsList() {}, sitAndStand() {}, skillStarted() {}, userInfo() {}, revive() {}, socialAction() {} },
    'GameServer/Actor/Generics/Die': (s, a) => { a.dead = true; service.onDeath(s); },
    'GameServer/Actor/Generics/TeleportTo': (s, a, loc) => { teleports.push({ id: a.fetchId(), ...loc }); place(a, loc); },
    'GameServer/Quest/QuestService': { questRates: () => ({ questSp: 1 }) },
    'GameServer/World/Generics/SpawnNpcs': { despawnQuestNpc: (w, npc) => despawn(npc) },
    'GameServer/Bot/AI/PartyAwareness': { npcThreateningActor: () => null },
    'GameServer/Geodata/GeodataEngine': { getHeight: (x, y, z) => z, hasLineOfSight: () => true },
    'GameServer/Bot/AI/BotEventJournal': { record: async () => {} },
    'GameServer/Bot/AI/BotTownTravel': { hasCombatThreat: () => false },
    'GameServer/Bot/AI/TownGatekeeperCatalog': { targetForTown: () => ({ town: 'TestTown', npcSelfId: 1 }) },
    'GameServer/Bot/AI/TownNpcApproach': { reset() {}, planOpen: () => ({ ready: true }) },
    'GameServer/Bot/AI/TownTransitPolicy': { townAt: a => a.x === 0 && a.y === 0 ? 'TestTown' : null,
        observeRecovery() {}, interact: () => true },
    'GameServer/Bot/BotAI': {
        getClosestTown: () => ({ name: 'TestTown', x: 0, y: 0, z: 0 }),
        clearTacticalState: BotAI.clearTacticalState,
        beginPartyTownRecovery: BotAI.beginPartyTownRecovery,
        getDeathRespawnTarget: () => ({ locX: 0, locY: 0, locZ: 0 })
    },
    'GameServer/Bot/AI/CompanionNavigationRecovery': { clear() {}, move(s, a, loc) {
        movements.push({ id: a.fetchId(), ...loc }); place(a, loc); return { status: 'started' };
    } }
};
function load(relative) {
    const filename = path.join(root, 'src', relative + '.js'), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: createRequire(filename),
        invoke: key => { assert(key in mocks, key); return mocks[key]; }, Date: Clock,
        Math: Object.assign(Object.create(Math), { random: () => 0 }),
        setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
        utils: { infoWarn: (...args) => { throw Error(args.join(' ')); } } }, { filename });
    return module.exports;
}
mocks['GameServer/Bot/AI/SpotService'] = { findById: () => null,
    assignSpot() { assert.fail('quest transport overwrote the farming profile'); } };
mocks['GameServer/Bot/AI/BotSpotTravel'] = load('GameServer/Bot/AI/BotSpotTravel');
mocks['GameServer/Actor/Generics/Revive'] = load('GameServer/Actor/Generics/Revive');
const service = mocks['GameServer/Clan/ClanAllianceService'] = load('GameServer/Clan/ClanAllianceService');
const ai = load('GameServer/Bot/AI/ClanAllianceQuestAI');
const quest = load('GameServer/Quest/quests/Q501_ProofOfClanAlliance');
const state = () => service.records.get(1);
const combat = { executeCombat(s, a, npc) {
    fights.push(npc);
    if (shouldKill && !npc.dead) { npc.dead = true; kills.push(service.onKill(s, npc)); }
} };
async function cycle(ms = 1000) {
    now += ms;
    for (const timer of timers.filter(t => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    for (const s of couriers) {
        if (s.actor.dead) continue;
        ai.tick(s, s.actor, {}, combat);
    }
    await Promise.all(kills.splice(0));
    await new Promise(resolve => setImmediate(resolve));
    // Wait for the real repository transaction queue, including AI requests.
    await Database.execute(['SELECT 1'], 'test:flow:drain');
    await new Promise(resolve => setImmediate(resolve));
}
async function until(predicate, label, limit = 240) {
    for (let i = 0; i < limit && !predicate(); i++) await cycle();
    assert(predicate(), `${label}: ${JSON.stringify(state())}`);
}
async function event(s, name) {
    const target = npcs.get(quest.eventNpc(name));
    place(s.actor, service.loc(target)); s.activeNpcTalk = { objectId: target.fetchId(), selfId: target.fetchSelfId() };
    const result = await service.event(s, name); assert(result.ok, `${name}: ${result.code}`);
    return result;
}
async function resurrectOfferings() {
    await until(() => state().members.every(m => m.pledged), 'three different members sacrifice');
    assert(couriers.every(s => s.actor.dead));
    await cycle(60000);
    assert(couriers.every(s => s.actor.dead), 'ritual deaths wait for actual resurrection');
    assert(state().members.every(m => !m.herb && !m.loyaltyDelivered));
    for (const s of couriers) mocks['GameServer/Actor/Generics/Revive'](s, s.actor, { delayMs: 2500, restoreFullVitals: true });
    await cycle(2500);
}
async function main() {
    await event(leader, 'start');
    for (const [slot, s] of couriers.entries()) await event(leader, `assign_${slot}_${s.actor.fetchId()}`);
    await event(leader, `choose_blood_${couriers[0].actor.fetchId()}`);
    await event(leader, 'ritual');
    await until(() => couriers.some(s => s.actor.state.casts), 'couriers begin their altar trip');
    leader.actor.online = false;
    for (const s of couriers) ai.tick(s, s.actor, {}, combat);
    assert(couriers.every(s => !s.actor.state.casts && !s.spotRelocation), 'leader disconnect pauses outstanding travel');
    leader.actor.online = true;
    await resurrectOfferings();
    await until(() => state().members.every(m => m.loyaltyDelivered), 'offerings return from the altar');
    assert.strictEqual(fights.length, 0, 'no herb hunt before poison');
    const tripsBeforePoison = teleports.length;
    await cycle(60000);
    assert.strictEqual(teleports.length, tripsBeforePoison, 'returned couriers wait for an explicit poison decision');
    assert.strictEqual(fights.length, 0);
    assert(couriers.every(s => !s.actor.backpack.fetchItemFromSelfId(state().members.find(m => m.id === s.actor.fetchId()).itemId)));
    await event(leader, 'poison');
    assert(leader.actor.effects.clan_alliance_poison);
    await until(() => state().members.every(m => m.herb), 'couriers earn their herbs');
    const fallenCourier = couriers[0];
    mocks['GameServer/Actor/Generics/Die'](fallenCourier, fallenCourier.actor);
    assert(fallenCourier.actor.dead);
    await cycle(0);
    assert(!fallenCourier.actor.dead, 'field death restarts the courier without elapsed waiting time or a Call');
    assert(state().members.find(m => m.id === fallenCourier.actor.fetchId()).herb, 'field death preserves the earned herb');
    await until(() => state().members.every(m => m.delivered && (!m.blood || m.bloodDelivered)), 'all ingredients return');
    assert(fights.filter(n => n.allianceChestToken).length >= 4, 'blood requires actual chest kill callbacks');
    assert.strictEqual(world.npc.spawns.filter(n => n.allianceChestToken).length, 0, 'successful trial removes its remaining boxes');
    for (const s of couriers) {
        assert(service.near(s.actor, leader.actor, 180), 'couriers physically approach the leader for delivery');
        assert(teleports.some(t => t.id === s.actor.fetchId() && t.locX === 0), 'courier uses SoE to town');
        assert(movements.some(t => t.id === s.actor.fetchId()), 'courier completes the final approach on foot');
        assert.strictEqual(ai.tick(s, s.actor, {}, combat), false, 'completed courier resumes its party role');
    }
    await Database.close(); Database.init();
    await service.snapshot(leader);
    assert(state().members.every(m => m.delivered && (!m.blood || m.bloodDelivered)), 'completed deliveries survive reopening SQLite');
    await event(leader, 'cure');
    assert(leader.actor.effects.clan_alliance_poison, 'receiving medicine does not drink it automatically');
    assert(leader.actor.backpack.fetchItemFromSelfId(3889), 'Kalis gives the physical Potion of Recovery');
    assert(couriers.every(s => !s.clanAllianceQuest), 'antidote releases every courier from the task');
    // Use the native item-skill path for 3889 -> 2060 -> remove skill 4082.
    // Only inventory storage is adapted to this isolated SQLite fixture.
    const medicine = leader.actor.backpack.fetchItemFromSelfId(3889);
    const medicineBag = leader.actor.backpack;
    const Backpack = invoke('GameServer/Actor/Backpack');
    const Skill = invoke('GameServer/Model/Skill');
    const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    assert.strictEqual(Restrictions.canMove(leader.actor), false, 'quest poison roots the leader');
    medicineBag.buildItemSkill = () => new Skill({ selfId: 2060, level: 1, name: 'Healing Medicine', spell: false, hitTime: 0, distance: -1 });
    let consumed;
    medicineBag.deleteItem = (s, id, count, done) => {
        consumed = Database.execute(['DELETE FROM items WHERE id=? AND characterId=? AND selfId=3889', [id, s.actor.fetchId()]], 'test:use-medicine')
            .then(() => { medicineBag.items = medicineBag.items.filter(i => i.fetchId() !== id); done(); });
    };
    medicineBag.applySelfItemSkill = Backpack.prototype.applySelfItemSkill;
    assert(Backpack.prototype.useSkillItem.call(medicineBag, leader, medicine.fetchId(), invoke('GameServer/Items/C4ItemSkills').resolve(3889)));
    await consumed;
    assert(!leader.actor.effects.clan_alliance_poison, 'using the medicine removes Poison of Death');
    assert.strictEqual(Restrictions.canMove(leader.actor), true, 'using the medicine releases the root');
    assert(!leader.actor.backpack.fetchItemFromSelfId(3889), 'medicine is consumed once');
    await event(leader, 'finish');
    assert.strictEqual(state().stage, 'completed');
    assert.strictEqual(leader.actor.sp, Rules.SP_REWARD);
    assert(leader.actor.backpack.fetchItemFromSelfId(3874), 'leader receives the physical Proof of Alliance');

    // A fresh attempt after the earned proof has been consumed elsewhere.
    await Database.execute(['DELETE FROM items WHERE selfId=3874'], 'test:flow:consume-proof');
    for (const herb of Rules.HERBS) {
        const old = npcs.get(herb.npcId), respawn = actor(objectId++, herb.npcId, old.x);
        world.npc.spawns = world.npc.spawns.filter(n => n !== old);
        world.npc.spawns.push(respawn); npcs.set(herb.npcId, respawn);
    }
    await event(leader, 'start');
    for (const [slot, s] of couriers.entries()) await event(leader, `assign_${slot}_${s.actor.fetchId()}`);
    await event(leader, 'ritual');
    await resurrectOfferings();
    await until(() => state().members.every(m => m.loyaltyDelivered), 'repeat offerings');
    await event(leader, 'poison');
    await until(() => state().members.every(m => m.herb), 'repeat herb hunt');
    shouldKill = false;
    await until(() => !!state().chests, 'first chest attempt');
    const bloodCourier = couriers.find(s => state().members.find(m => m.id === s.actor.fetchId()).blood);
    await cycle(); // Enter the chest phase before simulating an in-flight cast.
    bloodCourier.actor.state.casts = true; bloodCourier.actor.state.hits = true;
    const firstToken = state().chests.token;
    const foreignChest = actor(objectId++, 5173, 102273);
    foreignChest.questSpawn = { ownerId: 999, questId: 501 };
    foreignChest.allianceChestToken = firstToken;
    world.npc.spawns.push(foreignChest);
    await cycle(61000);
    await until(() => Number(bloodCourier.clanAllianceRetryAt || 0) > now, 'insufficient funds are reported');
    assert(!bloodCourier.actor.state.casts && !bloodCourier.actor.state.hits, 'expired chest attempt cancels its old combat');
    assert(reports.some(text => text.includes('10,000 Adena')), 'leader sees why the retry cannot begin');
    const calls = requests.filter(event => event === 'chests').length;
    await cycle(); await cycle();
    assert.strictEqual(requests.filter(event => event === 'chests').length, calls, 'blocked retries do not hammer the transaction queue');
    await Database.execute(["INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId) VALUES (57,'Adena',20000,0,0,0,?)",
        [bloodCourier.actor.fetchId()]], 'test:flow:fund-retry');
    await until(() => state().chests.token !== firstToken, 'funded chest retry starts');
    const balance = await Database.execute(['SELECT SUM(amount) n FROM items WHERE selfId=57 AND characterId=?',
        [bloodCourier.actor.fetchId()]], 'test:flow:balance');
    assert.strictEqual(Number(balance[0].n), 10000, 'retry charges exactly once');

    const traveller = couriers.find(s => s !== bloodCourier);
    traveller.actor.x = 80000; traveller.actor.state.casts = false;
    ai.move(traveller, leader.actor, 'leader');
    assert(traveller.spotRelocation, 'a return trip is active when the leader dies');
    leader.actor.dead = true;
    service.onDeath(leader);
    await until(() => state().stage === 'failed', 'leader death fails the trial');
    assert(couriers.every(s => !s.clanAllianceQuest && !s.spotRelocation && !s.actor.state.casts && !s.actor.state.hits),
        'failure releases all courier actions');
    assert(!leader.actor.effects.clan_alliance_poison);
    assert.deepStrictEqual(world.npc.spawns.filter(n => n.allianceChestToken), [foreignChest], 'failure removes only this attempt\'s boxes');
    const tripsBefore = teleports.length;
    await cycle(21000);
    assert.strictEqual(teleports.length, tripsBefore, 'cancelled SoE cannot fire after quest failure');
    const ingredients = await Database.execute(['SELECT COUNT(*) n FROM items WHERE selfId IN (3832,3833,3834,3835,3837,3872)'], 'test:flow:cleanup');
    assert.strictEqual(Number(ingredients[0].n), 0, 'failure cleans the real quest items');
    console.log('Clan alliance full flow: reward, disconnect/resume, reopen, expired casts, paid retry, leader death and scoped cleanup passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
});

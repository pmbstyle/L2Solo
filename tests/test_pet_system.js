const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Rules = invoke('GameServer/Pets/PetRules');
const Runtime = invoke('GameServer/Pets/PetRuntime');
const Inventory = invoke('GameServer/Pets/PetInventory');
const Backpack = invoke('GameServer/Actor/Backpack');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Database = invoke('Database');
const Control = invoke('GameServer/Npc/SummonControl');
const Response = invoke('GameServer/Network/Response');
const temp = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'pet-system-'));
const dbPath = path.join(temp, 'world.sqlite');
function owner(backpack) {
    const packets = [];
    const actor = { backpack, pet: null, mounted: false, fetchId: () => 2000001, fetchName: () => 'PetOwner', fetchLevel: () => 40,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0, fetchRadius: () => 10,
        fetchPvpFlag: () => 0, fetchKarma: () => 0, isDead: () => false, state: { fetchHits: () => false, fetchDead: () => false } };
    const session = { actor, packets, dataSendToMe: p => packets.push(p), dataSendToMeAndOthers: p => packets.push(p) };
    actor.session = session;
    return session;
}
async function main() {
    DataCache.init();
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('pet_test','test'); INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES (2000001,'pet_test','PetOwner',0,0,40,500,300,0,0,0,0,0,0,0)");
    seed.exec("INSERT INTO items(id,selfId,name,amount,characterId) VALUES (100,2375,'Wolf Collar',1,2000001),(101,2515,'Food for Wolves',10,2000001),(102,2505,'Iron Canine',1,2000001),(103,2375,'Wolf Collar',1,2000001)");
    seed.close();
    options.default.Database.path = dbPath;
    Database.init();
    const read = new DatabaseSync(dbPath);
    const backpack = new Backpack({ paperdoll: [], items: read.prepare('SELECT * FROM items').all() });
    const session = owner(backpack);
    World.user = { sessions: [session] };
    World.npc = { spawns: [], grid: {}, nextId: 9000001 };
    backpack.spawnPetFromItem(session, { itemObjectId: 100, npcId: 12077 });
    const pet = session.actor.pet;
    assert(pet, 'wolf spawns from collar');
    await pet.persistTail;
    assert.strictEqual(pet.fetchLevel(), 15);
    assert.strictEqual(pet.fetchExp(), Rules.stats(12077, 15).exp);
    assert.strictEqual(pet.fetchMaxHp(), Rules.stats(12077, 15).maxHp);
    assert.strictEqual(pet.fetchCollectiveAccur(), Rules.stats(12077, 15).accur, 'pet accuracy is already final, no NPC level addition');
    assert.strictEqual(pet.fetchMaxFeed(), Rules.stats(12077, 15).maxFeed);
    assert.strictEqual(Response.petInfo(pet, session.actor).readInt32LE(1), 2, 'native pet window uses pet type, not servitor');
    const dimensions = {12077:[13,11.5],12311:[9,10],12312:[9,10],12313:[9,10],
        12526:[23,31],12527:[23,31],12528:[23,31],12564:[10,24],12780:[12,15],12781:[7,15],12782:[11,15.7]};
    for (const [collarId, type] of Object.entries(Rules.TYPES)) {
        const collar = {fetchSelfId:()=>Number(collarId),fetchId:()=>999999,fetchPetData:()=>null,setPetData() {}};
        const candidate = Runtime.create(session, collar, {radius:1,size:1});
        const info = Response.petInfo(candidate, session.actor);
        assert.strictEqual(candidate.fetchRadius(), dimensions[type.npcId][0], 'species collision radius overrides fallback');
        assert.strictEqual(candidate.fetchSize(), dimensions[type.npcId][1], 'species collision height overrides fallback');
        assert.strictEqual(info.readDoubleLE(93), dimensions[type.npcId][0]);
        assert.strictEqual(info.readDoubleLE(101), dimensions[type.npcId][1]);
        let tail = 126;
        for (let string = 0; string < 2; string++) { while (info.readUInt16LE(tail) !== 0) tail += 2; tail += 2; }
        assert.strictEqual(info.readUInt16LE(tail + 27 * 4), type.category === 'strider' ? 1 : 0, 'C4 pet window ride button');
    }
    const status = Response.petStatusUpdate(pet);
    assert.strictEqual(status.readUInt32LE(51), pet.fetchExp(), 'client receives actual XP');
    await Inventory.rename(session, 'Fang');
    await assert.rejects(Inventory.rename(session, 'Again'));
    await Inventory.transfer(session, 101, 4, 'deposit');
    assert.strictEqual(backpack.fetchItemRaw(101).fetchAmount(), 6);
    assert.strictEqual(Inventory.items(pet)[0].fetchAmount(), 4);
    const foodId = Inventory.items(pet)[0].fetchId();
    await assert.rejects(Inventory.transfer(session, 103, 1, 'deposit'), 'cannot nest control items');
    await assert.rejects(Inventory.transfer(session, 101, 99, 'deposit'));
    await Inventory.transfer(session, 102, 1, 'deposit');
    const weapon = Inventory.items(pet).find(item => item.fetchSelfId() === 2505);
    const baseAtk = pet.fetchCollectivePAtk();
    await Inventory.use(session, weapon.fetchId());
    assert.strictEqual(pet.fetchCollectivePAtk(), baseAtk + 4);
    assert.strictEqual(invoke('GameServer/Item/ItemSlot').bodyPart(weapon), 0x020000);
    const Attack = invoke('GameServer/Actor/Attack');
    const attack = new Attack();
    const victim = { fetchCollectivePDef: () => 50, fetchDex: () => 0, fetchLocX: () => 5, fetchLocY: () => 0, fetchHead: () => 0 };
    const uncharged = attack.prepareNpcMeleeHit(pet, victim, true, () => 0.99);
    pet.setChargedSoulShot(true);
    const charged = attack.prepareNpcMeleeHit(pet, victim, true, () => 0.99);
    assert(Math.abs(charged.damage - uncharged.damage * 2) <= 1, 'beast soulshot affects pet damage');
    assert(charged.flags & Response.attack.HITFLAG_USESS);
    assert.strictEqual(pet.fetchChargedSoulShot(), false, 'charge consumed once');
    await assert.rejects(Inventory.transfer(session, weapon.fetchId(), 1, 'withdraw'));
    pet.setCurrentFeed(1);
    await Runtime.feedTick(pet);
    assert(pet.fetchCurrentFeed() > 1, 'autofeed consumes inventory food');
    assert.strictEqual(Inventory.items(pet).find(item => item.fetchId() === foodId).fetchAmount(), 3);
    const beforeXp = pet.fetchExp();
    const mob = { petDamage: new Map(), fetchHp: () => 100, fetchMaxHp: () => 100, fetchLevel: () => 15, fetchLocX: () => 0, fetchLocY: () => 0 };
    Runtime.recordDamage(mob, pet, 60);
    assert.strictEqual(Runtime.rewardDamage(mob, 1000, 100), 0.4);
    assert.strictEqual(pet.fetchExp() - beforeXp, Math.round(600 * invoke('GameServer/ProgressionRates').profile().exp));
    // Exercise the actual kill reward entry point with the pet as the killer.
    const Generics = invoke('GameServer/Actor/Generics');
    const Quests = invoke('GameServer/Quest/QuestService');
    const previous = [World.removeNpc, Generics.abortCombatState, Generics.experienceReward, Quests.onKill];
    let ownerReward = null;
    let questKiller = null;
    try {
        World.removeNpc = () => {};
        Generics.abortCombatState = () => {};
        Generics.experienceReward = (recipient, actor, exp, sp) => { ownerReward = { recipient, exp, sp }; };
        Quests.onKill = async recipient => { questKiller = recipient; };
        const target = { ...mob, petDamage: new Map(), fetchAcquiredExp: () => 1000, fetchRewardSp: () => 100 };
        Runtime.recordDamage(target, pet, 60);
        const beforeKill = pet.fetchExp();
        invoke('GameServer/Actor/Generics/NpcDied')(session, pet, target);
        assert.strictEqual(pet.fetchExp() - beforeKill, Math.round(600 * invoke('GameServer/ProgressionRates').profile().exp));
        assert.strictEqual(ownerReward.recipient, session);
        assert.strictEqual(ownerReward.exp, 400, 'pet contribution is removed from the owner reward pool');
        assert.strictEqual(questKiller, session, 'pet kills are attributed to the owner quest');
    } finally {
        [World.removeNpc, Generics.abortCombatState, Generics.experienceReward, Quests.onKill] = previous;
    }
    pet.petData.exp = Rules.stats(12077, 16).exp - 1;
    Runtime.award(pet, 2);
    assert.strictEqual(pet.fetchLevel(), 16);
    const earned = pet.fetchExp();
    await Runtime.persist(pet);
    Control.unsummon(session, session.actor, pet);
    backpack.spawnPetFromItem(session, { itemObjectId: 100, npcId: 12077 });
    assert.strictEqual(session.actor.pet, null, 'cannot resummon before inventory and state saves finish');
    await pet.persistTail;
    assert.strictEqual(session.actor.pet, null);
    const saved = JSON.parse(read.prepare('SELECT petData FROM items WHERE id=100').get().petData);
    assert.strictEqual(saved.exp, earned);
    assert.strictEqual(saved.name, 'Fang');
    assert(saved.inventory.some(item => item.equipped));
    const reloaded = new Backpack({ paperdoll: [], items: read.prepare('SELECT * FROM items WHERE characterId=2000001').all() });
    session.actor.backpack = reloaded;
    reloaded.spawnPetFromItem(session, { itemObjectId: 100, npcId: 12077 });
    const restored = session.actor.pet;
    assert.strictEqual(restored.fetchLevel(), 16);
    assert.strictEqual(restored.fetchName(), 'Fang');
    assert.strictEqual(restored.fetchExp(), earned);
    assert.strictEqual(restored.fetchCollectivePAtk(), Rules.stats(12077, 16).pAtk + 4);
    restored.destructor(session);
    restored.state.setDead(true);
    Runtime.die(restored);
    const deadline = restored.petData.deadUntil;
    const deathXp = restored.fetchExp();
    assert(deathXp < earned);
    Control.unsummon(session, session.actor, restored);
    await restored.persistTail;
    reloaded.spawnPetFromItem(session, { itemObjectId: 100, npcId: 12077 });
    const corpse = session.actor.pet;
    assert(corpse.state.fetchDead(), 'relog never revives dead pet');
    assert.strictEqual(corpse.petData.deadUntil, deadline, 'relog never resets corpse deadline');
    assert.strictEqual(corpse.fetchExp(), deathXp, 'no repeated death penalty');
    assert.strictEqual(Control.revivePet(session, corpse, 100), true);
    assert.strictEqual(corpse.fetchExp(), earned, 'resurrection recovers stored loss exactly once');
    assert.strictEqual(Control.revivePet(session, corpse, 100), false);
    await Runtime.persist(corpse);
    await Inventory.use(session, Inventory.items(corpse).find(item => item.fetchSelfId() === 2505).fetchId());
    await Inventory.transfer(session, Inventory.items(corpse).find(item => item.fetchSelfId() === 2505).fetchId(), 1, 'withdraw');
    assert(session.actor.backpack.fetchItemFromSelfId(2505));
    assert(!Inventory.items(corpse).some(item => item.fetchSelfId() === 2505));
    const loggedOutActor = session.actor;
    const transferInventory = Database.transferPetInventory;
    let enteredTransfer;
    let releaseTransfer;
    const entered = new Promise(resolve => { enteredTransfer = resolve; });
    const gate = new Promise(resolve => { releaseTransfer = resolve; });
    Database.transferPetInventory = async (...args) => { enteredTransfer(); await gate; return transferInventory(...args); };
    try {
        corpse.setCurrentFeed(1);
        const feeding = Inventory.use(session, foodId);
        await entered;
        Control.unsummon(session, session.actor, corpse);
        session.actor = null;
        releaseTransfer();
        await feeding;
        await corpse.teardownTail;
        assert.strictEqual(loggedOutActor.backpack.fetchItemRaw(100).petInUse, false, 'logout saves using the captured owner');
        const afterLogout = JSON.parse(read.prepare('SELECT petData FROM items WHERE id=100').get().petData);
        assert(afterLogout.currentFeed > 1, 'in-flight feeding completes and persists across disconnect');
        assert.strictEqual(afterLogout.inventory.find(item => item.id === foodId).amount, 2);
    } finally {
        releaseTransfer();
        Database.transferPetInventory = transferInventory;
        session.actor = loggedOutActor;
    }
    // Two collars with the same template never share pet identity or progress.
    reloaded.spawnPetFromItem(session, { itemObjectId: 103, npcId: 12077 });
    const second = session.actor.pet;
    assert.strictEqual(second.fetchLevel(), 15);
    assert.strictEqual(second.petData.name, '');
    assert.strictEqual(second.petData.inventory.length, 0);
    Runtime.remove(second, true);
    await second.expireTail;
    assert.strictEqual(read.prepare('SELECT id FROM items WHERE id=103').get(), undefined, 'expired pet loses its control item');
    // Ownership is checked inside the transaction, not only by the packet layer.
    await assert.rejects(Database.transferPetInventory(999, 100, { direction: 'withdraw', itemId: foodId, amount: 1 }));
    await Database.setItem(2000001, { selfId: 3417, name: 'Animal Lovers List', amount: 1, equipped: false, slot: 0 });
    await Database.setCharacterQuest(2000001, 419, 'started', { cond: 3, answers: 9 });
    const reward = await Database.completeWolfQuest(2000001);
    assert.strictEqual(read.prepare('SELECT selfId FROM items WHERE id=?').get(reward.id).selfId, 2375);
    await assert.rejects(Database.completeWolfQuest(2000001), /already claimed/);
    assert.strictEqual(read.prepare('SELECT state FROM character_quests WHERE characterId=2000001 AND questId=419').get().state, 'created');
    const NpcSkills = invoke('GameServer/Npc/NpcSkills');
    for (const [level, expected] of [[35,3],[55,5],[75,8],[80,9]]) {
        const heal = NpcSkills.forNpc({ fetchIsPet: () => true, fetchSelfId: () => 12312, fetchLevel: () => level }).find(skill => skill.fetchSelfId() === 4713);
        assert.strictEqual(heal.fetchLevel(), expected); assert.strictEqual(heal.fetchTargetKind(), 'self');
    }
    assert.strictEqual(read.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    read.close();
    await Database.close();
    fs.rmSync(temp, { recursive: true, force: true });
    console.log('Pet system persistence, inventory, XP and death checks passed');
}
main().catch(async error => { console.error(error); if (World.user?.sessions?.[0]?.actor?.pet) World.user.sessions[0].actor.pet.destructor(World.user.sessions[0]); await Database.close().catch(() => {}); process.exitCode = 1; });

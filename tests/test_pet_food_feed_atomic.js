const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('pet_food_feed', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
isolated.assertConfigured(options.default);
const Rules = invoke('GameServer/Pets/PetRules');
const Inventory = invoke('GameServer/Pets/PetInventory');
const Backpack = invoke('GameServer/Actor/Backpack');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Database = invoke('Database');
const temp = isolated.directory;
const dbPath = isolated.world;

// E232: eating pet food removes the food and raises the pet's feed. Both
// must reach the database together, as the mounted strider food already does
// (Database.feedMountedPet); a failed second write must not leave the food
// gone and the feed unchanged on the next load.
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
    seed.exec("INSERT INTO accounts(username,password) VALUES ('pet_food','test'); INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES (2000001,'pet_food','PetOwner',0,0,40,500,300,0,0,0,0,0,0,0)");
    seed.exec("INSERT INTO items(id,selfId,name,amount,characterId) VALUES (100,2375,'Wolf Collar',1,2000001),(101,2515,'Food for Wolves',10,2000001)");
    seed.close();
    options.default.Database.path = dbPath;
    Database.init();
    const read = new DatabaseSync(dbPath);
    const backpack = new Backpack({ id: 2000001, paperdoll: [], items: read.prepare('SELECT * FROM items').all() });
    const session = owner(backpack);
    World.user = { sessions: [session] };
    World.npc = { spawns: [], grid: {}, nextId: 9000001 };
    backpack.spawnPetFromItem(session, { itemObjectId: 100, npcId: 12077 });
    const pet = session.actor.pet;
    assert(pet, 'wolf spawns from collar');
    await pet.persistTail;
    await Inventory.transfer(session, 101, 4, 'deposit');
    const food = Inventory.items(pet).find(item => item.fetchSelfId() === 2515);
    assert.strictEqual(food.fetchAmount(), 4);
    const feed = Inventory.foodValue(2515);
    assert(feed > 0, 'wolf food has a feed value');
    pet.setCurrentFeed(1);

    // Every pet state write after the food left the pet inventory fails.
    const saveState = Database.savePetState;
    const transfer = Database.transferPetInventory;
    let foodRemoved = false;
    Database.transferPetInventory = async (...args) => { const result = await transfer(...args); foodRemoved = true; return result; };
    Database.savePetState = (...args) => foodRemoved ? Promise.reject(new Error('injected pet state write failure')) : saveState(...args);
    try {
        await Inventory.use(session, food.fetchId()).catch(() => {});
    } finally {
        Database.savePetState = saveState;
        Database.transferPetInventory = transfer;
    }
    assert(foodRemoved, 'the food was consumed');
    const stored = JSON.parse(read.prepare('SELECT petData FROM items WHERE id=100').get().petData);
    assert.strictEqual(stored.inventory.find(item => item.selfId === 2515).amount, 3, 'one food left the stored pet inventory');
    const expected = Math.min(Rules.stats(12077, pet.fetchLevel()).maxFeed, 1 + feed);
    assert.strictEqual(stored.currentFeed, expected, 'the stored feed rose with the food that left the inventory');
    assert.strictEqual(stored.starvingSince, 0);
    assert.strictEqual(pet.fetchCurrentFeed(), expected, 'memory matches the stored feed');
    assert.strictEqual(backpack.fetchItemRaw(100).fetchPetData().currentFeed, expected, 'collar snapshot carries the new feed');

    read.close();
    await Database.close();
    console.log('Pet food and feed are written together');
}
main().catch(async error => {
    console.error(error);
    await Database.close().catch(() => {});
    process.exitCode = 1;
}).finally(() => { fs.rmSync(temp, { recursive: true, force: true }); });

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Backpack = invoke('GameServer/Actor/Backpack');
const Quests = invoke('GameServer/Quest/QuestService');
const Exchange = invoke('GameServer/Pets/PetExchange');
const World = invoke('GameServer/World/World');
const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'pet-ticket-items-'));
let read;
async function main() {
    DataCache.init();
    for (const id of [7548,7549,7550,7551,7552,7553,7583,7584,7585,6648,6649,6650,7582]) {
        assert.strictEqual(DataCache.items.filter(item => item.selfId === id).length, 1, `one real template for ${id}`);
    }
    const dbPath = path.join(root, 'world.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(fs.readFileSync('database/sql/sqlite.sql', 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('quest_items_test','test'); INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES (2000001,'quest_items_test','QuestTester',0,0,50,500,300,0,0,0,0,0,0,0)");
    seed.close();
    options.default.Database.path = dbPath;
    Database.init();
    read = new DatabaseSync(dbPath);
    const packets = [];
    const session = { actor: { backpack: new Backpack({ items: [], paperdoll: [] }), fetchId: () => 2000001, fetchLevel: () => 50,
        fetchName: () => 'QuestTester', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
        fetchRadius: () => 10, fetchPvpFlag: () => 0, fetchKarma: () => 0, isDead: () => false,
        state: { fetchHits: () => false, fetchDead: () => false } }, dataSendToMe: packet => packets.push(packet), dataSendToMeAndOthers() {} };
    const count = id => session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
    const kill = id => Quests.onKill(session, { fetchSelfId: () => id });
    const event = (questId, npcId, name) => {
        session.activeNpcTalk = { selfId: npcId, objectId: 1000001 };
        return Quests.onEvent(session, { questId, name });
    };
    for (const [questId, startNpc, partnerNpc, mob, fragment, map, ticket] of [
        [43,7829,7097,171,7550,7551,7584], [42,7828,7735,68,7548,7549,7583], [44,7827,7505,919,7552,7553,7585]
    ]) {
        await Database.setCharacterQuest(2000001, questId, 'started', { cond: 2 });
        session.questStatesLoaded = false;
        if (questId === 43) {
            const templates = DataCache.items;
            DataCache.items = templates.filter(item => item.selfId !== fragment);
            try {
                await assert.rejects(Promise.race([kill(mob), new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error('quest queue hung')), 2000); timer.unref();
                })]), /Missing quest item template 7550/);
            } finally { DataCache.items = templates; }
        }
        await kill(1);
        assert.strictEqual(count(fragment), 0, 'unrelated mobs do not award fragments');
        const originalPreset = process.env.L2NODE_PROGRESSION_RATE;
        try {
            for (const preset of ['x1', 'x10', 'x50']) {
                process.env.L2NODE_PROGRESSION_RATE = preset;
                const before = count(fragment);
                await kill(mob);
                assert.strictEqual(count(fragment), before + 1, `one map piece per kill at ${preset}, with a working quest queue`);
            }
        } finally {
            if (originalPreset === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
            else process.env.L2NODE_PROGRESSION_RATE = originalPreset;
        }
        for (let i = 0; i < 30 && count(fragment) < 30; i++) await kill(mob);
        assert.strictEqual(count(fragment), 30);
        await kill(mob);
        assert.strictEqual(count(fragment), 30, 'fragment cap');
        assert.strictEqual(session.questStates.get(questId).getInt('cond'), 3);
        await event(questId, startNpc, 'map');
        assert.strictEqual(count(fragment), 0);
        assert.strictEqual(count(map), 1);
        await event(questId, partnerNpc, 'partner');
        assert.strictEqual(count(map), 0);
        await event(questId, startNpc, 'reward');
        assert.strictEqual(count(ticket), 1);
        assert.strictEqual(read.prepare('SELECT amount FROM items WHERE characterId=2000001 AND selfId=?').get(ticket).amount, 1);
    }
    const cougarTicket = session.actor.backpack.fetchItemFromSelfId(7584).fetchId();
    read.exec("CREATE TRIGGER reject_pet_exchange BEFORE INSERT ON items WHEN NEW.selfId = 6649 BEGIN SELECT RAISE(ABORT, 'exchange rollback probe'); END");
    await assert.rejects(Database.exchangePetTicket(2000001, cougarTicket), /exchange rollback probe/);
    assert.strictEqual(read.prepare('SELECT amount FROM items WHERE id=?').get(cougarTicket).amount, 1, 'failed output insertion rolls ticket consumption back');
    read.exec('DROP TRIGGER reject_pet_exchange');
    await Quests.giveItem(session, 7584, 1);
    World.user = { sessions: [session] };
    World.npc = { nextId: 1000100, grid: {}, spawns: [] };
    const Talk = invoke('GameServer/World/Generics/NpcTalk');
    for (const managerId of Exchange.managers) {
        const manager = { fetchSelfId: () => managerId, fetchId: () => 1000001, fetchName: () => 'Pet Manager',
            fetchTitle: () => 'Pet Manager', fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
        World.npc.spawns = [manager];
        Talk(session, manager);
        assert(packets.some(packet => packet.includes(Buffer.from('Exchange a Pet Ticket', 'utf16le'))), 'native manager dialog includes exchange');
        packets.length = 0;
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'pet-exchange' });
        assert(session.activePetExchange?.token);
    }
    for (const [ticketId, collarId, npcId] of [[7584,6649,12782], [7583,6648,12780], [7585,6650,12781]]) {
        Exchange.menu(session);
        const token = session.activePetExchange.token;
        const beforeTickets = count(ticketId);
        const ticketObjectId = session.actor.backpack.fetchItemFromSelfId(ticketId).fetchId();
        await assert.rejects(Database.exchangePetTicket(999999, ticketObjectId), /no longer owned/);
        session.activeTrade = {};
        await assert.rejects(Exchange.exchange(session, token, ticketId));
        session.activeTrade = null;
        const realX = session.actor.fetchLocX;
        session.actor.fetchLocX = () => 10000;
        await assert.rejects(Exchange.exchange(session, token, ticketId));
        session.actor.fetchLocX = realX;
        const results = await Promise.allSettled([Exchange.exchange(session, token, ticketId), Exchange.exchange(session, token, ticketId)]);
        assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1, 'one exchange per menu request');
        assert.strictEqual(count(ticketId), beforeTickets - 1);
        assert.strictEqual(count(collarId), 1);
        await assert.rejects(Exchange.exchange(session, token, ticketId), /menu again/);
        if (beforeTickets === 1) await assert.rejects(Database.exchangePetTicket(2000001, ticketObjectId), /missing/);
        const collar = session.actor.backpack.fetchItemFromSelfId(collarId);
        assert.strictEqual(collar.fetchStackable(), false, 'each pet has its own control item');
        session.actor.backpack.spawnPetFromItem(session, { itemObjectId: collar.fetchId(), npcId });
        const pet = session.actor.pet;
        assert(pet, 'exchanged collar summons its pet');
        assert.strictEqual(pet.fetchSelfId(), npcId);
        await pet.persistTail;
        invoke('GameServer/Npc/SummonControl').unsummon(session, session.actor, pet);
        await pet.teardownTail;
        assert.strictEqual(JSON.parse(read.prepare('SELECT petData FROM items WHERE id=?').get(collar.fetchId()).petData).npcId, npcId);
    }
    Exchange.menu(session);
    const secondCougar = await Exchange.exchange(session, session.activePetExchange.token, 7584);
    const cougarItems = session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 6649);
    assert.strictEqual(cougarItems.length, 2, 'two tickets produce independent control items');
    assert(cougarItems.every(item => item.fetchAmount() === 1));
    assert.strictEqual(read.prepare('SELECT petData FROM items WHERE id=?').get(secondCougar.id).petData, null, 'new collar has no inherited progress');
    assert(invoke('GameServer/World/Generics/NpcShopBuyLists').fetchForNpc(7829).some(item => item.selfId === 7582), 'Cooper sells baby food');
    assert.strictEqual(read.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    console.log('Pet ticket drops, quest completion, manager exchanges, replay rejection and pet summoning passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    const session = World.user?.sessions?.[0];
    session?.actor?.pet?.destructor(session);
    read?.close(); await Database.close(); fs.rmSync(root, { recursive: true, force: true });
});

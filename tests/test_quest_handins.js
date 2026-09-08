const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const QuestService = invoke('GameServer/Quest/QuestService');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
const Response = invoke('GameServer/Network/Response');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-quest-handins-'));
const file = path.join(directory, 'quests.sqlite');
const originalUserInfo = Response.userInfo;
const originalWarn = utils.infoWarn;
const warnings = [];

// Exercise real quest services, inventory packets, item templates and SQLite.
// Only unrelated character-stat rendering is replaced for the minimal actor.
Response.userInfo = () => Buffer.from([0x04]);
utils.infoWarn = (prefix, ...args) => warnings.push(require('node:util').format(...args));
options.default.Database.path = file;
process.env.L2NODE_PROGRESSION_RATE = 'x1';
Object.assign(options.default.General, {
    expRate: 1, spRate: 1, questExpRate: 1, questSpRate: 1, questAdenaRate: 1
});

async function sessionFor(id) {
    const session = {
        packets: [],
        actor: {
            exp: 0, sp: 0,
            fetchId: () => id,
            fetchName: () => `QuestTest${id}`,
            fetchRace: () => 2,
            fetchLevel: () => 6,
            fetchClanId: () => 0,
            fetchExp() { return this.exp; },
            fetchSp() { return this.sp; },
            setExpSp(exp, sp) { this.exp = exp; this.sp = sp; },
            backpack: new Backpack({ items: await Database.fetchItems(id), paperdoll: {} })
        },
        dataSendToMe(packet) { this.packets.push(packet); }
    };
    await QuestService.ensureLoaded(session);
    return session;
}

const count = (session, id) => session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
const state = (session, id) => session.questStates.get(id);
const html = session => session.packets.filter(p => p[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';

async function settle(session) {
    await session.questMutationTail;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings, [], 'NPC interactions must not fall back after an exception');
}

async function talk(session, npcId) {
    session.packets.length = 0;
    NpcTalk(session, {
        fetchSelfId: () => npcId, fetchId: () => 100000 + npcId,
        fetchName: () => 'Quest NPC', fetchTitle: () => ''
    });
    await settle(session);
    if (html(session).includes('bypass -h gatekeeper-quest')) {
        NpcTalkResponse(session, { link: 'gatekeeper-quest' });
        await settle(session);
    }
    if (html(session).includes(`html ${npcId}-quest`)) {
        NpcTalkResponse(session, { link: `html ${npcId}-quest` });
        await settle(session);
    }
    assert.doesNotMatch(html(session), /You are either not on a quest/);
    return html(session);
}

async function click(session, questId, event) {
    NpcTalkResponse(session, { link: `quest ${questId} ${event}` });
    await settle(session);
}

async function continueAt(session, npcId, event) {
    assert.match(await talk(session, npcId), new RegExp(`quest 168 ${event}`));
    await click(session, 168, event);
}

async function main() {
    const seed = new DatabaseSync(file);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('quest_test', 'test');
    for (let id = 1; id <= 10; id++) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (?, 'quest_test', ?, 31, 2, 6, 187, 74, 0, 0, 0, 0, 0, 0, 0)`).run(id, `QuestTest${id}`);
    }
    seed.close();
    Database.init();
    DataCache.init();

    const hunt = await sessionFor(1);
    assert.match(await talk(hunt, 7348), /quest 165 start/);
    await click(hunt, 165, 'start');
    const wolf = { fetchSelfId: () => 456 };
    for (let i = 0; i < 12; i++) await QuestService.onKill(hunt, wolf);
    assert.equal(count(hunt, 1160), 12);
    assert.match(await talk(hunt, 7348), /12\/13/);
    assert.equal(count(hunt, 1060), 0);
    await QuestService.onKill(hunt, wolf);
    assert.equal(state(hunt, 165).getInt('cond'), 2);
    await QuestService.onKill(hunt, wolf);
    assert.equal(count(hunt, 1160), 13, 'quest drops stop at the target');
    const bezoar = hunt.actor.backpack.fetchItemFromSelfId(1160);
    invoke('GameServer/World/Generics/NpcBypasses/SellShop')(hunt);
    assert(!hunt.activeNpcSellShop.items.has(bezoar.fetchId()), 'real quest items must not be offered for sale');
    hunt.activeNpcSellShop.items.set(bezoar.fetchId(), { selfId: 1160, price: 1 });
    const sellRequest = Buffer.alloc(21);
    sellRequest.writeInt32LE(1, 5);
    sellRequest.writeInt32LE(bezoar.fetchId(), 9);
    sellRequest.writeInt32LE(1160, 13);
    sellRequest.writeInt32LE(13, 17);
    await invoke('GameServer/Network/Request/Sell')(hunt, sellRequest);
    invoke('GameServer/World/Generics/NpcBypasses/SellJunk')(hunt);
    assert.equal(count(hunt, 1160), 13);
    assert.equal(count(hunt, 57), 0);
    const retainedItems = await Database.fetchItems(1);
    assert.equal(Number(retainedItems.find(item => Number(item.selfId) === 1160).amount), 13);
    assert(!retainedItems.some(item => Number(item.selfId) === 57), 'rejected quest sales must not persist Adena');
    assert.match(await talk(hunt, 7348), /hunt is complete/);
    assert.equal(count(hunt, 1160), 0);
    assert.equal(count(hunt, 1060), 5);
    assert.equal(hunt.actor.fetchExp(), 1000);
    assert.equal(state(hunt, 165).isCompleted(), true);
    assert.equal(QuestService.active(hunt).some(q => q.id === 165), false);
    assert.match(await talk(hunt, 7348), /already completed/);
    await click(hunt, 165, 'start');
    assert.equal(state(hunt, 165).isCompleted(), true, 'completed hunt cannot restart through a stale link');
    assert.equal(count(hunt, 1060), 5);

    // Both orders for the two independent sentry deliveries must complete.
    for (const [id, order] of [[2, [[7355, 'roselyn', 1155], [7357, 'kristin', 1156]]],
        [3, [[7357, 'kristin', 1156], [7355, 'roselyn', 1155]]]]) {
        const delivery = await sessionFor(id);
        await talk(delivery, 7349);
        await click(delivery, 168, 'start');
        assert.equal(count(delivery, 1153), 1);
        await continueAt(delivery, 7360, 'harant');
        assert.equal(count(delivery, 1153), 0);
        assert.deepEqual([1154, 1155, 1156].map(i => count(delivery, i)), [1, 1, 1]);
        assert.equal(state(delivery, 168).getInt('cond'), 2);
        await click(delivery, 168, 'harant');
        assert.deepEqual([1154, 1155, 1156].map(i => count(delivery, i)), [1, 1, 1]);
        await continueAt(delivery, 7349, 'jenna');
        assert.equal(count(delivery, 1154), 0);
        assert.equal(state(delivery, 168).getInt('cond'), 3);
        for (const [npcId, event, blade] of order) {
            await continueAt(delivery, npcId, event);
            assert.equal(count(delivery, blade), 0);
            const swords = count(delivery, 1157);
            await click(delivery, 168, event);
            assert.equal(count(delivery, 1157), swords, 'repeated delivery cannot duplicate a sword');
        }
        assert.equal(count(delivery, 1157), 2);
        assert.equal(state(delivery, 168).getInt('cond'), 4);
        await continueAt(delivery, 7349, 'reward');
        assert.equal(count(delivery, 1157), 0);
        assert.equal(count(delivery, 57), 820);
        assert.equal(state(delivery, 168).isCompleted(), true);
        await click(delivery, 168, 'reward');
        await click(delivery, 168, 'start');
        assert.equal(count(delivery, 57), 820, 'stale reward links cannot pay twice');
        assert.equal(state(delivery, 168).isCompleted(), true);
    }

    // A stale condition without its required inventory must not advance.
    const missing = await sessionFor(4);
    await talk(missing, 7349);
    await click(missing, 168, 'start');
    await QuestService.takeItem(missing, 1153);
    await continueAt(missing, 7360, 'harant');
    assert.equal(state(missing, 168).getInt('cond'), 1);
    assert.equal(count(missing, 1154), 0);
    await state(missing, 168).set('cond', 4);
    await QuestService.giveItem(missing, 1157, 1);
    await continueAt(missing, 7349, 'reward');
    assert.equal(count(missing, 57), 0, 'one sword is insufficient for the reward');
    assert.equal(count(missing, 1157), 1);
    assert.equal(state(missing, 168).isStarted(), true);

    // The same faulty argument also blocked Mass of Darkness's final hand-in.
    await talk(missing, 7130);
    await click(missing, 166, 'start');
    for (const npcId of [7135, 7139, 7143]) await talk(missing, npcId);
    assert.equal(state(missing, 166).getInt('cond'), 2);
    await talk(missing, 7130);
    assert.equal(state(missing, 166).isCompleted(), true);
    assert.deepEqual([1088, 1089, 1090, 1091].map(i => count(missing, i)), [0, 0, 0, 0]);
    assert.equal(count(missing, 57), 500);

    const adventures = [
        { quest: 6, race: 0, start: 7006, giver: 7033, recipient: 7311, event: 'letter', item: 7571 },
        { quest: 7, race: 1, start: 7146, giver: 7148, recipient: 7154, event: 'recommendation', item: 7572 },
        { quest: 8, race: 2, start: 7134, giver: 7355, recipient: 7144, event: 'note', item: 7573 }
    ];
    for (const [index, route] of adventures.entries()) {
        for (const recovering of [false, true]) {
            const id = 5 + index * 2 + Number(recovering);
            if (recovering) {
                // Persist the exact old bug: stage 2 was saved without its item.
                await Database.setCharacterQuest(id, route.quest, 'started', { cond: '2' });
                await WriteQueue.flushAll();
                await Database.close();
                Database.init();
            }
            const traveler = await sessionFor(id);
            traveler.actor.fetchRace = () => route.race;
            if (route.quest === 8) {
                await Database.setCharacterQuest(id, 168, 'started', { cond: '1' });
                traveler.questStatesLoaded = false;
                await QuestService.ensureLoaded(traveler);
            }
            if (!recovering) {
                await talk(traveler, route.start);
                await click(traveler, route.quest, 'start');
            }
            assert.match(await talk(traveler, route.giver), new RegExp(`quest ${route.quest} ${route.event}`));
            if (!recovering) {
                const originalSetItem = Database.setItem;
                Database.setItem = async () => { throw new Error('injected item write failure'); };
                try {
                    await assert.rejects(QuestService.onEvent(traveler, { questId: route.quest, name: route.event }), /injected item write failure/);
                } finally { Database.setItem = originalSetItem; }
                assert.equal(state(traveler, route.quest).getInt('cond'), 1);
                const persisted = (await Database.fetchCharacterQuests(id)).find(q => Number(q.questId) === route.quest);
                assert.equal(JSON.parse(persisted.variables).cond, '1', 'failed issuance must not persist the delivery stage');
            }
            await click(traveler, route.quest, route.event);
            assert.equal(count(traveler, route.item), 1);
            assert.equal(state(traveler, route.quest).getInt('cond'), 2);
            await click(traveler, route.quest, route.event);
            assert.equal(count(traveler, route.item), 1, 'recovery links must not duplicate the item');
            assert.doesNotMatch(await talk(traveler, route.giver), new RegExp(`quest ${route.quest} ${route.event}`));
            await talk(traveler, route.recipient);
            await click(traveler, route.quest, 'deliver');
            assert.equal(count(traveler, route.item), 0);
            assert.equal(state(traveler, route.quest).getInt('cond'), 3);
            await talk(traveler, route.giver);
            await click(traveler, route.quest, route.event);
            assert.equal(count(traveler, route.item), 0, 'delivered documents must not be reissued');
            await talk(traveler, route.start);
            await click(traveler, route.quest, 'reward');
            assert.equal(state(traveler, route.quest).isCompleted(), true);
            assert.equal(count(traveler, 7570), 1);
            assert.equal(count(traveler, 7559), 1);
            const scrollSkill = traveler.actor.backpack.buildItemSkill(
                invoke('GameServer/Items/C4ItemSkills').resolve(7559)
            );
            assert.equal(scrollSkill.fetchSelfId(), 2214);
            assert.equal(scrollSkill.fetchLevel(), 10);
            assert.deepEqual(scrollSkill.fetchTeleportCoords(), { locX: 83400, locY: 147943, locZ: -3404 });
            await click(traveler, route.quest, 'reward');
            assert.equal(count(traveler, 7570), 1);
            assert.equal(count(traveler, 7559), 1);
        }
    }

    await WriteQueue.flushAll();
    await Database.close();
    Database.init();
    const restoredHunt = await sessionFor(1);
    assert.equal(state(restoredHunt, 165).isCompleted(), true);
    assert.equal(count(restoredHunt, 1060), 5);
    assert.equal(count(restoredHunt, 1160), 0);
    for (const id of [2, 3]) {
        const restored = await sessionFor(id);
        assert.equal(state(restored, 168).isCompleted(), true);
        assert.equal(count(restored, 57), 820);
        assert.deepEqual([1153, 1154, 1155, 1156, 1157].map(i => count(restored, i)), [0, 0, 0, 0, 0]);
    }
    const rows = await Database.execute(['SELECT exp FROM characters WHERE id = 1', []], 'test:quest-exp');
    assert.equal(Number(rows[0].exp), 1000);
    for (let id = 5; id <= 10; id++) {
        const restored = await sessionFor(id);
        assert.equal(state(restored, adventures[Math.floor((id - 5) / 2)].quest).isCompleted(), true);
        assert.equal(count(restored, 7570), 1);
        assert.equal(count(restored, 7559), 1);
    }
    assert.deepEqual(warnings, []);
    console.log('Quest hand-ins: NPC routing, inventory, rewards, replay protection and SQLite reload passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await WriteQueue.flushAll();
    await Database.close();
    Response.userInfo = originalUserInfo;
    utils.infoWarn = originalWarn;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(directory);
});

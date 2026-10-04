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
    for (let id = 1; id <= 25; id++) {
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

    for (const recovering of [false, true]) {
        const traveler = await sessionFor(recovering ? 25 : 24);
        traveler.actor.fetchRace = () => 3;
        await talk(traveler, 7583);
        await click(traveler, 9, 'start');
        await talk(traveler, 7571);
        await click(traveler, 9, 'council');
        if (recovering) await QuestService.giveItem(traveler, 7570, 3);
        await talk(traveler, 7576);
        if (!recovering) {
            const originalSetItem = Database.setItem;
            Database.setItem = async (id, item) => {
                if (item.selfId === 7126) throw new Error('injected scroll write failure');
                return originalSetItem(id, item);
            };
            try {
                await assert.rejects(QuestService.onEvent(traveler, { questId: 9, name: 'reward' }), /injected scroll write failure/);
            } finally { Database.setItem = originalSetItem; }
            assert.equal(count(traveler, 7570), 1);
            assert.equal(state(traveler, 9).isStarted(), true);
        }
        await click(traveler, 9, 'reward');
        assert.equal(state(traveler, 9).isCompleted(), true);
        assert.equal(count(traveler, 7570), recovering ? 3 : 1);
        assert.equal(count(traveler, 7126), 1);
        await click(traveler, 9, 'reward');
        assert.equal(count(traveler, 7570), recovering ? 3 : 1);
        assert.equal(count(traveler, 7126), 1);
        const restored = await sessionFor(recovering ? 25 : 24);
        assert.equal(state(restored, 9).isCompleted(), true);
        assert.equal(count(restored, 7126), 1);
        assert.equal(count(restored, 7570), recovering ? 3 : 1);
    }

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

    let nightmare = await sessionFor(12);
    nightmare.actor.fetchLevel = () => 19;
    assert.match(await talk(nightmare, 7145), /quest 169 start/);
    await click(nightmare, 169, 'start');
    const nightmareRandom = Math.random;
    try {
        Math.random = () => 0.3;
        await QuestService.onKill(nightmare, { fetchSelfId: () => 25 });
        assert.equal(count(nightmare, 1030), 1);
        assert.match(await talk(nightmare, 7145), /skull is still missing/);
        Math.random = () => 0;
        await QuestService.onKill(nightmare, { fetchSelfId: () => 105 });
    } finally { Math.random = nightmareRandom; }
    assert.equal(count(nightmare, 1031), 1);
    assert.equal(state(nightmare, 169).getInt('cond'), 2);
    await QuestService.onKill(nightmare, { fetchSelfId: () => 25 });
    assert.equal(count(nightmare, 1031), 1, 'drops stop after the perfect skull');
    await WriteQueue.flushAll();
    nightmare = await sessionFor(12);
    assert.equal(state(nightmare, 169).getInt('cond'), 2);
    assert.match(await talk(nightmare, 7145), /nightmare is ended/);
    assert.equal(state(nightmare, 169).isCompleted(), true);
    assert.equal(count(nightmare, 1031), 0);
    assert.equal(count(nightmare, 31), 1);
    assert.equal(count(nightmare, 1030), 0);
    assert.equal(count(nightmare, 57), 17020);
    assert.match(await talk(nightmare, 7145), /already completed/);
    await click(nightmare, 169, 'start');
    assert.equal(state(nightmare, 169).isCompleted(), true, 'a stale start link cannot restart the quest');
    assert.equal(count(nightmare, 31), 1);
    assert.equal(count(nightmare, 57), 17020);

    // Hand-in follows actual inventory, including interrupted stage updates.
    for (const [id, cond, skulls] of [[13, '1', 1], [14, '2', 0]]) {
        await Database.setCharacterQuest(id, 169, 'started', { cond });
        const recovering = await sessionFor(id);
        if (skulls) await QuestService.giveItem(recovering, 1031, skulls);
        await talk(recovering, 7145);
        assert.equal(state(recovering, 169).isCompleted(), Boolean(skulls));
        assert.equal(count(recovering, 31), skulls, 'no reward without a perfect skull');
        assert.equal(count(recovering, 57), skulls * 17000);
        assert.equal(count(recovering, 1031), 0);
    }


    const seduction = await sessionFor(15);
    for (const level of [19, 20]) {
        seduction.actor.fetchLevel = () => level;
        const unavailable = await talk(seduction, 7305);
        assert.match(unavailable, /Dangerous Seduction/);
        assert.match(unavailable, /level 21/);
        assert.doesNotMatch(unavailable, /quest 170 start/);
        await click(seduction, 170, 'start');
        assert.equal(state(seduction, 170).isStarted(), false);
    }
    seduction.actor.fetchLevel = () => 21;
    seduction.actor.fetchRace = () => 0;
    assert.match(await talk(seduction, 7305), /Dark Elves only/);
    assert.doesNotMatch(html(seduction), /quest 170 start/);
    await click(seduction, 170, 'start');
    assert.equal(state(seduction, 170).isStarted(), false);
    seduction.actor.fetchRace = () => 2;
    assert.match(await talk(seduction, 7305), /quest 170 start/);
    assert.match(html(seduction), /Dangerous Seduction/);
    await click(seduction, 170, 'start');
    assert.equal(state(seduction, 170).isStarted(), true);
    assert.match(await talk(seduction, 7305), /Bring the nightmare crystal/);
    await QuestService.onKill(seduction, { fetchSelfId: () => 5022 });
    await QuestService.onKill(seduction, { fetchSelfId: () => 5022 });
    assert.equal(count(seduction, 1046), 1);
    assert.match(await talk(seduction, 7305), /resisted temptation/);
    assert.equal(count(seduction, 1046), 0);
    assert.equal(count(seduction, 57), 102680);
    assert.equal(state(seduction, 170).isCompleted(), true);
    assert.match(await talk(seduction, 7305), /already completed/);
    assert.doesNotMatch(html(seduction), /quest 170 start/);
    await click(seduction, 170, 'start');
    assert.equal(state(seduction, 170).isCompleted(), true);
    assert.equal(count(seduction, 57), 102680);

    for (const [id, recipient, event, total] of [
        [16, 7255, 'haprock_finish', 5000],
        [17, 7210, 'norman_finish', 22000]
    ]) {
        let kin = await sessionFor(id);
        kin.actor.fetchLevel = () => 19;
        await talk(kin, 7350);
        await click(kin, 167, 'start');
        assert.equal(count(kin, 1076), 1);
        await click(kin, 167, 'haprock');
        assert.equal(count(kin, 1076), 1, 'letter cannot be delivered at the starting NPC');
        assert.match(await talk(kin, 7255), /quest 167 haprock/);
        await click(kin, 167, 'haprock');
        assert.equal(state(kin, 167).getInt('cond'), 2);
        assert.equal(count(kin, 1076), 0);
        assert.equal(count(kin, 1106), 1);
        assert.equal(count(kin, 57), 2000);
        await click(kin, 167, 'haprock');
        assert.equal(count(kin, 1106), 1);
        assert.equal(count(kin, 57), 2000);
        await click(kin, 167, 'norman_finish');
        assert.equal(state(kin, 167).isCompleted(), false, 'Norman delivery cannot run at Haprock');
        await WriteQueue.flushAll();
        kin = await sessionFor(id);
        kin.actor.fetchLevel = () => 19;
        assert.match(await talk(kin, recipient), new RegExp(`quest 167 ${event}`));
        await click(kin, 167, event);
        assert.equal(state(kin, 167).isCompleted(), true);
        assert.equal(count(kin, 1106), 0);
        assert.equal(count(kin, 57), total);
        await click(kin, 167, event);
        await talk(kin, 7350);
        await click(kin, 167, 'start');
        assert.equal(state(kin, 167).isCompleted(), true);
        assert.equal(count(kin, 1076), 0);
        assert.equal(count(kin, 57), total);
    }
    const lostLetter = await sessionFor(18);
    lostLetter.actor.fetchLevel = () => 19;
    await talk(lostLetter, 7350);
    await click(lostLetter, 167, 'start');
    await QuestService.takeItem(lostLetter, 1076);
    await talk(lostLetter, 7255);
    await click(lostLetter, 167, 'haprock');
    assert.equal(state(lostLetter, 167).getInt('cond'), 1);
    assert.equal(count(lostLetter, 1106), 0);
    assert.equal(count(lostLetter, 57), 0);
    await state(lostLetter, 167).set('cond', 2);
    for (const [npc, event] of [[7255, 'haprock_finish'], [7210, 'norman_finish']]) {
        await talk(lostLetter, npc);
        await click(lostLetter, 167, event);
        assert.equal(state(lostLetter, 167).isCompleted(), false);
        assert.equal(count(lostLetter, 57), 0, 'missing letters must not pay rewards');
    }

    // Luxury exchange merchants keep their shop menu before quest routing.
    for (const race of [0, 1, 2, 3, 4]) {
        const visitor = await sessionFor(19 + race);
        visitor.actor.fetchRace = () => race;
        visitor.actor.fetchLevel = () => 25;
        const galladucci = { fetchSelfId: () => 7097, fetchId: () => 107097,
            fetchName: () => 'Galladucci', fetchTitle: () => 'Trader' };
        NpcTalk(visitor, galladucci);
        await settle(visitor);
        assert.match(html(visitor), /exchange-shop npc/);
        assert.match(html(visitor), /sell-shop/);
        assert.match(html(visitor), /html 7097-quest/);
        assert.doesNotMatch(html(visitor), /Available quests/);
        NpcTalkResponse(visitor, { link: 'exchange-shop npc' });
        assert.match(html(visitor), /exchange-shop buy/);
        NpcTalkResponse(visitor, { link: 'sell-shop' });
        assert(visitor.activeNpcSellShop, 'selling remains reachable');
        NpcTalkResponse(visitor, { link: 'html 7097-quest' });
        await settle(visitor);
        assert.match(html(visitor), /Mark of Traveler/);
        assert.doesNotMatch(html(visitor), /quest \d+ start/);
        await QuestService.giveItem(visitor, 7570, 1);
        const page = await talk(visitor, 7097);
        assert.match(page, new RegExp(`quest ${45 + race} start`));
        assert.equal((page.match(/quest \d+ start/g) || []).length, 1);
        await click(visitor, 45 + race, 'start');
        assert.equal(state(visitor, 45 + race).isStarted(), true);
        assert.equal(count(visitor, 7563), 1);
        await QuestService.takeItem(visitor, 7563);
        await talk(visitor, 7097);
        assert.equal(count(visitor, 7563), 1, 'recover a started route missing its initial order');
        await talk(visitor, 7097);
        assert.equal(count(visitor, 7563), 1, 'recovery does not duplicate orders');
        NpcTalk(visitor, galladucci);
        await settle(visitor);
        assert.match(html(visitor), /exchange-shop npc/, 'active quests also preserve trading');
        for (const [npc, event] of [[7094, 'hilt'], [7097, 'order2'], [7090, 'powder'],
            [7097, 'order3'], [7116, 'necklace'], [7097, 'reward']]) {
            await talk(visitor, npc);
            await click(visitor, 45 + race, event);
        }
        assert.equal(state(visitor, 45 + race).isCompleted(), true);
        assert.equal(count(visitor, 7554 + race), 1);
        for (const item of [7570, 7563, 7564, 7565, 7566, 7567, 7568]) assert.equal(count(visitor, item), 0);
        await talk(visitor, 7097);
        await click(visitor, 45 + race, 'start');
        assert.equal(state(visitor, 45 + race).isCompleted(), true);

    }

    const craftsman = await sessionFor(11);
    craftsman.actor.fetchLevel = () => 15;
    assert.match(await talk(craftsman, 7307), /quest 103 start/);
    await click(craftsman, 103, 'start');
    assert.equal(count(craftsman, 968), 1);
    assert.match(await talk(craftsman, 7132), /Speak with Harne/);
    assert.equal(count(craftsman, 968), 0);
    assert.equal(count(craftsman, 969), 1);
    await talk(craftsman, 7144);
    const originalRandom = Math.random;
    try {
        Math.random = () => 0;
        for (let i = 0; i < 10; i++) await QuestService.onKill(craftsman, { fetchSelfId: () => 455 });
        assert.equal(count(craftsman, 1107), 10);
        assert.equal(state(craftsman, 103).getInt('cond'), 4);
        await talk(craftsman, 7144);
        assert.equal(count(craftsman, 1107), 0, 'Harne must consume all ten bone fragments');
        assert.equal(count(craftsman, 971), 1);
        await talk(craftsman, 7132);
        assert.equal(count(craftsman, 972), 1);
        await QuestService.onKill(craftsman, { fetchSelfId: () => 15 });
    } finally { Math.random = originalRandom; }
    await talk(craftsman, 7132);
    assert.equal(count(craftsman, 974), 1);
    assert.match(await talk(craftsman, 7307), /spirit is at peace/);
    assert.equal(state(craftsman, 103).isCompleted(), true);
    assert.equal(count(craftsman, 975), 1);
    for (const id of [968, 969, 970, 971, 972, 973, 974, 1107]) assert.equal(count(craftsman, id), 0);

    await WriteQueue.flushAll();
    await Database.close();
    Database.init();
    const restoredNightmare = await sessionFor(12);
    assert.equal(state(restoredNightmare, 169).isCompleted(), true);
    assert.equal(count(restoredNightmare, 31), 1);
    assert.equal(count(restoredNightmare, 57), 17020);
    assert.equal(count(restoredNightmare, 1030), 0);
    assert.equal(count(restoredNightmare, 1031), 0);
    const restoredCraftsman = await sessionFor(11);
    assert.equal(state(restoredCraftsman, 103).isCompleted(), true);
    assert.equal(count(restoredCraftsman, 975), 1);
    assert.equal(count(restoredCraftsman, 1107), 0, 'consuming all fragments must persist');
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
    fs.rmSync(directory, { recursive: true, force: true });
});

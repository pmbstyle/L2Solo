const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, withRandom, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const H = invoke('GameServer/Quest/SecondProfessionQuest');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const DiamondExchange = invoke('GameServer/World/Generics/NpcBypasses/DiamondExchange');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const Actor = invoke('GameServer/Actor/Actor');
const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');

async function run() {
    const world = await createWorld([
        { id: 710001, classId: 1, level: 35 }, { id: 710002, classId: 1, level: 40 },
        { id: 710003, classId: 19, race: 1, level: 40 }
    ], 'second-profession');
    const runtime = enableQuestSpawns();
    let session = await world.session(710001);
    const stranger = await world.session(710002), elf = await world.session(710003);
    const id = session.actor.fetchId();
    const event = (quest, name, npc) => world.event(session, quest, name, npc);
    const kill = (npc, n = 1) => Promise.resolve().then(async () => {
        for (let i = 0; i < n; i++) await world.kill(session, npc);
    });
    const state = quest => world.state(session, quest);
    const cond = quest => state(quest).getInt('cond');
    const amount = item => world.amount(id, item);
    const level = async n => {
        await Database.execute(['UPDATE characters SET level = ? WHERE id = ?', [n, id]]);
        session.actor.level = n;
    };
    const personal = npc => H.personalSpawns(state(211), npc)[0];
    async function clickPersonal(name, npc) {
        session.activeNpcTalk = { selfId: npc.fetchSelfId(), objectId: npc.fetchId() };
        assert.equal(await Service.onEvent(session, { questId: 211, name }), true);
    }
    function staticNpc(selfId, objectId = selfId + 100000) {
        const npc = { fetchSelfId: () => selfId, fetchId: () => objectId,
            fetchName: () => H.npcName(selfId), fetchTitle: () => '',
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
        runtime.npc.spawns.push(npc);
        session.activeNpcTalk = { selfId, objectId };
        return npc;
    }
    async function realActor() {
        const row = await world.character(id), template = DataCache.classTemplates.find(row => row.classId === session.actor.fetchClassId());
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), id,
            name: row.name, username: row.username, level: row.level, classId: row.classId,
            locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
            items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
        session.dataSendToOthers = packet => session.packets.push(packet);
    }
    async function abort(target, questId) {
        const packet = Buffer.alloc(5);
        packet[0] = 0x64;
        packet.writeInt32LE(questId, 1);
        await QuestAbort(target, packet);
    }
    try {
        assert.equal(Profession.routes.length, 31);
        for (const route of Profession.routes) {
            assert.equal(route.marks.length, 3);
            assert(route.marks.every(id => DataCache.items.some(item => item.selfId === id)));
            assert(route.npcs.every(id => DataCache.npcs.some(npc => npc.selfId === id)));
        }
        const exchanges = require('../data/Items/dimensional_diamond_exchanges.json');
        assert.equal(exchanges.recipes.length, 18);
        for (const recipe of exchanges.recipes) {
            assert(DataCache.items.some(item => item.selfId === recipe.itemId && item.etc.stackable));
            assert.equal(recipe.cost, recipe.itemId <= 7121 ? 5 : 8);
            const use = invoke('GameServer/Items/C4ItemSkills').resolve(recipe.itemId);
            const skill = DataCache.skills.find(skill => skill.selfId === use.skillId);
            const destination = skill.levels.find(level => level.level === use.level);
            assert([destination.locX, destination.locY, destination.locZ].every(Number.isFinite),
                'each exchange scroll has a usable teleport destination');
        }
        assert.equal(await event(217, 'start', 7191), false, 'trust starts at 37');
        assert.equal(await event(222, 'start', 7623), false, 'duelist starts at 39');
        assert.equal(await world.event(elf, 217, 'start', 7191), false, 'trust is human only');
        // Two legitimately active quests at Asterios remain independently
        // reachable; selecting one does not progress the other.
        await world.event(elf, 7, 'start', 7146);
        await world.event(elf, 7, 'recommendation', 7148);
        await world.event(elf, 159, 'start', 7154);
        await world.talk(elf, 7154);
        assert.match(world.page(elf), /quest 159 show_quest/);
        assert.equal(await world.event(elf, 159, 'show_quest', 7154), true);
        assert.equal(world.state(elf, 7).getInt('cond'), 2);
        assert.equal(world.state(elf, 159).getInt('cond'), 1);
        assert.equal(await event(211, 'start', 7645), false, 'start bypass cannot move to another NPC');
        await event(211, 'start', 7644);
        await Promise.all([kill(5110), kill(5110)]);
        assert.equal(await amount(2632), 1);
        assert.equal(H.personalSpawns(state(211), 7647).length, 1);
        let chest = personal(7647);
        await world.event(stranger, 211, 'start', 7644);
        stranger.activeNpcTalk = { selfId: 7647, objectId: chest.fetchId() };
        assert.equal(await Service.onEvent(stranger, { questId: 211, name: 'open' }), false);
        assert.equal(await Service.onTalk(stranger, chest), false);
        // A restart can remove a temporary encounter. The saved kill position
        // recovers it without a second reward or an extra boss kill.
        H.clearSpawns(state(211));
        session = await world.reopen(id);
        assert.equal(cond(211), 2);
        await event(211, 'recover', 7644);
        chest = personal(7647);
        assert(chest);
        await withRandom([.9, .5], () => clickPersonal('open', chest));
        assert.equal(await amount(2631), 1);
        assert.equal(await amount(2632), 0);
        assert.equal(await Service.onEvent(session, { questId: 211, name: 'open' }), false);
        await event(211, 'letter', 7644);
        await event(211, 'martien', 7645);
        await kill(5112);
        await event(211, 'eye', 7645);
        await kill(5113);
        assert.equal(cond(211), 7);
        await event(211, 'filaur', 7535);
        assert.equal(cond(211), 7, 'Filaur waits until level 36');
        await clickPersonal('raldo', personal(7646));
        await event(211, 'filaur', 7535);
        assert.equal(cond(211), 8);
        await kill(5114);
        assert.equal(cond(211), 8, 'queen kill before Filaur directions gives no progress');
        await level(36);
        await event(211, 'filaur', 7535);
        await kill(5114);
        const beforeChallenger = await world.character(id);
        await clickPersonal('finish', personal(7646));
        assert.equal(await amount(2627), 1);
        assert.equal(await amount(7562), 8, 'historical C4 awards diamonds once');
        const afterChallenger = await world.character(id);
        assert.equal(afterChallenger.exp - beforeChallenger.exp, 72394);
        assert.equal(afterChallenger.sp - beforeChallenger.sp, 11250);
        assert.equal(afterChallenger.classId, 1, 'trial completion awards a mark, not a class');

        await level(37);
        await event(217, 'start', 7191);
        await event(217, 'handin', 7154);
        await withRandom([0], () => kill(36));
        await withRandom([0], () => kill(36));
        assert.equal(H.personalSpawns(state(217), 5120).length, 1, 'spirit summons are deduplicated');
        H.clearSpawns(state(217));
        session = await world.reopen(id);
        await withRandom([0], () => kill(36));
        assert.equal(H.personalSpawns(state(217), 5120).length, 1, 'hunting recovers a lost spirit after restart');
        let spirit = H.personalSpawns(state(217), 5120)[0];
        await Service.onKill(stranger, spirit);
        assert.equal(await amount(2746), 0);
        await Service.onKill(session, spirit);
        assert.equal(await amount(2746), 1);
        await withRandom([0], () => kill(13));
        spirit = H.personalSpawns(state(217), 5121)[0];
        await Service.onKill(session, spirit);
        assert.equal(cond(217), 3);
        await event(217, 'handin', 7154);
        await event(217, 'handin', 7358);
        await event(217, 'handin', 7464);
        await kill(550, 10);
        assert.equal(await amount(2752), 1);
        await kill(550, 11);
        assert.equal(await amount(2752), 1, 'finished reagent never repeats');
        assert.equal(await amount(2749), 0);
        await kill(82, 10);
        session = await world.reopen(id);
        assert.equal(cond(217), 6);
        await kill(234, 10);
        assert.equal(cond(217), 7);
        await event(217, 'handin', 7464);
        await event(217, 'handin', 7358);
        await event(217, 'handin', 7191);
        await event(217, 'handin', 7657);
        assert.equal(cond(217), 11);
        assert.equal(await amount(2739), 1, 'level gate retains the letter');
        await level(38);
        await event(217, 'handin', 7657);
        await event(217, 'handin', 7565);
        assert.equal(await amount(2757), 1, 'Letter to Manakia uses the source tuple ordering');
        await event(217, 'handin', 7515);
        await withRandom(Array(10).fill(.9), () => kill(553, 10));
        await event(217, 'handin', 7515);
        assert.equal(await amount(2758), 1);
        await event(217, 'handin', 7565);
        await event(217, 'handin', 7531);
        await event(217, 'handin', 7621);
        await kill(213, 10);
        for (const npc of [7621, 7531, 7191, 7031]) await event(217, 'handin', npc);
        assert.equal(await amount(2734), 1);
        assert.equal(await amount(7562), 24);
        const trustAward = await world.character(id);
        await event(217, 'handin', 7031);
        assert.deepEqual(await world.character(id), trustAward, 'finished reward cannot replay');

        await level(39);
        await event(222, 'start', 7623);
        await event(222, 'handin', 7623);
        assert.equal(state(222).getInt('step'), 1, 'forged next-round bypass cannot skip trophies');
        for (const npc of [85, 90, 234, 202, 270, 552, 582, 564, 601, 602]) await kill(npc, 11);
        assert.equal(await amount(2768), 10);
        await event(222, 'handin', 7623);
        session = await world.reopen(id);
        assert.equal(state(222).getInt('step'), 2);
        for (const npc of [214, 217, 554, 588, 604]) await kill(npc, 4);
        assert.equal(await amount(2779), 3);
        await Promise.all([event(222, 'handin', 7623), event(222, 'handin', 7623)]);
        assert.equal(await amount(2762), 1);
        assert.equal(await amount(7562), 24, 'Q222 awards no diamonds');
        assert.equal((await world.character(id)).sp, 33750);
        for (const quest of [211, 217, 222]) {
            assert.equal((await world.questRow(id, quest)).state, 'completed');
            for (const item of state(quest).quest.questItems) assert.equal(await amount(item), 0);
        }

        await realActor();
        let master = staticNpc(7109);
        NpcTalk(session, master);
        assert.match(world.page(session), /second-profession/);
        assert.equal((await Transfer(session, ['second-profession', '2'])).reason, 'level');
        session.actor.setLevel(40);
        await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [id]]);
        staticNpc(7644);
        assert.equal((await Transfer(session, ['second-profession', '2'])).reason, 'wrong_profession');
        master = staticNpc(7109, 171010);
        // Deleting the last mark fails after earlier mark deductions in SQL;
        // rollback must restore both deductions and the class.
        await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = 2762', [id]]);
        assert.equal((await Transfer(session, ['second-profession', '2'])).reason, 'marks');
        assert.equal(await amount(2627), 1);
        assert.equal(await amount(2734), 1);
        assert.equal((await world.character(id)).classId, 1);
        await realActor();
        await Service.giveItem(session, 2762, 1);
        const awardSkills = session.actor.skillset.awardSkills;
        session.actor.skillset.awardSkills = async () => { throw new Error('injected refresh failure'); };
        const result = await Transfer(session, ['second-profession', '2']);
        assert.equal(result.ok, true);
        assert.equal(result.refreshPending, true);
        assert.equal((await world.character(id)).classId, 2);
        for (const mark of [2627, 2734, 2762]) assert.equal(await amount(mark), 0);
        session.actor.skillset.awardSkills = awardSkills;
        // Reconnect loses all session flags; the persisted class still makes
        // refreshing skills free, without consuming additional marks.
        session = await world.reopen(id);
        await realActor();
        staticNpc(7109, 171011);
        session.packets.length = 0;
        session.actor.setHp(5);
        session.actor.setMp(4);
        assert.equal((await Transfer(session, ['second-profession', '2'])).ok, true);
        assert.equal(session.actor.fetchHp(), 5, 'replaying transfer is not a free heal');
        assert.equal(session.actor.fetchMp(), 4);
        assert.equal(session.actor.fetchClassId(), 2);
        assert(session.actor.skillset.fetchSkills().length > 1);
        assert(session.packets.some(packet => packet[0] === 0x58));
        assert(session.packets.some(packet => packet[0] === 0x04));

        staticNpc(7080);
        assert.match(invoke('GameServer/World/C4GatekeeperTeleports').menu(7080, false), /diamond-exchange/);
        await DiamondExchange(session, ['diamond-exchange', '7126']);
        assert.equal(await amount(7562), 16);
        assert.equal(await amount(7126), 1);
        await Promise.all(Array.from({ length: 3 }, () => DiamondExchange(session, ['diamond-exchange', '7126'])));
        assert.equal(await amount(7562), 0);
        assert.equal(await amount(7126), 3, 'insufficient exchange cannot issue a scroll');
        await Service.giveItem(session, 7562, 5);
        await DiamondExchange(session, ['diamond-exchange', '7117']);
        assert.equal(await amount(7117), 1, 'village SoE templates are loaded as well as Giran');
        assert.equal(await amount(7562), 0);
        session = await world.reopen(id);
        assert.equal(session.actor.fetchClassId(), 2);
        assert.equal(await amount(7126), 3);
        // Abort goes through the client packet and removes only this trial's
        // items, spawns and radar points. The actor can accept the trial again.
        await world.kill(stranger, 5110);
        const strangerTrial = world.state(stranger, 211);
        assert.equal(H.personalSpawns(strangerTrial).length, 1);
        Service.addRadar(stranger, 123, 456, 789);
        await abort(stranger, 211);
        assert.equal(strangerTrial.state, 'created');
        assert.equal(H.personalSpawns(strangerTrial).length, 0);
        assert.equal(await world.amount(710002, 2632), 0);
        assert(stranger.questWaypoints.size > 0, 'another quest waypoint survives abort');
        await world.event(stranger, 211, 'start', 7644);
        assert.equal(strangerTrial.getInt('cond'), 1);
        await world.event(stranger, 222, 'start', 7623);
        await world.kill(stranger, 85);
        await abort(stranger, 222);
        for (const item of world.state(stranger, 222).quest.questItems) assert.equal(await world.amount(710002, item), 0);
        await world.event(stranger, 222, 'start', 7623);
        assert.equal(await world.amount(710002, 2763), 1);
        console.log('Second profession: complete Gladiator trials, ownership, restart, atomic transfer and diamond exchange passed');
    } finally {
        for (const npc of [...runtime.npc.spawns]) if (npc.questSpawn) runtime.despawnQuestNpc(npc);
        await world.close();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });

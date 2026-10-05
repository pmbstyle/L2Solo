const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, withRandom, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const H = invoke('GameServer/Quest/SecondProfessionQuest');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const Actor = invoke('GameServer/Actor/Actor');

async function run() {
    const id = 730001;
    const world = await createWorld([{ id, classId: 47, race: 3, level: 35 }], 'tyrant-profession');
    const runtime = enableQuestSpawns();
    let session = await world.session(id);
    const state = q => world.state(session, q);
    const amount = item => world.amount(id, item);
    const cond = q => state(q).getInt('cond');
    const event = (q, name, npc) => world.event(session, q, name, npc);
    async function click(q, name, npc) {
        await world.talk(session, npc);
        if (!world.page(session).includes(`quest ${q} ${name}`)) {
            assert.equal(await event(q, 'show_quest', npc), true);
        }
        assert(world.page(session).includes(`quest ${q} ${name}`), `Q${q} offers ${name} at ${npc}`);
        assert.equal(await event(q, name, npc), true);
    }
    async function kill(npc, n = 1) {
        await withRandom(Array(n).fill(0), async () => {
            for (let i = 0; i < n; i++) await world.kill(session, npc);
        });
    }
    async function level(n) {
        session.actor.level = n;
        await Database.execute(['UPDATE characters SET level = ? WHERE id = ?', [n, id]]);
    }
    async function reopen() { session = await world.reopen(id); }
    async function personalEvent(q, name, template) {
        const npc = H.personalSpawns(state(q), template)[0];
        assert(npc);
        session.activeNpcTalk = { selfId: template, objectId: npc.fetchId() };
        assert.equal(await Service.onEvent(session, { questId: q, name }), true);
    }
    async function ownedKills(q, template, n = 1) {
        for (let i = 0; i < n; i++) {
            const npc = H.personalSpawns(state(q), template).find(npc => !npc.isDead());
            assert(npc);
            npc.isDead = () => true;
            await Service.onKill(session, npc);
        }
    }
    function master(selfId) {
        const objectId = runtime.npc.nextId++;
        const npc = { fetchSelfId: () => selfId, fetchId: () => objectId,
            fetchName: () => H.npcName(selfId), fetchTitle: () => '',
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
        runtime.npc.spawns.push(npc);
        session.activeNpcTalk = { selfId, objectId };
    }
    async function realActor() {
        const row = await world.character(id), template = DataCache.classTemplates.find(entry => entry.classId === row.classId);
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), id, name: row.name, username: row.username,
            level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
            items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
        session.dataSendToOthers = packet => session.packets.push(packet);
    }
    try {
        const route = Profession.routes.find(row => row.classId === 48);
        assert.equal(route.name, 'Tyrant');
        assert.deepEqual(route.quests, [211, 220, 222]);
        assert.deepEqual(route.marks, [2627, 3203, 2762]);
        assert.equal(await event(220, 'start', 7514), false);
        assert.equal(await event(222, 'start', 7623), false);

        // A Monk takes the same source Challenger trial as an Orc Raider.
        await click(211, 'start', 7644);
        await kill(5110);
        await withRandom([.9, .4], () => personalEvent(211, 'open', 7647));
        await click(211, 'letter', 7644);
        await click(211, 'martien', 7645);
        await kill(5112);
        await click(211, 'eye', 7645);
        await kill(5113);
        H.clearSpawns(state(211));
        await reopen();
        assert.equal(cond(211), 7);
        await click(211, 'recover', 7645);
        await personalEvent(211, 'raldo', 7646);
        await level(36);
        await click(211, 'filaur', 7535);
        await kill(5114);
        await personalEvent(211, 'finish', 7646);
        assert.equal(await amount(2627), 1);
        assert.equal(await amount(7562), 8);

        // Glory supports Monk as well as Raider: all five independent chiefs,
        // tribal encounters, punishment and Tantos recovery are required.
        await level(37);
        await click(220, 'start', 7514);
        for (const npc of [563, 193, 550]) await kill(npc, 10);
        await click(220, 'handin', 7514);
        await click(220, 'handin', 7642);
        await click(220, 'tunath', 7501); await click(220, 'chief', 7618);
        await click(220, 'vuku', 7501); await click(220, 'chief', 7619);
        await kill(234, 30); await click(220, 'handin', 7619);
        await click(220, 'breka', 7515); await click(220, 'chief', 7615);
        await ownedKills(220, 5080); await ownedKills(220, 5081);
        await click(220, 'handin', 7615);
        await click(220, 'enku', 7515); await click(220, 'chief', 7616);
        await ownedKills(220, 5082, 4); await click(220, 'handin', 7616);
        await click(220, 'turek', 7501); await click(220, 'chief', 7617);
        await ownedKills(220, 5083, 2); await click(220, 'handin', 7617);
        assert.equal(cond(220), 5, 'the last combat chief also closes the five-scepter stage');
        await click(220, 'handin', 7642);
        assert.equal(await amount(3216), 1);
        await reopen();
        await level(38);
        await click(220, 'handin', 7642);
        await kill(583, 20); await kill(601, 20);
        await click(220, 'handin', 7642);
        await click(220, 'handin', 7571);
        await kill(779);
        H.clearSpawns(state(220));
        await reopen();
        await click(220, 'recover', 7571);
        await ownedKills(220, 5086);
        await click(220, 'handin', 7571);
        await click(220, 'handin', 7565);
        assert.equal(await amount(3203), 1);
        assert.equal(await amount(7562), 24);
        assert.equal((await world.character(id)).classId, 47, 'trials leave the character a Monk');

        // A Monk uses Duelist rather than Champion for his final mark.
        assert.equal(await event(222, 'start', 7623), false);
        await level(39);
        assert.equal(await event(223, 'start', 7624), false);
        await click(222, 'start', 7623);
        for (const npc of [85, 90, 234, 202, 270, 552, 582, 564, 601, 602]) await kill(npc, 10);
        await click(222, 'handin', 7623);
        await reopen();
        assert.equal(state(222).getInt('step'), 2);
        for (const npc of [214, 217, 554, 588, 604]) await kill(npc, 3);
        await click(222, 'handin', 7623);
        const finished = await world.character(id);
        assert.equal(finished.exp, 210866);
        assert.equal(finished.sp, 33750);
        assert.equal(await amount(7562), 24, 'Duelist awards no extra diamonds');
        for (const [q, npc] of [[211, 7644], [220, 7565], [222, 7623]]) {
            assert.equal((await world.questRow(id, q)).state, 'completed');
            assert.equal(await event(q, q === 211 ? 'start' : 'handin', npc), false);
            for (const item of state(q).quest.questItems) assert.equal(await amount(item), 0);
        }
        assert.deepEqual(await world.character(id), finished, 'all three trial rewards remain single-use');
        for (const item of route.marks) assert.equal(await amount(item), 1);

        await realActor();
        master(7513);
        assert.equal(Profession.render(session), true);
        assert.match(world.page(session), /Become a Tyrant/);
        assert.equal((await Transfer(session, ['second-profession', '48'])).reason, 'level');
        session.actor.setLevel(40);
        await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [id]]);
        master(7109);
        assert.equal((await Transfer(session, ['second-profession', '48'])).reason, 'wrong_profession');
        for (const item of route.marks) assert.equal(await amount(item), 1);
        master(7513);
        assert.equal((await Transfer(session, ['second-profession', '46'])).reason, 'wrong_profession', 'a Monk cannot become a Destroyer');
        assert.equal((await Transfer(session, ['second-profession', '48'])).ok, true);
        assert.equal((await world.character(id)).classId, 48);
        assert.equal(session.actor.fetchClassId(), 48);
        // The level-40 Tyrant tree grants these specific skills and ranks.
        for (const [skill, rank] of [[280, 3], [282, 1], [284, 6]]) {
            assert.equal(session.actor.skillset.fetchSkill(skill)?.fetchLevel(), rank);
        }
        assert(session.packets.some(packet => packet[0] === 0x58));
        assert(session.packets.some(packet => packet[0] === 0x04));
        for (const item of route.marks) assert.equal(await amount(item), 0);
        await reopen();
        await realActor();
        assert.equal(session.actor.fetchClassId(), 48);
        const storedSkills = await Database.fetchSkills(id);
        for (const [skill, rank] of [[280, 3], [282, 1], [284, 6]]) {
            assert.equal(storedSkills.find(row => row.selfId === skill)?.level, rank, 'Tyrant skills survive reconnect');
        }
        assert.equal(await amount(7562), 24);
        master(7513);
        session.actor.setHp(11); session.actor.setMp(7);
        assert.equal((await Transfer(session, ['second-profession', '48'])).ok, true);
        assert.equal(session.actor.fetchHp(), 11, 'repeating transfer does not heal');
        assert.equal(session.actor.fetchMp(), 7);
        console.log('Tyrant: full Monk route, C4 rewards, restart, master restrictions, mark consumption and real skills passed');
    } finally {
        for (const npc of [...runtime.npc.spawns]) if (npc.questSpawn) runtime.despawnQuestNpc(npc);
        await world.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

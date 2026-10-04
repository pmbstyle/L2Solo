const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, withRandom, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const H = invoke('GameServer/Quest/SecondProfessionQuest');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const Actor = invoke('GameServer/Actor/Actor');
const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');
const Dialogue = require('./helpers/npcDialogueHarness');

async function run() {
    const world = await createWorld([
        { id: 720001, classId: 1, level: 35 }, { id: 720002, classId: 45, race: 3, level: 35 },
        { id: 720003, classId: 45, race: 3, level: 40 }, { id: 720004, classId: 47, race: 3, level: 40 }
    ], 'warlord-destroyer');
    const runtime = enableQuestSpawns();
    let session = await world.session(720001);
    const stranger = await world.session(720003), monk = await world.session(720004);
    const state = q => world.state(session, q);
    const cond = q => state(q).getInt('cond');
    const amount = item => world.amount(session.actor.fetchId(), item);
    const event = (q, name, npc) => world.event(session, q, name, npc);
    const click = (q, name, npc) => Dialogue.questClick({ session, world }, q, name, npc);
    const kill = async (npc, n = 1) => {
        for (let i = 0; i < n; i++) await withRandom([0], () => world.kill(session, npc));
    };
    const level = async n => {
        session.actor.level = n;
        await Database.execute(['UPDATE characters SET level = ? WHERE id = ?', [n, session.actor.fetchId()]]);
    };
    const reopen = async () => { session = await world.reopen(session.actor.fetchId()); };
    async function ownedKill(q, template) {
        const npc = H.personalSpawns(state(q), template).find(npc => !npc.isDead());
        assert(npc, `personal ${template} is spawned`);
        npc.isDead = () => true;
        await Service.onKill(session, npc);
        return npc;
    }
    async function personalEvent(q, name, template) {
        const npc = H.personalSpawns(state(q), template)[0];
        assert(npc);
        await Dialogue.questClick({ session, world }, q, name, template, npc);
    }
    async function challenger() {
        await event(211, 'start', 7644);
        await kill(5110);
        await withRandom([.9, .5], () => personalEvent(211, 'open', 7647));
        await event(211, 'letter', 7644);
        await event(211, 'martien', 7645);
        await kill(5112);
        await event(211, 'eye', 7645);
        await kill(5113);
        await personalEvent(211, 'raldo', 7646);
        await level(36);
        await event(211, 'filaur', 7535);
        await kill(5114);
        await personalEvent(211, 'finish', 7646);
        assert.equal(await amount(2627), 1);
    }
    async function trust() {
        await level(37);
        await event(217, 'start', 7191);
        await event(217, 'handin', 7154);
        await kill(36); await ownedKill(217, 5120);
        await kill(13); await ownedKill(217, 5121);
        for (const npc of [7154, 7358, 7464]) await event(217, 'handin', npc);
        for (const npc of [550, 82, 234]) await kill(npc, 10);
        for (const npc of [7464, 7358, 7191]) await event(217, 'handin', npc);
        await level(38);
        for (const npc of [7657, 7565, 7515]) await event(217, 'handin', npc);
        await withRandom(Array(10).fill(.9), async () => {
            for (let i = 0; i < 10; i++) await world.kill(session, 553);
        });
        for (const npc of [7515, 7565, 7531, 7621]) await event(217, 'handin', npc);
        await kill(213, 10);
        for (const npc of [7621, 7531, 7191, 7031]) await event(217, 'handin', npc);
        assert.equal(await amount(2734), 1);
    }
    async function champion() {
        assert.equal(await event(223, 'start', 7624), false, 'champion requires level 39');
        await level(39);
        assert.equal(await event(223, 'start', 7196), false);
        await click(223, 'start', 7624);
        const row = await world.questRow(session.actor.fetchId(), 223);
        assert.equal(await event(223, 'handin', 7624), false, 'Ascalon cannot skip Mason');
        assert.deepEqual(await world.questRow(session.actor.fetchId(), 223), row);
        await kill(780);
        assert.equal(await amount(3290), 0, 'ring is required before Bloody Axe trophies');
        await click(223, 'handin', 7625);
        await kill(780, 101);
        assert.equal(await amount(3290), 100);
        await click(223, 'handin', 7625);
        await kill(780);
        assert.equal(await amount(3290), 0, 'retiring the ring stops recollection in the same step');
        await click(223, 'handin', 7624);
        await click(223, 'handin', 7093);
        await withRandom([.5], () => world.kill(session, 145));
        assert.equal(await amount(3287), 0, '50 percent drop misses at its boundary');
        await kill(145, 31);
        await kill(158, 31); await kill(553, 31);
        assert.equal(await amount(3287), 30);
        await reopen();
        assert.equal(state(223).getInt('step'), 3);
        assert.equal(cond(223), 1, 'source keeps one client condition and persists its internal step');
        await click(223, 'handin', 7093);
        await kill(158);
        assert.equal(await amount(3288), 0);
        await click(223, 'handin', 7624);
        await click(223, 'handin', 7196);
        await kill(551, 101);
        assert.equal(await amount(3291), 100);
        await click(223, 'handin', 7196);
        for (const [npc, chance] of [[577, .5], [578, .6], [579, .7], [580, .8], [581, .9], [582, .95]]) {
            await withRandom([chance], () => world.kill(session, npc));
        }
        assert.equal(await amount(3292), 0, 'all six Leto variants use their authored chance');
        await kill(582, 101);
        assert.equal(await amount(3292), 100);
        await click(223, 'handin', 7196);
        await kill(582);
        assert.equal(await amount(3292), 0, 'Mouen retires the final hunt order');
        const before = await world.character(session.actor.fetchId());
        const diamonds = await amount(7562);
        await Dialogue.talk(session,world,7624);
        assert(world.page(session).includes('quest 223 handin'), 'Ascalon offers the final award');
        await Promise.all([event(223, 'handin', 7624), event(223, 'handin', 7624)]);
        const after = await world.character(session.actor.fetchId());
        assert.equal(after.exp - before.exp, 117454);
        assert.equal(after.sp - before.sp, 25000);
        assert.equal(await amount(3276), 1);
        assert.equal(await amount(7562), diamonds, 'Q223 awards no diamonds');
        await reopen();
        assert.equal(await event(223, 'handin', 7624), false);
        assert.deepEqual(await world.character(session.actor.fetchId()), after);
    }
    async function glory() {
        await level(37);
        await click(220, 'start', 7514);
        await event(220, 'handin', 7642);
        assert.equal(cond(220), 1, 'cannot skip the first hunt');
        for (const npc of [563, 192, 550]) await kill(npc, 11);
        assert.equal(cond(220), 2);
        assert.equal(await amount(3205), 10);
        await click(220, 'handin', 7514);
        await click(220, 'handin', 7642);
        await event(220, 'chief', 7616);
        assert.equal(H.personalSpawns(state(220), 5082).length, 0, 'a forged challenge needs its letter');
        assert.equal(await event(220, 'breka', 7501), false, 'Kasman cannot issue Manakia letters');
        await click(220, 'breka', 7515);
        await event(220, 'breka', 7515);
        assert.equal(await amount(3228), 1);
        await click(220, 'chief', 7615);
        await click(220, 'chief', 7615);
        assert.equal(H.personalSpawns(state(220), 5080).length, 1);
        // A second Orc has legitimately reached the same challenge. Its kill
        // of our quest monster must still award neither character a trophy.
        await world.event(stranger, 220, 'start', 7514);
        for (const npc of [563, 193, 550]) for (let i = 0; i < 10; i++) await world.kill(stranger, npc);
        await world.event(stranger, 220, 'handin', 7514);
        await world.event(stranger, 220, 'handin', 7642);
        await world.event(stranger, 220, 'breka', 7515);
        await world.event(stranger, 220, 'chief', 7615);
        const opponent = H.personalSpawns(state(220), 5080)[0];
        await Service.onKill(stranger, opponent);
        assert.equal(await world.amount(720003, 3221), 0);
        assert.equal(await amount(3221), 0);
        await ownedKill(220, 5080);
        assert.equal(await amount(3223), 1, 'both sons must die before the glove is retired');
        H.clearSpawns(state(220));
        await reopen();
        await click(220, 'chief', 7615);
        assert.equal(H.personalSpawns(state(220), 5080).length, 0, 'completed son is not respawned');
        await ownedKill(220, 5081);
        assert.equal(await amount(3223), 0);
        await click(220, 'handin', 7615);
        assert.equal(await amount(3211), 1);
        await click(220, 'enku', 7515);
        await click(220, 'chief', 7616);
        assert.equal(H.personalSpawns(state(220), 5082).length, 4, 'all four Enku Overlords spawn');
        await click(220, 'chief', 7616);
        assert.equal(H.personalSpawns(state(220), 5082).length, 4, 'repeated dialogue cannot duplicate a group');
        await ownedKill(220, 5082); await ownedKill(220, 5082);
        runtime.despawnQuestNpc(H.personalSpawns(state(220), 5082).find(npc => !npc.isDead()));
        await click(220, 'chief', 7616);
        const remaining = H.personalSpawns(state(220), 5082);
        assert.equal(remaining.length, 2, 'an expired opponent is replaced without reviving completed kills');
        assert.equal(new Set(remaining.map(npc => [npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()].join(':'))).size, 2);
        H.clearSpawns(state(220));
        await reopen();
        await click(220, 'chief', 7616);
        assert.equal(H.personalSpawns(state(220), 5082).length, 2, 'restart restores only unfinished opponents');
        await ownedKill(220, 5082); await ownedKill(220, 5082);
        assert.equal(await amount(3224), 4);
        await click(220, 'handin', 7616);
        await click(220, 'turek', 7501);
        await click(220, 'chief', 7617);
        assert.equal(H.personalSpawns(state(220), 5083).length, 2);
        await ownedKill(220, 5083); await ownedKill(220, 5083);
        await click(220, 'handin', 7617);
        await click(220, 'vuku', 7501);
        await click(220, 'chief', 7619);
        await withRandom([.75], () => world.kill(session, 234));
        assert.equal(await amount(3234), 0, 'Stakato Drone husks have a 75 percent chance');
        await kill(234, 31);
        assert.equal(await amount(3234), 30);
        await click(220, 'handin', 7619);
        await click(220, 'tunath', 7501);
        await click(220, 'chief', 7618);
        assert.equal(cond(220), 5, 'all five independent chiefs are required');
        await click(220, 'handin', 7642);
        assert.equal(cond(220), 5);
        assert.equal(await amount(3216), 1, 'level 37 gets the waiting order');
        await reopen();
        await click(220, 'handin', 7642);
        assert.equal(await amount(3216), 1, 'waiting order does not duplicate');
        await level(38);
        await click(220, 'handin', 7642);
        assert.equal(cond(220), 6);
        assert.equal(await amount(3216), 0);
        for (const [npc, chance] of [[583, .5], [584, .6], [585, .7], [586, .8], [587, .9], [601, .5], [602, .6]]) {
            await withRandom([chance], () => world.kill(session, npc));
        }
        assert.equal(await amount(3219), 0);
        assert.equal(await amount(3218), 0);
        await kill(588, 21); await kill(602, 21);
        assert.equal(cond(220), 7);
        assert.equal(await amount(3218), 20);
        await click(220, 'handin', 7642);
        await click(220, 'handin', 7571);
        await kill(5086);
        assert.equal(await amount(3236), 0, 'a public template cannot impersonate the personal revenant');
        await kill(778); await kill(779);
        assert.equal(H.personalSpawns(state(220), 5086).length, 1);
        H.clearSpawns(state(220));
        await reopen();
        assert.equal(cond(220), 9);
        await click(220, 'recover', 7571);
        await ownedKill(220, 5086);
        assert.equal(cond(220), 10);
        await click(220, 'handin', 7571);
        const before = await world.character(session.actor.fetchId());
        await Promise.all([event(220, 'handin', 7565), event(220, 'handin', 7565)]);
        const after = await world.character(session.actor.fetchId());
        assert.equal(after.exp - before.exp, 91457);
        assert.equal(after.sp - before.sp, 2500);
        assert.equal(await amount(3203), 1);
        assert.equal(await amount(7562), 24);
        assert.equal(H.personalSpawns(state(220)).length, 0);
        await reopen();
        assert.equal(await event(220, 'handin', 7565), false);
        assert.deepEqual(await world.character(session.actor.fetchId()), after);
    }
    async function transfer(target, master, marks) {
        const id = session.actor.fetchId();
        const row = await world.character(id);
        const template = DataCache.classTemplates.find(entry => entry.classId === row.classId);
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), id, name: row.name, username: row.username,
            level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
            items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
        session.dataSendToOthers = packet => session.packets.push(packet);
        const npc = { fetchSelfId: () => master, fetchId: () => master + 100000,
            fetchName: () => H.npcName(master), fetchTitle: () => '',
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
        runtime.npc.spawns.push(npc);
        session.activeNpcTalk = { selfId: master, objectId: npc.fetchId() };
        assert.equal((await Transfer(session, ['second-profession', String(target)])).reason, 'level');
        session.actor.setLevel(40);
        await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [id]]);
        const results = await Promise.all([Transfer(session, ['second-profession', String(target)]),
            Transfer(session, ['second-profession', String(target)])]);
        assert(results.every(result => result.ok));
        assert(results.every(result => !result.refreshPending), 'normal class refresh awards real skills');
        assert.equal((await world.character(id)).classId, target);
        assert.equal(session.actor.fetchClassId(), target);
        assert(session.actor.skillset.fetchSkills().length > 1);
        for (const item of marks) assert.equal(await amount(item), 0);
        assert(session.packets.some(packet => packet[0] === 0x58));
        await reopen();
        assert.equal(session.actor.fetchClassId(), target);
    }
    try {
        for (const q of [220, 223]) {
            const quest = Service.quests().find(quest => quest.id === q);
            const worldSpawns = new Set(DataCache.npcSpawns.flatMap(area => area.spawns.map(spawn => spawn.selfId)));
            for (const id of quest.npcs) assert(worldSpawns.has(id), `Q${q} talk NPC ${id} exists in the world`);
            for (const id of [...quest.npcs, ...quest.killNpcs, ...quest.questSpawns || []]) {
                assert(DataCache.npcs.some(npc => npc.selfId === id), `Q${q} NPC ${id} has a template`);
            }
            for (const item of quest.questItems) assert(DataCache.items.some(entry => entry.selfId === item));
        }
        assert.equal(await event(220, 'start', 7514), false, 'Glory is for Orcs');
        assert.equal(await world.event(monk, 223, 'start', 7624), false, 'Monk does not take Champion');
        await challenger(); await trust(); await champion();
        assert.equal((await world.character(720001)).exp, 229419);
        assert.equal((await world.character(720001)).sp, 38750);
        await transfer(3, 7109, [2627, 2734, 3276]);
        session = await world.session(720002);
        assert.equal(await event(220, 'start', 7514), false, 'Glory requires level 37');
        await challenger(); await glory(); await champion();
        assert.equal((await world.character(720002)).exp, 281305);
        assert.equal((await world.character(720002)).sp, 38750);
        await transfer(46, 7513, [2627, 3203, 3276]);
        for (const [id, quests] of [[720001, [211, 217, 223]], [720002, [211, 220, 223]]]) {
            for (const q of quests) {
                assert.equal((await world.questRow(id, q)).state, 'completed');
                for (const item of Service.quests().find(quest => quest.id === q).questItems) assert.equal(await world.amount(id, item), 0);
            }
        }
        // Aborting Champion must preserve the same player's active Glory quest.
        session = await world.session(720003);
        await event(223, 'start', 7624);
        await event(223, 'handin', 7625);
        await kill(780, 2);
        const gloryRow = await world.questRow(720003, 220);
        const abortChampion = Buffer.alloc(5); abortChampion[0] = 0x64; abortChampion.writeInt32LE(223, 1);
        await QuestAbort(session, abortChampion);
        assert.equal(state(223).isStarted(), false);
        for (const item of state(223).quest.questItems) assert.equal(await amount(item), 0);
        assert.deepEqual(await world.questRow(720003, 220), gloryRow);
        assert.equal(await amount(3223), 1);
        await event(223, 'start', 7624);
        assert.equal(state(223).getInt('step'), 1);
        // Abort one active encounter and leave the other Orc's summons intact.
        const otherSpawns = H.personalSpawns(world.state(stranger, 220)).length;
        session = await world.session(720004);
        await event(220, 'start', 7514);
        for (const npc of [563, 192, 550]) await kill(npc, 10);
        await event(220, 'handin', 7514); await event(220, 'handin', 7642);
        await event(220, 'enku', 7515); await event(220, 'chief', 7616);
        const unrelated = [123, 456, 789];
        state(220).addRadar(...unrelated);
        const packet = Buffer.alloc(5); packet[0] = 0x64; packet.writeInt32LE(220, 1);
        await QuestAbort(session, packet);
        assert.equal(state(220).isStarted(), false);
        assert.equal(H.personalSpawns(state(220)).length, 0);
        assert.equal(H.personalSpawns(world.state(stranger, 220)).length, otherSpawns);
        assert(session.questWaypoints.has(unrelated.join(':')));
        for (const item of state(220).quest.questItems) assert.equal(await amount(item), 0);
        await event(220, 'start', 7514);
        assert.equal(cond(220), 1);
        console.log('Warlord and Destroyer: full C4 routes, personal encounters, restart, rewards and class transfer passed');
    } finally {
        for (const npc of [...runtime.npc.spawns]) if (npc.questSpawn) runtime.despawnQuestNpc(npc);
        await world.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

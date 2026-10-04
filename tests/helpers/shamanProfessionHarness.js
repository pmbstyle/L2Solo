// Full C4 walkthroughs drive real handlers, inventory and SQLite persistence.
const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, withRandom, Service, Database, DataCache } = require('./c4QuestHarness');
const H = invoke('GameServer/Quest/SecondProfessionQuest');
const Actor = invoke('GameServer/Actor/Actor');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');

async function abort(session, questId) {
    const packet = Buffer.alloc(5);
    packet[0] = 0x64; packet.writeInt32LE(questId, 1);
    await QuestAbort(session, packet);
}

async function createTrialWorld(label, id, extra = []) {
    const world = await createWorld([{ id, classId: 50, race: 3, level: 34 }, ...extra], label);
    const runtime = enableQuestSpawns();
    const ctx = { world, runtime, id, session: await world.session(id) };
    ctx.state = q => world.state(ctx.session, q);
    ctx.amount = item => world.amount(ctx.id, item);
    ctx.cond = q => ctx.state(q).getInt('cond');
    ctx.event = (q, name, npc) => world.event(ctx.session, q, name, npc);
    ctx.click = async (q, name, npc) => {
        await world.talk(ctx.session, npc);
        if (!world.page(ctx.session).includes(`quest ${q} ${name}`)) assert.equal(await ctx.event(q, 'show_quest', npc), true);
        assert(world.page(ctx.session).includes(`quest ${q} ${name}`), `Q${q} offers ${name} at NPC ${npc}`);
        assert.equal(await ctx.event(q, name, npc), true);
    };
    ctx.kill = async (npc, n = 1, roll = 0) => withRandom(Array(n).fill(roll), async () => {
        for (let i = 0; i < n; i++) await world.kill(ctx.session, npc);
    });
    ctx.level = async n => {
        ctx.session.actor.level = n;
        await Database.execute(['UPDATE characters SET level = ? WHERE id = ?', [n, ctx.id]]);
    };
    ctx.reopen = async () => { ctx.session = await world.reopen(ctx.id); };
    ctx.ownedKill = async (q, template, n = 1) => {
        for (let i = 0; i < n; i++) {
            const npc = H.personalSpawns(ctx.state(q), template).find(npc => !npc.isDead());
            assert(npc);
            npc.isDead = () => true;
            await withRandom([0], () => Service.onKill(ctx.session, npc));
        }
    };
    ctx.personalEvent = async (q, name, template) => {
        const npc = H.personalSpawns(ctx.state(q), template)[0];
        assert(npc);
        ctx.session.activeNpcTalk = { selfId: template, objectId: npc.fetchId() };
        assert.equal(await Service.onEvent(ctx.session, { questId: q, name }), true);
    };
    ctx.close = async () => {
        for (const npc of [...runtime.npc.spawns]) if (npc.questSpawn) runtime.despawnQuestNpc(npc);
        await world.close();
    };
    return ctx;
}

async function pilgrim(c, { book = false, keep = false } = {}) {
    assert.equal(await c.event(215, 'start', 7648), false, 'Pilgrim starts at 35');
    await c.level(35);
    await c.click(215, 'start', 7648);
    assert.equal(await c.event(215, 'handin', 7648), false);
    await c.click(215, 'handin', 7571); await c.click(215, 'handin', 7649);
    await c.kill(5116, 1, 0);
    assert.equal(c.cond(215), 3, 'salamander drop needs the authored 1-of-5 roll');
    await c.kill(5116, 1, .2); await c.click(215, 'handin', 7649);
    await c.click(215, 'handin', 7550);
    if (book) {
        await Service.giveItem(c.session, 57, 99999);
        assert.equal(await c.event(215, 'buy', 7650), false);
        assert.equal(await c.amount(57), 99999);
        await Service.giveItem(c.session, 57, 1);
        await c.click(215, 'buy', 7650);
        assert.equal(await c.amount(57), 0);
        assert.equal(await c.amount(2726), 1);
    }
    await c.click(215, 'handin', 7651);
    if (book) {
        await c.reopen();
        const rate = options.default.General.questAdenaRate;
        options.default.General.questAdenaRate = 50;
        try { await c.click(215, 'refund', 7650); } finally { options.default.General.questAdenaRate = rate; }
        assert.equal(await c.amount(57), 100000, 'refund equals the payment at any reward rate');
        assert.equal(await c.event(215, 'refund', 7650), false);
        assert.equal(await c.amount(57), 100000);
    }
    await c.click(215, 'handin', 7117); await c.click(215, 'handin', 7036);
    await c.kill(5117); await c.click(215, 'handin', 7036);
    await c.click(215, 'handin', 7362);
    await c.kill(5118, 1, .2); await c.click(215, 'handin', 7652);
    await c.reopen();
    await c.click(215, keep ? 'keep' : 'burn', 7362);
    assert.equal(await c.amount(2731), keep ? 1 : 0);
    await c.click(215, 'handin', 7612);
    assert.equal(await c.amount(2731), 0);
    await c.click(215, 'handin', 7648);
    assert.equal(await c.amount(2721), 1);
    assert.equal(await c.amount(7562), 8, 'historical C4 awards eight diamonds once');
    const row = await c.world.character(c.id);
    assert.equal(row.exp, 77832); assert.equal(row.sp, 16000);
    assert.equal(await c.event(215, 'handin', 7648), false);
    assert.deepEqual(await c.world.character(c.id), row);
}

async function glory(c) {
    await c.level(37); await c.click(220, 'start', 7514);
    for (const npc of [563, 192, 550]) await c.kill(npc, 10);
    await c.click(220, 'handin', 7514); await c.click(220, 'handin', 7642);
    await c.click(220, 'breka', 7515); await c.click(220, 'chief', 7615);
    await c.ownedKill(220, 5080); await c.ownedKill(220, 5081); await c.click(220, 'handin', 7615);
    await c.click(220, 'enku', 7515); await c.click(220, 'chief', 7616);
    await c.ownedKill(220, 5082, 4); await c.click(220, 'handin', 7616);
    await c.click(220, 'vuku', 7501); await c.click(220, 'chief', 7619);
    await c.kill(234, 30); await c.click(220, 'handin', 7619);
    await c.click(220, 'turek', 7501); await c.click(220, 'chief', 7617);
    await c.ownedKill(220, 5083, 2); await c.click(220, 'handin', 7617);
    await c.click(220, 'tunath', 7501); await c.click(220, 'chief', 7618);
    await c.click(220, 'handin', 7642);
    assert.equal(c.cond(220), 5);
    await c.level(38); await c.click(220, 'handin', 7642);
    await c.kill(588, 20); await c.kill(602, 20);
    await c.click(220, 'handin', 7642); await c.click(220, 'handin', 7571);
    await c.kill(778); await c.ownedKill(220, 5086);
    await c.click(220, 'handin', 7571); await c.click(220, 'handin', 7565);
    assert.equal(await c.amount(3203), 1); assert.equal(await c.amount(7562), 24);
}

async function finishRoute(c, target, skillRanks) {
    const route = Profession.routes.find(r => r.classId === target);
    for (const q of route.quests) {
        assert.equal((await c.world.questRow(c.id, q)).state, 'completed');
        for (const i of c.state(q).quest.questItems) assert.equal(await c.amount(i), 0);
    }
    for (const i of route.marks) assert.equal(await c.amount(i), 1);
    const row = await c.world.character(c.id), template = DataCache.classTemplates.find(t => t.classId === 50);
    c.session.actor = new Actor(c.session, { ...row, ...utils.crushOb(template), id: c.id, name: row.name, username: row.username,
        level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
        items: await Database.fetchItems(c.id), paperdoll: utils.tupleAlloc(16, {}) });
    c.session.dataSendToOthers = p => c.session.packets.push(p);
    const npc = { fetchSelfId: () => 7513, fetchId: () => 173001, fetchName: () => H.npcName(7513), fetchTitle: () => '',
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
    c.runtime.npc.spawns.push(npc); c.session.activeNpcTalk = { selfId: 7513, objectId: npc.fetchId() };
    assert.equal((await Transfer(c.session, ['second-profession', String(target)])).reason, 'level');
    c.session.actor.setLevel(40); await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [c.id]]);
    assert.equal((await Transfer(c.session, ['second-profession', String(target)])).ok, true);
    assert.equal(c.session.actor.fetchClassId(), target);
    for (const i of route.marks) assert.equal(await c.amount(i), 0);
    for (const [skill, rank] of skillRanks) assert.equal(c.session.actor.skillset.fetchSkill(skill)?.fetchLevel(), rank);
    assert(c.session.packets.some(p => p[0] === 0x58));
    await c.reopen();
    assert.equal(c.session.actor.fetchClassId(), target);
    const stored = await Database.fetchSkills(c.id);
    for (const [skill, rank] of skillRanks) assert.equal(stored.find(s => s.selfId === skill)?.level, rank);
}
module.exports = { createTrialWorld, pilgrim, glory, finishRoute, abort, H, Service, Database, DataCache, withRandom };

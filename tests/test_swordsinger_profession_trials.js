const assert = require('node:assert/strict');
const { createTrialWorld, challenger, duelist, finishRoute, abort, H, Service, Database, DataCache } = require('./helpers/fighterProfessionHarness');
const { life } = require('./helpers/elderProfessionHarness');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const Actor = invoke('GameServer/Actor/Actor');

async function reloadActor(c) {
    const row = await c.world.character(c.id), template = DataCache.classTemplates.find(t => t.classId === row.classId);
    c.session.actor = new Actor(c.session, { ...row, ...utils.crushOb(template), id: c.id, name: row.name, username: row.username,
        level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
        items: await Database.fetchItems(c.id), paperdoll: utils.tupleAlloc(16, {}) });
    c.session.dataSendToOthers = p => c.session.packets.push(p);
    await c.session.actor.skillset.populate(c.id);
}

function master(c, selfId) {
    const npc = { fetchSelfId: () => selfId, fetchId: () => 190000 + selfId, fetchName: () => H.npcName(selfId), fetchTitle: () => '',
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false };
    c.runtime.npc.spawns.push(npc); c.session.activeNpcTalk = { selfId, objectId: npc.fetchId() };
    return npc;
}

(async () => {
    const c = await createTrialWorld('swordsinger', 180001, [
        { id: 180002, classId: 19, race: 1, level: 35 },
        { id: 180003, classId: 22, race: 1, level: 39 },
        { id: 180004, classId: 1, race: 0, level: 39 }
    ], { classId: 19, race: 1, level: 34 });
    try {
        const route = Profession.routes.find(r => r.classId === 21);
        assert.deepEqual(route.quests, [211, 218, 222]); assert.deepEqual(route.marks, [2627, 3140, 2762]);
        assert.deepEqual(route.npcs, [7109, 7187, 7689, 7849, 7900]);
        const foreign = await c.world.session(180002), scout = await c.world.session(180003), human = await c.world.session(180004);
        assert.equal(await c.world.event(scout, 211, 'start', 7644), false);
        assert.equal(await c.world.event(scout, 222, 'start', 7623), false);
        assert.equal(await c.world.event(human, 218, 'start', 7460), false);
        assert.equal(await c.event(222, 'start', 7623), false);
        await c.world.event(foreign, 211, 'start', 7644);
        await challenger(c, foreign);
        await life(c, { beforeSpearParts: async () => {
            await c.level(39); await c.click(222, 'start', 7623);
            await c.kill(582);
            assert.equal(await c.amount(3166), 1); assert.equal(await c.amount(2774), 1);
            await c.reopen(); assert.equal(c.cond(218), 13); assert.equal(c.state(222).getInt('step'), 1);
        } });
        // Q218 retires the wielded trial spear while the Duelist's hunt stays active.
        assert.equal(c.state(222).getInt('step'), 1); assert((await c.amount(2774)) > 0);
        await duelist(c, { started: true });
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 224000); assert.equal(row.sp, 42500); assert.equal(row.classId, 19);
        assert.equal(await c.amount(7562), 24);
        await reloadActor(c);
        for (const npc of route.npcs) {
            master(c, npc); assert.equal(Profession.render(c.session), true);
            assert.match(c.world.page(c.session), /Become a Swordsinger/);
        }
        master(c, 7623);
        assert.equal((await Transfer(c.session, ['second-profession', '21'])).reason, 'wrong_profession');
        master(c, 7109);
        assert.equal((await Transfer(c.session, ['second-profession', '34'])).reason, 'wrong_profession');
        // Missing the middle mark must roll back the Challenger deduction and class change.
        c.session.actor.setLevel(40); await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [c.id]]);
        await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = 3140', [c.id]]);
        assert.equal((await Transfer(c.session, ['second-profession', '21'])).reason, 'marks');
        assert.equal(await c.amount(2627), 1); assert.equal(await c.amount(2762), 1);
        assert.equal((await c.world.character(c.id)).classId, 19);
        await c.reopen();
        await Service.giveItem(c.session, 3140, 1); await c.level(39);
        await finishRoute(c, 21, [[267, 1], [123, 1], [102, 2], [239, 2]]);
        // Repeating the master dialogue after reconnect refreshes songs without spending marks or healing.
        await reloadActor(c); master(c, 7900);
        c.session.actor.setHp(11); c.session.actor.setMp(7);
        assert.equal((await Transfer(c.session, ['second-profession', '21'])).ok, true);
        assert.equal(c.session.actor.fetchHp(), 11); assert.equal(c.session.actor.fetchMp(), 7);
        assert.equal(c.session.actor.skillset.fetchSkill(267).fetchLevel(), 1);
        assert.equal(c.session.actor.skillset.fetchSkill(269), undefined, 'Song of Hunter is not a level-40 song');
        for (const mark of route.marks) assert.equal(await c.amount(mark), 0);
        await abort(foreign, 211);
        console.log('Swordsinger: complete Elven Knight trials, shared hunt isolation, equipped spear retirement, personal encounter recovery, C4 masters, persisted Song of Warding and idempotent transfer passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

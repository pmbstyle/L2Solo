const assert = require('node:assert/strict');
const { createTrialWorld, challenger, duelist, finishRoute, abort, Service, Database, reloadActor, master } = require('./helpers/fighterProfessionHarness');
const { fate } = require('./helpers/darkElfProfessionHarness');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');

(async () => {
    const c = await createTrialWorld('bladedancer', 181001, [
        { id: 181002, classId: 32, race: 2, level: 37 },
        { id: 181003, classId: 19, race: 1, level: 39 },
        { id: 181004, classId: 35, race: 2, level: 39 }
    ], { classId: 32, race: 2, level: 34 });
    try {
        const route = Profession.routes.find(r => r.classId === 34);
        assert.deepEqual(route.quests, [211, 219, 222]); assert.deepEqual(route.marks, [2627, 3172, 2762]);
        assert.deepEqual(route.npcs, [7195, 7699, 7474, 7862, 7910, 8285, 8324, 8328, 8331, 8334]);
        const foreign = await c.world.session(181002), elf = await c.world.session(181003), assassin = await c.world.session(181004);
        assert.equal(await c.world.event(elf, 219, 'start', 7476), false);
        assert.equal(await c.world.event(assassin, 211, 'start', 7644), false);
        assert.equal(await c.world.event(assassin, 222, 'start', 7623), false);
        assert.equal(await c.event(222, 'start', 7623), false);
        assert.equal(await c.world.event(foreign, 211, 'start', 7644), true);
        assert.equal(await c.world.event(foreign, 219, 'start', 7476), true);
        await challenger(c, foreign);
        await fate(c, foreign, { beforeSkulls: async () => {
            await c.level(39); await c.click(222, 'start', 7623);
            await c.kill(582);
            assert.equal(await c.amount(3197), 1); assert.equal(await c.amount(2774), 1);
            await c.reopen(); assert.equal(c.cond(219), 14); assert.equal(c.state(222).getInt('step'), 1);
        } });
        // Returning the Pixy's skulls consumes only Fate's proofs, preserving Duelist trophies.
        assert.equal(await c.amount(3197), 0); assert.equal(await c.amount(2774), 10);
        assert.equal(await c.amount(2772), 10);
        await duelist(c, { started: true });
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 187592); assert.equal(row.sp, 33000); assert.equal(row.classId, 32);
        assert.equal(await c.amount(7562), 24);
        await reloadActor(c);
        for (const npc of route.npcs) {
            master(c, npc); assert.equal(Profession.render(c.session), true);
            assert.match(c.world.page(c.session), /Become a Bladedancer/);
        }
        master(c, 7109);
        assert.equal((await Transfer(c.session, ['second-profession', '34'])).reason, 'wrong_profession');
        master(c, 7195);
        assert.equal((await Transfer(c.session, ['second-profession', '21'])).reason, 'wrong_profession');
        // Missing the final mark must roll back both earlier deductions and the class change.
        c.session.actor.setLevel(40); await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [c.id]]);
        await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = 2762', [c.id]]);
        assert.equal((await Transfer(c.session, ['second-profession', '34'])).reason, 'marks');
        assert.equal(await c.amount(2627), 1); assert.equal(await c.amount(3172), 1);
        assert.equal((await c.world.character(c.id)).classId, 32);
        await c.reopen(); await Service.giveItem(c.session, 2762, 1); await c.level(39);
        await finishRoute(c, 34, [[274, 1], [144, 3], [122, 1], [239, 2]]);
        // Recover a missing first dance after login using the persisted class, with no new marks.
        await Database.execute(['DELETE FROM skills WHERE characterId = ? AND selfId = 274', [c.id]]);
        await reloadActor(c); assert.equal(c.session.actor.skillset.fetchSkill(274), undefined);
        master(c, 8334); c.session.actor.setHp(11); c.session.actor.setMp(7);
        assert.equal((await Transfer(c.session, ['second-profession', '34'])).ok, true);
        assert.equal(c.session.actor.fetchHp(), 11); assert.equal(c.session.actor.fetchMp(), 7);
        assert.equal(c.session.actor.skillset.fetchSkill(274).fetchLevel(), 1);
        assert.equal(c.session.actor.skillset.fetchSkill(277), undefined, 'Dance of Light requires level 43');
        assert.equal(c.session.actor.skillset.fetchSkill(271), undefined, 'Dance of Warrior requires level 55');
        for (const mark of route.marks) assert.equal(await c.amount(mark), 0);
        await c.reopen(); assert.equal(c.session.actor.fetchClassId(), 34);
        assert.equal((await Database.fetchSkills(c.id)).find(s => s.selfId === 274).level, 1);
        await abort(foreign, 211); await abort(foreign, 219);
        console.log('Bladedancer: complete Palus Knight route, shared skull/trophy hunts, personal Alder recovery, C4 masters, atomic mark rollback and persisted Dance of Fire recovery passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

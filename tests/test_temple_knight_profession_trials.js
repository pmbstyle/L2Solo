const assert = require('node:assert/strict');
const { createTrialWorld, duty, healer, finishRoute, abort, Service, Database, reloadActor, master } = require('./helpers/knightProfessionHarness');
const { life } = require('./helpers/elderProfessionHarness');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');

(async () => {
    const c = await createTrialWorld('temple-knight', 183001, [
        { id: 183002, classId: 19, race: 1, level: 35 },
        { id: 183003, classId: 22, race: 1, level: 39 },
        { id: 183004, classId: 4, race: 0, level: 39 }
    ], { classId: 19, race: 1, level: 34 });
    try {
        const route = Profession.routes.find(r => r.classId === 20);
        assert.deepEqual(route.quests, [212, 218, 226]); assert.deepEqual(route.marks, [2633, 3140, 2820]);
        assert.deepEqual(route.npcs, [7109, 7187, 7689, 7849, 7900]);
        const foreign = await c.world.session(183002), scout = await c.world.session(183003), human = await c.world.session(183004);
        assert.equal(await c.world.event(scout, 212, 'start', 7109), false);
        assert.equal(await c.world.event(scout, 226, 'start', 7473), false);
        assert.equal(await c.world.event(human, 218, 'start', 7460), false);
        assert.equal(await c.event(226, 'start', 7473), false);
        await c.world.event(foreign, 212, 'start', 7109);
        await c.world.event(foreign, 212, 'handin', 7653);
        await duty(c, foreign, { beforeArticles: async () => {
            await life(c, { beforeSpearParts: async () => {
                assert.equal(c.cond(212), 11); assert.equal(c.cond(218), 13);
                assert.equal(await c.amount(2641), 1, 'Duty gets its guaranteed article when Life fails its 50% roll');
                await c.kill(581, 1, .499);
                assert.equal(await c.amount(2641), 2); assert.equal(await c.amount(3166), 1);
                await c.reopen(); assert.equal(c.cond(212), 11); assert.equal(c.cond(218), 13);
                assert.equal(await c.amount(2641), 2); assert.equal(await c.amount(3166), 1);
                await c.world.talk(c.session, 7655);
                assert.match(c.world.page(c.session), /quest 218 show_quest/, 'Isael exposes both active trials');
                assert.equal(await c.event(218, 'show_quest', 7655), true);
                assert.equal(c.cond(212), 11); assert.equal(await c.amount(2641), 2);
            } });
            // Life retires its wielded spear and proofs while Duty keeps its collected articles.
            assert.equal(c.state(218).state, 'completed'); assert.equal(await c.amount(3140), 1);
            assert.equal(await c.amount(3026), 0); assert.equal(await c.amount(3027), 0);
            assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
            assert.equal(c.cond(212), 11); assert.equal(await c.amount(2641), 9);
        } });
        await c.level(39); await healer(c, true);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 319262); assert.equal(row.sp, 65000); assert.equal(row.classId, 19);
        assert.equal(await c.amount(7562), 24); assert.equal(await c.amount(57), 0);
        await reloadActor(c);
        for (const npc of route.npcs) {
            NpcTalk(c.session, master(c, npc)); await c.session.questMutationTail;
            await new Promise(resolve => setImmediate(resolve));
            assert.match(c.world.page(c.session), /second-profession/);
            assert.equal(Profession.render(c.session), true); assert.match(c.world.page(c.session), /Become a Temple Knight/);
        }
        master(c, 7195); assert.equal((await Transfer(c.session, ['second-profession', '20'])).reason, 'wrong_profession');
        master(c, 7109); assert.equal((await Transfer(c.session, ['second-profession', '5'])).reason, 'wrong_profession');
        // A missing final mark rolls back the earlier Duty/Life deductions and persisted class.
        c.session.actor.setLevel(40); await Database.execute(['UPDATE characters SET level = 40 WHERE id = ?', [c.id]]);
        await Database.execute(['DELETE FROM items WHERE characterId = ? AND selfId = 2820', [c.id]]);
        assert.equal((await Transfer(c.session, ['second-profession', '20'])).reason, 'marks');
        assert.equal(await c.amount(2633), 1); assert.equal(await c.amount(3140), 1);
        assert.equal((await c.world.character(c.id)).classId, 19);
        await c.reopen(); await Service.giveItem(c.session, 2820, 1); await c.level(39);
        await finishRoute(c, 20, [[10, 1], [18, 3], [153, 3], [239, 2]]);
        await Database.execute(['DELETE FROM skills WHERE characterId = ? AND selfId = 10', [c.id]]);
        await reloadActor(c); assert.equal(c.session.actor.skillset.fetchSkill(10), undefined);
        master(c, 7900); c.session.actor.setHp(11); c.session.actor.setMp(7);
        assert.equal((await Transfer(c.session, ['second-profession', '20'])).ok, true);
        assert.equal(c.session.actor.fetchHp(), 11); assert.equal(c.session.actor.fetchMp(), 7);
        assert.equal(c.session.actor.skillset.fetchSkill(10).fetchLevel(), 1);
        for (const skill of [67, 143, 288]) assert.equal(c.session.actor.skillset.fetchSkill(skill), undefined, 'Life Cubic, Cubic Mastery and Guard Stance require level 43');
        for (const mark of route.marks) assert.equal(await c.amount(mark), 0);
        await c.reopen(); assert.equal(c.session.actor.fetchClassId(), 20);
        assert.equal((await Database.fetchSkills(c.id)).find(s => s.selfId === 10).level, 1);
        await abort(foreign, 212);
        console.log('Temple Knight: full Elven Knight route, overlapping Duty/Life hunts at Isael, wielded trial weapons, donation reward, atomic marks and persisted Storm Cubic recovery passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

const assert = require('node:assert/strict');
const { createTrialWorld, duty, trust, healer, finishRoute, abort, H, Service, Database, reloadActor, master } = require('./helpers/knightProfessionHarness');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');

(async () => {
    const c = await createTrialWorld('paladin', 182001, [
        { id: 182002, classId: 4, race: 0, level: 35 },
        { id: 182003, classId: 19, race: 1, level: 34 },
        { id: 182004, classId: 32, race: 2, level: 34 },
        { id: 182005, classId: 1, race: 0, level: 39 }
    ], { classId: 4, race: 0, level: 34 });
    try {
        const route = Profession.routes.find(r => r.classId === 5);
        assert.deepEqual(route.quests, [212, 217, 226]); assert.deepEqual(route.marks, [2633, 2734, 2820]);
        assert.deepEqual(route.npcs, [7109, 7187, 7689, 7849, 7900]);
        const foreign = await c.world.session(182002), fighter = await c.world.session(182005);
        assert.equal(await c.world.event(fighter, 212, 'start', 7109), false);
        assert.equal(await c.world.event(foreign, 212, 'start', 7109), true);
        await c.world.event(foreign, 212, 'handin', 7653);
        await duty(c, foreign); await trust(c);
        assert.equal(await c.event(226, 'start', 7473), false);
        await c.level(39); await healer(c, false);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 237707); assert.equal(row.sp, 32500); assert.equal(row.classId, 4);
        assert.equal(await c.amount(7562), 24);
        await reloadActor(c);
        for (const npc of route.npcs) {
            NpcTalk(c.session, master(c, npc));
            await c.session.questMutationTail;
            await new Promise(resolve => setImmediate(resolve));
            assert.match(c.world.page(c.session), /second-profession/, 'ordinary master dialog keeps the transfer link');
            assert.equal(Profession.render(c.session), true);
            assert.match(c.world.page(c.session), /Become a Paladin/);
        }
        master(c, 7195); assert.equal((await Transfer(c.session, ['second-profession', '5'])).reason, 'wrong_profession');
        await finishRoute(c, 5, [[262, 3], [197, 1], [153, 3], [18, 3], [239, 2]]);
        await Database.execute(['DELETE FROM skills WHERE characterId = ? AND selfId = 262', [c.id]]);
        await reloadActor(c); assert.equal(c.session.actor.skillset.fetchSkill(262), undefined);
        master(c, 7900); c.session.actor.setHp(11); c.session.actor.setMp(7);
        assert.equal((await Transfer(c.session, ['second-profession', '5'])).ok, true);
        assert.equal(c.session.actor.fetchHp(), 11); assert.equal(c.session.actor.fetchMp(), 7);
        assert.equal(c.session.actor.skillset.fetchSkill(262).fetchLevel(), 3);
        assert.equal(c.session.actor.skillset.fetchSkill(196), undefined, 'Holy Blade requires level 43');
        assert.equal(c.session.actor.skillset.fetchSkill(69), undefined, 'Sacrifice requires level 52');
        for (const mark of route.marks) assert.equal(await c.amount(mark), 0);
        await c.reopen(); assert.equal(c.session.actor.fetchClassId(), 5);
        assert.equal((await Database.fetchSkills(c.id)).find(s => s.selfId === 262).level, 3);
        await abort(foreign, 212);
        // Both other source classes can accept Duty. Aborting retires worn gear and expired encounters.
        c.id = 182003; c.session = await c.world.session(c.id);
        await duty(c, null, { stopAtSword: true });
        await Service.giveItem(c.session, 57, 123); await Service.giveItem(c.session, 3141, 1);
        await c.world.talk(c.session, 7460); c.state(218).addRadar(90, 80, 70);
        H.clearSpawns(c.state(212)); await abort(c.session, 212);
        assert.equal(await c.amount(3027), 0); assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
        assert.equal(await c.amount(57), 123); assert.equal(await c.amount(3141), 1);
        assert.equal(c.session.questWaypoints.size, 1);
        assert.equal(await c.event(212, 'start', 7109), true);
        await abort(c.session, 212);
        c.id = 182004; c.session = await c.world.session(c.id);
        await duty(c, null, { stopAtSpirit: true });
        for (const npc of H.personalSpawns(c.state(212))) c.runtime.despawnQuestNpc(npc);
        await abort(c.session, 212);
        assert.equal(H.personalSpawns(c.state(212)).length, 0); assert.equal(c.session.questWaypoints.size, 0);
        assert.equal(await c.event(212, 'recover', 7654), false);
        assert.equal(await c.event(212, 'start', 7109), true); await abort(c.session, 212);
        console.log('Paladin: complete Knight route, wielded Duty sword, private spirits, restart recovery, exact rewards, no-donation Healer and persisted Holy Blessing passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

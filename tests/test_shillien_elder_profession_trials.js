const assert = require('node:assert/strict');
const { createTrialWorld, pilgrim, fate, reformer, finishRoute, abort, H, Service } = require('./helpers/darkElfProfessionHarness');

(async () => {
    const c = await createTrialWorld('shillien-elder', 177001, [
        { id: 177002, classId: 29, race: 1, level: 39 },
        { id: 177003, classId: 32, race: 2, level: 37 }
    ], { classId: 42, race: 2, level: 34 });
    try {
        const outsider = await c.world.session(177002);
        assert.equal(await c.world.event(outsider, 219, 'start', 7476), false);
        const foreign = await c.world.session(177003);
        assert.equal(await c.world.event(foreign, 219, 'start', 7476), true);
        await pilgrim(c); await fate(c, foreign);
        await c.level(39); await reformer(c);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 310047); assert.equal(row.sp, 35250); assert.equal(await c.amount(7562), 24);
        await finishRoute(c, 43, [[1013, 6], [1240, 1], [1242, 1], [239, 2]]);
        c.id = 177003; c.session = await c.world.session(c.id);
        await abort(c.session, 219);
        // Exercise the direct level-38 branch on a Palus Knight.
        await c.level(38); await c.click(219, 'start', 7476);
        await c.click(219, 'handin', 7614); await c.kill(144);
        for (const npc of [7614, 7463]) await c.click(219, 'handin', npc);
        for (const mob of [158, 233, 202, 192, 234]) await c.kill(mob, 10);
        for (const npc of [7463, 7614, 7476, 7114, 7210, 7476, 7358, 7419]) await c.click(219, 'handin', npc);
        assert.equal(await c.amount(3188), 0); assert.equal(c.cond(219), 14);
        // Both tasks may be undertaken and turned in in either order.
        await c.click(219, 'treant', 12089); await c.kill(5079); await c.click(219, 'sap', 12089);
        await c.click(219, 'pixy', 12084); await c.kill(554, 3);
        await Service.giveItem(c.session, 57, 123); await Service.giveItem(c.session, 2723, 1);
        await c.world.talk(c.session, 7648); c.state(215).addRadar(90, 80, 70);
        await abort(c.session, 219);
        for (const item of c.state(219).quest.questItems) assert.equal(await c.amount(item), 0);
        assert.equal(await c.amount(57), 123); assert.equal(await c.amount(2723), 1);
        assert.equal(c.session.questWaypoints.size, 1);
        await c.reopen(); await c.click(219, 'start', 7476);
        // Cancel after Alder expires; the saved quest radar must still be removed.
        await c.click(219, 'handin', 7614); await c.kill(144);
        for (const npc of [7614, 7463]) await c.click(219, 'handin', npc);
        for (const mob of [158, 233, 202, 192, 234]) await c.kill(mob, 10);
        for (const npc of [7463, 7614, 7476]) await c.click(219, 'handin', npc);
        for (const npc of H.personalSpawns(c.state(219))) c.runtime.despawnQuestNpc(npc);
        assert(c.session.questWaypoints.size > 0);
        await abort(c.session, 219);
        assert.equal(c.session.questWaypoints.size, 0);
        assert.equal(H.personalSpawns(c.state(219)).length, 0);
        console.log('Shillien Elder: full Oracle route, racial eligibility, drop boundaries, quotas, both level branches, parallel tasks, personal spirit recovery, abort and persisted skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

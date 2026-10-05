const assert = require('node:assert/strict');
const { createTrialWorld, pilgrim, life, healer, finishRoute, abort, Service } = require('./helpers/elderProfessionHarness');

(async () => {
    const c = await createTrialWorld('elven-elder', 176001, [
        { id: 176002, classId: 42, race: 2, level: 39 },
        { id: 176003, classId: 22, race: 1, level: 37 },
        { id: 176004, classId: 19, race: 1, level: 37 }
    ], { classId: 29, race: 1, level: 34 });
    try {
        const outsider = await c.world.session(176002);
        assert.equal(await c.world.event(outsider, 218, 'start', 7460), false);
        await pilgrim(c); await life(c);
        await c.level(39); await healer(c, false);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 300727); assert.equal(row.sp, 53500); assert.equal(await c.amount(7562), 24);
        await finishRoute(c, 30, [[1013, 6], [1016, 3], [1259, 1], [239, 2]]);
        // The racial trial is also available to Elven Scouts and Knights.
        c.id = 176003; c.session = await c.world.session(c.id);
        await life(c, { stopAtSpear: true });
        await Service.giveItem(c.session, 57, 123); await Service.giveItem(c.session, 2723, 1);
        await abort(c.session, 218);
        assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
        for (const item of c.state(218).quest.questItems) assert.equal(await c.amount(item), 0);
        assert.equal(await c.amount(57), 123); assert.equal(await c.amount(2723), 1);
        await c.reopen(); assert.equal(c.session.actor.backpack.fetchEquippedWeapon(), undefined);
        await c.click(218, 'start', 7460);
        c.id = 176004; c.session = await c.world.session(c.id);
        await life(c, { equipped: false, waitAt37: false });
        console.log('Elven Elder: full Oracle route, racial eligibility, quotas, level gates, equipped/carried spear retirement, abort, persistence and class skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

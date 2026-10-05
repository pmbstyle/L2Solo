const assert = require('node:assert/strict');
const { createClericWorld, pilgrim, trust, reformer, finishRoute, abort, H, Service, withRandom } = require('./helpers/clericProfessionHarness');

(async () => {
    const c = await createClericWorld('prophet', 175001, [
        { id: 175002, classId: 42, race: 2, level: 39 }, { id: 175003, classId: 29, race: 1, level: 39 }
    ]);
    try {
        await pilgrim(c); await trust(c);
        assert.equal(await c.event(227, 'start', 7118), false, 'Reformer starts at 39');
        const oracle = await c.world.session(175003);
        assert.equal(await c.world.event(oracle, 227, 'start', 7118), false, 'Elven Oracle cannot take Reformer');
        const foreign = await c.world.session(175002);
        assert.equal(await c.world.event(foreign, 227, 'start', 7118), true, 'Shillien Oracle is eligible');
        await c.level(39); await reformer(c, foreign);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 281435); assert.equal(row.sp, 36000); assert.equal(await c.amount(7562), 24);
        // The Shillien Oracle's own boss and diary fragments are removed by abort.
        const resumed = await c.world.session(175002);
        await withRandom(Array(7).fill(0), async () => { for (let i = 0; i < 7; i++) await c.world.kill(resumed, 5099); });
        const foreignState = c.world.state(resumed, 227);
        assert.equal(H.personalSpawns(foreignState, 5128).length, 1);
        await Service.giveItem(resumed, 57, 123); await Service.giveItem(resumed, 2723, 1);
        await c.world.talk(resumed, 7648); c.world.state(resumed, 215).addRadar(90, 80, 70);
        await abort(resumed, 227);
        assert.equal(H.personalSpawns(foreignState).length, 0);
        for (const item of foreignState.quest.questItems) assert.equal(await c.world.amount(175002, item), 0);
        assert.equal(await c.world.amount(175002, 57), 123); assert.equal(await c.world.amount(175002, 2723), 1);
        assert.equal(resumed.questWaypoints.size, 1);
        assert.equal(await c.world.event(resumed, 227, 'start', 7118), true);
        await finishRoute(c, 17, [[1068, 3], [1240, 1], [1242, 1], [239, 2]]);
        console.log('Prophet: complete Cleric route, owned/recovered encounters, pilgrim hand-in, greetings, bone quotas, rewards, abort and persisted skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

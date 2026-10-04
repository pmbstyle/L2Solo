const assert = require('node:assert/strict');
const { createTrialWorld, pilgrim, abort, Service } = require('./helpers/shamanProfessionHarness');

(async () => {
    const c = await createTrialWorld('pilgrim', 172001, [
        { id: 172002, classId: 15, race: 0, level: 34 },
        { id: 172003, classId: 29, race: 1, level: 34 },
        { id: 172004, classId: 42, race: 2, level: 34 },
        { id: 172005, classId: 45, race: 3, level: 39 }
    ]);
    try {
        const raider = await c.world.session(172005);
        assert.equal(await c.world.event(raider, 215, 'start', 7648), false, 'a Raider is not eligible');
        // All four first professions reach the same mark through real hand-ins.
        for (const id of [172001, 172002, 172003, 172004]) {
            c.id = id; c.session = await c.world.session(id);
            await pilgrim(c, { book: id % 2 === 0, keep: id % 2 === 0 });
            for (const i of c.state(215).quest.questItems) assert.equal(await c.amount(i), 0);
        }
        // Completed trials cannot be reset by the abort packet.
        await abort(c.session, 215);
        assert.equal(c.state(215).isCompleted(), true);
        assert.equal(await c.amount(2721), 1);
        // Start a fresh pilgrimage, cancel it, and verify only its proof is removed.
        raider.actor.classId = 50;
        assert.equal(await c.world.event(raider, 215, 'start', 7648), true);
        await Service.giveItem(raider, 57, 123);
        await Service.giveItem(raider, 3200, 1);
        await c.world.talk(raider, 7514);
        const other = c.world.state(raider, 220); other.addRadar(100, 200, 300);
        await abort(raider, 215);
        assert.equal(c.world.state(raider, 215).isStarted(), false);
        assert.equal(await c.world.amount(172005, 2723), 0);
        assert.equal(await c.world.amount(172005, 3200), 1);
        assert.equal(await c.world.amount(172005, 57), 123);
        assert(raider.questWaypoints.size > 0);
        assert.equal(await c.world.event(raider, 215, 'start', 7648), true);
        console.log('Pilgrim: all four classes, both book choices, exact one-time refund, C4 rewards, restart and abort passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

const assert = require('node:assert/strict');
const { createClericWorld, pilgrim, trust, healer, finishRoute, abort, H, Service } = require('./helpers/clericProfessionHarness');

(async () => {
    const c = await createClericWorld('bishop', 174001, [
        { id: 174002, classId: 29, race: 1, level: 39 },
        { id: 174003, classId: 4, race: 0, level: 39 },
        { id: 174004, classId: 19, race: 1, level: 39 },
        { id: 174005, classId: 50, race: 3, level: 39 }
    ]);
    try {
        await pilgrim(c); await trust(c);
        assert.equal(await c.event(226, 'start', 7473), false, 'Healer starts at 39');
        const outsider = await c.world.session(174005);
        assert.equal(await c.world.event(outsider, 226, 'start', 7473), false, 'Shaman cannot take Healer');
        const foreign = await c.world.session(174002);
        assert.equal(await c.world.event(foreign, 226, 'start', 7473), true);
        await c.level(39); await healer(c, true, foreign);
        const row = await c.world.character(c.id);
        assert.equal(row.exp, 252242); assert.equal(row.sp, 68500); assert.equal(await c.amount(7562), 24);
        await finishRoute(c, 16, [[1217, 3], [1016, 3], [1254, 1], [239, 2]]);
        // Cancel the foreign player's encounter without removing another quest's proof or radar.
        const resumed = await c.world.session(174002);
        c.id = 174002; c.session = resumed;
        await c.click(226, 'challenge', 7428); await c.ownedKill(226, 5134);
        for (const npc of [7428, 7424, 7658]) await c.click(226, 'handin', npc);
        await c.click(226, 'skip', 7658); await c.click(226, 'handin', 7327); await c.click(226, 'challenge', 7674);
        assert.equal(H.personalSpawns(c.state(226)).length, 3);
        // Timer expiry removes actors without clearing the player's saved radar markers.
        for (const npc of H.personalSpawns(c.state(226))) c.runtime.despawnQuestNpc(npc);
        await Service.giveItem(resumed, 57, 123); await Service.giveItem(resumed, 2723, 1);
        await c.world.talk(resumed, 7648); c.world.state(resumed, 215).addRadar(90, 80, 70);
        await abort(resumed, 226);
        assert.equal(H.personalSpawns(c.world.state(resumed, 226)).length, 0);
        assert.equal(await c.world.amount(174002, 2810), 0);
        assert.equal(await c.world.amount(174002, 57), 123); assert.equal(await c.world.amount(174002, 2723), 1);
        assert.equal(resumed.questWaypoints.size, 1);
        assert.equal(await c.world.event(resumed, 226, 'start', 7473), true);
        // All four source classes are eligible. Knights and Elven Knights also finish without donating.
        for (const id of [174003, 174004]) {
            c.id = id; c.session = await c.world.session(id);
            await healer(c, false);
        }
        console.log('Bishop: complete Cleric route, four-class Healer eligibility, both donation rewards, recovered waves, expired-encounter abort and persisted skills passed');
    } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

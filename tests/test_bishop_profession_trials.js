const assert = require('node:assert/strict');
const { createClericWorld, pilgrim, trust, finishRoute, abort, H, Service } = require('./helpers/clericProfessionHarness');

async function healer(c, donate, foreign = null) {
    const before = await c.world.character(c.id);
    await c.click(226, 'start', 7473);
    assert.equal(await c.event(226, 'finish', 7473), false);
    assert.equal(await c.event(226, 'challenge', 7674), false);
    await c.click(226, 'challenge', 7428);
    const tatoma = H.personalSpawns(c.state(226), 5134)[0];
    assert(tatoma);
    await c.kill(5134); assert.equal(c.cond(226), 2, 'a wild/fabricated Tatoma is not the personal opponent');
    if (foreign) {
        await Service.onKill(foreign, tatoma);
        assert.equal(c.world.state(foreign, 226).getInt('cond'), 1);
    }
    H.clearSpawns(c.state(226)); await c.reopen();
    await c.click(226, 'recover', 7428); await c.click(226, 'recover', 7428);
    assert.equal(H.personalSpawns(c.state(226), 5134).length, 1);
    await c.ownedKill(226, 5134);
    for (const npc of [7428, 7424, 7658]) await c.click(226, 'handin', npc);
    if (donate) {
        await Service.giveItem(c.session, 57, 99999);
        assert.equal(await c.event(226, 'donate', 7658), false); assert.equal(await c.amount(57), 99999);
        await Service.giveItem(c.session, 57, 1);
        await c.click(226, 'donate', 7658);
        assert.equal(await c.amount(57), 0); assert.equal(await c.amount(2812), 1);
        assert.equal(await c.event(226, 'donate', 7658), false);
        await c.click(226, 'handin', 7660); await c.click(226, 'handin', 7658);
        assert.equal(await c.amount(2813), 1);
    } else {
        await c.click(226, 'skip', 7658);
        assert.equal(c.cond(226), 9, 'the no-donation branch reaches the rescue');
        assert.equal(await c.amount(2813), 0); assert.equal(await c.amount(57), 0);
    }
    await c.click(226, 'handin', 7327); await c.click(226, 'challenge', 7674);
    assert.equal(H.personalSpawns(c.state(226), 5122).length, 2);
    assert.equal(H.personalSpawns(c.state(226), 5123).length, 1);
    const leader = H.personalSpawns(c.state(226), 5123)[0];
    assert.deepEqual([leader.fetchLocX(), leader.fetchLocY(), leader.fetchLocZ()], [-97441, 106585, -3405]);
    await c.ownedKill(226, 5122); assert.equal(c.cond(226), 11);
    await c.ownedKill(226, 5123);
    await c.kill(5123); assert.equal(await c.amount(2816), 1);
    assert.equal(H.personalSpawns(c.state(226)).length, 0);
    await c.click(226, 'handin', 7674); assert.equal(await c.amount(2816), 1, 'Daurin keeps the original letter for Kristina');
    await c.click(226, 'guide', 7662);
    assert(c.session.questWaypoints.size > 0);
    for (const [template, item] of [[5124, 2817], [5125, 2818], [5127, 2819]]) {
        await c.click(226, 'challenge', 7661);
        assert.equal(H.personalSpawns(c.state(226)).length, 3);
        // Let an encounter disappear, reopen SQLite, then recover without duplication.
        H.clearSpawns(c.state(226)); await c.reopen();
        await c.click(226, 'recover', 7661); await c.click(226, 'recover', 7661);
        assert.equal(H.personalSpawns(c.state(226)).length, 3);
        await c.ownedKill(226, template);
        assert.equal(await c.amount(item), 1); assert.equal(H.personalSpawns(c.state(226)).length, 0);
        await c.kill(template); assert.equal(await c.amount(item), 1);
    }
    for (const i of [2816, 2817, 2818, 2819]) assert.equal(await c.amount(i), 1);
    await c.click(226, 'handin', 7661); await c.click(226, 'guide', 7663);
    assert.equal(c.cond(226), 21);
    await c.click(226, 'handin', 7665); await c.click(226, 'handin', 7327);
    await c.reopen(); await c.click(226, 'finish', 7473);
    assert.equal(await c.amount(2820), 1);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, donate ? 134839 : 118304);
    assert.equal(after.sp - before.sp, donate ? 50000 : 26250);
    for (const i of c.state(226).quest.questItems) assert.equal(await c.amount(i), 0);
    assert.equal(c.session.questWaypoints?.size || 0, 0);
    assert.equal(await c.event(226, 'finish', 7473), false); assert.deepEqual(await c.world.character(c.id), after);
}

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
